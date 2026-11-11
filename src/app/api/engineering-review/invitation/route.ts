import { cookies } from "next/headers";
import { z } from "zod";
import { inspectInvitation, redeemInvitation } from "@/server/engineering-review";
import { reviewCookie, reviewError, reviewHeaders, reviewJson } from "@/server/engineering-review-http";
export const runtime = "nodejs";
const Input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inspect"), token: z.string().max(100) }).strict(),
  z.object({ kind: z.literal("redeem"), token: z.string().max(100), acknowledgeScope: z.literal(true) }).strict(),
  z.object({ kind: z.literal("leave") }).strict(),
]);
export async function POST(request: Request) {
  try {
    const input = Input.parse(await reviewJson(request));
    if (input.kind === "leave") { (await cookies()).delete(reviewCookie); return Response.json({ left: true }, { headers: reviewHeaders }); }
    if (input.kind === "inspect") return Response.json(await inspectInvitation(input.token), { headers: reviewHeaders });
    const result = await redeemInvitation(input.token);
    (await cookies()).set(reviewCookie, result.credential, { httpOnly: true, sameSite: "strict", secure: new URL(request.url).protocol === "https:", path: "/", expires: new Date(result.expiresAt) });
    return Response.json({ redeemed: true, expiresAt: result.expiresAt }, { headers: reviewHeaders });
  } catch (error) { return reviewError(error); }
}
