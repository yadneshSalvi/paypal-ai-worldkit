import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { WorldKitError } from "../contracts/index";

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && [0, 168].includes(b!) || a === 100 && b! >= 64 && b! <= 127 || a! >= 224 || a === 198 && [18, 19, 51].includes(b!) || a === 203 && b === 0);
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice(7));
    return !["::", "::1"].includes(value) && !/^(fc|fd|fe[89ab]|ff|2001:db8)/.test(value) && !value.startsWith("::");
  }
  return false;
}
export function productUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WorldKitError("invalid_request", "Paste a full HTTPS product page address."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".") || /\.(local|localhost|internal|test|invalid|example)$/.test(url.hostname) || url.hostname === "localhost") {
    throw new WorldKitError("invalid_request", "Use a public HTTPS product page, without a login or private network address.");
  }
  url.hash = "";
  return url;
}
export async function publicProductUrl(value: string): Promise<URL> {
  const url = productUrl(value);
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try { addresses = await lookup(url.hostname, { all: true }); } catch { throw new WorldKitError("invalid_request", "The product page’s website could not be found."); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new WorldKitError("invalid_request", "That website does not resolve to a public product page.");
  return url;
}
