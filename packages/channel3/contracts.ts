import { z } from "zod";

export const DiscoveryFiltersSchema = z.object({
  conditions: z.array(z.enum(["new", "used"])).min(1).max(2).default(["new"]),
  maxPriceMinor: z.number().int().positive().max(1_000_000).optional(),
  maxWidthMm: z.number().positive().max(10000).optional(),
  categoryId: z.string().min(1).max(150).optional(),
  attributes: z.record(z.string().max(100), z.array(z.string().max(150)).min(1).max(8)).default({}),
}).strict();
export type DiscoveryFilters = z.infer<typeof DiscoveryFiltersSchema>;
export type CatalogCategory = { id: string; title: string; path: string[]; children: { id: string; title: string }[]; attributes: { id: string; title: string; values: string[] }[] };
export type PriceHistory = {
  productId: string; observedAt: string; points: { at: string; minor: number; currency: string }[];
  statistics: { lowMinor: number; highMinor: number; meanMinor: number; currentMinor: number; status: "low" | "typical" | "high"; currency: string } | null;
};
export type AttributionReport = {
  startAt: string; endAt: string; page: number; hasMore: boolean;
  clicks: { id: string; at: string; productId: string | null; title: string | null }[];
  transactions: { id: string; at: string; productId: string | null; title: string | null; status: string }[];
  scope: "this_workspace_only"; amounts: "omitted_provider_currency_not_returned";
};
