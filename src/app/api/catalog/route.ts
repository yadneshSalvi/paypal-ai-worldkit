import { z } from "zod";
import { CatalogFailure, retrieveProduct, searchProducts, similarProducts } from "../../../../packages/channel3/client";
import { getSnapshots, reserveUsage, saveCatalogResult } from "@/server/repository";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
import { WorldKitError } from "../../../../packages/contracts/index";
export const runtime = "nodejs";
export const maxDuration = 60;
const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("search"), query: z.string().trim().min(3).max(250) }).strict(),
  z.object({ kind: z.literal("details"), productId: z.string().min(1).max(200), selectedOptions: z.record(z.string().max(80), z.string().max(100)).default({}) }).strict(),
  z.object({ kind: z.literal("similar"), productId: z.string().min(1).max(200) }).strict(),
]);
export async function POST(request: Request) {
  let tenantId: string | null = null;
  try {
    sameOrigin(request); const session = await requireSession(); tenantId = session.id; const input = Input.parse(await readJson(request));
    if (input.kind !== "search" && !(await getSnapshots(session.id)).some(s => s.productId === input.productId)) throw new WorldKitError("not_found", "Discover this product in your workspace first.", 404);
    await reserveUsage(session.id, "discovery");
    if (input.kind === "details") {
      const result = await retrieveProduct(input.productId, session.id, input.selectedOptions);
      await saveCatalogResult(session.id, [result.value.snapshot], result.receipt);
      return Response.json({ ...result.value, receipt: result.receipt }, { headers: { "Cache-Control": "no-store" } });
    }
    const result = input.kind === "search" ? await searchProducts(input.query, session.id) : await similarProducts(input.productId, session.id);
    await saveCatalogResult(session.id, result.value, result.receipt);
    return Response.json({ snapshots: result.value, receipt: result.receipt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (tenantId && error instanceof CatalogFailure) await saveCatalogResult(tenantId, [], error.receipt);
    return errorResponse(error);
  }
}
