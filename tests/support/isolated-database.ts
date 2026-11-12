export function requireIsolatedDatabase() {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
  const certificate = process.env.WORLDKIT_QA_MODE === "certificate" && url.pathname === "/worldkit_certificate_qa";
  const sourceImpact = process.env.WORLDKIT_QA_MODE === "source-impact" && /^\/wk_source_impact_[a-f0-9]{12}$/.test(url.pathname) && /^wksi_[a-f0-9]{12}$/.test(url.username);
  const toolkit = process.env.WORLDKIT_QA_MODE === "toolkit" && /^\/wk_toolkit_[a-f0-9]{20}$/.test(url.pathname) && url.username === `wkt_${url.pathname.slice("/wk_toolkit_".length)}` && url.port === "5432";
  const engineering = process.env.WORLDKIT_QA_MODE === "engineering" && /^\/wk_engineering_[a-f0-9]{20}$/.test(url.pathname) && url.username === `wke_${url.pathname.slice("/wk_engineering_".length)}` && url.port === "5432";
  const domainPacks = process.env.WORLDKIT_QA_MODE === "domain-packs" && /^\/wk_domain_[a-f0-9]{20}$/.test(url.pathname) && url.username === `wkd_${url.pathname.slice("/wk_domain_".length)}` && url.port === "55565";
  const cartInterop = process.env.WORLDKIT_QA_MODE === "cart-interop" && /^\/wk_cart_[a-f0-9]{20}$/.test(url.pathname) && url.username === `wkc_${url.pathname.slice("/wk_cart_".length)}` && url.port === "55570";
  const physicalNotebook = process.env.WORLDKIT_QA_MODE === "physical-notebook" && url.pathname === "/worldkit_physical" && url.username === "worldkit_physical" && url.port === "55576";
  const researchNotebook = process.env.WORLDKIT_QA_MODE === "research-notebook" && url.pathname === "/worldkit_research" && url.username === "worldkit_research" && url.port === "55576";
  const guidedJourney = process.env.WORLDKIT_QA_MODE === "guided-journey" && url.pathname === "/worldkit_guided" && url.username === "worldkit_guided" && url.port === "55576";
  const releaseFinal = process.env.WORLDKIT_QA_MODE === "release-final" && url.pathname === "/worldkit_release_final" && url.username === "wk_release_final_app" && url.port === "55576";
  if (url.hostname !== "127.0.0.1" || process.env.WORLDKIT_DISABLE_PROVIDERS !== "true" || (!certificate && !sourceImpact && !toolkit && !engineering && !domainPacks && !cartInterop && !physicalNotebook && !researchNotebook && !guidedJourney && !releaseFinal))
    throw new Error("Use an isolated certificate, source-impact, Toolkit, engineering, domain-packs, cart, physical-notebook, research-notebook or guided-journey QA launcher. Existing application databases and provider calls are forbidden.");
}
