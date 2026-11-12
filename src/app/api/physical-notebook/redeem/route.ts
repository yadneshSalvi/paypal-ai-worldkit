import { NextResponse } from "next/server";
import { redeemBenchInvitation } from "../../../../server/physical-notebook-authority";
import { benchError, benchHeaders, benchOrigin, benchReviewerCookie, readBenchJson } from "../../../../server/physical-notebook-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    benchOrigin(request); const result = await redeemBenchInvitation(await readBenchJson(request));
    const response = NextResponse.json({ runId: result.runId, expiresAt: result.expiresAt }, { headers: benchHeaders });
    response.cookies.set(benchReviewerCookie, result.credential, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "strict", path: "/", expires: new Date(result.expiresAt) }); return response;
  } catch (error) { return benchError(error); }
}
