import { handleBenchBlob } from "../../../../server/physical-notebook-blob";
import { requireBenchAccess } from "../../../../server/physical-notebook-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleBenchBlob(request, () => requireBenchAccess()); }
