import { handleCartProtocol } from "../../../../../server/cart-interop-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleCartProtocol(request, "create"); }
