import type { PoolClient } from "pg";
import { CertificateSchema, DeviceSchema, KitSchema, SourceSchema, WorldKitError, type Component, type Connection, type DeviceProfile, type Source, type Certificate } from "../../packages/contracts";
import { graphHash, hash } from "../../packages/compatibility";
import { InventoryItemSchema } from "../../packages/inventory/contracts";
import { PackEditionSchema } from "../../packages/domain-packs/contracts";
import { assertPackEdition } from "../../packages/domain-packs/compiler";
import { benchProtocol } from "../../packages/physical-notebook/policy";
import type { BenchBinding, BenchHome, BenchSubject } from "../../packages/physical-notebook/contracts";
import { assertEngineeringProfilesCurrent } from "./engineering-review";
import { domainEditionFreshness } from "./domain-packs";
import { benchFail } from "./physical-notebook-authority";

function makeBinding(subject: BenchSubject, title: string, components: Component[], connections: Connection[], profiles: DeviceProfile[], sources: Source[], certificate: Certificate, steps: BenchBinding["steps"], graphSource: BenchBinding["graphSource"]): BenchBinding {
  const content = { kind: subject.kind, subjectId: subject.subjectId, revisionId: subject.revisionId, graphHash: subject.graphHash, title, certificateHash: hash(certificate), ruleVersion: certificate.ruleVersion,
    components: components.map(component => {
      const profile = profiles.find(candidate => candidate.id === component.profileId);
      if (!profile) benchFail("The exact saved profile is missing; repair the source graph first.", "needs_evidence");
      return { id: component.id, profileId: profile.id, model: `${profile.manufacturer} ${profile.model} · ${profile.variant}`, profileHash: hash(profile) };
    }),
    connections: connections.map(connection => ({ id: connection.id, from: `${connection.from.componentId}/${connection.from.portId}`, to: `${connection.to.componentId}/${connection.to.portId}`, signal: connection.signal, protocol: connection.protocol, cable: connection.cable, enabled: connection.enabled })),
    configuration: components.map(component => ({ componentId: component.id, settings: component.settings })),
    sources: sources.map(source => ({ id: source.id, hash: source.contentHash, title: source.title, url: source.url })),
    requirements: certificate.results.map(witness => ({ id: witness.id, label: witness.title, modeledStatus: witness.status })), steps, graphSource,
  };
  return { ...content, hash: hash(content) };
}

/** Only persisted owned graphs may be bound. No model/provider call or graph mutation. */
export async function resolveBenchBinding(db: PoolClient, tenantId: string, subject: BenchSubject, requireCurrent = false): Promise<{ binding: BenchBinding; current: boolean; issues: string[] }> {
  const issues: string[] = [];
  if (subject.kind === "domain") {
    const row = (await db.query("SELECT e.payload,p.current_edition_id,p.archived_at FROM wk_domain_editions e JOIN wk_domain_projects p ON p.id=e.project_id AND p.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND e.project_id=$2 AND e.id=$3 FOR SHARE OF p", [tenantId, subject.subjectId, subject.revisionId])).rows[0];
    if (!row) benchFail("That system edition is outside this workspace.", "not_found");
    const edition = PackEditionSchema.parse(row.payload); assertPackEdition(edition);
    if (edition.certificate.graphHash !== subject.graphHash) benchFail("The selected graph fingerprint changed.", "stale_revision");
    if (row.current_edition_id !== subject.revisionId) issues.push("The saved system has a newer edition. This report retains its original graph.");
    if (row.archived_at) issues.push("The saved system is archived.");
    const inventory = (await db.query("SELECT payload FROM wk_inventory_items WHERE tenant_id=$1 ORDER BY id FOR SHARE", [tenantId])).rows.map(value => InventoryItemSchema.parse(value.payload));
    issues.push(...domainEditionFreshness(edition, inventory).issues.map(issue => issue.message));
    if (requireCurrent && issues.length) benchFail(issues[0]!, "stale_revision");
    const config = edition.graph.state.config;
    const inputs = edition.graph.components.filter(component => edition.profiles.find(profile => profile.id === component.profileId)?.kind === "microphone").map(component => ({ id: component.id, label: component.role }));
    const steps = config.packId === "desk-displays" ? benchProtocol("desk", [], { displays: config.displays }) : benchProtocol("audio", inputs, { cameraRequired: false });
    return { binding: makeBinding(subject, edition.graph.title, edition.graph.components, edition.graph.connections, edition.profiles, edition.sources, edition.certificate, steps, "modelled"), current: !issues.length, issues };
  }
  const row = (await db.query("SELECT r.kit,r.certificate,r.profiles,r.sources,k.current_revision_id FROM wk_revisions r JOIN wk_kits k ON k.id=r.kit_id AND k.tenant_id=r.tenant_id WHERE r.tenant_id=$1 AND r.kit_id=$2 AND r.id=$3 FOR SHARE OF k", [tenantId, subject.subjectId, subject.revisionId])).rows[0];
  if (!row) benchFail("That creator-system revision is outside this workspace.", "not_found");
  const kit = KitSchema.parse(row.kit), certificate = CertificateSchema.parse(row.certificate), profiles = DeviceSchema.array().parse(row.profiles), sources = SourceSchema.array().parse(row.sources);
  if (graphHash(kit, profiles) !== certificate.graphHash || certificate.graphHash !== subject.graphHash || certificate.revisionId !== kit.id) benchFail("The saved graph and certificate fingerprints do not agree.", "stale_revision");
  if (row.current_revision_id !== subject.revisionId) issues.push("The creator system has a newer revision. This report retains its original graph.");
  try { await assertEngineeringProfilesCurrent(db, tenantId, profiles); }
  catch (error) { if (error instanceof WorldKitError) issues.push(error.message); else throw error; }
  if (requireCurrent && issues.length) benchFail(issues[0]!, "stale_revision");
  const inputs = kit.components.filter(component => profiles.find(profile => profile.id === component.profileId)?.kind === "microphone").map(component => ({ id: component.id, label: component.role }));
  const steps = benchProtocol("audio", inputs, { cameraRequired: kit.goal.requirements.some(requirement => requirement.kind === "camera_stream" && requirement.hard) });
  return { binding: makeBinding(subject, kit.goal.title, kit.components, kit.connections, profiles, sources, certificate, steps, kit.sourceMode === "sample" ? "sample" : kit.sourceMode === "modelled" ? "modelled" : "mixed"), current: !issues.length, issues };
}

export async function benchSubjects(db: PoolClient, tenantId: string): Promise<BenchHome["subjects"]> {
  const creator = (await db.query("SELECT r.kit,r.certificate FROM wk_kits k JOIN wk_revisions r ON r.id=k.current_revision_id AND r.tenant_id=k.tenant_id WHERE k.tenant_id=$1 ORDER BY k.created_at LIMIT 40", [tenantId])).rows.map(row => ({ subject: { kind: "creator" as const, subjectId: row.kit.kitId, revisionId: row.kit.id, graphHash: row.certificate.graphHash }, title: row.kit.goal.title as string, componentCount: row.kit.components.length as number, kindLabel: "Creator system" }));
  const domain = (await db.query("SELECT p.id,p.title,p.pack_id,e.id AS edition_id,e.graph_hash,e.payload FROM wk_domain_projects p JOIN wk_domain_editions e ON e.id=p.current_edition_id AND e.project_id=p.id AND e.tenant_id=p.tenant_id WHERE p.tenant_id=$1 AND p.archived_at IS NULL ORDER BY p.created_at LIMIT 40", [tenantId])).rows.map(row => ({ subject: { kind: "domain" as const, subjectId: row.id as string, revisionId: row.edition_id as string, graphHash: row.graph_hash as string }, title: row.title as string, componentCount: row.payload.graph.components.length as number, kindLabel: row.pack_id === "desk-displays" ? "Desk & displays" : "Shared podcast" }));
  return [...creator, ...domain];
}
