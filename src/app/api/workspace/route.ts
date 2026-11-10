import { cookies } from "next/headers";
import { createSession, getWorkspace } from "@/server/repository";
import { errorResponse, requireSession, sameOrigin, sessionCookie } from "@/server/http";
export const runtime = "nodejs";
export async function GET() { try { return Response.json(await getWorkspace(await requireSession()), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
  try {
    sameOrigin(request); const { token, session } = await createSession();
    (await cookies()).set(sessionCookie, token, { httpOnly: true, secure: process.env.NODE_ENV === "production" && new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 7 * 86400 });
    return Response.json(await getWorkspace(session), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
