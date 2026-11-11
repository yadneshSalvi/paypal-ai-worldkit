import { createHash } from "node:crypto";
import { hash } from "../compatibility";
import { WorldKitError } from "../contracts";
import type { ExtractionDraft } from "../spec-evidence/contracts";
import type { SourceDocument } from "../spec-evidence/sources";
import type { EngineeringClaim, ProposalContent, ReviewAsset, ReviewAssessment, ReviewDecision, ReviewEdition, TargetAssessment } from "./contracts";

export const simultaneous = (claim: Pick<EngineeringClaim, "category" | "predicate">) => claim.category === "simultaneous" || /simultaneous|whilestreaming|concurrent|maxSimultaneous/i.test(claim.predicate);
export const digestText = (text: string) => createHash("sha256").update(text).digest("hex");
export function validAnchors(claim: EngineeringClaim, document: SourceDocument): boolean {
  return claim.evidence.length > 0 && claim.evidence.every(anchor => {
    const page = document.pages.find(page => page.number === anchor.page);
    return page && Number.isSafeInteger(anchor.start) && Number.isSafeInteger(anchor.end) && anchor.start >= 0 && anchor.contentHash === document.contentHash && anchor.textHash === document.textHash && anchor.end > anchor.start && anchor.end <= page.text.length &&
      digestText(page.text.slice(anchor.start, anchor.end)) === anchor.excerptHash;
  });
}

/** A draft may be corrected, but no critical source obligation can be erased or downgraded. */
export function validateContent(content: ProposalContent, draft: ExtractionDraft, document: SourceDocument, candidate: { manufacturer: string; model: string; variant: string }, asset: ReviewAsset | null) {
  function fail(message: string): never { throw new WorldKitError("needs_evidence", message, 422); }
  if (["manufacturer", "model", "variant"].some(key => content.scope[key as keyof typeof candidate] !== candidate[key as keyof typeof candidate])) fail("The exact manufacturer, model and variant must match this source candidate. Related manuals cannot approve it.");
  if (new Set(content.claims.map(claim => claim.id)).size !== content.claims.length || new Set(content.ports.map(port => port.id)).size !== content.ports.length) fail("Claim and port identities must be unique and stable within an edition.");
  const originalIds = content.claims.flatMap(claim => claim.originalAssertionId ? [claim.originalAssertionId] : []);
  if (new Set(originalIds).size !== originalIds.length) fail("An extraction assertion can have only one correction in an edition.");
  const properties = content.claims.map(claim => `${claim.target}:${claim.predicate}`);
  if (new Set(properties).size !== properties.length) fail("Two values for the same predicate are a conflict. Retain the disagreement in review history and propose one exact correction.");
  for (const original of draft.facts) {
    const claim = content.claims.find(claim => claim.originalAssertionId === original.assertionId);
    if (original.critical && (!claim || !claim.critical || claim.predicate !== original.property || claim.target !== "device")) fail(`The critical extraction obligation ${original.property} must remain explicit, including when its value is unknown.`);
  }
  for (const claim of content.claims) {
    if (claim.originalAssertionId && !draft.facts.some(fact => fact.assertionId === claim.originalAssertionId && fact.property === claim.predicate)) fail("A correction must retain the exact original assertion and predicate.");
    if (simultaneous(claim) && !claim.critical) fail("Simultaneous-mode claims are always critical and require two independent reviewers.");
    if (claim.evidence.length && !validAnchors(claim, document)) fail(`The source spans for ${claim.predicate} no longer match the exact document and normalized text.`);
  }
  const identity = content.claims.find(claim => claim.id === "model-identity");
  if (!identity || identity.category !== "identity" || identity.predicate !== "modelIdentity" || identity.target !== "device" || !identity.critical || ![true, null].includes(identity.value as true | null)) fail("Keep the required exact-model and variant identity assertion.");
  for (const port of content.ports) {
    for (const [field, id] of Object.entries(port.fields)) {
      if (!id) continue;
      const claim = content.claims.find(claim => claim.id === id);
      if (!claim || claim.target !== `port:${port.id}` || claim.predicate !== `port:${field}` || claim.category !== "port" || !claim.critical) fail(`${port.label}: ${field} needs its own critical, port-bound assertion.`);
      const value = claim.value;
      if (value !== null && ((field === "channels" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 512)) ||
        (field === "direction" && !["in", "out", "bidirectional"].includes(String(value))) ||
        (field === "signal" && !["audio", "video", "data", "power"].includes(String(value))) ||
        (field === "power" && (typeof value !== "number" || value < 0 || claim.unit !== "W")) ||
        (["connector", "protocols", "resource"].includes(field) && (typeof value !== "string" || !value.trim())))) fail(`${port.label}: ${field} has an incompatible typed value or unit.`);
    }
    if (port.anchor.kind === "image" && (!asset || !asset.available || !asset.current || port.anchor.assetId !== asset.id || port.anchor.imageHash !== asset.imageHash || port.anchor.cropHash !== asset.cropHash)) fail("This port anchor belongs to another image or crop. Select the current approved image and review its coordinates again.");
  }
}

export const decisionSetHash = (decisions: ReviewDecision[]) => hash(decisions.filter(decision => decision.kind === "review").map(({ id, actorId, outcome, editionHash, targetId }) => ({ id, actorId, outcome, editionHash, targetId })).sort((a, b) => a.id.localeCompare(b.id)));

export function reviewAssessment(edition: ReviewEdition, decisions: ReviewDecision[], stale: string[] = []): ReviewAssessment {
  const used = new Set(edition.content.ports.flatMap(port => Object.values(port.fields).filter((id): id is string => Boolean(id))));
  const targets = [...edition.content.claims.map(claim => ({ id: claim.id, label: claim.predicate, required: simultaneous(claim) || edition.disputedPredicates.includes(`${claim.target}:${claim.predicate}`) ? 2 : 1, blocking: claim.critical || used.has(claim.id) || edition.disputedPredicates.includes(`${claim.target}:${claim.predicate}`), known: claim.value !== null && claim.evidence.length > 0 })),
    { id: "$port-map", label: "Complete port map, conditions and image anchors", required: edition.disputedPredicates.includes("$port-map") ? 2 : 1, blocking: true, known: edition.content.portMapDeclaredComplete && edition.content.ports.every(port => ["connector", "direction", "signal", "protocols", "channels", "power", "resource"].every(field => Boolean(port.fields[field as keyof typeof port.fields]))) }];
  const assessments: TargetAssessment[] = targets.map(target => {
    const all = decisions.filter(decision => decision.editionId === edition.id && decision.editionHash === edition.hash && decision.targetId === target.id);
    const current = all.filter(decision => decision.active && !edition.authors.includes(decision.actorId) && !edition.authorIdentities.some(author => author.identityHash === decision.principalHash) && decision.qualification.provenance === edition.provenance);
    const setHash = decisionSetHash(all);
    const reviews = current.filter(decision => decision.kind === "review");
    const outcomes = new Set(reviews.map(decision => decision.outcome));
    const hasDispute = new Set(all.filter(decision => decision.kind === "review").map(decision => decision.outcome)).size > 1;
    // A later vote never erases a recorded disagreement. Resolution is a separate,
    // exact-set-bound two-principal adjudication, even for a noncritical claim.
    const adjudications = current.filter(decision => decision.kind === "adjudication" && decision.decisionSetHash === setHash);
    const relevant = hasDispute ? adjudications : reviews;
    const required = hasDispute ? Math.max(2, target.required) : target.required;
    const accepted = new Set(relevant.filter(decision => decision.outcome === "accept").map(decision => decision.principalHash)).size;
    let status: TargetAssessment["status"] = "pending";
    let reason = `${required} distinct qualified ${hasDispute ? "adjudicators" : "reviewers"} required.`;
    if (hasDispute && (adjudications.length < required || new Set(adjudications.map(decision => decision.outcome)).size > 1)) { status = "conflicted"; reason = "The recorded disagreement needs two matching adjudications of this exact decision set."; }
    else if (relevant.some(decision => decision.outcome === "reject")) { status = "rejected"; reason = "A reviewer rejected this assertion. Correct it in a new edition or resolve the recorded disagreement."; }
    else if (relevant.some(decision => decision.outcome === "unresolved")) { status = "unresolved"; reason = "A reviewer left an explicit unresolved condition. New evidence and a new edition are needed."; }
    else if (!target.known) { status = "unresolved"; reason = "A typed value, exact source span or complete port field is missing; a vote cannot supply it."; }
    else if (accepted >= required) { status = "accepted"; reason = edition.provenance === "sample" ? "Sample decisions satisfy the software policy; actual human review remains zero." : "The current qualified principals accepted this exact assertion and its conditions."; }
    else if (outcomes.size > 1) { status = "conflicted"; }
    return { ...target, blocking: target.blocking || all.some(decision => decision.outcome !== "accept"), status, reason, accepted, required, decisionSetHash: setHash, activeReviewers: [...new Set(relevant.map(decision => decision.actorName))] };
  });
  const blockers = [...stale, ...(edition.provenance === "human" && edition.authorIdentities.some(author => !author.identityHash || !author.qualificationId) ? ["The author’s real-world identity must be independently established before actual human review can count."] : []), ...assessments.filter(target => target.blocking && target.status !== "accepted").map(target => `${target.label}: ${target.reason}`)];
  return { eligible: blockers.length === 0, state: stale.length ? "stale" : assessments.some(target => target.status === "conflicted") ? "conflicted" : blockers.length ? "incomplete" : "ready", targets: assessments,
    actualReviewed: edition.provenance === "human" ? assessments.filter(target => target.status === "accepted").length : 0,
    sampleReviewed: edition.provenance === "sample" ? assessments.filter(target => target.status === "accepted").length : 0, physicalTests: 0, blockers };
}

export function initialContent(profile: { manufacturer: string; model: string; variant: string }, draft: ExtractionDraft): ProposalContent {
  return { scope: { manufacturer: profile.manufacturer, model: profile.model, variant: profile.variant, firmware: "Unknown — review required", os: "Unknown — review required", application: "Unknown — review required", conditions: [] },
    claims: [{ id: "model-identity", predicate: "modelIdentity", target: "device", value: null, unit: null, conditions: [], category: "identity", critical: true, originalAssertionId: null, evidence: [], rationale: "Confirm that this document establishes the exact model, variant and selected operating scope." }, ...draft.facts.map((fact, index): EngineeringClaim => ({ id: `claim-${index + 1}`, predicate: fact.property, target: "device", value: fact.value, unit: fact.unit, conditions: fact.conditions, category: simultaneous({ category: "fact", predicate: fact.property }) ? "simultaneous" : "fact", critical: fact.critical || simultaneous({ category: "fact", predicate: fact.property }), originalAssertionId: fact.assertionId, evidence: fact.evidence.map(({ sourceId: _sourceId, ...anchor }) => anchor), rationale: fact.explanation }))], ports: [], portMapDeclaredComplete: false, notes: "Extraction proposals remain unchanged. This edition is a separate engineering review." };
}
