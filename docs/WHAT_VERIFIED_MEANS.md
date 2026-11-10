# What WorldKit has and has not verified

Updated 11 November 2026. This is an evidence ledger, not a blanket readiness claim.

## Evidence modes

| Label | Meaning |
| --- | --- |
| Live | The named provider was called and returned the recorded result. A catalog response is not an order or fulfillment. |
| Live · Sandbox | An actual PayPal sandbox resource or money operation was observed in this project's own merchant. It is not real-money production evidence. |
| Modelled | A deterministic computational rule or generated audio signal, with explicit inputs. It is not a measurement of physical equipment. |
| Sample | Declared fixture inputs, account-independent tests or an illustrative event. It is not a captured production incident. |
| Replay | A recorded event replay, only where an actual underlying event and its provenance exist. A hand-authored event stays Sample. |

## Observed local results

- **44 unit and actual SDK wire tests passed**, including graph/source invariants, waveform samples, exact v3 Vault bodies, safe errors, no automatic write retry, owned-token checks, origin handling and authenticated encryption.
- **22 PostgreSQL integration tests passed**, including immutable revisions, optimistic races, tenant isolation, MCP revocation, restart persistence, quote/payment duplicates, altered authority refusal, cumulative repair races, gross cap after refunds, claim-before-transport, encrypted payment documents, revocation-before-provider-delete, retirement after a base refund, per-tool rate/concurrency gates and deployment-wide creation races.
- TypeScript and the Next.js 16.4.6 production build passed. Node is pinned to 22.x.
- Actual HTTP checks confirm that a fresh workspace consumes one global quota unit, an existing cookie reuses the same workspace without consuming another unit, reads remain available, and a foreign origin is rejected. See [workspace HTTP evidence](evidence/workspace-http-qualification.json).
- Live Channel3 qualification: three searches, product details, similar products, categories and price history. Sanitized receipts are in [channel3-qualification.json](evidence/channel3-qualification.json). The initial `/v1/v1` endpoint mistake and its actual failures remain in [the initial failure evidence](evidence/channel3-initial-endpoint-failure.json); the adapter normalizes the documented SDK base path.
- Live structured model qualification: Gemini `gemini-3.8-flash` and OpenAI `gpt-6-astra` at maximum reasoning returned schema-valid goal proposals. These individual requests do not measure accuracy. See [model qualification](evidence/model-qualification.json).
- A real MCP SDK client used the HTTP endpoint and received the same immutable certificate as the workbench; stale/foreign/revoked operations were refused. See [MCP qualification](evidence/mcp-qualification.json).
- Root in-app-browser review observed working condenser/48V repair, disconnected source recovery, actual changing soundcheck meters, a valid mono 24 kHz/16-bit WAV, live eight-result Channel3 search, current retailer offers with used/new condition and unknown landed costs, saved guide checks, a 390 px layout without horizontal overflow, and modal focus restoration. Private screenshots are excluded from this repository.

## Open capability gates

The current hero library has eleven exact candidate profiles. Its critical facts still need independent human review. Ten of twelve source documents have locally retrieved content hashes; other sources and missing power/bandwidth/app-specific facts remain explicit. No physical rig or physical recording is claimed. The default certificate is therefore not overall green.

WorldKit's own real sandbox buyer flow has now passed: an itemized $12 capture, saving during purchase and an independent owned-token read, an $8 merchant-initiated saved-wallet amendment, $20/$60 escalations with $17 left, completed full refunds of $8 and $12, local consent revocation and provider token deletion confirmed by a 404 reread. Exactly two domain orders and five provider operations were recorded. Current provider order itemization, captures and refunds were reread without another financial mutation. [Safe qualification evidence](evidence/paypal-worldkit-qualification.json) excludes token/customer/payer identifiers and proves their encrypted storage.

Root review found a genuine lifecycle defect: the original refund left the repair policy displayed as active. It is fixed in both the domain and UI, with PostgreSQL regression tests. Refunding the base, fulfilling it or revoking the wallet closes the authority; the $8 gross history remains. The completed qualification's local policy projection was retired for the same reason. This is a disclosed fix, not a claim that the initial implementation was flawless.

Authentic deployed webhooks remain an open gate. The observed checkout sells the declared Studio digital service; it does not prove physical kit procurement, live retailer stock-driven repair, a production mandate or first-ever buyer wallet enrollment.

Further full-scope work remains: confirmed photo-region inventory, deeper catalog/variant selection and subscriptions with real Svix delivery, the 60-profile reviewed target library, source extraction and the ≥200-assertion/≥20-device held-out evaluation with two human reviewers, durable job recovery and deployed webhook workers, scoped PayPal Agent Toolkit, public-safe shareable certificates, broader reviewed domain packs, collaboration/review and upgrade workflows, physical manifest, consented customer study, original release media and final release documentation. These are retained requirements, not silently removed scope.

Current generated audio is an original routing test signal. Neutral original line art avoids claiming permission to reuse product photographs. Human participants, equipment access and rights outreach are pending user choices; none are fabricated by the application or this evidence file.
