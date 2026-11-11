import { readPhoto } from "@/server/inventory-photos";
import { errorResponse, requireSession } from "@/server/http";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(); const { id } = await context.params;
    const photo = await readPhoto(session.id, id);
    return new Response(new Uint8Array(photo.bytes), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=equipment.webp" } });
  } catch (error) { return errorResponse(error); }
}
