/** Browser writes must come from this deployment. Local aliases are allowed only
 * when both the actual Host and the handler URL are loopback on the project port. */
export function trustedOrigin(request: Request, configured?: string, deploymentHost?: string): boolean {
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
  if (publicUrl && host === publicUrl.host && origin.origin === publicUrl.origin) return true;
  // VERCEL_URL is a server-provided hostname, without a scheme. Each deployment
  // admits only its own exact host; other preview and branch aliases stay closed.
  if (deploymentHost && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/.test(deploymentHost)) {
    if (request.headers.has("host") && host === deploymentHost && origin.origin === `https://${deploymentHost}`) return true;
  }
  if (publicUrl || deploymentHost) return false;
  return host === target.host && origin.origin === target.origin;
}
