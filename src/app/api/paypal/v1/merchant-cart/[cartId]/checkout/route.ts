import { handleCartProtocol } from "../../../../../../../server/cart-interop-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ cartId: string }> }) { return handleCartProtocol(request, "checkout", (await context.params).cartId); }
