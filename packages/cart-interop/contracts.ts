import { z } from "zod";
import { cartItemSchema, payPalCartWritableSchema, type CompleteCheckoutResponse, type PayPalCart, type PayPalCartWritable, type ValidationIssue } from "@paypal/agentic-commerce-spec";

export const CART_SPEC = "@paypal/agentic-commerce-spec@1.1.0" as const;
export const CartScopeSchema = z.enum(["cart", "checkout"]);
export type CartScope = z.infer<typeof CartScopeSchema>;
export const CartInputSchema = payPalCartWritableSchema.extend({
  items: z.array(cartItemSchema.extend({ quantity: z.number().int().min(1).max(99) }).strict()).min(1).max(40).optional(),
}).strict();
export type CartInput = PayPalCartWritable;
export type CartCredential = {
  id: string; merchantId: string; tenantId: string; publicKey: string; tokenHash: string;
  audience: string; accountId: string; clientId: string; scopes: CartScope[];
  sourceMode: "sample"; expiresAt: string; revokedAt: string | null; sessionExpiresAt: string;
};
export type CartPrincipal = { credentialId: string; merchantId: string; tenantId: string; scopes: CartScope[]; sourceMode: "sample"; expiresAt: string };
export type CartCatalogueLine = {
  id: string; parentId: string; merchantId: string; title: string; description: string;
  productKind: "physical" | "digital"; sourceMode: "sample"; priceMinor: number; stock: number; stockVersion: number;
  projectId: string; editionId: string; graphHash: string; currentEditionId: string; currentGraphHash: string;
  packId: "desk-displays" | "podcast-classroom"; editionNumber: number; componentCount: number;
  modelConflicts: number; actualHumanReviews: number; physicalTests: number; active: boolean; evidenceCurrent: boolean;
};
export type CartEvaluation = { cart: PayPalCart; issues: ValidationIssue[]; totalMinor: number | null; graphHashes: string[]; catalogueVersions: { id: string; stockVersion: number; priceMinor: number }[]; digest: string };
export type CartRevision = { id: string; number: number; hash: string; input: CartInput; response: CompleteCheckoutResponse; evaluationHash: string; totalMinor: number | null; createdAt: string };
export type CartRecord = {
  id: string; merchantId: string; tenantId: string; sourceMode: "sample"; version: number;
  state: "open" | "completed"; current: CartRevision; completedAt: string | null;
  createdAt: string; expiresAt: string;
};
export type CartEvent = { id: string; kind: string; cartId: string | null; version: number | null; detail: string; at: string; sourceMode: "sample" };
export type CartGrantView = { id: string; scopes: CartScope[]; expiresAt: string; revokedAt: string | null; createdAt: string };
export type CartSystemChoice = { id: string; title: string; packId: "desk-displays" | "podcast-classroom"; editionId: string; editionNumber: number; graphHash: string; modelConflicts: number; modelQuestions: number; componentCount: number; evidenceCurrent: boolean };
export type CartHome = {
  sourceMode: "sample"; spec: typeof CART_SPEC; workspaceKey: string;
  merchant: { id: string; audience: string; createdAt: string } | null;
  systems: CartSystemChoice[]; catalogue: CartCatalogueLine[]; credentials: CartGrantView[];
  carts: { id: string; version: number; state: "open" | "completed"; totalMinor: number | null; createdAt: string; expiresAt: string }[];
  selected: null | { record: CartRecord; displayedRevision: CartRevision; response: CompleteCheckoutResponse; reviewRequired: boolean; historical: boolean;
    history: { id: string; number: number; hash: string; evaluationHash: string; totalMinor: number | null; createdAt: string }[];
    approval: { id: string; token: string; payerId: string; expiresAt: string; current: boolean } | null };
  events: CartEvent[];
};
export type CartCommandResult = { message: string; cartId?: string; credential?: CartGrantView; token?: string; secretUnavailable?: boolean };
const id = z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/);
const requestId = z.string().min(8).max(120).regex(/^[A-Za-z0-9:_-]+$/);
const amount = z.number().int().min(1).max(999300);
const stock = z.number().int().min(0).max(1000);
export const CartCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start_sample"), requestId, acknowledgedSample: z.literal(true) }).strict(),
  z.object({ kind: z.literal("catalogue_add"), requestId, projectId: id, expectedEditionId: id, expectedGraphHash: z.string().length(64), priceMinor: amount, stock, acknowledgedSample: z.literal(true) }).strict(),
  z.object({ kind: z.literal("catalogue_change"), requestId, catalogueId: id, expectedStockVersion: z.number().int().positive(), priceMinor: amount, stock, acknowledgedSample: z.literal(true) }).strict(),
  z.object({ kind: z.literal("credential_issue"), requestId, scopes: z.array(CartScopeSchema).min(1).max(2).refine(items => new Set(items).size === items.length), acknowledgedSample: z.literal(true) }).strict(),
  z.object({ kind: z.literal("credential_revoke"), requestId, credentialId: id }).strict(),
  z.object({ kind: z.literal("cart_create"), requestId, body: CartInputSchema }).strict(),
  z.object({ kind: z.literal("cart_replace"), requestId, cartId: id, expectedVersion: z.number().int().positive(), body: CartInputSchema }).strict(),
  z.object({ kind: z.literal("cart_approve"), requestId, cartId: id, expectedVersion: z.number().int().positive(), evaluationHash: z.string().length(64), token: z.string().min(8).max(120), acknowledgedSample: z.literal(true) }).strict(),
  z.object({ kind: z.literal("cart_complete"), requestId, cartId: id, body: CartInputSchema }).strict(),
]);
export type CartCommand = z.infer<typeof CartCommandSchema>;

export class CartProblem extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly issue?: ValidationIssue) { super(message); this.name = "CartProblem"; }
}
export const cartMoney = (minor: number) => ({ currency_code: "USD", value: (minor / 100).toFixed(2) });
