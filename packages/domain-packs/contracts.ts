import { z } from "zod";
import { CertificateSchema, ComponentSchema, ConnectionSchema, DeviceSchema, SourceSchema } from "../contracts";

export const PACK_SCHEMA = "worldkit.domain-pack.1" as const;
export const PackIdSchema = z.enum(["desk-displays", "podcast-classroom"]);
export type PackId = z.infer<typeof PackIdSchema>;
export const PackProfileSchema = DeviceSchema.extend({ kind: z.enum(["host", "display", "recorder", "microphone", "headphones", "power", "cable", "storage", "accessory"]) });
export type PackProfile = z.infer<typeof PackProfileSchema>;
export const DeskConfigSchema = z.object({
  packId: z.literal("desk-displays"), host: z.enum(["air-m2", "air-m3"]), displays: z.number().int().min(1).max(2),
  lid: z.enum(["open", "closed"]), macos: z.enum(["14.2", "14.3", "14.6", "15", "26"]),
  externalInputs: z.boolean(), powerConnected: z.boolean(), directPorts: z.boolean(),
}).strict();
export const PodcastConfigSchema = z.object({
  packId: z.literal("podcast-classroom"), recorder: z.enum(["podtrak-p4", "podtrak-p8"]),
  participants: z.number().int().min(2).max(6), destination: z.enum(["sd_card", "usb_host"]),
  storageConfirmed: z.boolean(), powerConfirmed: z.boolean(), keepTrackFiles: z.boolean(),
}).strict();
export const PackConfigSchema = z.discriminatedUnion("packId", [DeskConfigSchema, PodcastConfigSchema]);
export type PackConfig = z.infer<typeof PackConfigSchema>;
export const PackOwnershipSchema = z.object({
  componentId: z.string().min(1).max(120), inventoryItemId: z.string().min(1).max(200), inventoryVersion: z.number().int().positive(),
  profileHash: z.string().length(64), quantity: z.number().int().positive(),
}).strict();
export type PackOwnership = z.infer<typeof PackOwnershipSchema>;
export const PackStateSchema = z.object({
  config: PackConfigSchema, disabledConnections: z.array(z.string().min(1).max(120)).max(30),
  ownership: z.array(PackOwnershipSchema).max(30), budgetMinor: z.number().int().min(0).max(1_000_000),
}).strict();
export type PackState = z.infer<typeof PackStateSchema>;
export type PackRequirement = { id: string; label: string; detail: string; hard: true; target: number | null };
export type PackManifest = {
  schema: typeof PACK_SCHEMA; id: PackId; version: string; ruleVersion: string; name: string; eyebrow: string;
  description: string; promise: string; accent: string; defaultState: PackState; sourceIds: string[];
  coverage: string[]; exclusions: string[]; actualHumanReviews: 0; physicalTests: 0;
};
export const PackGraphSchema = z.object({
  id: z.string(), projectId: z.string(), edition: z.number().int().positive(), parentEditionId: z.string().nullable(),
  packId: PackIdSchema, packVersion: z.string(), templateId: z.string(), title: z.string(),
  state: PackStateSchema, components: z.array(ComponentSchema), connections: z.array(ConnectionSchema),
  createdAt: z.string(), sourceMode: z.literal("modelled"),
});
export type PackGraph = z.infer<typeof PackGraphSchema>;
export const PackEditionSchema = z.object({
  schema: z.literal("worldkit.domain-edition.1"), id: z.string(), projectId: z.string(), number: z.number().int().positive(),
  hash: z.string().length(64), packHash: z.string().length(64), graph: PackGraphSchema, certificate: CertificateSchema,
  profiles: z.array(PackProfileSchema), sources: z.array(SourceSchema), reason: z.string(), createdAt: z.string(),
});
export type PackEdition = z.infer<typeof PackEditionSchema>;
export type PackFreshness = { current: boolean; issues: { kind: "pack" | "inventory" | "source"; message: string; componentIds: string[] }[] };
export type PackProject = { id: string; packId: PackId; title: string; currentEditionId: string; version: number; createdAt: string; archivedAt: string | null };
export type PackChange = { field: string; before: string; after: string };
export type PackPreview = {
  id: string; hash: string; expectedEditionId: string; expectedVersion: number; expectedGraphHash: string;
  packHash: string; state: PackState; edition: PackEdition; changes: PackChange[]; expiresAt: string;
  reason: string; freshness: PackFreshness;
};
export type PackGuide = { id: string; index: number; connectionId: string | null; title: string; instruction: string; sourceIds: string[]; enabled: boolean };
export type PackHome = {
  manifests: PackManifest[]; projects: PackProject[]; selected: null | {
    project: PackProject; edition: PackEdition; currentGraphHash: string; history: { id: string; number: number; hash: string; createdAt: string; reason: string }[];
    freshness: PackFreshness; requirements: PackRequirement[]; guide: PackGuide[];
    inventory: { id: string; version: number; label: string; profileId: string; profileHash: string; quantity: number; compatibleComponents: string[] }[];
    grants: { id: string; expiresAt: string; revokedAt: string | null }[];
  };
};
const CommandIdentity = { requestId: z.uuid() };
const Current = { projectId: z.string().min(1).max(200), expectedEditionId: z.string().min(1).max(200), expectedVersion: z.number().int().positive(), expectedGraphHash: z.string().length(64) };
export const PackCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), ...CommandIdentity, packId: PackIdSchema, title: z.string().trim().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("preview"), ...CommandIdentity, ...Current, state: PackStateSchema, reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ kind: z.literal("apply"), ...CommandIdentity, ...Current, previewId: z.string().min(1).max(200), previewHash: z.string().length(64) }).strict(),
  z.object({ kind: z.literal("restore_preview"), ...CommandIdentity, ...Current, restoreEditionId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("refresh_preview"), ...CommandIdentity, ...Current }).strict(),
  z.object({ kind: z.literal("archive"), ...CommandIdentity, ...Current }).strict(),
  z.object({ kind: z.literal("grant"), ...CommandIdentity, ...Current, confirmedReadOnly: z.literal(true) }).strict(),
  z.object({ kind: z.literal("revoke_grant"), ...CommandIdentity, projectId: z.string().min(1).max(200), grantId: z.string().min(1).max(200) }).strict(),
]);
export type PackCommand = z.infer<typeof PackCommandSchema>;
export type PackCommandResult = { projectId: string; editionId?: string; preview?: PackPreview; archived?: true; grant?: { id: string; token?: string; expiresAt: string }; revoked?: true };
