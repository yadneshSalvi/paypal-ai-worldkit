import { randomUUID } from "node:crypto";
import { hash } from "../../packages/compatibility";
import type { DeviceProfile } from "../../packages/contracts";
import type { InventoryItem } from "../../packages/inventory/contracts";
import { sampleSynthesisInput } from "../../packages/synthesis/sample";
import type { ComparisonDetail, OfferObservation, SynthesisInput } from "../../packages/synthesis/contracts";
import { verifySystem } from "../../packages/synthesis/validation";
import { database, transaction } from "../../src/server/db";
import { createSession, getRevision, saveRevision } from "../../src/server/repository";
import { initializeSynthesis } from "../../src/server/synthesis-db";
import { synthesisCommand, synthesisHome, synthesisOwner } from "../../src/server/synthesis";
import { requireIsolatedDatabase } from "./isolated-database";

/** CLI/tests only: this fixture can never be created by a product API. Every
 * identity, price and premise is explicitly fictional. Earlier rows survive. */
export async function seedSynthesisFixture(options: { budgetMinor?: number; tracks?: number; name?: string; missingEvidence?: boolean } = {}) {
  requireIsolatedDatabase(); await initializeSynthesis();
  const created = await createSession(), previous = await getRevision(created.session.id);
  const input = sampleSynthesisInput(new Date().toISOString(), previous.kit.kitId, randomUUID());
  input.base.kit.revision = previous.kit.revision + 1; input.base.kit.parentRevisionId = previous.kit.id;
  if (options.budgetMinor !== undefined) {
    input.base.kit.goal.budgetMinor = options.budgetMinor;
    const requirement = input.base.kit.goal.requirements.find(value => value.kind === "budget")!;
    requirement.target = options.budgetMinor; requirement.label = `New equipment under $${(options.budgetMinor / 100).toFixed(2)}`;
  }
  if (options.tracks !== undefined) {
    const requirement = input.base.kit.goal.requirements.find(value => value.kind === "isolated_tracks")!;
    requirement.target = options.tracks; requirement.label = `${options.tracks} separate microphone tracks`;
  }
  if (options.name) input.base.kit.goal.title = options.name;
  input.base.kit.goal.brief = `Fictional Sample equipment and offers: ${options.tracks ?? 2} separate microphone tracks, a camera stream and monitoring. Keep the Sample camera, tablet and headphones. Equipment budget $${(input.base.kit.goal.budgetMinor / 100).toFixed(2)}. No physical test or human review.`;
  if (options.missingEvidence) {
    const host = input.profiles.find(profile => profile.kind === "host")!;
    host.facts.exactAppHardwareSupport!.value = null; host.facts.exactAppHardwareSupport!.state = "unknown";
    const saved = input.base.profiles.find(profile => profile.id === host.id)!;
    Object.assign(saved, structuredClone(host));
    input.offers = input.offers.map(offer => offer.profileId === host.id ? { ...offer, profileHash: hash(host) } : offer);
  }
  input.base.certificate = verifySystem(input.base.kit, input).certificate;
  await transaction(async db => {
    await saveRevision(db, created.session.id, input.base);
    await db.query("UPDATE wk_kits SET current_revision_id=$1 WHERE id=$2 AND tenant_id=$3", [input.base.kit.id, previous.kit.kitId, created.session.id]);
    await db.query("INSERT INTO wk_synthesis_sample_catalogs(id,tenant_id,payload) VALUES($1,$2,$3)", [randomUUID(), created.session.id, { profiles: input.profiles, sources: input.sources, provenance: "Fictional Sample, no actual reviews or physical observations" }]);
    for (const offer of input.offers) await db.query("INSERT INTO wk_synthesis_observations(id,tenant_id,payload) VALUES($1,$2,$3)", [randomUUID(), created.session.id, offer]);
  });
  const owner = synthesisOwner(created.session);
  const compare = async () => {
    const current = await getRevision(created.session.id);
    const result = await synthesisCommand(owner, { kind: "compare", requestId: randomUUID(), expectedRevisionId: current.kit.id, expectedGraphHash: current.certificate.graphHash });
    return (await synthesisHome(owner, result.editionId)).current!;
  };
  return { ...created, previous, input, owner, compare };
}
export const expectedChoice = (detail: ComparisonDetail) => ({ editionId: detail.edition.id, expectedEditionHash: detail.edition.hash, expectedChoiceVersion: detail.choice.version });
export async function appendSampleObservation(tenantId: string, observation: OfferObservation) {
  requireIsolatedDatabase();
  await database().query("INSERT INTO wk_synthesis_observations(id,tenant_id,payload) VALUES($1,$2,$3)", [randomUUID(), tenantId, observation]);
}
export function inventoryFixture(profile: DeviceProfile, quantity = 1): InventoryItem {
  const at = new Date().toISOString();
  return { id: randomUUID(), version: 1, profile, ownership: "owned", quantity, condition: "used", accessories: [], notes: "Fictional isolated synthesis fixture", status: "active", origin: "manual", snapshotId: null, photoId: null, regionId: null, confirmedAt: at, createdAt: at, updatedAt: at };
}
export async function appendSampleCatalog(tenantId: string, input: SynthesisInput) {
  requireIsolatedDatabase();
  await database().query("INSERT INTO wk_synthesis_sample_catalogs(id,tenant_id,payload) VALUES($1,$2,$3)", [randomUUID(), tenantId, { profiles: input.profiles, sources: input.sources, provenance: "Fictional Sample edition; no actual reviews" }]);
}
export const financialTables = ["wk_commerce_orders", "wk_quotes", "wk_wallet_consents", "wk_vault_operations", "wk_repair_policies", "wk_repair_claims", "wk_financial_authorities", "wk_payment_resources", "wk_kit_commitments", "wk_kit_commitment_versions", "wk_kit_amendments", "wk_kit_repair_policies", "wk_kit_repair_claims", "wk_kit_compensations", "wk_kit_repair_outbox", "wk_kit_sample_payments", "wk_provider_receipts", "wk_source_model_requests", "wk_source_model_observations", "paycore_operations", "paycore_attempts", "paycore_webhook_events", "paycore_webhook_deliveries"];
export async function preservationSnapshot(tenantId: string) {
  const tables: Record<string, { count: number; hash: string }> = {};
  for (const table of financialTables) {
    const exists = (await database().query("SELECT to_regclass($1) AS name", [table])).rows[0].name;
    const filter = table === "wk_source_model_observations" ? "operation_id IN (SELECT operation_id FROM wk_source_model_requests WHERE tenant_id=$1)" : "tenant_id=$1";
    const rows = exists ? (await database().query(`SELECT to_jsonb(r) AS value FROM ${table} r WHERE ${filter} ORDER BY to_jsonb(r)::text`, [tenantId])).rows.map(value => value.value) : [];
    tables[table] = { count: rows.length, hash: hash(rows) };
  }
  return tables;
}
