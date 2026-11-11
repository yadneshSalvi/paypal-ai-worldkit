import { z } from "zod";
import { attributionReport, browseProducts, CatalogFailure, lookupProductUrl, normalizedHistory, retrieveCategory, retrieveProduct, searchCategories, searchProducts, similarProducts } from "../../../../packages/channel3/client";
import { DiscoveryFiltersSchema, type CatalogCategory, type DiscoveryFilters } from "../../../../packages/channel3/contracts";
import { reserveUsage, saveCatalogResult } from "@/server/repository";
import { database } from "@/server/db";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
import { WorldKitError } from "../../../../packages/contracts/index";
export const runtime = "nodejs";
export const maxDuration = 60;
const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("search"), query: z.string().trim().min(3).max(1000), filters: DiscoveryFiltersSchema.optional(), mode: z.enum(["default", "agentic"]).default("default") }).strict(),
  z.object({ kind: z.literal("details"), productId: z.string().min(1).max(200), selectedOptions: z.record(z.string().max(80), z.string().max(100)).default({}) }).strict(),
  z.object({ kind: z.literal("similar"), productId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("lookup"), url: z.url().max(2048) }).strict(),
  z.object({ kind: z.literal("history"), productId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("categories"), query: z.string().trim().min(2).max(150) }).strict(),
  z.object({ kind: z.literal("category"), categoryId: z.string().min(1).max(150) }).strict(),
  z.object({ kind: z.literal("browse"), filters: DiscoveryFiltersSchema }).strict(),
  z.object({ kind: z.literal("reporting"), page: z.number().int().min(1).max(20).default(1) }).strict(),
]);
async function validateFilters(tenantId: string, filters: DiscoveryFilters | undefined) {
  if (!filters) return;
  if (!filters.categoryId && Object.keys(filters.attributes).length) throw new WorldKitError("invalid_request", "Choose a catalog category before filtering its attributes.");
  if (filters.categoryId) {
    const result = await database().query("SELECT payload FROM wk_catalog_categories WHERE tenant_id=$1 AND id=$2", [tenantId, filters.categoryId]);
    const category = result.rows[0]?.payload as CatalogCategory | undefined;
    if (!category) throw new WorldKitError("invalid_request", "Find a real category before browsing it.");
    for (const [key, values] of Object.entries(filters.attributes)) {
      const attribute = category.attributes.find(a => a.id === key);
      if (!attribute || attribute.values.length && values.some(value => !attribute.values.includes(value))) throw new WorldKitError("invalid_request", "Use only attributes and values returned by this category.");
    }
  }
}
export async function POST(request: Request) {
  let tenantId: string | null = null;
  try {
    sameOrigin(request); const session = await requireSession(); tenantId = session.id; const input = Input.parse(await readJson(request));
    if ("productId" in input) {
      const known = await database().query("SELECT 1 FROM wk_catalog WHERE tenant_id=$1 AND (product_id=$2 OR jsonb_path_exists(snapshot, '$.variantOptions[*].values[*] ? (@.productId == $id)',jsonb_build_object('id',$2::text))) LIMIT 1", [session.id, input.productId]);
      if (!known.rowCount) throw new WorldKitError("not_found", "Discover this product in your workspace first.", 404);
    }
    await reserveUsage(session.id, "discovery");
    if (input.kind === "details") {
      const result = await retrieveProduct(input.productId, session.id, input.selectedOptions);
      await saveCatalogResult(session.id, [result.value.snapshot], result.receipt);
      return Response.json({ ...result.value, receipt: result.receipt }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.kind === "history") {
      const result = await normalizedHistory(input.productId); await saveCatalogResult(session.id, [], result.receipt);
      return Response.json({ history: result.value, receipt: result.receipt }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.kind === "reporting") {
      const result = await attributionReport(session.id, input.page); for (const receipt of result.receipts) await saveCatalogResult(session.id, [], receipt);
      return Response.json({ report: result.value, receipts: result.receipts }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.kind === "categories") {
      const result = await searchCategories(input.query);
      const categories: CatalogCategory[] = result.value.categories.map(c => ({ id: c.slug, title: c.title, path: (c.path ?? []).map(p => p.title), children: [], attributes: [] }));
      for (const category of categories) await database().query("INSERT INTO wk_catalog_categories(tenant_id,id,payload) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO NOTHING", [session.id, category.id, category]);
      await saveCatalogResult(session.id, [], result.receipt);
      return Response.json({ categories, receipt: result.receipt }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.kind === "category") {
      const known = await database().query("SELECT 1 FROM wk_catalog_categories WHERE tenant_id=$1 AND id=$2", [session.id, input.categoryId]);
      if (!known.rowCount) throw new WorldKitError("invalid_request", "Find this category before loading its attributes.");
      const result = await retrieveCategory(input.categoryId);
      await database().query("UPDATE wk_catalog_categories SET payload=$3 WHERE tenant_id=$1 AND id=$2", [session.id, input.categoryId, result.value]);
      for (const child of result.value.children) await database().query("INSERT INTO wk_catalog_categories(tenant_id,id,payload) VALUES($1,$2,$3) ON CONFLICT(tenant_id,id) DO NOTHING", [session.id, child.id, { ...child, path: [...result.value.path, child.title], children: [], attributes: [] }]);
      await saveCatalogResult(session.id, [], result.receipt);
      return Response.json({ category: result.value, receipt: result.receipt }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.kind === "search" || input.kind === "browse") await validateFilters(session.id, input.filters);
    if (input.kind === "browse" && !input.filters.categoryId) throw new WorldKitError("invalid_request", "Choose a category to browse.");
    const result = input.kind === "search" ? await searchProducts(input.query, session.id, input.filters, input.mode)
      : input.kind === "lookup" ? await lookupProductUrl(input.url, session.id)
      : input.kind === "browse" ? await browseProducts(input.filters, session.id)
      : await similarProducts(input.productId, session.id);
    await saveCatalogResult(session.id, result.value, result.receipt);
    return Response.json({ snapshots: result.value, receipt: result.receipt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (tenantId && error instanceof CatalogFailure) await saveCatalogResult(tenantId, [], error.receipt);
    return errorResponse(error);
  }
}
