import { z } from "zod";
import { createAccessToken, revokeAccessToken } from "@/server/repository";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
const Input = z.object({ scopes: z.array(z.enum(["kit:verify", "kit:propose", "kit:quote", "payment:read"])).min(1).max(4).refine(value => new Set(value).size === value.length) }).strict();
export async function POST(request: Request) { try { sameOrigin(request); const input = Input.parse(await readJson(request)); return Response.json(await createAccessToken(await requireSession(), input.scopes), { headers: { "Cache-Control": "no-store" } }); } catch (error) { return errorResponse(error); } }
export async function DELETE(request: Request) { try { sameOrigin(request); const input = z.object({ id: z.string() }).strict().parse(await readJson(request)); await revokeAccessToken(await requireSession(), input.id); return Response.json({ revoked: true }); } catch (error) { return errorResponse(error); } }
