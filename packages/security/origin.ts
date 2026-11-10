/** Browser writes must come from this deployment. Local aliases are allowed only
 * when both the actual Host and the handler URL are loopback on the project port. */
export function trustedOrigin(request: Request, configured?: string): boolean {
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) return false;
  let origin: URL; let target: URL; let publicUrl: URL | null;
  try { origin = new URL(rawOrigin); target = new URL(request.url); publicUrl = configured ? new URL(configured) : null; }
  catch { return false; }
  if (rawOrigin !== origin.origin || origin.username || origin.password) return false;
  const host = request.headers.get("host")?.toLowerCase() ?? target.host.toLowerCase();
  const localHosts = new Set(["localhost:4106", "127.0.0.1:4106"]);
  if (localHosts.has(host) && localHosts.has(target.host) && localHosts.has(origin.host)) {
    return target.protocol === "http:" && origin.protocol === "http:";
  }
  if (publicUrl) return host === publicUrl.host && origin.origin === publicUrl.origin;
  return host === target.host && origin.origin === target.origin;
}
