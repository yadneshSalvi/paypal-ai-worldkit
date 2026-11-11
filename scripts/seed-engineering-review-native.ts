import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { seedEngineeringFixture, acceptTargets } from "../tests/support/engineering-review-fixture";
import { requireIsolatedDatabase } from "../tests/support/isolated-database";
import { closeDatabase, database } from "../src/server/db";
import { engineeringDetail } from "../src/server/engineering-review";

requireIsolatedDatabase();
assert.equal(process.env.WORLDKIT_QA_MODE, "engineering");
assert.equal(process.env.WORLDKIT_DISABLE_PROVIDERS, "true");
const path = ".local/engineering-review-qa/native-private.json", origin = "http://127.0.0.1:4532";
const existing = await readFile(path, "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return null; });
if (existing) { console.log("Existing native fixtures retained. No deadline or record was reset."); process.exit(0); }
const cookie = (name: string, value: string, expiresAt: string) => ({ name, value, origin, path: "/", httpOnly: true, sameSite: "Strict", secure: false, expiresAt });
try {
  const review = await seedEngineeringFixture(), edit = await seedEngineeringFixture(), stale = await seedEngineeringFixture();
  const a = await review.addActor("Sample Alex · first reviewer"), b = await review.addActor("Sample Blake · dissenting reviewer"), c = await review.addActor("Sample Casey · adjudicator");
  await acceptTargets(a.access, review.detail);
  await review.command(b.access, { kind: "decide", proposalId: review.proposalId, expectedVersion: review.detail.edition.version, expectedHash: review.detail.edition.hash, targetId: "claim-2", outcome: "reject", reason: "Sample disagreement: confirm the stated firmware and USB recording mode against the exact fictional source. This is software rehearsal, not human engineering evidence." });
  const pendingActor = await review.command(review.owner, { kind: "register_actor", name: "Sample Drew · invited reader", provenance: "sample" });
  const invitation = await review.command(review.owner, { kind: "invite", actorId: pendingActor.actorId, role: "reader", kitId: review.kit.kitId, profileId: review.profileId, documentId: review.documentId, expiresAt: new Date(Date.now() + 6 * 3600000).toISOString() });
  await database().query("UPDATE wk_source_heads SET version=version+1 WHERE tenant_id=$1", [stale.session.id]);
  const final = await engineeringDetail(review.owner, review.proposalId);
  assert.equal(final.assessment.state, "conflicted"); assert.equal(final.assessment.actualReviewed, 0); assert.equal(final.assessment.physicalTests, 0);
  const bundle = {
    schema: "worldkit.engineering-native-private.1", createdAt: new Date().toISOString(), origin, provenance: "sample", actualHumanReviews: 0, physicalTests: 0,
    review: { url: `${origin}/review?proposal=${review.proposalId}`, proposalId: review.proposalId, editionId: final.edition.id, editionHash: final.edition.hash, simultaneousTarget: "claim-2", owner: cookie("wk_engineering_qa", review.token, review.session.expiresAt),
      reviewers: [{ label: "Alex — all first reviews recorded", ...a }, { label: "Blake — recorded rejection; first adjudication pending", ...b }, { label: "Casey — second adjudication pending", ...c }].map(actor => ({ label: actor.label, actorId: actor.actorId, capabilityId: actor.access.capabilityId, cookie: cookie("wk_engineering_reviewer_qa", actor.credential, actor.expiresAt) })),
      unusedInvitation: { url: `${origin}/review/join#invitation=${invitation.token}`, actorId: pendingActor.actorId, capabilityId: invitation.capabilityId, expiresAt: invitation.expiresAt } },
    edit: { url: `${origin}/review?proposal=${edit.proposalId}`, proposalId: edit.proposalId, editionId: edit.detail.edition.id, editionHash: edit.detail.edition.hash, owner: cookie("wk_engineering_qa", edit.token, edit.session.expiresAt), firstPortId: "input-a", initialAnchor: { x: .2625, y: .645833 }, sourceSelection: { page: 1, start: 0, end: 75 }, expectedSourceHash: edit.document.contentHash },
    stale: { url: `${origin}/review?proposal=${stale.proposalId}`, proposalId: stale.proposalId, editionHash: stale.detail.edition.hash, owner: cookie("wk_engineering_qa", stale.token, stale.session.expiresAt), expectedState: "stale", reason: "A newer source head version must require an explicit fresh edition binding." },
    protocol: "See docs/ENGINEERING_REVIEW.md. Use only these isolated cookies, clear the specialist cookie before creator steps, and never copy this private file into a report or commit.",
  };
  await writeFile(path, JSON.stringify(bundle, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Prepared three isolated native fixtures: disagreement/adjudication, source-and-anchor editing, stale-source recovery. Credentials are in the ignored 0600 native-private.json only. Actual human review and physical tests remain zero.");
} finally { await closeDatabase(); }
