import { WorldKitError } from "../../packages/contracts";
import { PublicEditionSchema, PublicSlugSchema } from "../../packages/public-record";

/** Publication URLs never derive authority or a hostname from request headers. */
type PublicationEnvironment = { WORLDKIT_PUBLIC_URL?: string; VERCEL?: string; VERCEL_URL?: string };
export function publicRecordOrigin(env: PublicationEnvironment = { WORLDKIT_PUBLIC_URL: process.env.WORLDKIT_PUBLIC_URL, VERCEL: process.env.VERCEL, VERCEL_URL: process.env.VERCEL_URL }): string {
  const configured = env.WORLDKIT_PUBLIC_URL;
  if (!configured) throw new WorldKitError("provider_unavailable", "A stable public address is required before sharing a certificate.", 503);
  let url: URL;
  try { url = new URL(configured); } catch { throw new WorldKitError("provider_unavailable", "The certificate address needs configuration.", 503); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new WorldKitError("provider_unavailable", "Use an origin without credentials, paths or query strings for certificates.", 503);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:" && !env.VERCEL)) || (env.VERCEL && local)) throw new WorldKitError("provider_unavailable", "Hosted certificates require a stable HTTPS address.", 503);
  return url.origin;
}
export function publicRecordPath(slug: string, edition?: number): string {
  return `/record/${PublicSlugSchema.parse(slug)}${edition === undefined ? "" : `/e/${PublicEditionSchema.parse(edition)}`}`;
}
export function publicRecordUrl(slug: string, edition?: number, env?: PublicationEnvironment): string {
  return `${publicRecordOrigin(env)}${publicRecordPath(slug, edition)}`;
}
