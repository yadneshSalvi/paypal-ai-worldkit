import { handleInventoryPhotoUpload } from "@/server/inventory-photo-http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { return handleInventoryPhotoUpload(request); }
