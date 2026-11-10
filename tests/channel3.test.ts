import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProduct } from "../packages/channel3/client";
import type { Channel3Api } from "@channel3/sdk";
const product: Channel3Api.Product = { id: "documented-test-fixture", title: "Sample product", offers: [{ url: "https://merchant.example/item?ephemeral=secret", domain: "merchant.example", availability: "InStock", condition: "new", price: { currency: "USD", price: 19.95 } }], variants: { options: [], selected: [{ name: "Color", label: "Black" }] } };
test("persistable catalog snapshots contain no reusable offer URLs or image data", () => { const value = normalizeProduct(product); const stored = JSON.stringify(value.snapshot); assert.equal(stored.includes("https://"), false); assert.equal(stored.includes("ephemeral"), false); assert.equal(value.buyLinks.length, 1); assert.equal(value.snapshot.offers[0]!.price!.minor, 1995); });
test("variant relaxation cannot silently satisfy an exact request", () => { assert.equal(normalizeProduct(product, { Color: "White" }).snapshot.variantExact, false); assert.equal(normalizeProduct(product, { color: "Black" }).snapshot.variantExact, true); assert.equal(normalizeProduct(product, { Color: "Black", Size: "Large" }).snapshot.variantExact, false); });
test("unsafe retailer URL schemes are excluded", () => { const unsafe = structuredClone(product); unsafe.offers![0]!.url = "javascript:alert(1)"; assert.deepEqual(normalizeProduct(unsafe).buyLinks, []); });
test("a foreign currency does not turn into an invented USD price", () => { const foreign = structuredClone(product); foreign.offers![0]!.price.currency = "EUR"; assert.equal(normalizeProduct(foreign).snapshot.offers[0]!.price, null); });
