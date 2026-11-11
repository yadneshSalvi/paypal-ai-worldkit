import { z } from "zod";

export const ToolkitReadInput = z.object({
  requestId: z.uuid(), orderId: z.string().min(1).max(100),
  expectedGraphHash: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(["get_order", "list_transactions"]),
}).strict();
export type ToolkitReadInput = z.infer<typeof ToolkitReadInput>;
export interface ToolkitOwnedOrder {
  orderId: string; kitId: string; revisionId: string; graphHash: string;
  providerOrderId: string; captureId: string; customId: string; amountMinor: number;
}
export interface ToolkitObservation {
  source: "sandbox" | "synthetic_transport";
  transport: "Toolkit"; package: "@paypal/agent-toolkit@1.11.0";
  operation: ToolkitReadInput["operation"]; observedAt: string; bodyHash: string; httpStatus: number;
  binding: ToolkitOwnedOrder;
  order: null | { status: string; captureStatus: string; amountMinor: number; currency: "USD"; occurredAt: string | null };
  reporting: null | { observed: boolean; status: string | null; amountMinor: number | null; occurredAt: string | null; start: string; end: string; page: 1; pageSize: 100; totalItems: number; totalPages: number; refreshedAt: string | null; complete: false };
  disclosure: string;
}
export interface ToolkitReadRecord {
  id: string; orderId: string; graphHash: string; operation: ToolkitReadInput["operation"];
  state: "running" | "succeeded" | "failed"; createdAt: string; finishedAt: string | null;
  observation: ToolkitObservation | null; message: string;
}
export interface ToolkitDesk {
  available: boolean; mode: "sandbox" | "synthetic_transport"; message: string;
  orders: { id: string; graphHash: string; createdAt: string; capturedMinor: number; purpose: "Studio service" | "Studio amendment" | "Controlled kit amendment" }[];
  records: ToolkitReadRecord[];
}
