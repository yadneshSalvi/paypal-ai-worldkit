import { mkdir, writeFile } from "node:fs/promises";
import { searchProducts, retrieveProduct, similarProducts, searchCategories, priceHistory, CatalogFailure } from "../packages/channel3/client";
await mkdir("docs/evidence", { recursive: true });
const receipts: unknown[] = []; const snapshots: unknown[] = [];
const user = "worldkit-qualification";
for (const query of ["Zoom H4essential portable recorder", "Shure SM58-LC wired XLR microphone", "Audio Technica AT2020 XLR black condenser microphone"]) {
  try { const result = await searchProducts(query, user); receipts.push(result.receipt); snapshots.push(...result.value); console.log(JSON.stringify({ operation: "search", status: result.receipt.status, products: result.value.length, durationMs: result.receipt.durationMs })); }
  catch (error) { if (error instanceof CatalogFailure) receipts.push(error.receipt); console.log(JSON.stringify({ operation: "search", status: "failed" })); }
}
const first = snapshots[0] as { productId: string } | undefined;
if (first) {
  for (const operation of ["details", "similar", "categories", "price_history"] as const) {
    try {
      if (operation === "details") { const result = await retrieveProduct(first.productId, user); receipts.push(result.receipt); snapshots.push(result.value.snapshot); }
      if (operation === "similar") { const result = await similarProducts(first.productId, user); receipts.push(result.receipt); snapshots.push(...result.value); }
      if (operation === "categories") { const result = await searchCategories("microphones audio recorders"); receipts.push(result.receipt); }
      if (operation === "price_history") { const result = await priceHistory(first.productId); receipts.push(result.receipt); }
      console.log(JSON.stringify({ operation, status: "succeeded" }));
    } catch (error) { if (error instanceof CatalogFailure) receipts.push(error.receipt); console.log(JSON.stringify({ operation, status: "failed" })); }
  }
}
await writeFile("docs/evidence/channel3-qualification.json", JSON.stringify({ observedAt: new Date().toISOString(), sdk: "@channel3/sdk@4.9.0", receipts, snapshots, notes: ["Actual API responses with sanitized metadata only. No offer URLs or catalog imagery retained.", "Search similarity does not confirm an exact hardware identity or specification.", "Physical tests and retail purchases were not performed."] }, null, 2) + "\n");
if (!snapshots.length) process.exitCode = 1;
