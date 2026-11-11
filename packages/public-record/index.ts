import { z } from "zod";
import { isIP } from "node:net";
import { combine, graphHash, hash } from "../compatibility/index";
import { CertificateSchema, ProvenanceSchema, SignalSchema, TruthSchema, WorldKitError, type Certificate, type DeviceProfile, type KitRevision, type Source } from "../contracts/index";

const text = z.string().max(2400), id = z.string().min(1).max(240), digest = z.string().regex(/^[a-f0-9]{64}$/);
const stringList = z.array(text).max(100);
const publicFact = z.object({ id, property: text, value: z.union([text, z.number(), z.boolean(), z.null()]), unit: text.nullable(), scope: text, conditions: stringList, state: z.enum(["supported", "unknown", "conflicted"]), critical: z.boolean(), review: z.enum(["pending", "reviewed", "rejected"]), sourceIds: z.array(id).max(50) }).strict();
const publicDevice = z.object({ componentId: id, profileId: id, role: text, manufacturer: text, model: text, variant: text, profileVersion: z.number().int().positive(), quantity: z.number().int().positive(), kind: text,
  settings: z.array(z.object({ name: text, value: z.union([text, z.number(), z.boolean()]) }).strict()).max(30),
  ports: z.array(z.object({ id, label: text, connector: text, direction: text, signal: SignalSchema }).strict()).max(100),
  facts: z.array(publicFact).max(100), reviewState: text, exactScope: stringList,
}).strict();
const publicConnection = z.object({ id, from: z.object({ componentId: id, portId: id }).strict(), to: z.object({ componentId: id, portId: id }).strict(), signal: SignalSchema, protocol: text, cable: text, enabled: z.boolean(), sourceIds: z.array(id).max(50) }).strict();
export const PublicRecordPayloadSchema = z.object({
  schema: z.literal("worldkit.public-record.v1"), title: z.string().min(3).max(100), preparedAt: z.iso.datetime(),
  revisionId: id, revision: z.number().int().positive(), certificateId: id, graphHash: digest, sourceHash: digest, ruleVersion: id,
  issuedAt: z.string(), sourceMode: ProvenanceSchema, modelStatus: TruthSchema, physicalTest: z.literal("not_performed"),
  scope: z.literal("Computational routing and source-backed constraints; physical performance not tested."),
  counts: z.object({ satisfied: z.number().int().nonnegative(), violated: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
  review: z.object({ required: z.number().int().nonnegative(), reviewed: z.number().int().nonnegative(), pending: z.number().int().nonnegative() }).strict(),
  requirements: z.array(z.object({ id, label: text, kind: text, hard: z.boolean(), confirmed: z.boolean(), status: TruthSchema,
    witness: z.object({ ruleId: id, title: text, explanation: text, componentIds: z.array(id).max(100), connectionIds: z.array(id).max(100), factIds: z.array(id).max(100), sourceIds: z.array(id).max(100), nextAction: text.nullable() }).strict(),
  }).strict()).max(100),
  devices: z.array(publicDevice).max(100), connections: z.array(publicConnection).max(300),
  sources: z.array(z.object({ id, title: text, publisher: text, kind: text, retrievedAt: text, contentHash: text, url: z.url().nullable(), linkState: z.enum(["public_reference", "withheld"]) }).strict()).max(300),
  assembly: z.array(z.object({ id, index: z.number().int().positive(), connectionId: id, fromComponentId: id, fromPortId: id, toComponentId: id, toPortId: id,
    title: text, instruction: text, test: text, signal: SignalSchema, enabled: z.boolean(), sourceIds: z.array(id).max(50),
  }).strict()).max(300),
  limitations: stringList,
}).strict();
export type PublicRecordPayload = z.infer<typeof PublicRecordPayloadSchema>;
export type PublicRecordSnapshot = { id: string; slug: string; edition: number; version: number; shareVersion: number; state: "draft" | "reviewed" | "published" | "withdrawn"; contentHash: string; payload: PublicRecordPayload; reviewedAt: string | null; publishedAt: string | null; withdrawnAt: string | null };
export type PublicRecordView = { state: "published" | "withdrawn" | "unavailable"; record: PublicRecordSnapshot | null; revisionState: "current" | "superseded" | null; sourceState: "recorded" | "changed" | null; checkedAt: string; expiresAt: string | null; editionUrl: string | null };
export type PublicRecordDesk = { revisionId: string; graphHash: string; revision: number; publicOrigin: string; share: { slug: string; version: number; currentRecordId: string | null; withdrawnAt: string | null } | null; records: (PublicRecordSnapshot & { availability: "private" | "published" | "withdrawn"; currentSourceState: "recorded" | "changed" | "unavailable" })[]; expiresAt: string };

const actionBase = { requestId: z.uuid(), expectedRevisionId: id, expectedGraphHash: digest };
export const PreparePublicRecordInput = z.object({ ...actionBase, action: z.literal("prepare"), title: z.string().trim().min(3).max(100), expectedShareVersion: z.number().int().nonnegative() }).strict();
const editionAction = { ...actionBase, recordId: z.uuid(), expectedVersion: z.number().int().positive(), expectedContentHash: digest, expectedShareVersion: z.number().int().nonnegative() };
export const ReviewPublicRecordInput = z.object({ ...editionAction, action: z.literal("review"), reviewedDisplayFields: z.literal(true), understoodScope: z.literal(true) }).strict();
export const PublishPublicRecordInput = z.object({ ...editionAction, action: z.literal("publish"), confirmPublicAccess: z.literal(true) }).strict();
export const WithdrawPublicRecordInput = z.object({ action: z.literal("withdraw"), requestId: z.uuid(), expectedShareVersion: z.number().int().nonnegative() }).strict();
export const PublicRecordActionInput = z.discriminatedUnion("action", [PreparePublicRecordInput, ReviewPublicRecordInput, PublishPublicRecordInput, WithdrawPublicRecordInput]);
export type PublicRecordAction = z.infer<typeof PublicRecordActionInput>;
export const PublicSlugSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const PublicEditionSchema = z.coerce.number().int().positive().max(10000);

// Reference links never contain a user name, signed query, private address or
// private storage location. No source URL is fetched by publishing or reading.
export function publicReferenceUrl(raw: string): string | null {
  try {
    const u = new URL(raw), host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.port || u.search || u.hash) return null;
    if (isIP(host.replace(/^\[|\]$/g, "")) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
    if (/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|corp|lan|home|onion|invalid|test|example)$/.test(host) || /(?:^|\.)(?:home\.arpa|vercel-storage\.com|nip\.io|sslip\.io)$/.test(host)) return null;
    return u.href;
  } catch { return null; }
}
const settingNames = new Set(["sampleRate", "phantomEnabled", "usbMode", "recordingMode", "powerSource", "resolution", "cleanHdmiConfirmed", "firmware", "firmwareVersion", "hardwareRevision", "os", "osVersion", "app", "appVersion"]);
type Bundle = { kit: KitRevision; certificate: Certificate; profiles: DeviceProfile[]; sources: Source[] };
export function projectPublicRecord(bundle: Bundle, title: string, preparedAt = new Date().toISOString()): PublicRecordPayload {
  const { kit, profiles, sources } = bundle, certificate = CertificateSchema.parse(bundle.certificate);
  if (certificate.revisionId !== kit.id || certificate.graphHash !== graphHash(kit, profiles)) throw new WorldKitError("stale_revision", "The certificate no longer identifies this exact saved graph.", 409);
  const expectedId = `cert_${hash({ graph: certificate.graphHash, sources: certificate.sourceHash, rules: certificate.ruleVersion, results: certificate.results }).slice(0, 32)}`;
  if (certificate.id !== expectedId || (["satisfied", "violated", "unknown"] as const).some(status => certificate.counts[status] !== certificate.results.filter(result => result.status === status).length)) throw new WorldKitError("stale_revision", "The saved certificate's identity or result totals are inconsistent.", 409);
  const criticalFacts = [...new Set(kit.components.map(c => c.profileId))].flatMap(profileId => Object.values(profiles.find(p => p.id === profileId)?.facts ?? {})).filter(f => f.critical);
  const reviewed = criticalFacts.filter(f => f.state === "supported" && f.value !== null && f.review.status === "reviewed" && f.review.reviewer && f.sourceIds.length > 0 && f.sourceIds.every(id => sources.some(s => s.id === id && /^[a-f0-9]{64}$/.test(s.contentHash) && ["manufacturer", "software_publisher", "sample"].includes(s.kind)))).length;
  const status = combine([...certificate.results.filter(r => kit.goal.requirements.find(q => q.id === r.requirementId)?.hard).map(r => r.status), reviewed === criticalFacts.length && criticalFacts.length > 0 ? "satisfied" : "unknown"]);
  if (certificate.status !== status || certificate.review.required !== criticalFacts.length || certificate.review.reviewed !== reviewed || certificate.review.pending !== criticalFacts.length - reviewed) throw new WorldKitError("stale_revision", "The certificate status or review coverage is inconsistent with its saved scope.", 409);
  const ids = new Set(certificate.results.flatMap(result => result.factIds));
  const devices = kit.components.map(component => {
    const profile = profiles.find(item => item.id === component.profileId);
    if (!profile) throw new WorldKitError("needs_evidence", "Every component needs an exact identity before its record can be shared.", 422);
    const facts = Object.values(profile.facts).filter(fact => ids.has(fact.id) || fact.critical);
    return { componentId: component.id, profileId: profile.id, role: component.role, manufacturer: profile.manufacturer, model: profile.model, variant: profile.variant, profileVersion: profile.version, quantity: component.quantity, kind: profile.kind,
      settings: Object.entries(component.settings).filter(([name]) => settingNames.has(name)).map(([name, value]) => ({ name, value })),
      ports: profile.ports.map(port => ({ id: port.id, label: port.label, connector: port.connector, direction: port.direction, signal: port.signal })),
      facts: facts.map(fact => ({ id: fact.id, property: fact.property, value: fact.value, unit: fact.unit, scope: fact.scope, conditions: [...fact.conditions], state: fact.state, critical: fact.critical, review: fact.review.status, sourceIds: [...fact.sourceIds] })),
      reviewState: profile.reviewState, exactScope: [...new Set(facts.map(fact => fact.scope).filter(Boolean))],
    };
  });
  const requirements = kit.goal.requirements.map(requirement => {
    const result = certificate.results.find(item => item.requirementId === requirement.id);
    if (!result) throw new WorldKitError("needs_evidence", "Each requirement needs its saved verification result.", 422);
    return { id: requirement.id, label: requirement.label, kind: requirement.kind, hard: requirement.hard, confirmed: requirement.confirmed, status: result.status,
      witness: { ruleId: result.ruleId, title: result.title, explanation: result.explanation, componentIds: [...result.componentIds], connectionIds: [...result.connectionIds], factIds: [...result.factIds], sourceIds: [...result.sourceIds], nextAction: result.nextAction } };
  });
  if (new Set(requirements.map(r => r.id)).size !== requirements.length || certificate.results.length !== requirements.length) throw new WorldKitError("needs_evidence", "Requirements and their saved witnesses must match one to one.", 422);
  const connections = kit.connections.map(edge => ({ id: edge.id, from: { componentId: edge.from.componentId, portId: edge.from.portId }, to: { componentId: edge.to.componentId, portId: edge.to.portId }, signal: edge.signal, protocol: edge.protocol, cable: edge.cable, enabled: edge.enabled, sourceIds: [...edge.sourceIds] }));
  const requiredSources = new Set([...devices.flatMap(d => d.facts.flatMap(f => f.sourceIds)), ...requirements.flatMap(r => r.witness.sourceIds), ...connections.flatMap(c => c.sourceIds)]);
  const publicSources = sources.filter(source => requiredSources.has(source.id)).map(source => {
    const url = publicReferenceUrl(source.url);
    return { id: source.id, title: source.title, publisher: source.publisher, kind: source.kind, retrievedAt: source.retrievedAt, contentHash: source.contentHash, url, linkState: url ? "public_reference" as const : "withheld" as const };
  });
  if ([...requiredSources].some(sourceId => !publicSources.some(source => source.id === sourceId))) throw new WorldKitError("needs_evidence", "A referenced source is missing from this saved revision.", 422);
  const device = (id: string) => devices.find(d => d.componentId === id);
  const port = (componentId: string, id: string) => device(componentId)?.ports.find(p => p.id === id)?.label ?? "Port identity unresolved";
  const assembly = connections.map((edge, index) => ({ id: `step:${edge.id}`, index: index + 1, connectionId: edge.id, fromComponentId: edge.from.componentId, fromPortId: edge.from.portId, toComponentId: edge.to.componentId, toPortId: edge.to.portId,
    title: `${device(edge.from.componentId)?.model ?? "Unknown device"} → ${device(edge.to.componentId)?.model ?? "Unknown device"}`,
    instruction: edge.enabled ? `Connect ${port(edge.from.componentId, edge.from.portId)} to ${port(edge.to.componentId, edge.to.portId)} using ${edge.cable}.` : `This saved connection is disabled. Do not assemble it from this guide.`,
    test: edge.signal === "power" ? "Check the exact supply, voltage, polarity and cable against the manufacturer instructions before applying power. This guide is not an electrical safety approval." : "Check the exact ports and documented modes. Run the modeled connection test in the private workbench; actual hardware performance needs a separate physical test.",
    signal: edge.signal, enabled: edge.enabled, sourceIds: [...edge.sourceIds],
  }));
  return PublicRecordPayloadSchema.parse({ schema: "worldkit.public-record.v1", title, preparedAt, revisionId: kit.id, revision: kit.revision, certificateId: certificate.id,
    graphHash: certificate.graphHash, sourceHash: certificate.sourceHash, ruleVersion: certificate.ruleVersion, issuedAt: certificate.issuedAt, sourceMode: kit.sourceMode,
    modelStatus: certificate.status, physicalTest: certificate.physicalTest, scope: certificate.scope, counts: { ...certificate.counts }, review: { ...certificate.review }, requirements, devices, connections, sources: publicSources, assembly,
    limitations: ["This record preserves one saved computational model. It does not establish physical performance, electrical safety, ownership, purchase or delivery.", "Unknown checks remain unknown. A passed routing check does not turn an unresolved device, firmware, OS or application scope into a verified one.", "Source and review coverage are recorded as of this revision. No independent human review is implied by publication.", "Assembly checkboxes are personal reminders only. They cannot create a test result or change the certificate.", "Saved images, printed copies and downloads cannot be recalled. Check the current sharing state at the QR link.", ...(publicSources.some(s => !s.url) ? ["Some source links are withheld because they are not safe public reference URLs. Source fingerprints and the recorded verification scope remain visible."] : [])],
  });
}
export function publicRecordHash(payload: PublicRecordPayload): string { return hash(PublicRecordPayloadSchema.parse(payload)); }
