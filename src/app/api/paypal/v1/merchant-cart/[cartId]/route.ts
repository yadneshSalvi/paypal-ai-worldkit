import { handleCartProtocol } from "../../../../../../server/cart-interop-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ cartId: string }> }) { return handleCartProtocol(request, "get", (await context.params).cartId); }
export async function PUT(request: Request, context: { params: Promise<{ cartId: string }> }) { return handleCartProtocol(request, "replace", (await context.params).cartId); }
