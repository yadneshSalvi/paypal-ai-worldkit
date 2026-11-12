import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { WorldKitError } from "../../packages/contracts";
import { hash } from "../../packages/compatibility";
import { BenchRedeemSchema, type BenchAccess, type BenchBinding, type BenchEdition, type BenchGrant } from "../../packages/physical-notebook/contracts";
import type { Qualification } from "../../packages/engineering-review/contracts";
import { database, transaction } from "./db";
import { initializePhysicalNotebook } from "./physical-notebook-db";
import { seal, unseal } from "./secrets";
import type { Session } from "./repository";

export type BenchRow = Record<string, any>;
export const benchIso = (value: string | Date) => new Date(value).toISOString();
export const benchDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function benchFail(message: string, code: "forbidden" | "not_found" | "stale_revision" | "needs_evidence" | "invalid_request" = "forbidden", status = code === "not_found" ? 404 : code === "stale_revision" ? 409 : code === "needs_evidence" ? 422 : code === "invalid_request" ? 400 : 403): never { throw new WorldKitError(code, message, status); }
export const ownerBenchAccess = (session: Session): BenchAccess => ({ tenantId: session.id, actorId: session.id, kind: "owner", grantId: null });
export async function benchEvent(db: PoolClient, access: BenchAccess, runId: string, kind: string, summary: string, payload: unknown = {}) {
  await db.query("INSERT INTO wk_bench_events(id,run_id,tenant_id,actor_id,kind,summary,payload) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), runId, access.tenantId, access.actorId, kind, summary, payload]);
}

export async function benchActor(db: PoolClient, tenantId: string, actorId: string): Promise<BenchRow | null> {
  return (await db.query("SELECT a.*,q.payload AS qualification,q.identity_hash AS qualification_identity,q.actor_id AS qualified_actor,q.evidence_hash AS qualification_evidence,i.identity_hash AS registered_identity FROM wk_review_actors a LEFT JOIN wk_review_qualifications q ON q.id=a.qualification_id AND q.actor_id=a.id AND q.tenant_id=a.tenant_id LEFT JOIN wk_review_identities i ON i.actor_id=a.id AND i.tenant_id=a.tenant_id WHERE a.id=$1 AND a.tenant_id=$2", [actorId, tenantId])).rows[0] ?? null;
}
function currentQualification(actor: BenchRow | null, expertise: string[]): Qualification | null {
  const q = actor?.qualification as Qualification | undefined;
  if (!actor || actor.revoked_at || actor.provenance !== "human" || !q || q.provenance !== "human" || q.id !== actor.qualification_id || q.actorId !== actor.id || actor.qualified_actor !== actor.id || q.identityHash !== actor.qualification_identity || q.identityHash !== actor.registered_identity || q.evidenceHash !== actor.qualification_evidence || !/^[a-f0-9]{64}$/.test(q.identityHash) || !/^[a-f0-9]{64}$/.test(q.evidenceHash) || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= Date.now() || !Array.isArray(q.expertise) || !expertise.every(value => q.expertise.includes(value as Qualification["expertise"][number]))) return null;
  return q;
}
export async function benchPrincipal(db: PoolClient, access: BenchAccess, binding: BenchBinding) {
  const actor = await benchActor(db, access.tenantId, access.actorId);
  if (!actor) benchFail("This reviewer identity is unavailable.");
  if (actor.revoked_at) return { actor, qualified: false, principalHash: null, qualificationId: null, reason: "This reviewer identity has been revoked; its historical decisions remain retained." };
  if (actor.provenance === "sample") return { actor, qualified: false, principalHash: hash(["sample-physical-reviewer", actor.id]), qualificationId: null as string | null, reason: "A Sample reviewer never counts as an actual human review." };
  const expertise = binding.steps.some(step => step.id === "simultaneous" && step.required) ? ["engineering", "simultaneous"] : ["engineering"];
  const reviewer = currentQualification(actor, expertise);
  const creator = currentQualification(await benchActor(db, access.tenantId, access.tenantId), ["identity"]);
  const independent = !!reviewer && !!creator && reviewer.identityHash !== creator.identityHash;
  return { actor, qualified: independent, principalHash: reviewer ? hash(["physical-review-principal", reviewer.identityHash]) : null, qualificationId: reviewer?.id ?? null, reason: !reviewer ? "An operator must independently establish this person's current identity and relevant engineering qualification; an invitation is insufficient." : !creator ? "The report creator's identity must be independently established before reviewer independence can be counted." : !independent ? "The creator cannot independently review their own report through a different invitation." : "Current independently established identity and relevant engineering qualification." };
}

/** Serialize every command and read with workspace revocation; use wall time after waits. */
export async function authorizeBench(db: PoolClient, access: BenchAccess, runId?: string, purpose: "read" | "owner" | "review" = "read") {
  const session = (await db.query("SELECT id,expires_at FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE", [access.tenantId])).rows[0];
  if (!session || Date.parse(benchIso(session.expires_at)) <= Date.now()) benchFail("This private workspace has expired.");
  if (access.kind === "owner") {
    if (access.actorId !== access.tenantId || access.grantId || purpose === "review") benchFail("The creator cannot submit an independent reviewer decision.");
    return { expiresAt: benchIso(session.expires_at), grant: null as BenchRow | null, actor: null as BenchRow | null };
  }
  if (purpose === "owner" || !access.grantId) benchFail("This invitation does not permit creator actions.");
  const grant = (await db.query("SELECT g.* FROM wk_bench_grants g JOIN wk_review_actors a ON a.id=g.actor_id AND a.tenant_id=g.tenant_id JOIN wk_bench_editions e ON e.id=g.edition_id AND e.run_id=g.run_id AND e.tenant_id=g.tenant_id WHERE g.id=$1 AND g.tenant_id=$2 AND g.actor_id=$3 AND g.status='active' AND g.expires_at>clock_timestamp() AND a.revoked_at IS NULL AND a.kind='specialist' AND e.content_hash=g.edition_hash AND e.payload->>'phase'='sealed'", [access.grantId, access.tenantId, access.actorId])).rows[0];
  if (!grant || Date.parse(benchIso(grant.expires_at)) <= Date.now() || runId && runId !== grant.run_id) benchFail("This review access has ended or does not cover that report.", runId ? "not_found" : "forbidden");
  return { expiresAt: benchIso(new Date(Math.min(new Date(session.expires_at).getTime(), new Date(grant.expires_at).getTime()))), grant: grant as BenchRow, actor: await benchActor(db, access.tenantId, access.actorId) };
}
export async function benchRun(db: PoolClient, access: BenchAccess, runId: string, lock = false): Promise<{ row: BenchRow; edition: BenchEdition }> {
  const found = (await db.query(`SELECT r.*,e.payload AS edition FROM wk_bench_runs r JOIN wk_bench_editions e ON e.id=r.current_edition_id AND e.run_id=r.id AND e.tenant_id=r.tenant_id WHERE r.id=$1 AND r.tenant_id=$2 ${lock ? "FOR UPDATE OF r" : ""}`, [runId, access.tenantId])).rows[0];
  if (!found) benchFail("That report is outside this private workspace.", "not_found");
  if (access.kind === "reviewer") {
    const auth = await authorizeBench(db, access, runId);
    if (found.current_edition_id !== auth.grant!.edition_id || found.edition.hash !== auth.grant!.edition_hash) benchFail("This invitation covers a different exact manifest.", "not_found");
  }
  return { row: found, edition: found.edition as BenchEdition };
}
export async function authenticateBenchReviewer(token?: string): Promise<BenchAccess | null> {
  if (!token || !/^wkbr_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  await initializePhysicalNotebook();
  const row = (await database().query("SELECT g.id,g.tenant_id,g.actor_id FROM wk_bench_grants g JOIN wk_sessions s ON s.id=g.tenant_id JOIN wk_review_actors a ON a.id=g.actor_id AND a.tenant_id=g.tenant_id WHERE g.credential_hash=$1 AND g.status='active' AND g.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND a.revoked_at IS NULL", [benchDigest(token)])).rows[0];
  return row ? { tenantId: row.tenant_id, actorId: row.actor_id, kind: "reviewer", grantId: row.id } : null;
}
export async function benchGrantDto(db: PoolClient, row: BenchRow, binding: BenchBinding): Promise<BenchGrant> {
  const principal = await benchPrincipal(db, { tenantId: row.tenant_id, actorId: row.actor_id, kind: "reviewer", grantId: row.id }, binding);
  return { id: row.id, runId: row.run_id, editionId: row.edition_id, editionHash: row.edition_hash, actorId: row.actor_id, name: principal.actor.name, provenance: principal.actor.provenance, role: "reviewer", version: row.version, expiresAt: benchIso(row.expires_at), status: row.status,
    qualification: principal.actor.provenance === "sample" ? "sample" : principal.qualified ? "current" : principal.actor.qualification && Date.parse(principal.actor.qualification.expiresAt) <= Date.now() ? "expired" : "unestablished" };
}
export async function createBenchGrant(db: PoolClient, access: BenchAccess, edition: BenchEdition, input: { actorId: string | null; name: string; provenance: "sample" | "human"; hours: number }) {
  const auth = await authorizeBench(db, access, edition.runId, "owner");
  if (edition.phase !== "sealed") benchFail("Seal an exact manifest before inviting a reviewer.", "needs_evidence");
  let actor: BenchRow | null;
  if (input.actorId) {
    actor = await benchActor(db, access.tenantId, input.actorId);
    if (!actor || actor.kind !== "specialist" || actor.revoked_at || actor.provenance !== input.provenance || actor.name !== input.name) benchFail("Select the current exact reviewer identity.", "not_found");
  } else {
    const actorId = randomUUID();
    await db.query("INSERT INTO wk_review_actors(id,tenant_id,name,kind,provenance) VALUES($1,$2,$3,'specialist',$4)", [actorId, access.tenantId, input.name, input.provenance]);
    actor = await benchActor(db, access.tenantId, actorId);
  }
  const id = randomUUID(), invitation = `wkbi_${randomBytes(32).toString("base64url")}`;
  const expires = new Date(Math.min(Date.parse(auth.expiresAt), Date.now() + input.hours * 3_600_000)).toISOString();
  const row = (await db.query("INSERT INTO wk_bench_grants(id,run_id,tenant_id,edition_id,edition_hash,actor_id,invite_hash,invite_sealed,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'invited',$9) RETURNING *", [id, edition.runId, access.tenantId, edition.id, edition.hash, actor!.id, benchDigest(invitation), seal(`physical-invitation:${access.tenantId}:${id}`, { invitation }), expires])).rows[0];
  await benchEvent(db, access, edition.runId, "reviewer.invited", "An invitation covers only this sealed manifest and its permitted original files. It establishes no real-world identity or qualification.", { grantId: id, editionId: edition.id, editionHash: edition.hash, provenance: input.provenance, expiresAt: expires });
  return { ...await benchGrantDto(db, row, edition.binding), invitation };
}
export async function redeemBenchInvitation(value: unknown) {
  const input = BenchRedeemSchema.parse(value); await initializePhysicalNotebook();
  const invitationHash = benchDigest(input.invitation), inputHash = hash(input);
  return transaction(async db => {
    const found = (await db.query("SELECT id,tenant_id FROM wk_bench_grants WHERE invite_hash=$1", [invitationHash])).rows[0];
    if (!found) benchFail("This invitation is unavailable.", "not_found");
    const session = (await db.query("SELECT expires_at FROM wk_sessions WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE", [found.tenant_id])).rows[0];
    if (!session) benchFail("This invitation has expired.", "not_found");
    const row = (await db.query("SELECT g.* FROM wk_bench_grants g JOIN wk_review_actors a ON a.id=g.actor_id AND a.tenant_id=g.tenant_id WHERE g.id=$1 AND g.expires_at>clock_timestamp() AND a.revoked_at IS NULL FOR UPDATE OF g", [found.id])).rows[0];
    if (!row || row.status === "revoked") benchFail("This invitation is unavailable.", "not_found");
    const scope = `physical-credential:${row.tenant_id}:${row.id}`;
    if (row.status === "active") {
      if (row.redeem_request_id !== input.requestId || row.redeem_input_hash !== inputHash) benchFail("This invitation has already been redeemed.", "stale_revision");
      await authorizeBench(db, { tenantId: row.tenant_id, actorId: row.actor_id, kind: "reviewer", grantId: row.id }, row.run_id);
      return { ...unseal<{ credential: string }>(scope, row.credential_sealed), expiresAt: benchIso(row.expires_at), runId: row.run_id };
    }
    const credential = `wkbr_${randomBytes(32).toString("base64url")}`;
    await db.query("UPDATE wk_bench_grants SET status='active',version=version+1,credential_hash=$2,credential_sealed=$3,redeem_request_id=$4,redeem_input_hash=$5,redeemed_at=clock_timestamp() WHERE id=$1", [row.id, benchDigest(credential), seal(scope, { credential }), input.requestId, inputHash]);
    const access: BenchAccess = { tenantId: row.tenant_id, actorId: row.actor_id, kind: "reviewer", grantId: row.id };
    await benchEvent(db, access, row.run_id, "reviewer.redeemed", "The invitation was exchanged for scoped private review access; it confers no qualification.", { grantId: row.id, editionId: row.edition_id });
    await authorizeBench(db, access, row.run_id);
    return { credential, expiresAt: benchIso(row.expires_at), runId: row.run_id };
  });
}
