import { randomUUID } from "node:crypto";
import { hash, verifyKit } from "../../packages/compatibility";
import { architectures } from "../../packages/device-library";
import { DeviceSchema, type Source } from "../../packages/contracts";
import type { ExtractionDraft } from "../../packages/spec-evidence/contracts";
import type { SourceDocument } from "../../packages/spec-evidence/sources";
import { digestText, initialContent } from "../../packages/engineering-review/policy";
import { SAMPLE_REVIEW_IMAGE } from "../../packages/engineering-review/sample-image";
import type { EngineeringClaim, ProposalContent, ReviewAsset, ReviewAccess, ReviewDetail } from "../../packages/engineering-review/contracts";
import { database, transaction } from "../../src/server/db";
import { createSession, getRevision, saveRevision } from "../../src/server/repository";
import { engineeringCommand, engineeringDetail, ownerReviewAccess, redeemInvitation } from "../../src/server/engineering-review";
import { requireIsolatedDatabase } from "./isolated-database";

export async function seedEngineeringFixture() {
  requireIsolatedDatabase();
  const created = await createSession(), owner = await ownerReviewAccess(created.session), tenantId = created.session.id;
  const profileId = `sample-review-recorder-${randomUUID().slice(0, 8)}`, candidateId = `research:${profileId}:sample`, documentId = randomUUID(), draftId = randomUUID(), jobId = randomUUID();
  const text = "SAMPLE: Fictional Review Recorder, demonstration variant A. Firmware 1.0; Sample OS 1; Sample Stream 1.\n" +
    "In the sample fixture, two independent tracks are recorded onboard while the USB stereo mix is sent, at 48,000 Hz. This is fictional software evidence, never a manufacturer or physical test.\n" +
    "INPUT A is an XLR audio input carrying analog_audio, one channel, consuming zero watts at the port and sharing resource mic-input.\n" +
    "USB is a USB-C bidirectional data port carrying usb_audio, two channels, consuming one watt at the port and sharing resource usb-bus.\n" +
    "The original fictional illustration shows INPUT A at normalized (0.2625, 0.645833) and USB at (0.73375, 0.634375). Only these two ports belong to this declared fictional scope; no actual product geometry is established.";
  const sourceHash = digestText(`fictional-document:${text}`), textHash = digestText(text);
  const document: SourceDocument = { sourceId: `sample:${profileId}`, url: "https://example.invalid/worldkit-fictional-review", retrievedAt: new Date().toISOString(), contentHash: sourceHash, textHash, mediaType: "text/html", bytes: text.length, pages: [{ number: 1, text }], parser: "worldkit-text.1", identityMentioned: true };
  const anchor = { sourceId: document.sourceId, contentHash: sourceHash, textHash, page: 1, start: 0, end: text.length, excerptHash: digestText(text) };
  const draft: ExtractionDraft = { id: draftId, profileId, sourceId: document.sourceId, sourceHash, textHash, createdAt: new Date().toISOString(), promptVersion: "source-extractor.1", queriesHash: hash({ sample: true }), promotion: "human_review_required", physicalTest: "not_performed", counts: { located: 2, unknown: 0, rejected: 0, conflicted: 0 }, limitations: ["Sample fixture. No model, manufacturer, human reviewer or physical measurement produced this content."], facts: [
    { assertionId: `${profileId}:tracks`, property: "independentChannels", value: 2, unit: "count", critical: true, state: "supported", proposedState: "supported", conditions: ["Sample firmware and settings only"], scope: "Fictional Review Recorder, demonstration variant A", evidence: [anchor], validation: "located_pending_review", validationIssues: [], review: { status: "pending", reviewer: null, date: null }, explanation: "A fictional input for testing exact immutable review." },
    { assertionId: `${profileId}:simultaneous`, property: "simultaneousUsbRecording", value: true, unit: null, critical: true, state: "supported", proposedState: "supported", conditions: ["48,000 Hz; firmware 1.0; Sample OS 1; Sample Stream 1"], scope: "Fictional Review Recorder, demonstration variant A", evidence: [anchor], validation: "located_pending_review", validationIssues: [], review: { status: "pending", reviewer: null, date: null }, explanation: "Sample simultaneous-mode assertion; two distinct Sample reviewers are needed for the rehearsal." },
  ] };
  const source: Source = { id: document.sourceId, title: "Sample engineering source — fictional", publisher: "WorldKit software qualification", url: document.url, kind: "sample", contentHash: sourceHash, retrievedAt: document.retrievedAt, location: "Original fictional text, page 1", summary: "Synthetic test data. No manufacturer, model extraction or physical observation is claimed.", rights: "link_and_facts_only" };
  const profile = DeviceSchema.parse({ id: candidateId, corpusId: profileId, baseProfileId: profileId, sourceVersion: sourceHash, manufacturer: "Fictional", model: "Review Recorder", variant: "demonstration variant A", kind: "recorder", version: 1, shortName: "Sample recorder", description: "Fictional engineering-review qualification", ports: [], facts: {}, portMapStatus: "pending", catalogId: null, selectedOptions: [], reviewState: "review_pending", art: "original_line_art", accent: "#dbe6e2" });
  const asset: ReviewAsset = { id: randomUUID(), profileId, photoId: null, imageHash: digestText(SAMPLE_REVIEW_IMAGE), cropHash: hash({ imageHash: digestText(SAMPLE_REVIEW_IMAGE), crop: { x: 0, y: 0, width: 1, height: 1 } }), crop: { x: 0, y: 0, width: 1, height: 1 }, width: 800, height: 480, provenance: "sample", description: "Original fictional recorder illustration; no actual product geometry.", current: true, available: true };
  const prior = await getRevision(tenantId);
  const kit = { ...prior.kit, id: randomUUID(), revision: prior.kit.revision + 1, parentRevisionId: prior.kit.id, components: prior.kit.components.map(component => component.role === "audio" ? { ...component, profileId: candidateId } : component) };
  const profiles = [...prior.profiles, profile], sources = [...prior.sources, source];
  const certificate = verifyKit(kit, profiles, sources, architectures);
  await transaction(async db => {
    await db.query("INSERT INTO wk_jobs(id,tenant_id,kind,status,input,output) VALUES($1,$2,'sample_engineering','succeeded',$3,$4)", [jobId, tenantId, { sourceMode: "sample" }, { sourceMode: "sample" }]);
    await db.query("INSERT INTO wk_source_documents(id,tenant_id,profile_id,job_id,source_url,blob_path,content_hash,text_hash,media_type,bytes,payload,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'text/html',$9,$10,'available')", [documentId, tenantId, profileId, jobId, document.url, `worldkit/${tenantId}/sources/${documentId}.source`, sourceHash, textHash, text.length, document]);
    await db.query("INSERT INTO wk_source_heads(tenant_id,profile_id,document_id,version) VALUES($1,$2,$3,1)", [tenantId, profileId, documentId]);
    await db.query("INSERT INTO wk_source_drafts(id,tenant_id,document_id,profile_id,job_id,payload,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)", [draftId, tenantId, documentId, profileId, jobId, draft, { provider: "sample", sourceMode: "sample", actualModelCall: false }]);
    await db.query("INSERT INTO wk_source_profile_versions(id,tenant_id,profile_id,draft_id,source_document_id,payload,source) VALUES($1,$2,$3,$4,$5,$6,$7)", [candidateId, tenantId, profileId, draftId, documentId, profile, source]);
    await db.query("INSERT INTO wk_review_assets(id,tenant_id,profile_id,image_hash,crop_hash,payload,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [asset.id, tenantId, profileId, asset.imageHash, asset.cropHash, asset, owner.actorId]);
    await db.query("INSERT INTO wk_review_asset_heads(tenant_id,profile_id,asset_id) VALUES($1,$2,$3)", [tenantId, profileId, asset.id]);
    await saveRevision(db, tenantId, { kit, certificate, profiles, sources });
    await db.query("UPDATE wk_kits SET current_revision_id=$2 WHERE id=$1", [kit.kitId, kit.id]);
  });
  const command = (actor: ReviewAccess, body: object) => engineeringCommand(actor, { requestId: randomUUID(), ...body });
  const opened = await command(owner, { kind: "create", candidateId, kitId: kit.kitId, expectedRevisionId: kit.id, expectedGraphHash: certificate.graphHash, provenance: "sample" });
  let detail = await engineeringDetail(owner, opened.proposalId);
  const content: ProposalContent = initialContent(profile, draft);
  content.scope = { ...content.scope, firmware: "1.0 (Sample)", os: "Sample OS 1", application: "Sample Stream 1", conditions: ["48,000 Hz", "Entire review is a fictional software exercise"] };
  const { sourceId: _sourceId, ...span } = anchor;
  content.claims[0] = { ...content.claims[0]!, value: true, evidence: [span], rationale: "Exact fictional variant named in the sample text." };
  for (const [id, label, x, y, connector, direction, signal, protocols, channels, power, resource] of [
    ["input-a", "INPUT A", 0.2625, 0.645833, "XLR", "in", "audio", "analog_audio", 1, 0, "mic-input"],
    ["usb", "USB", 0.73375, 0.634375, "USB-C", "bidirectional", "data", "usb_audio", 2, 1, "usb-bus"],
  ] as const) {
    const fields = { connector: "", direction: "", signal: "", protocols: "", channels: "", power: "", resource: "" };
    for (const [field, value] of Object.entries({ connector, direction, signal, protocols, channels, power, resource })) {
      const claim: EngineeringClaim = { id: `${id}-${field}`, target: `port:${id}`, predicate: `port:${field}`, value, unit: field === "power" ? "W" : field === "channels" ? "count" : null, conditions: ["Fictional sample port"], category: "port", critical: true, originalAssertionId: null, evidence: [span], rationale: "Source-bound Sample field for the software review fixture." };
      content.claims.push(claim); fields[field as keyof typeof fields] = claim.id;
    }
    content.ports.push({ id, label, fields, anchor: { kind: "image", assetId: asset.id, imageHash: asset.imageHash, cropHash: asset.cropHash, x, y, facing: "front", labelSide: "below" } });
  }
  content.portMapDeclaredComplete = true;
  await command(owner, { kind: "revise", proposalId: opened.proposalId, expectedVersion: detail.edition.version, expectedHash: detail.edition.hash, content, reason: "Added exact fictional port fields, conditions and source anchors for software qualification.", rebase: false });
  detail = await engineeringDetail(owner, opened.proposalId);
  async function addActor(name: string, role: "reader" | "editor" | "reviewer" | "adjudicator" = "adjudicator", provenance: "human" | "sample" = "sample") {
    const actor = await command(owner, { kind: "register_actor", name, provenance });
    const invitation = await command(owner, { kind: "invite", actorId: actor.actorId, role, kitId: kit.kitId, profileId, documentId, expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const redeemed = await redeemInvitation(invitation.token);
    return { actorId: actor.actorId as string, invitation, ...redeemed };
  }
  return { ...created, owner, profileId, candidateId, documentId, draftId, source, document, text, asset, kit, certificate, profile, draft, content, proposalId: opened.proposalId as string, detail, command, addActor };
}

export async function acceptTargets(access: ReviewAccess, detail: ReviewDetail, exclude: string[] = []) {
  for (const target of detail.assessment.targets.filter(target => !exclude.includes(target.id))) await engineeringCommand(access, { kind: "decide", requestId: randomUUID(), proposalId: detail.edition.proposalId, expectedVersion: detail.edition.version, expectedHash: detail.edition.hash, targetId: target.id, outcome: "accept", reason: "Sample software decision against the exact fictional passage and edition; not actual human review." });
}

export async function sourceSnapshot(tenantId: string) {
  const result = await database().query("SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM wk_revisions r WHERE r.tenant_id=$1) AS revisions,(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM wk_source_drafts d WHERE d.tenant_id=$1) AS drafts,(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM wk_source_profile_versions v WHERE v.tenant_id=$1) AS candidates", [tenantId]);
  return hash(result.rows[0]);
}
