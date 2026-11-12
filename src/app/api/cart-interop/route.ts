import { CartProblem } from "../../../../packages/cart-interop/contracts";
import { cartHome, cartWorkbenchCommand } from "../../../server/cart-interop-workbench";
import { cartResponseHeaders, readCartJson } from "../../../server/cart-interop-http";
import { errorResponse, requireSession, sameOrigin } from "../../../server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  if (error instanceof CartProblem) return Response.json({ error: { code: error.code, message: error.message, nextAction: "Review the saved cart and try again" } }, { status: error.status, headers: cartResponseHeaders });
  const response = errorResponse(error); for (const [key, value] of Object.entries(cartResponseHeaders)) response.headers.set(key, value); return response;
}
export async function GET(request: Request) {
  try { const url = new URL(request.url); return Response.json(await cartHome(await requireSession(), url.searchParams.get("cartId") ?? undefined, url.searchParams.get("revisionId") ?? undefined), { headers: cartResponseHeaders }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try { sameOrigin(request, 65_536); const session = await requireSession(); return Response.json(await cartWorkbenchCommand(session, await readCartJson(request)), { headers: cartResponseHeaders }); }
  catch (error) { return failure(error); }
}
