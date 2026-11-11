import { z } from "zod";
import type { CatalogSnapshot, Certificate, Component, DeviceProfile, Goal, KitRevision, Source, Truth, Witness } from "../contracts";
import type { InventoryItem } from "../inventory/contracts";

export const SYNTHESIS_VERSION = "worldkit.synthesis.2" as const;
export const OFFER_MAX_AGE_MS = 15 * 60_000;
export type Bundle = { kit: KitRevision; certificate: Certificate; profiles: DeviceProfile[]; sources: Source[] };
export type OfferObservation = {
  id: string; profileId: string; profileHash: string; productId: string | null;
  selectedOptions: DeviceProfile["selectedOptions"]; snapshotId: string; snapshotHash: string;
  offerId: string; retailer: string; condition: string; currency: string;
  unitMinor: number | null; shippingMinor: number | null; taxMinor: number | null;
  availability: "available" | "unavailable" | "unknown";
  observedAt: string; expiresAt: string; mode: "live" | "sample";
  note: string;
};
export type CostLine = {
  componentId: string; profileId: string; name: string; quantity: number;
  kind: "owned" | "new" | "planned_reuse";
  unitMinor: number | null; subtotalMinor: number | null; shippingMinor: number | null; taxMinor: number | null;
  state: "owned" | "current" | "stale" | "unavailable" | "missing" | "identity_mismatch" | "currency_mismatch";
  observation: OfferObservation | null;
};
export type CostEstimate = {
  currency: "USD"; knownSubtotalMinor: number; landedMinor: number | null;
  shippingMinor: number | null; taxMinor: number | null; complete: boolean;
  mode: "live" | "sample" | "mixed" | "unavailable"; lines: CostLine[];
  missingComponents: string[]; validUntil: string | null;
  scope: "Observed estimate; no quote, reservation or payment authority.";
};
export type Basis = {
  revisionId: string; graphHash: string; goalHash: string; goalVersion: number;
  profilesHash: string; sourcesHash: string; sourceHeadsHash: string; engineeringHash: string;
  inventoryHash: string; offersHash: string; commitmentsHash: string; ruleVersion: string;
};
export type SynthesisInput = {
  base: Bundle; profiles: DeviceProfile[]; sources: Source[]; snapshots: CatalogSnapshot[];
  inventory: InventoryItem[]; offers: OfferObservation[]; basis: Basis;
  purchased: { id: string; version: number; graphHash: string; components: Component[] }[];
  invalidProfileIds: string[]; sourceProblems: { profileId: string; reason: string }[];
  fixture: boolean; now: string;
};
export type ObjectiveVector = {
  landedMinor: number | null; newItems: number; connections: number;
  externalRecordingDependencies: number; spareInputs: number | null; reusedItems: number;
};
export type ComponentDiff = { id: string; kind: "added" | "removed" | "changed" | "retained"; before: Component | null; after: Component | null; beforeName: string | null; afterName: string | null };
export type ConnectionDiff = { id: string; kind: "added" | "removed" | "changed" | "retained"; before: KitRevision["connections"][number] | null; after: KitRevision["connections"][number] | null };
export type GraphDiff = { components: ComponentDiff[]; connections: ConnectionDiff[]; preservedOwned: string[]; storedForLater: string[] };
export type Candidate = {
  id: string; designKey: string; architecture: KitRevision["templateId"]; title: string; subtitle: string;
  bundle: Bundle; cost: CostEstimate; objectives: ObjectiveVector; constraints: Witness[];
  feasible: boolean; state: Truth; nondominated: boolean; dominatedBy: string[];
  labels: ("budget" | "balanced" | "upgrade")[]; tradeoffs: string[]; diff: GraphDiff;
  openPremises: { id: string; profileId: string; property: string; reason: string; sourceIds: string[] }[];
  soundcheck: { supported: boolean; reason: string };
  retainedEquipment: string[]; newEquipment: string[];
};
export type GoalChange =
  | { kind: "budget"; before: number; after: number; requirementId: string; explanation: string }
  | { kind: "tracks"; before: number; after: number; requirementId: string; explanation: string };
export type Relaxation = {
  id: string; title: string; changes: GoalChange[]; proposedGoal: Goal;
  candidateIds: string[]; originalBlockers: string[]; verifiedCandidateCount: number;
  minimal: true; scope: "Smallest changes within the evaluated architecture catalog; not a global market optimum.";
};
export type ComparisonEdition = {
  id: string; kitId: string; sequence: number; previousEditionId: string | null;
  createdAt: string; createdBy: string; hash: string; basis: Basis; sourceMode: "sample" | "modelled";
  originalGoal: Goal; goal: Goal; goalChanges: GoalChange[]; candidates: Candidate[]; relaxations: Relaxation[];
  origin: Bundle; search: { evaluated: number; uniqueArchitectures: number; truncated: boolean; catalogScope: string };
  policy: { dominance: string; budget: string; balanced: string; upgrade: string; ties: string };
  outcome: "feasible" | "research" | "infeasible"; unsatisfied: { id: string; title: string; status: Truth; candidateCount: number }[];
  rebasedPreference: { previousCandidateId: string; matchedCandidateId: string | null } | null;
};
export type Choice = { editionId: string; version: number; candidateId: string | null; appliedRevisionId: string | null; appliedAt: string | null };
export type ChoiceEvent = { version: number; candidateId: string | null; appliedRevisionId: string | null; kind: "opened" | "preferred" | "applied"; createdAt: string };
export type Freshness = { current: boolean; changes: { field: keyof Basis | "offers_expired"; title: string }[]; checkedAt: string };
export type UpgradeStage = {
  id: string; index: number; title: string; candidateId: string; bundle: Bundle; diff: GraphDiff;
  fullSystemCost: CostEstimate; incrementalCost: CostEstimate; reusedFromPreviousStage: string[];
  prerequisites: string[]; evidenceNeeded: string[]; originalOwned: string[];
  status: "proposed"; funding: "not_approved"; fulfillment: "not_performed";
};
export type UpgradeJourney = {
  id: string; editionId: string; kitId: string; createdAt: string; hash: string;
  origin: Bundle; basis: Basis; stages: UpgradeStage[]; title: string;
  purchasedHistory: SynthesisInput["purchased"]; authority: "Planning only. Each later graph needs a fresh review; purchases and repairs require separate authority.";
};
export type ComparisonDetail = { edition: ComparisonEdition; choice: Choice; choiceHistory: ChoiceEvent[]; freshness: Freshness; journeys: UpgradeJourney[] };
export type SynthesisHome = { history: { id: string; sequence: number; createdAt: string; outcome: ComparisonEdition["outcome"]; goal: string; candidateCount: number; selectedCandidateId: string | null; appliedRevisionId: string | null; previousEditionId: string | null; sourceMode: ComparisonEdition["sourceMode"] }[]; current: ComparisonDetail | null; currentRevisionId: string; currentGraphHash: string };

const id = z.string().min(1).max(200);
const expected = { editionId: id, expectedEditionHash: z.string().length(64), expectedChoiceVersion: z.number().int().positive() };
export const SynthesisCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("compare"), requestId: z.uuid(), expectedRevisionId: id, expectedGraphHash: z.string().length(64) }).strict(),
  z.object({ kind: z.literal("prefer"), requestId: z.uuid(), ...expected, candidateId: id }).strict(),
  z.object({ kind: z.literal("apply"), requestId: z.uuid(), ...expected, candidateId: id, acknowledgeOpenQuestions: z.boolean(), acknowledgeGoalChanges: z.boolean(), acknowledgePlanningOnly: z.literal(true) }).strict(),
  z.object({ kind: z.literal("rebase"), requestId: z.uuid(), ...expected, expectedRevisionId: id, expectedGraphHash: z.string().length(64) }).strict(),
  z.object({ kind: z.literal("relax"), requestId: z.uuid(), ...expected, relaxationId: id, acknowledgeGoalChanges: z.literal(true) }).strict(),
  z.object({ kind: z.literal("journey"), requestId: z.uuid(), ...expected, firstCandidateId: id, laterCandidateId: id, acknowledgePlanningOnly: z.literal(true) }).strict(),
]);
export type SynthesisCommand = z.infer<typeof SynthesisCommandSchema>;
export type SynthesisCommandResult = { editionId: string; choiceVersion: number; appliedRevisionId?: string; journeyId?: string };
