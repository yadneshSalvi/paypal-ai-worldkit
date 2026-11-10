import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpQuoteInput, McpRepairInput, McpVerifyInput, WorldKitError, type Principal, type ToolScope } from "../../packages/contracts/index";
import { graphHash, suggestRepairs, verifyKit } from "../../packages/compatibility/index";
import { architectures, sources as currentSources } from "../../packages/device-library/index";
import { editKit } from "../../packages/workbench/index";
import { authenticateAccess, createQuote, getRevision } from "./repository";
import { claimTool, releaseTool, type LimitedTool } from "./tool-limits";
import { trustedOrigin } from "../../packages/security/origin";

export async function authorizeKit(principal: Principal, scope: ToolScope, revisionId: string, expectedHash: string) {
  if (!principal.scopes.includes(scope) || Date.parse(principal.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "The current grant does not allow this operation.", 403);
  const bundle = await getRevision(principal.tenantId, revisionId);
  if (!principal.allowedKitIds.includes(bundle.kit.kitId)) throw new WorldKitError("forbidden", "This kit is outside the current grant.", 403);
  if (bundle.certificate.graphHash !== expectedHash || graphHash(bundle.kit, bundle.profiles) !== expectedHash) throw new WorldKitError("stale_revision", "The expected graph hash does not match this saved revision.", 409);
  return bundle;
}
function success(value: Record<string, unknown>) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value }; }
async function guarded(principal: Principal, tool: LimitedTool, action: () => Promise<Record<string, unknown>>) {
  let lease: string | null = null;
  try { lease = await claimTool(principal, tool); return success(await action()); }
  catch (error) { const known = error instanceof WorldKitError; return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: known ? error.code : "invalid_request", message: known ? error.message : "The tool request could not be completed." } }) }] }; }
  finally { if (lease) await releaseTool(principal, lease); }
}
export function createMcpServer(principal: Principal): McpServer {
  const server = new McpServer({ name: "worldkit", version: "0.1.0" }, { instructions: "WorldKit verifies source-backed physical-system plans. A satisfied modeled check is not a physical test. Unknown critical facts block overall verification. Tools only inspect, propose repairs and create WorldKit Studio sandbox service quotes. They cannot modify a kit, authorize payment, spend a wallet, place retailer orders, or remove constraints." });
  server.registerTool("verify_kit", { title: "Verify a saved kit", description: "Return the exact immutable certificate for an authorized kit revision. Current-sources mode explicitly re-evaluates source availability and returns a new certificate.", inputSchema: McpVerifyInput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, input => guarded(principal, "verify_kit", async () => {
    const bundle = await authorizeKit(principal, "kit:verify", input.kit_revision_id, input.expected_graph_hash);
    if (input.requirement_ids?.some(id => !bundle.kit.goal.requirements.some(r => r.id === id))) throw new WorldKitError("invalid_request", "An unknown requirement was requested.", 400);
    const certificate = input.freshness_policy === "current_sources" ? verifyKit(bundle.kit, bundle.profiles, currentSources, architectures) : bundle.certificate;
    return { certificate, selectedResults: input.requirement_ids ? certificate.results.filter(r => input.requirement_ids!.includes(r.requirementId)) : certificate.results, sourceMode: "modelled", physicalTest: "not_performed" };
  }));
  server.registerTool("repair_kit", { title: "Propose a repair", description: "Generate deterministic repair previews without changing the saved plan. Preserve every hard requirement and owned item. Hardware costs remain unknown unless sourced; a delta cap does not create spending authority.", inputSchema: McpRepairInput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, input => guarded(principal, "repair_kit", async () => {
    const bundle = await authorizeKit(principal, "kit:propose", input.kit_revision_id, input.expected_graph_hash);
    if (input.failed_requirement_ids.some(id => !bundle.certificate.results.some(r => r.requirementId === id && r.status !== "satisfied"))) throw new WorldKitError("invalid_request", "Repair targets must be unresolved requirements on this revision.", 400);
    const proposals = suggestRepairs(bundle.kit, bundle.certificate).map(repair => {
      const kit = editKit(bundle.kit, bundle.certificate, { kind: "repair", repairId: repair.id });
      const certificate = verifyKit(kit, bundle.profiles, bundle.sources, architectures);
      return { ...repair, proposedGraphHash: certificate.graphHash, certificate, requiresUserConfirmation: true, priceDeltaMinor: null, costWithinCap: "unknown", movesMoney: false };
    });
    return { basedOnRevisionId: bundle.kit.id, proposals, preservedHardRequirements: bundle.kit.goal.requirements.filter(r => r.hard).map(r => r.id), preservedOwnedProfiles: bundle.kit.goal.requiredOwnedProfileIds, commitsChanges: false };
  }));
  server.registerTool("quote_kit", { title: "Quote a Studio setup service", description: "Create an expiring, graph-bound WorldKit Studio sandbox service proposal. This is not a retailer equipment quote or checkout authorization. The user must explicitly approve any future checkout.", inputSchema: McpQuoteInput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, input => guarded(principal, "quote_kit", async () => {
    const bundle = await authorizeKit(principal, "kit:quote", input.kit_revision_id, input.expected_graph_hash);
    if (input.verification_id !== bundle.certificate.id) throw new WorldKitError("stale_revision", "The certificate does not belong to this revision.", 409);
    return { quote: await createQuote(principal.tenantId, bundle), hardwareFulfillment: "not_included", paymentAuthorized: false, verificationStatus: bundle.certificate.status };
  }));
  return server;
}
export async function handleMcp(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL)) return Response.json({ error: "Origin is not permitted" }, { status: 403 });
  const header = request.headers.get("authorization");
  const principal = header?.startsWith("Bearer ") ? await authenticateAccess(header.slice(7)) : null;
  if (!principal) return Response.json({ error: "An active scoped WorldKit token is required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } });
  const server = createMcpServer(principal); const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 20000 });
  await server.connect(transport);
  try { const response = await transport.handleRequest(request); response.headers.set("Cache-Control", "no-store"); return response; }
  finally { await server.close(); }
}
