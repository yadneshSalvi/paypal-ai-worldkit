import type { NextConfig } from "next";

// PDF.js loads its worker and canvas through runtime paths that static tracing misses.
const sourceRuntimeFiles = [
  "./node_modules/pdfjs-dist/package.json",
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "./node_modules/@napi-rs/canvas/**/*",
  "./node_modules/@napi-rs/canvas-*/**/*",
];
const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg", "@fracture/paypal-core", "paypal", "better-sqlite3", "pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: Object.fromEntries(["/api/evidence", "/api/jobs", "/api/jobs/recover", "/api/planner", "/api/inventory"].map(route => [route, sourceRuntimeFiles])),
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "X-Frame-Options", value: "DENY" }
    ] }];
  }
};
export default nextConfig;
