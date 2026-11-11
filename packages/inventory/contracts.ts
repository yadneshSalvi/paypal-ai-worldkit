import { z } from "zod";
import { DeviceKindSchema, DeviceSchema, SelectedOptionSchema } from "../contracts/index";

export const CropSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0.025).max(1), height: z.number().min(0.025).max(1) }).strict().refine(c => c.x + c.width <= 1.000001 && c.y + c.height <= 1.000001, "Keep the crop within the photo.");
export type Crop = z.infer<typeof CropSchema>;
export type InventoryPhoto = { id: string; width: number; height: number; bytes: number; contentHash: string; createdAt: string; sourceMode: "live" | "sample"; status: "active" | "deleting"; imageUrl: string };
export type InventoryRegion = { id: string; photoId: string; label: string; hint: string; crop: Crop; origin: "model_proposal" | "manual"; confirmedAt: string | null; snapshotIds: string[]; jobId: string | null; createdAt: string };
export const InventoryItemSchema = z.object({
  id: z.string(), version: z.number().int().positive(), profile: DeviceSchema,
  ownership: z.enum(["owned", "planned"]), quantity: z.number().int().min(1).max(20),
  condition: z.enum(["new", "used", "unknown"]), accessories: z.array(z.string().max(120)).max(12), notes: z.string().max(1000),
  status: z.enum(["active", "archived"]), origin: z.enum(["catalog", "photo_crop", "manual"]),
  snapshotId: z.string().nullable(), photoId: z.string().nullable(), regionId: z.string().nullable(),
  confirmedAt: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;
export type InventoryHistory = { id: string; itemId: string; version: number; at: string; title: string; detail: string };
export type InventoryProfileChoice = Pick<z.infer<typeof DeviceSchema>, "id" | "baseProfileId" | "basisProfileId" | "corpusId" | "sourceVersion" | "manufacturer" | "model" | "variant" | "kind">;
export type InventoryWorkspace = { items: InventoryItem[]; photos: InventoryPhoto[]; regions: InventoryRegion[]; history: InventoryHistory[]; library: InventoryProfileChoice[]; storageReady: boolean };
export const IdentitySchema = z.object({
  libraryProfileId: z.string().min(1).max(200).nullable(), manufacturer: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(160), variant: z.string().trim().min(1).max(250), deviceKind: DeviceKindSchema,
  ownership: z.enum(["owned", "planned"]), quantity: z.number().int().min(1).max(20),
  condition: z.enum(["new", "used", "unknown"]), accessories: z.array(z.string().trim().min(1).max(120)).max(12), notes: z.string().trim().max(1000),
  confirmedExactIdentity: z.literal(true), confirmedOwnership: z.boolean(),
}).strict().refine(value => value.ownership !== "owned" || value.confirmedOwnership, "Confirm that this equipment is yours.");
export const ConfirmationSchema = z.object({
  requestId: z.uuid(), identity: IdentitySchema, snapshotId: z.string().nullable(), selectedOptions: z.array(SelectedOptionSchema).max(15),
  photoId: z.string().nullable(), regionId: z.string().nullable(),
  targetComponentId: z.string().nullable(), expectedRevisionId: z.string(), expectedGraphHash: z.string().length(64),
  correctItemId: z.string().nullable().default(null), expectedItemVersion: z.number().int().positive().nullable().default(null),
  confirmOwnedReplacement: z.boolean().default(false),
}).strict();
export type InventoryConfirmation = z.infer<typeof ConfirmationSchema>;
export type Identity = z.infer<typeof IdentitySchema>;
export type InventoryPreview = { profile: z.infer<typeof DeviceSchema>; certificate: import("../contracts/index").Certificate | null; previousProfile: string | null; targetComponentId: string | null; changesOwnedConstraint: boolean; warnings: string[] };

export const RegionProposalSchema = z.object({ regions: z.array(z.object({ label: z.string().min(1).max(80), hint: z.string().max(180), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(.025).max(1), height: z.number().min(.025).max(1), uncertainty: z.string().max(300) }).strict()).max(12), explanation: z.string().max(800) }).strict();
export type RegionProposal = z.infer<typeof RegionProposalSchema>;
