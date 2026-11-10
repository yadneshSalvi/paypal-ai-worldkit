import { cookies } from "next/headers";
import { createSession, findSession, getWorkspace } from "@/server/repository";
import { errorResponse, requireSession, sameOrigin, sessionCookie } from "@/server/http";
import { claimSessionCreation, SessionLimitError } from "@/server/session-limits";
export const runtime = "nodejs";
export async function GET() { try { return Response.json(await getWorkspace(await requireSession()), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const existing = await findSession((await cookies()).get(sessionCookie)?.value);
    if (existing) return Response.json(await getWorkspace(existing), { headers: { "Cache-Control": "no-store" } });
    await claimSessionCreation();
    const { token, session } = await createSession();
    (await cookies()).set(sessionCookie, token, { httpOnly: true, secure: process.env.NODE_ENV === "production" && new URL(request.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 7 * 86400 });
    return Response.json(await getWorkspace(session), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { const response = errorResponse(error); if (error instanceof SessionLimitError) response.headers.set("Retry-After", String(error.retryAfter)); return response; }
}
