import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpQuoteInput, McpRepairInput, McpVerifyInput, WorldKitError, type Principal, type ToolScope } from "../../packages/contracts/index";
import { graphHash, suggestRepairs, verifyKit } from "../../packages/compatibility/index";
import { architectures, sources as currentSources } from "../../packages/device-library/index";
import { editKit } from "../../packages/workbench/index";
import { authenticateAccess, createQuote, currentAccess, getRevision } from "./repository";
import { claimTool, releaseTool, type LimitedTool } from "./tool-limits";
import { trustedOrigin } from "../../packages/security/origin";
import { privateRecord } from "./public-records";
import { initializePublicRecords } from "./public-record-db";
import { database } from "./db";
import { ToolkitReadInput } from "../../packages/commerce/toolkit-contracts";
import { readPaymentEvidence } from "./payment-evidence";
import { initializeSynthesis } from "./synthesis-db";
import { synthesisHome, synthesisOwner } from "./synthesis";
import { listScopedDomains, readScopedDomain } from "./domain-packs";

export async function authorizeKit(principal: Principal, scope: ToolScope, revisionId: string, expectedHash: string) {
  if (!principal.scopes.includes(scope) || Date.parse(principal.expiresAt) <= Date.now()) throw new WorldKitError("forbidden", "The current grant does not allow this operation.", 403);
  const current = await currentAccess(principal, scope);
  const bundle = await getRevision(principal.tenantId, revisionId);
  if (!principal.allowedKitIds.includes(bundle.kit.kitId) || !current.allowedKitIds.includes(bundle.kit.kitId)) throw new WorldKitError("forbidden", "This kit is outside the current grant.", 403);
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
  const server = new McpServer({ name: "worldkit", version: "0.1.0" }, { instructions: "WorldKit verifies source-backed physical-system plans. A satisfied modeled check is not a physical test. Unknown critical facts block overall verification. Tools inspect kits, propose repairs, create WorldKit Studio sandbox service quotes, and—with a separate payment:read grant—record owned sandbox payment observations. They cannot modify a kit, authorize payment, spend a wallet, place retailer orders, or remove constraints." });
  server.registerTool("verify_kit", { title: "Verify a saved kit", description: "Return the exact immutable certificate for an authorized kit revision. Current-sources mode explicitly re-evaluates source availability and returns a new certificate.", inputSchema: McpVerifyInput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, input => guarded(principal, "verify_kit", async () => {
    if (input.kit_revision_id.startsWith("packrev_")) {
      const record = await readScopedDomain(principal, input.kit_revision_id, input.expected_graph_hash, "certificate", input.freshness_policy);
      if (input.requirement_ids?.some(id => !record.certificate.results.some(result => result.requirementId === id))) throw new WorldKitError("invalid_request", "An unknown domain requirement was requested.");
      return { ...record, selectedResults: input.requirement_ids ? record.certificate.results.filter(result => input.requirement_ids!.includes(result.requirementId)) : record.certificate.results };
    }
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
  if (principal.scopes.includes("payment:read")) server.registerTool("read_payment_evidence", { title: "Read one owned sandbox payment", description: "With the separate payment:read grant, use the official PayPal Toolkit to read an existing owned order or one bounded reporting page for its capture. Pass the application order ID, original graph hash and a unique requestId. Repeating that exact identity returns the saved attempt, never a second provider call. A reporting absence is inconclusive. This records an observation; it cannot change payments, refund, approve or buy equipment.", inputSchema: ToolkitReadInput, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, input => guarded(principal, "read_payment_evidence", async () => ({ record: await readPaymentEvidence({ principal }, input), paymentStateChanged: false })));
  for (const kind of ["certificate", "assembly"] as const) {
    const template = new ResourceTemplate(`worldkit://records/{revisionId}/{graphHash}/{recordId}/${kind}`, { list: async () => {
      const current = await currentAccess(principal, "kit:verify"); await initializePublicRecords();
      const rows = (await database().query("SELECT id,revision_id,edition,payload->>'graphHash' AS graph_hash,payload->>'title' AS title FROM wk_record_editions WHERE tenant_id=$1 AND kit_id=ANY($2::text[]) ORDER BY created_at DESC LIMIT 100", [current.tenantId, current.allowedKitIds])).rows;
      return { resources: rows.map(row => ({ uri: `worldkit://records/${encodeURIComponent(row.revision_id)}/${row.graph_hash}/${row.id}/${kind}`, name: `${kind}-${row.id}`, title: `${row.title} · edition ${row.edition} · ${kind}`, mimeType: "application/json", description: "Private scoped access to an immutable prepared edition. Public sharing does not grant this access." })) };
    } });
    server.registerResource(`saved-${kind}`, template, { title: kind === "certificate" ? "Saved certificate edition" : "Saved assembly guide", mimeType: "application/json", description: "Read the same prepared graph, scope and source-linked steps as the app. Requires a current kit:verify grant. No publication, payment, modification or source-document access." }, async (uri, variables) => {
      let lease: string | null = null;
      try {
        lease = await claimTool(principal, "verify_kit");
        if (typeof variables.revisionId !== "string" || typeof variables.graphHash !== "string" || typeof variables.recordId !== "string") throw new WorldKitError("invalid_request", "Use one exact revision, graph hash and record identity.");
        const resource = await readScopedRecord(principal, variables.revisionId, variables.graphHash, variables.recordId, kind);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(resource) }] };
      } catch (error) {
        throw new McpError(ErrorCode.InvalidRequest, error instanceof WorldKitError ? error.message : "The scoped record could not be read.", { code: error instanceof WorldKitError ? error.code : "invalid_request" });
      } finally { if (lease) await releaseTool(principal, lease); }
    });
  }
  for (const kind of ["comparison", "upgrades"] as const) {
    const template = new ResourceTemplate(`worldkit://systems/{revisionId}/{graphHash}/{editionId}/${kind}`, { list: async () => {
      const current = await currentAccess(principal, "kit:verify"); await initializeSynthesis();
      const rows = (await database().query("SELECT id,sequence,payload->'basis'->>'revisionId' AS revision_id,payload->'basis'->>'graphHash' AS graph_hash,payload->'goal'->>'title' AS title FROM wk_synthesis_editions WHERE tenant_id=$1 AND kit_id=ANY($2::text[]) ORDER BY created_at DESC,id LIMIT 100", [current.tenantId, current.allowedKitIds])).rows;
      await currentAccess(principal, "kit:verify");
      return { resources: rows.map(row => ({ uri: `worldkit://systems/${encodeURIComponent(row.revision_id)}/${row.graph_hash}/${encodeURIComponent(row.id)}/${kind}`, name: `${kind}-${row.id}`, title: `${row.title} · comparison ${row.sequence} · ${kind}`, mimeType: "application/json", description: "An exact immutable planning edition with current freshness, scoped to this kit. No purchase, approval or physical verification." })) };
    } });
    server.registerResource(`system-${kind}`, template, { title: kind === "comparison" ? "Complete system comparison" : "Proposed upgrade journey", mimeType: "application/json", description: "Read the exact system alternatives or proposed upgrade stages and their current staleness. Requires current kit:verify access; grants no modification, repair, payment or fulfillment authority." }, async (uri, variables) => {
      let lease: string | null = null;
      try {
        lease = await claimTool(principal, "verify_kit");
        if (typeof variables.revisionId !== "string" || typeof variables.graphHash !== "string" || typeof variables.editionId !== "string") throw new WorldKitError("invalid_request", "Use an exact saved graph and comparison edition.");
        const value = await readScopedSynthesis(principal, variables.revisionId, variables.graphHash, variables.editionId, kind);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
      } catch (error) {
        throw new McpError(ErrorCode.InvalidRequest, error instanceof WorldKitError ? error.message : "The scoped system facts could not be read.", { code: error instanceof WorldKitError ? error.code : "invalid_request" });
      } finally { if (lease) await releaseTool(principal, lease); }
    });
  }
  for (const kind of ["certificate", "assembly"] as const) {
    const template = new ResourceTemplate(`worldkit://domains/{projectId}/{editionId}/{graphHash}/${kind}`, { list: () => listScopedDomains(principal, kind) });
    server.registerResource(`domain-${kind}`, template, { title: kind === "certificate" ? "Domain system certificate" : "Domain assembly guide", mimeType: "application/json", description: "Read an exact saved domain edition with current source and equipment freshness. The explicit project grant is read-only; no modification, review promotion, purchase or physical verification." }, async (uri, variables) => {
      let lease: string | null = null;
      try {
        lease = await claimTool(principal, "verify_kit");
        if (typeof variables.projectId !== "string" || typeof variables.editionId !== "string" || typeof variables.graphHash !== "string") throw new WorldKitError("invalid_request", "Choose one exact domain system, edition and graph hash.");
        const value = await readScopedDomain(principal, variables.editionId, variables.graphHash, kind, "historical", variables.projectId);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
      } catch (error) { throw new McpError(ErrorCode.InvalidRequest, error instanceof WorldKitError ? error.message : "The domain evidence could not be read.", { code: error instanceof WorldKitError ? error.code : "invalid_request" }); }
      finally { if (lease) await releaseTool(principal, lease); }
    });
  }
  return server;
}

export async function readScopedSynthesis(principal: Principal, revisionId: string, expectedHash: string, editionId: string, kind: "comparison" | "upgrades") {
  const bundle = await authorizeKit(principal, "kit:verify", revisionId, expectedHash);
  const home = await synthesisHome(synthesisOwner({ id: principal.tenantId, expiresAt: principal.expiresAt, discoveryRequests: 0, liveRebuilds: 0 }), editionId);
  const detail = home.current;
  if (!detail || detail.edition.kitId !== bundle.kit.kitId || detail.edition.basis.revisionId !== revisionId || detail.edition.basis.graphHash !== expectedHash) throw new WorldKitError("stale_revision", "This comparison belongs to a different exact source graph.", 409);
  await currentAccess(principal, "kit:verify");
  return { schema: `worldkit.scoped-${kind}.v1`, access: "scoped_private", editionId, editionHash: detail.edition.hash, revisionId, graphHash: expectedHash,
    sourceMode: detail.edition.sourceMode, freshness: detail.freshness, physicalTest: "not_performed", authority: "Read-only planning facts; no purchase, funding, fulfillment or repair permission.",
    ...(kind === "comparison" ? { edition: detail.edition, choice: detail.choice, choiceHistory: detail.choiceHistory } : { journeys: detail.journeys }) };
}

export async function readScopedRecord(principal: Principal, revisionId: string, expectedHash: string, recordId: string, kind: "certificate" | "assembly") {
  await authorizeKit(principal, "kit:verify", revisionId, expectedHash);
  const record = await privateRecord({ id: principal.tenantId, expiresAt: principal.expiresAt, discoveryRequests: 0, liveRebuilds: 0 }, recordId);
  if (record.payload.revisionId !== revisionId || record.payload.graphHash !== expectedHash) throw new WorldKitError("stale_revision", "This edition does not belong to the requested saved graph.", 409);
  await currentAccess(principal, "kit:verify");
  const identity = { recordId: record.id, edition: record.edition, contentHash: record.contentHash, revisionId, graphHash: expectedHash, certificateId: record.payload.certificateId, sourceHash: record.payload.sourceHash, ruleVersion: record.payload.ruleVersion, physicalTest: record.payload.physicalTest, access: "scoped_private", sharingState: record.state };
  return kind === "certificate" ? { schema: "worldkit.scoped-certificate.v1", ...identity, payload: record.payload } : { schema: "worldkit.scoped-assembly.v1", ...identity, title: record.payload.title, devices: record.payload.devices, connections: record.payload.connections, assembly: record.payload.assembly, sources: record.payload.sources, limitations: record.payload.limitations };
}
export async function handleMcp(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !trustedOrigin(request, process.env.WORLDKIT_PUBLIC_URL, process.env.VERCEL_URL)) return Response.json({ error: "Origin is not permitted" }, { status: 403 });
  const header = request.headers.get("authorization");
  const principal = header?.startsWith("Bearer ") ? await authenticateAccess(header.slice(7)) : null;
  if (!principal) return Response.json({ error: "An active scoped WorldKit token is required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } });
  const server = createMcpServer(principal); const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 20000 });
  await server.connect(transport);
  try { const response = await transport.handleRequest(request); response.headers.set("Cache-Control", "no-store"); return response; }
  finally { await server.close(); }
}
