import { z } from "zod";
import { setStep } from "@/server/repository";
import { errorResponse, readJson, requireSession, sameOrigin } from "@/server/http";
const Input = z.object({ revisionId: z.string(), stepId: z.string(), completed: z.boolean() }).strict();
export async function POST(request: Request) { try { sameOrigin(request); const input = Input.parse(await readJson(request)); await setStep(await requireSession(), input.revisionId, input.stepId, input.completed); return Response.json({ saved: true }); } catch (error) { return errorResponse(error); } }
