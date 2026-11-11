export function requireIsolatedDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  const certificate = process.env.WORLDKIT_QA_MODE === "certificate" && url.pathname === "/worldkit_certificate_qa";
  const sourceImpact = process.env.WORLDKIT_QA_MODE === "source-impact" && /^\/wk_source_impact_[a-f0-9]{12}$/.test(url.pathname) && /^wksi_[a-f0-9]{12}$/.test(url.username);
  const toolkit = process.env.WORLDKIT_QA_MODE === "toolkit" && /^\/wk_toolkit_[a-f0-9]{20}$/.test(url.pathname) && url.username === `wkt_${url.pathname.slice("/wk_toolkit_".length)}` && url.port === "5432";
  const engineering = process.env.WORLDKIT_QA_MODE === "engineering" && /^\/wk_engineering_[a-f0-9]{20}$/.test(url.pathname) && url.username === `wke_${url.pathname.slice("/wk_engineering_".length)}` && url.port === "5432";
  if (url.hostname !== "127.0.0.1" || process.env.WORLDKIT_DISABLE_PROVIDERS !== "true" || (!certificate && !sourceImpact && !toolkit && !engineering))
    throw new Error("Use an isolated certificate, source-impact or Toolkit QA launcher. Existing application databases and provider calls are forbidden.");
}
