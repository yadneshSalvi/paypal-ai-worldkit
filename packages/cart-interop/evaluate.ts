import { createHash } from "node:crypto";
import type { CartItem, PayPalCart, ValidationIssue } from "@paypal/agentic-commerce-spec";
import { CartInputSchema, cartMoney, type CartCatalogueLine, type CartEvaluation, type CartInput } from "./contracts";

export function cartHash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export const SAMPLE_SHIPPING_MINOR = 700;
export const SAMPLE_TAX_MINOR = 0;
function sameMoney(value: { currency_code: string; value: string }, minor: number) {
  const parts = /^(0|[1-9]\d{0,7})(?:\.(\d{1,2}))?$/.exec(value.value);
  return value.currency_code === "USD" && !!parts && Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0")) === minor;
}
export function evaluateCart(input: CartInput, catalogue: CartCatalogueLine[], merchantId: string, cartId: string): CartEvaluation {
  const body = CartInputSchema.parse(input);
  const issues: ValidationIssue[] = []; const items: CartItem[] = []; const graphHashes: string[] = [];
  const catalogueVersions: CartEvaluation["catalogueVersions"] = [];
  const issue = (code: ValidationIssue["code"], type: ValidationIssue["type"], message: string, field: string, itemId?: string) => issues.push({ code, type, message, user_message: message, field, ...(itemId ? { item_id: itemId } : {}) });
  let subtotal = 0; let priced = true;
  if (!body.items?.length) issue("INVENTORY_ISSUE", "MISSING_FIELD", "Choose an exact item from this merchant's catalogue.", "items");
  const seen = new Set<string>();
  for (const [index, requested] of (body.items ?? []).entries()) {
    const id = requested.variant_id ?? requested.item_id; const field = `items[${index}]`;
    const line = catalogue.find(value => value.id === id && value.merchantId === merchantId);
    if (!id || !line) { priced = false; issue("INVENTORY_ISSUE", "INVALID_DATA", "This exact variant is not in the selected merchant's catalogue.", `${field}.variant_id`, id); continue; }
    if (seen.has(id)) issue("DATA_ERROR", "INVALID_DATA", "Combine this variant into one line with its total quantity.", `${field}.variant_id`, id);
    seen.add(id);
    if (requested.item_id && requested.item_id !== id || requested.parent_id && requested.parent_id !== line.parentId) issue("DATA_ERROR", "INVALID_DATA", "The parent or legacy item identity does not match this exact variant.", field, id);
    if (!line.active) issue("INVENTORY_ISSUE", "BUSINESS_RULE", "This catalogue entry is no longer active.", field, id);
    if (line.sourceMode !== "sample" || line.productKind !== "physical") issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "This controlled merchant accepts only its declared Sample physical-goods catalogue. Digital services are outside this interface.", field, id);
    if (!Number.isSafeInteger(line.priceMinor) || line.priceMinor < 0 || line.priceMinor > 1_000_000) { priced = false; issue("PRICING_ERROR", "INVALID_DATA", "The merchant has not established a valid price for this variant.", `${field}.price`, id); }
    else subtotal += line.priceMinor * requested.quantity;
    if (!Number.isSafeInteger(line.stock) || line.stock < requested.quantity) issue("INVENTORY_ISSUE", "BUSINESS_RULE", "The current Sample stock cannot supply this quantity. Stock has not been reserved.", `${field}.quantity`, id);
    if (line.currentEditionId !== line.editionId || line.currentGraphHash !== line.graphHash) issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "The saved system has a newer edition. Refresh the exact system handoff before checkout.", field, id);
    if (!line.evidenceCurrent) issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "The source, pack rules or equipment passport changed. Review and save a current system edition before checkout.", field, id);
    if (line.modelConflicts > 0) issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "This system still has modeled connection conflicts. Review its proof before checkout.", field, id);
    if (requested.price && !sameMoney(requested.price, line.priceMinor)) issue("PRICING_ERROR", "BUSINESS_RULE", "The submitted price differs from the current merchant price. Review the refreshed total.", `${field}.price`, id);
    if (requested.selected_attributes?.length || requested.custom_options?.length || requested.gift_options) issue("DATA_ERROR", "INVALID_DATA", "This exact system bundle does not accept extra attributes, custom or gift options.", field, id);
    items.push({ variant_id: line.id, parent_id: line.parentId, quantity: requested.quantity, name: line.title, description: line.description, ...(Number.isSafeInteger(line.priceMinor) && line.priceMinor >= 0 ? { price: cartMoney(line.priceMinor) } : {}) });
    graphHashes.push(line.graphHash); catalogueVersions.push({ id: line.id, stockVersion: line.stockVersion, priceMinor: line.priceMinor });
  }
  if (!Number.isSafeInteger(subtotal) || subtotal + SAMPLE_SHIPPING_MINOR + SAMPLE_TAX_MINOR > 1_000_000) { priced = false; issue("PRICING_ERROR", "BUSINESS_RULE", "This Sample cart exceeds the merchant's supported total.", "items"); }
  if (!body.customer?.email_address) issue("DATA_ERROR", "MISSING_FIELD", "Provide a customer email for this cart. The Sample flow sends no email.", "customer.email_address");
  const address = body.shipping_address;
  if (!address) issue("SHIPPING_ERROR", "MISSING_FIELD", "Choose a complete US shipping address. The Sample flow ships no equipment.", "shipping_address");
  else {
    if (address.country_code !== "US") issue("SHIPPING_ERROR", "BUSINESS_RULE", "This merchant interface supports only US destinations in USD.", "shipping_address.country_code");
    for (const name of ["address_line_1", "admin_area_1", "admin_area_2", "postal_code"] as const) if (!address[name]?.trim()) issue("SHIPPING_ERROR", "MISSING_FIELD", "Complete the required shipping address fields.", `shipping_address.${name}`);
    if (address.admin_area_1 && !/^[A-Z]{2}$/.test(address.admin_area_1)) issue("SHIPPING_ERROR", "INVALID_DATA", "Use the two-letter state code for this address.", "shipping_address.admin_area_1");
    if (address.postal_code && !/^\d{5}(?:-\d{4})?$/.test(address.postal_code)) issue("SHIPPING_ERROR", "INVALID_DATA", "Use a five-digit US ZIP code, with an optional four-digit extension.", "shipping_address.postal_code");
  }
  const shipping = body.available_shipping_options?.filter(option => option.is_selected) ?? [];
  if (shipping.length > 1 || shipping.some(option => option.id !== "sample-standard")) issue("SHIPPING_ERROR", "INVALID_DATA", "Select the supported Sample standard shipping option.", "available_shipping_options");
  if (shipping.some(option => !sameMoney(option.price, SAMPLE_SHIPPING_MINOR))) issue("PRICING_ERROR", "BUSINESS_RULE", "The shipping amount is set by the merchant. Review the refreshed Sample shipping charge.", "available_shipping_options");
  if (body.coupons?.length) issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "This Sample catalogue does not support coupons.", "coupons");
  if (body.checkout_fields?.length) issue("DATA_ERROR", "INVALID_DATA", "This merchant does not accept additional checkout fields. Buyer approval is a separate exact-cart action.", "checkout_fields");
  if (body.geo_coordinates) issue("DATA_ERROR", "INVALID_DATA", "This merchant uses the supplied US address; coordinate-based delivery is not supported.", "geo_coordinates");
  const totalMinor = priced && items.length > 0 ? subtotal + SAMPLE_SHIPPING_MINOR + SAMPLE_TAX_MINOR : null;
  const cart: PayPalCart = {
    id: cartId, status: issues.length ? "INCOMPLETE" : "READY",
    validation_status: !issues.length ? "VALID" : issues.every(value => value.type === "MISSING_FIELD") ? "REQUIRES_ADDITIONAL_INFORMATION" : "INVALID",
    validation_issues: issues, ...(items.length ? { items } : {}),
    ...(body.customer ? { customer: body.customer } : {}), ...(address ? { shipping_address: address } : {}),
    ...(body.billing_address ? { billing_address: body.billing_address } : {}),
    available_shipping_options: [{ id: "sample-standard", name: "Sample standard shipping", description: "Controlled test charge; no equipment is shipped.", price: cartMoney(SAMPLE_SHIPPING_MINOR), is_selected: true }],
    ...(totalMinor !== null ? { totals: { subtotal: cartMoney(subtotal), shipping: cartMoney(SAMPLE_SHIPPING_MINOR), tax: cartMoney(SAMPLE_TAX_MINOR), total: cartMoney(totalMinor) } } : {}),
    payment_method: { type: "paypal" },
  };
  return { cart, issues, totalMinor, graphHashes, catalogueVersions, digest: cartHash({ cart, graphHashes, catalogueVersions }) };
}
