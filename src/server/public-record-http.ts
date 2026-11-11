import QRCode from "qrcode";
import { errorResponse } from "./http";
import { publicRecordUrl } from "./public-record-origin";

export const PUBLIC_RECORD_HEADERS = { "Cache-Control": "private, no-store, max-age=0, must-revalidate", "Pragma": "no-cache", "Expires": "0", "CDN-Cache-Control": "no-store", "Vercel-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer" };
export function recordJson(value: unknown, status = 200) { return Response.json(value, { status, headers: PUBLIC_RECORD_HEADERS }); }
export function recordFailure(error: unknown) { const response = errorResponse(error); for (const [key, value] of Object.entries(PUBLIC_RECORD_HEADERS)) response.headers.set(key, value); return response; }
export async function recordQr(slug: string, edition: number): Promise<Buffer> {
  return QRCode.toBuffer(publicRecordUrl(slug, edition), { type: "png", width: 400, margin: 4, errorCorrectionLevel: "M", color: { dark: "#142a42", light: "#ffffff" } });
}
