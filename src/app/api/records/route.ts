import { requireSession, readJson, sameOrigin } from "@/server/http";
import { mutatePublicRecord, publicRecordDesk } from "@/server/public-records";
import { recordFailure, recordJson } from "@/server/public-record-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { try { return recordJson(await publicRecordDesk(await requireSession())); } catch (error) { return recordFailure(error); } }
export async function POST(request: Request) {
  try { sameOrigin(request); const input = await readJson(request), session = await requireSession(); return recordJson(await mutatePublicRecord(session, input)); }
  catch (error) { return recordFailure(error); }
}
