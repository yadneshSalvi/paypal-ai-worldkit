import type { NextConfig } from "next";

// PDF.js loads its worker and canvas through runtime paths that static tracing misses.
const sourceRuntimeFiles = [
  "./node_modules/pdfjs-dist/package.json",
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "./node_modules/@napi-rs/canvas/**/*",
  "./node_modules/@napi-rs/canvas-*/**/*",
];
const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  distDir: process.env.WORLDKIT_QA_MODE === "domain-packs" ? ".next-domain-packs-qa" : process.env.WORLDKIT_QA_MODE === "engineering" ? ".next-engineering-qa" : process.env.WORLDKIT_QA_MODE === "certificate" ? ".next-certificate-qa" : process.env.WORLDKIT_QA_MODE === "source-impact" ? ".next-source-impact-qa" : ".next",
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@fracture/paypal-core", "paypal", "better-sqlite3", "pdf-parse", "pdfjs-dist", "@napi-rs/canvas", "@paypal/agent-toolkit", "axios"],
  outputFileTracingIncludes: Object.fromEntries(["/api/evidence", "/api/jobs", "/api/jobs/recover", "/api/planner", "/api/inventory"].map(route => [route, sourceRuntimeFiles])),
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-Frame-Options", value: "DENY" }
    ] }, ...["/record/:path*", "/api/public-records/:path*", "/api/records", "/review/:path*", "/api/engineering-review/:path*", "/api/synthesis", "/api/domain-packs/:path*"].map(source => ({ source, headers: [
      { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
      { key: "CDN-Cache-Control", value: "no-store" },
      { key: "Vercel-CDN-Cache-Control", value: "no-store" },
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "Referrer-Policy", value: "no-referrer" }
    ] }))];
  }
};
export default nextConfig;
