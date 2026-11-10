import type { PoolClient } from "pg";
import { database, initialize, transaction } from "./db";
import type { SqlConnection, SqlDatabase } from "@fracture/paypal-core";
import { seal, unseal } from "./secrets";
const state = globalThis as unknown as { worldkitCommerceSchema1?: Promise<void> };
export function initializeCommerce() {
  return state.worldkitCommerceSchema1 ??= initialize().then(async () => { await database().query(`
    CREATE TABLE IF NOT EXISTS wk_commerce_orders (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), quote_id text NOT NULL,
      payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,quote_id)
    );
    CREATE TABLE IF NOT EXISTS wk_wallet_consents (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_vault_operations (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), consent_id text NOT NULL REFERENCES wk_wallet_consents(id),
      kind text NOT NULL, state text NOT NULL, body_hash text NOT NULL, request_id text NOT NULL,
      resource_id text, result jsonb, error text, updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(consent_id,kind)
    );
    CREATE TABLE IF NOT EXISTS wk_repair_policies (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_repair_claims (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), policy_id text NOT NULL REFERENCES wk_repair_policies(id),
      business_key text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(policy_id,business_key)
    );
    CREATE TABLE IF NOT EXISTS wk_financial_authorities (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), order_id text NOT NULL REFERENCES wk_commerce_orders(id),
      operation_id text UNIQUE NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_payment_resources (
      provider_id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), order_id text NOT NULL REFERENCES wk_commerce_orders(id),
      kind text NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wk_notifications (
      id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES wk_sessions(id), kind text NOT NULL, payload jsonb NOT NULL,
      read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
  `); }).catch(error => { state.worldkitCommerceSchema1 = undefined; throw error; });
}
export async function commerceTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> { await initializeCommerce(); return transaction(work); }
/** A storage codec, outside the immutable core: opaque operation documents are
 * encrypted while indexed claim/amount/version columns retain SQL semantics. */
const connection = (db: Pick<PoolClient, "query">): SqlConnection => ({ dialect: "postgres", async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
  const encoded = params?.map(value => {
    if (typeof value !== "string" || !value.startsWith("{")) return value;
    let parsed; try { parsed = JSON.parse(value); } catch { return value; }
    if (parsed?.command?.scope?.projectId !== "worldkit") return value;
    const tenantId = parsed.command.scope.tenantId as string;
    return JSON.stringify({ worldkitOperation: true, tenantId, ...seal(tenantId, parsed) });
  });
  const result = await db.query<T>(sql, encoded);
  const rows = result.rows.map(row => {
    if (typeof row.document !== "string") return row;
    const parsed = JSON.parse(row.document);
    if (!parsed.worldkitOperation) return row;
    return { ...row, document: JSON.stringify(unseal(parsed.tenantId, parsed)) } as T;
  });
  return { rows, rowCount: result.rowCount ?? 0 };
} });
export const paymentDatabase: SqlDatabase = {
  dialect: "postgres",
  async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) { return connection(database()).query<T>(sql, params); },
  async transaction<T>(work: (db: SqlConnection) => Promise<T>) { return commerceTransaction(db => work(connection(db))); },
  async close() { /* The application owns its shared pool. */ },
};
