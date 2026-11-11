export function requireIsolatedDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  const certificate = process.env.WORLDKIT_QA_MODE === "certificate" && url.pathname === "/worldkit_certificate_qa";
  const sourceImpact = process.env.WORLDKIT_QA_MODE === "source-impact" && /^\/wk_source_impact_[a-f0-9]{12}$/.test(url.pathname) && /^wksi_[a-f0-9]{12}$/.test(url.username);
  if (url.hostname !== "127.0.0.1" || process.env.WORLDKIT_DISABLE_PROVIDERS !== "true" || (!certificate && !sourceImpact))
    throw new Error("Use an isolated certificate or source-impact QA launcher. Existing application databases and provider calls are forbidden.");
}
