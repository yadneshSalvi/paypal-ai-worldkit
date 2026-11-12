/** Shapes of the curated dossier and of the independent source-check record. */
export type DossierValue = string | number | boolean;
export type DossierDevice = {
  id: string; manufacturer: string; model: string; variant: string; kind: string; shortName: string; description: string; accent: string;
  sources: { id: string; title: string; publisher: string; url: string; kind: "manufacturer" | "software_publisher"; location: string }[];
  ports: { id: string; label: string; connector: string; direction: "in" | "out" | "bidirectional"; signal: "audio" | "video" | "data" | "power"; protocols: string[]; channels: number; integral?: boolean; sourceId: string; quote: string; locator: string }[];
  facts: { property: string; value: DossierValue; unit: string | null; conditions: string[]; critical: boolean; sourceId: string; quote: string; locator: string; note: string | null }[];
  unknowns: { property: string; reason: string }[];
  operatingModes: { id: string; label: string; settings: Record<string, DossierValue | DossierValue[]>; enables: string[]; sourceId: string; quote: string; locator: string }[];
};
export type Dossier = { schema: "worldkit.dossier.1"; extractor: string; devices: DossierDevice[] };
export type SourceCheckVerdict = "confirmed" | "refuted" | "insufficient" | "quote_not_found" | "not_run";
export type SourceCheckItem = {
  id: string; deviceId: string; kind: "fact" | "port" | "mode"; property: string; value: DossierValue; sourceId: string;
  quote: string; quoteHash: string; page: number | null; verdict: SourceCheckVerdict; reason: string; receiptId: string | null; checkedAt: string;
};
export type SourceCheckFile = {
  schema: "worldkit.source-checks.1"; method: "quote_located+independent_model"; extractor: string; checker: string; ranAt: string;
  dossierHashes: Record<string, string>;
  sources: { id: string; url: string; title: string; publisher: string; kind: "manufacturer" | "software_publisher"; location: string; retrievedAt: string; contentHash: string; textHash: string; mediaType: string }[];
  items: SourceCheckItem[];
  receipts: { id: string; deviceId: string; model: string; requestedAt: string; completedAt: string; inputHash: string; promptHash: string; outputHash: string; responseId: string | null; inputTokens: number | null; outputTokens: number | null }[];
  summary: { devices: number; items: number; confirmed: number; refuted: number; insufficient: number; quoteNotFound: number; notRun: number };
};
