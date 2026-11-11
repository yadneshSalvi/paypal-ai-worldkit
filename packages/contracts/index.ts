import { z } from "zod";

export const CONTRACT_VERSION = "worldkit.v1" as const;
export const RULE_VERSION = "creator-audio.1.1.0" as const;
export const ProvenanceSchema = z.enum(["live", "replay", "modelled", "sample"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;
export const TruthSchema = z.enum(["satisfied", "violated", "unknown"]);
export type Truth = z.infer<typeof TruthSchema>;
export const MoneySchema = z.object({ currency: z.literal("USD"), minor: z.number().int().nonnegative().max(100_000_000) });
export type Money = z.infer<typeof MoneySchema>;
export const SourceSchema = z.object({
  id: z.string(), title: z.string(), publisher: z.string(), url: z.url(),
  kind: z.enum(["manufacturer", "software_publisher", "catalog", "physical_test", "sample"]),
  retrievedAt: z.string(), contentHash: z.string(), location: z.string(),
  summary: z.string(), rights: z.literal("link_and_facts_only"),
});
export type Source = z.infer<typeof SourceSchema>;
export const FactSchema = z.object({
  id: z.string(), property: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().nullable(), sourceIds: z.array(z.string()), scope: z.string(), conditions: z.array(z.string()),
  state: z.enum(["supported", "unknown", "conflicted"]), critical: z.boolean(),
  review: z.object({ status: z.enum(["pending", "reviewed", "rejected"]), reviewer: z.string().nullable(), date: z.string().nullable() }),
});
export type Fact = z.infer<typeof FactSchema>;
export const SignalSchema = z.enum(["audio", "video", "data", "power"]);
export type Signal = z.infer<typeof SignalSchema>;
export const PortSchema = z.object({
  id: z.string(), label: z.string(), connector: z.string(), direction: z.enum(["in", "out", "bidirectional"]),
  signal: SignalSchema, protocols: z.array(z.string()), channels: z.number().int().positive(),
  facts: z.array(z.string()),
});
export type Port = z.infer<typeof PortSchema>;
export const DeviceKindSchema = z.enum(["microphone", "recorder", "interface", "mixer", "camera", "capture", "host", "hub", "headphones", "power", "cable", "storage", "stand"]);
export type DeviceKind = z.infer<typeof DeviceKindSchema>;
export const SelectedOptionSchema = z.object({ name: z.string(), value: z.string() });
export const CatalogBindingSchema = z.object({
  snapshotId: z.string(), productId: z.string(), selectedOptions: z.array(SelectedOptionSchema),
  confirmedAt: z.string(), confirmation: z.literal("user_confirmed_exact_identity"),
});
export const DeviceSchema = z.object({
  id: z.string(), manufacturer: z.string(), model: z.string(), variant: z.string(), kind: DeviceKindSchema,
  version: z.number().int().positive(), shortName: z.string(), description: z.string(),
  ports: z.array(PortSchema), facts: z.record(z.string(), FactSchema),
  catalogId: z.string().nullable(), selectedOptions: z.array(SelectedOptionSchema),
  baseProfileId: z.string().optional(), catalogBinding: CatalogBindingSchema.optional(),
  reviewState: z.enum(["candidate", "sources_collected", "review_pending", "verified_scope", "conflicted"]),
  art: z.literal("original_line_art"), accent: z.string(),
});
export type DeviceProfile = z.infer<typeof DeviceSchema>;
export const RequirementKindSchema = z.enum(["isolated_tracks", "camera_stream", "monitoring", "power", "budget", "reuse", "simultaneous", "connections", "source_review"]);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;
export const RequirementSchema = z.object({
  id: z.string(), label: z.string(), detail: z.string(), kind: RequirementKindSchema,
  hard: z.boolean(), target: z.number().nullable(), confirmed: z.boolean(),
});
export type Requirement = z.infer<typeof RequirementSchema>;
export const GoalSchema = z.object({
  id: z.string(), title: z.string(), brief: z.string(), version: z.number().int().positive(),
  currency: z.literal("USD"), budgetMinor: z.number().int().min(0).max(1_000_000), locale: z.literal("en-US"),
  requirements: z.array(RequirementSchema), requiredOwnedProfileIds: z.array(z.string()),
});
export type Goal = z.infer<typeof GoalSchema>;
export const ComponentSchema = z.object({
  id: z.string(), profileId: z.string(), role: z.string(), owned: z.boolean(), quantity: z.number().int().min(1).max(99),
  position: z.object({ x: z.number(), y: z.number() }),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  inventoryItemId: z.string().optional(), ownershipSource: z.enum(["sample", "user_confirmed"]).optional(),
});
export type Component = z.infer<typeof ComponentSchema>;
export const ConnectionSchema = z.object({
  id: z.string(), from: z.object({ componentId: z.string(), portId: z.string() }),
  to: z.object({ componentId: z.string(), portId: z.string() }),
  signal: SignalSchema, protocol: z.string(), cable: z.string(), enabled: z.boolean(),
  sourceIds: z.array(z.string()),
});
export type Connection = z.infer<typeof ConnectionSchema>;
export const ArchitectureSchema = z.object({
  id: z.enum(["T1", "T2", "T3", "T4"]), name: z.string(), subtitle: z.string(),
  description: z.string(), tradeoff: z.string(), recordingLocation: z.string(),
  requiredFacts: z.array(z.object({ role: z.string(), property: z.string(), expected: z.union([z.string(), z.number(), z.boolean()]) })),
});
export type Architecture = z.infer<typeof ArchitectureSchema>;
export const KitSchema = z.object({
  id: z.string(), kitId: z.string(), revision: z.number().int().positive(), parentRevisionId: z.string().nullable(),
  templateId: z.enum(["T1", "T2", "T3", "T4"]), goal: GoalSchema,
  components: z.array(ComponentSchema), connections: z.array(ConnectionSchema),
  createdAt: z.string(), sourceMode: ProvenanceSchema,
});
export type KitRevision = z.infer<typeof KitSchema>;
export const WitnessSchema = z.object({
  id: z.string(), requirementId: z.string(), ruleId: z.string(), status: TruthSchema,
  title: z.string(), explanation: z.string(), componentIds: z.array(z.string()), connectionIds: z.array(z.string()),
  factIds: z.array(z.string()), sourceIds: z.array(z.string()), nextAction: z.string().nullable(),
});
export type Witness = z.infer<typeof WitnessSchema>;
export const CertificateSchema = z.object({
  id: z.string(), revisionId: z.string(), graphHash: z.string(), ruleVersion: z.string(), sourceHash: z.string(),
  status: TruthSchema, issuedAt: z.string(), sourceMode: ProvenanceSchema,
  results: z.array(WitnessSchema), counts: z.object({ satisfied: z.number(), violated: z.number(), unknown: z.number() }),
  review: z.object({ required: z.number(), reviewed: z.number(), pending: z.number() }),
  scope: z.literal("Computational routing and source-backed constraints; physical performance not tested."),
  physicalTest: z.literal("not_performed"),
});
export type Certificate = z.infer<typeof CertificateSchema>;
export const CatalogOfferSchema = z.object({
  id: z.string(), retailer: z.string(), domain: z.string(), price: MoneySchema.nullable(), availability: z.string(),
  condition: z.string(), observedAt: z.string(), shipping: z.literal("unknown"),
  dimensions: z.object({ length: z.number().nullable(), width: z.number().nullable(), height: z.number().nullable(), unit: z.string() }).optional(),
});
export type CatalogOffer = z.infer<typeof CatalogOfferSchema>;
export const CatalogSnapshotSchema = z.object({
  id: z.string(), productId: z.string(), title: z.string(), brand: z.string().nullable(), description: z.string(),
  selectedOptions: z.array(SelectedOptionSchema), variantExact: z.boolean(), offers: z.array(CatalogOfferSchema),
  detailChecked: z.boolean().optional(),
  variantOptions: z.array(z.object({ name: z.string(), values: z.array(z.object({ value: z.string(), exists: z.boolean(), availability: z.string().nullable(), productId: z.string().nullable() })) })).optional(),
  categoryIds: z.array(z.string()), observedAt: z.string(), source: z.literal("channel3"),
  responseHash: z.string(), sourceMode: z.literal("live"),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;
export type FreshCatalogProduct = { snapshot: CatalogSnapshot; buyLinks: { offerId: string; url: string }[] };
export type CatalogReceipt = {
  id: string; operation: string; status: "succeeded" | "failed"; requestedAt: string; completedAt: string;
  durationMs: number; resultIds: string[]; query: string; mode: "live"; estimatedCredits: number;
  providerRequestId: string | null; error: string | null;
};
export const QuoteSchema = z.object({
  id: z.string(), tenantId: z.string(), revisionId: z.string(), verificationId: z.string(), graphHash: z.string(), quoteHash: z.string(),
  merchantId: z.literal("worldkit-studio"), merchantName: z.literal("WorldKit Studio"),
  items: z.array(z.object({ sku: z.string(), name: z.string(), quantity: z.number().int().positive(), unitMinor: z.number().int().nonnegative(), profileId: z.string().nullable() })),
  total: MoneySchema, createdAt: z.string(), expiresAt: z.string(), policyVersion: z.literal("studio-sandbox.v1"),
  source: z.literal("sample"), checkoutRequired: z.literal(true),
});
export type Quote = z.infer<typeof QuoteSchema>;
export type Event = { id: string; sequence: number; type: string; at: string; title: string; detail: string; sourceMode: Provenance; revisionId: string | null };
export type AssemblyStep = { id: string; index: number; connectionId: string; title: string; instruction: string; test: string; sourceIds: string[]; signal: Signal; componentIds: string[] };
export const ErrorCodeSchema = z.enum(["forbidden", "stale_revision", "invalid_identity", "needs_evidence", "infeasible", "quote_expired", "rate_limited", "provider_unavailable", "capability_requires_approval", "invalid_request", "not_found"]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export class WorldKitError extends Error {
  constructor(public code: ErrorCode, message: string, public status = 400, public nextAction: string | null = null) { super(message); this.name = "WorldKitError"; }
}
export const McpVerifyInput = z.object({
  kit_revision_id: z.string().min(1), expected_graph_hash: z.string().min(1),
  requirement_ids: z.array(z.string()).optional(), freshness_policy: z.enum(["historical", "current_sources"]).optional(),
}).strict();
export const McpRepairInput = z.object({
  kit_revision_id: z.string().min(1), expected_graph_hash: z.string().min(1), failed_requirement_ids: z.array(z.string()).min(1),
  constraints: z.object({ preserve_hard_requirements: z.literal(true), preserve_owned: z.literal(true) }).strict(),
  max_delta_minor: z.number().int().nonnegative().optional(), currency: z.literal("USD").optional(),
}).strict();
export const McpQuoteInput = z.object({
  kit_revision_id: z.string(), verification_id: z.string(), expected_graph_hash: z.string(),
  merchant_id: z.literal("worldkit-studio"), currency: z.literal("USD"), locale: z.literal("en-US"),
}).strict();
export type ToolScope = "kit:verify" | "kit:propose" | "kit:quote";
export type Principal = { tenantId: string; id: string; kind: "judge" | "external"; expiresAt: string; scopes: ToolScope[]; allowedKitIds: string[] };
export type Workspace = {
  session: { id: string; expiresAt: string }; kit: KitRevision; certificate: Certificate;
  profiles: DeviceProfile[]; sources: Source[]; architectures: Architecture[];
  alternatives: { kit: KitRevision; certificate: Certificate }[]; snapshots: CatalogSnapshot[];
  receipts: CatalogReceipt[]; events: Event[]; assembly: AssemblyStep[]; completedSteps: string[];
  repairOptions: { id: string; title: string; description: string; change: string }[];
  usage: { discoveryRequests: number; maxDiscoveryRequests: number; liveRebuilds: number; maxLiveRebuilds: number };
};
