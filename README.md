# WorldKit

A creator workbench for turning a goal into a complete physical-system plan, with exact equipment profiles, source-linked checks, an audible routing model and a durable sandbox purchase record.

The inventory and source-reading integration checkpoints are running at [WorldKit on Vercel](https://paypal-ai-worldkit.vercel.app). Hosted checks include an actual manufacturer PDF, private storage, Gemini reading, saved candidate and tenant isolation. It remains under active development; physical testing, independent source review, complete engineering port maps, several broader integrations and release assets are still open. See [evidence and limitations](docs/WHAT_VERIFIED_MEANS.md).

## Run locally

Use Node **22.x** (tested with 22.22.3), npm 10.9.8, Git and PostgreSQL. Start with a fresh database/user and independent local secrets; leave optional provider keys empty for the initial Sample. The [complete setup and release guide](docs/RELEASE_READINESS.md) covers database creation, SDK install/transport, private Blob storage, optional providers and safe staging of existing data.

```sh
npm ci
cp .env.example .env
# Configure the new database, AUTH_SECRET and CRON_SECRET locally.
# Add WORLDKIT_DISABLE_PROVIDERS=true for the initial Sample run.
```

Then use the guide's guarded Sample launch to clear inherited connection/provider values before migration and startup. An empty key in `.env` does not override a key already inherited from your shell.

Open http://localhost:4106 and choose **Start Sample**. Passive visits only check for an existing workspace; they create nothing. The explicit action creates a private, durable Sample workbench with a seven-day opaque session. If its response is lost, **Recover this Sample** uses the original saved request and keeps the original expiry. [Entry and recovery contract](docs/EXPLICIT_SAMPLE_ENTRY.md). A deployment-wide PostgreSQL backstop admits at most 30 new workspaces/hour and 200/day; an existing cookie reopens its current workspace and existing work remains usable. The workbench also supports http://127.0.0.1:4106; loopback aliases are permitted only on that port with matching Host checks. Deployed writes require matching Host and Origin for the configured public URL or the exact server-provided Vercel deployment hostname. Other preview or branch aliases are not automatically trusted.

```sh
node --experimental-strip-types --test tests/release-inputs.test.ts
node scripts/check-release.mjs
```

These bounded source checks use no environment file, database, runtime or provider. [Dependency checks and residual findings](docs/DEPENDENCY_REVIEW.md) are recorded separately; the current full/production audit retains 10 findings (9 high, 1 moderate). Database/build/native qualification needs its own isolated exact-source workflow. Credentialed scripts (`qualify:catalog`, `qualify:models`, `qualify:inventory`) make real external requests and may consume account quota.

Deliberate MCP verification uses `npm run verify:mcp -- --input /absolute/private-input.json --output /absolute/new-receipt.json`, with an existing private grant and exact saved certificate/revision. It loads no implicit `.env`, creates no workspace/grant/quote, and preserves new receipt/journal paths; request counters can change. [Strict input, permissions and recovery contract](docs/RELEASE_READINESS.md#mcp-verification-with-existing-authority).

## What works

- A spatial graph and accessible connection list, requirement editing, source inspection, explicit failure witnesses and deterministic repairs.
- A six-step guided creator journey that listens to the saved graph, previews a condenser conflict, applies an explicitly approved repair, and keeps unresolved evidence visible. Exact preview consent, durable same-request recovery and scoped navigation connect complete-system comparison, commerce and retained test/research evidence. [Journey and recovery contract](docs/GUIDED_JOURNEY.md).
- Persisted complete-system comparison editions with whole-graph costs and resource checks, distinct Pareto choices, visible rejected candidates, explicit hard-goal relaxations, separate preference/application, stale-evidence rebase, immutable choice history and conditional staged upgrades. Local six-case and hosted API/browser qualification preserve original graphs and financial history. The ordinary hosted catalog keeps unresolved research visible; comparison creates no purchase or repair authority. [System synthesis contract](docs/SYSTEM_SYNTHESIS.md), [independent native qualification](docs/evidence/system-synthesis-native-qualification.json), and [hosted release receipt](docs/evidence/system-synthesis-hosted-qualification.json).
- Immutable PostgreSQL revisions/certificates, optimistic version checks, tenant isolation, append-only events and resumable jobs with leased workers, bounded retries, cancellation and durable attempt receipts.
- Real Channel3 discovery, exact variant refresh, category/attribute browsing, condition/price/dimension filters, observed price history, product URL lookup and workspace-scoped attribution. Fresh retailer URLs are excluded from persisted snapshots; original diagrams are used instead of unlicensed product images.
- An equipment passport with private photo upload, editable model region proposals, user-confirmed crop search, exact model/ownership review, quantities, accessories, condition and history. Placing or correcting an item previews the whole kit, commits an immutable profile and preserves older proofs. Unknown engineering facts remain unknown.
- Direct OpenAI and Gemini structured goal and photo-region proposals, saved as recoverable jobs. Models propose; the deterministic compiler decides verification.
- A reading room for 60 exact manufacturer-source candidates. Private document copies, source fingerprints, selected text pages, traceable model proposals, unanswered review questions and immutable candidate versions remain separate. Saving a candidate never approves its claims or records ownership. [Source-reading method](docs/SOURCE_READING.md).
- An engineering reading room with actor-bound specialist roles, expiring single-use copy-link invitations, exact immutable review editions, source and port-map editing, keyboard image anchors, retained disagreements, two-person critical adjudication, guarded scoped profile promotion and dependent-kit impact. Sample software qualification stays separate from genuine human review and physical evidence. [Review policy, isolated qualification and native protocol](docs/ENGINEERING_REVIEW.md).
- Sixty retained primary-provider source drafts contain 478 located proposals, 216 unknowns, three conflicts and one rejected proposal. All 858 citation anchors match the retained source text. The separate 323-assertion, 30-device held-out run finished across Astra and Gemini; its reference remains an unreviewed AI draft, so human accuracy and semantic support precision are not reported. [Corpus audit](docs/evidence/corpus-library-qualification.json).
- Actual Web Audio routing from the saved graph, isolated model buses, downstream disconnection behavior and downloadable PCM WAV files. The original test signals are labelled **Modelled**, not a hardware recording.
- A deployed **Cart lab** with a separate Sample merchant, exact desk/podcast editions, full cart replacement, version-specific buyer approval, changed-price refusal, immutable history and one durable Sample settlement. The pinned official Cart API client passed real HTTP/PostgreSQL and hosted qualification; no retailer purchase or genuine Store Sync enrollment is implied. [Interoperability contract](docs/CART_INTEROPERABILITY.md) and [hosted/native release receipt](docs/evidence/cart-hosted-qualification.json).
- Scoped Streamable HTTP MCP tools: `verify_kit`, `repair_kit`, `quote_kit`. An actual external SDK client has matched the browser's immutable certificate and tested stale/foreign/revoked requests. These tools do not authorize payment or mutate a saved kit. PostgreSQL enforces 60 verifications/minute, 5 repair proposals/hour, 2 quotes/minute and at most 2 concurrent tools per grant.
- A deployed **Proof → Certificate** workflow prepares an exact public-safe preview, records its explicit review, then publishes it through a separate action. Immutable editions, logical connection maps, source and rule fingerprints, mobile assembly guides, A4/Letter print views and edition-specific QR codes retain unresolved facts and `physicalTest: not_performed`. Withdrawal closes all public editions; private source removal and session expiry also withhold dependent public records. Scoped MCP certificate and assembly resources use the existing kit grant. Native mobile/print and hosted publication/MCP checks passed; [the release receipt](docs/evidence/certificate-hosted-qualification.json) records migration and original-data continuity. [Public record contract and isolated QA](docs/PUBLIC_RECORDS.md).
- The **Studio** view offers an itemized $12 digital routing dossier and connection guide, with graph-bound PayPal sandbox create/approval/capture, save-during-purchase consent, owned-order/token reads, separately labelled Vault setup fallback, revocation and compensating full refunds before delivery within 24 hours.
- A separate $25 cumulative repair authority for unfulfilled Studio digital service orders. Server-owned sample events exercise actual sandbox saved-wallet payment when that account is qualified. Pending claims count; refunds do not restore the allowance; a larger change requires new approval.
- A **Living kit** milestone with exact-variant merchant alerts, signed Channel3/PayPal receivers, duplicate/conflict receipts, durable recovery, fresh stock review incidents and private notifications. Payment callbacks only reread accepted resources and preserve gross history. Three original PayPal callback signatures were re-verified through actual postback; Channel3 delivery, external resource ownership and fresh/duplicate callback qualification remain open. [Receiver and ownership contract](docs/LIVING_KIT.md), [original signature evidence](docs/evidence/paypal-webhook-original-signature-qualification.json).
- A persisted **Repair workshop** that follows an incident through dependency tracing, exact alternatives, critical-fact checks, immutable proposals and controlled merchant commitments. Fresh kit authority, cumulative gross limits, interrupted-operation recovery, separate compensation and conditional undo are complete in the explicit Sample workflow. Sample engineering premises, actual catalog observations and PayPal sandbox receipts retain separate labels. [Living Repair contract and local workflow](docs/LIVING_REPAIR.md).

A catalog product is not retailer procurement. The Studio service does not sell or ship physical gear. Its dossier preserves unresolved compatibility facts. WorldKit's own observed buyer-present $12 capture, save-during-purchase, $8 saved-wallet amendment, $20/$60 escalation, full $8+$12 refunds and token deletion are recorded in [project qualification evidence](docs/evidence/paypal-worldkit-qualification.json). These observations remain separate from sample SDK/database tests and another project's payment evidence.

The deployed **Test notebook** workflow binds a physical report to one saved creator or domain system, records exact conditions and immutable observations, retains private original bytes with hashes/waveforms, and supports scoped review of a sealed manifest. Generated Samples stay explicit, unknowns and failures remain visible, and no physical test or actual human review is inferred. [Workflow, storage, rights and retention](docs/PHYSICAL_NOTEBOOK.md). Actual private Blob upload, authenticated provider callback, byte verification, explicit attachment and sealing passed with one generated Sample WAV. Real equipment, reviewer findings and provider deletion/retention remain separate gates. [Hosted/native release receipt](docs/evidence/notebooks-hosted-qualification.json).

The deployed **Research notebook** workflow declares tasks and separate dated permissions, records explicit attempts and outcomes, preserves failed first attempts through retries, and reports exact protocol cohorts with private or permitted aggregate exports. It records source changes during repair tasks and withholds private text when current or original consent ends. Sample and operator-recorded studies remain distinct; recruitment and independent human-performance findings are not inferred. [Study workflow, consent and metric definitions](docs/RESEARCH_NOTEBOOK.md), [hosted/native release receipt](docs/evidence/notebooks-hosted-qualification.json).

## Integrations and boundaries

| Integration | Current implementation |
| --- | --- |
| APIMatic PayPal | `paypal` 2.29.0, Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`; typed Orders, Payments and Vault calls. This is not `@paypal/paypal-server-sdk`. |
| Shared guarded executor | Immutable `@fracture/paypal-core` 0.2.4 archive, SHA-256 `5c03e848a603c91f98f213c9bfee2e5e4ccb00fd54946ae349945c55f53c3f0f`. Domain policy, PostgreSQL claims, exact cents, supported PayPal request IDs and conservative reconciliation. |
| Channel3 | Official `@channel3/sdk` 4.9.0 and real account-qualified product reads. Selected options and offer condition are preserved. |
| Living Kit events | Svix 2.10.0 raw verification, PayPal postback verification, encrypted original receipts, exact ownership routing and leased read-only projection. Local tests are Sample; authentic delivery proof is a separate gate. |
| OpenAI / Gemini | Direct server-side SDKs, structured schemas and prompt/input/output hashes; no secrets in prompts. |
| MCP | Official SDK 1.32.2, exact scopes and schema checks; no financial tools. |
| Storage | PostgreSQL for authority, immutable revisions, model request identities and leased jobs; private Vercel Blob for sanitized equipment photos, manufacturer source copies and explicitly retained notebook originals. Full source text is never served by the public evidence API. |
| Hosting | Next.js 16.4.6 / React 19.3.1 on Vercel Node 22. Hosted session/quote isolation, live catalog search and a reviewed OpenAI proposal were independently exercised; see [HTTP checks](docs/evidence/hosted-http-qualification.json) and [provider qualification](docs/evidence/hosted-provider-qualification.json). |

The [PayPal implementation contract](paypal-plan.md) records the actual SDK maps, authority boundaries, error/unknown-state handling and revision history. [APIMatic setup](APIMATIC_SETUP.md) preserves skill provenance. The shared package's provenance is in `vendor/`.

## Equipment and background work

Open **Equipment** to add a labelled photo, public HTTPS product URL or exact model. Photos are re-encoded without original filenames or location metadata, stored in a private Blob store and served through an authenticated route. Model-suggested regions remain proposals; confirm a crop before catalog image search, then confirm the exact model and ownership separately. Removing a photo removes access immediately and queues private-file deletion. Expired seven-day workspaces and interrupted uploads are cleaned by recovery; historical equipment confirmations retain their non-image fingerprints.

Configure `BLOB_READ_WRITE_TOKEN` for a **private** Blob store. `OPENAI_VISION_MODEL` and `GEMINI_VISION_MODEL` optionally override the configured goal models. `POST /api/planner` now accepts `{ brief, provider, requestId }` and returns a saved job with HTTP202; `GET /api/jobs` and `GET /api/jobs?id=…` return only this workspace’s work. Long reads are fenced with a lease, preserve attempt receipts, and cannot apply equipment or goals without confirmation. These workers never dispatch payments.

The checked-in Vercel cron runs `GET /api/jobs/recover` every minute, authenticated by `CRON_SECRET` (at least 24 characters); the deployment plan must support that cadence. Browser polling also resumes work. A process crash can repeat an ordinary provider read after its lease expires; the old worker cannot commit late output. Source extraction records its model operation before dispatch, resumes a saved OpenAI background response, and never repeats an ambiguous dispatch automatically. Hosted inventory recovery returned successful automatic cron responses; see [hosted runtime evidence](docs/evidence/worldkit-inventory-runtime-summary.json).

Run `npm run qualify:inventory` to exercise actual Blob/catalog/model operations on an original, explicitly synthetic equipment illustration. The script makes no equipment purchase or physical-performance claim. The observed qualification and disclosed URL lookup failures are in [inventory evidence](docs/evidence/inventory-qualification.json).

Open **Proof → Source library** to inspect the exact manufacturer scope, save a private copy, select pages and ask Gemini or Astra for proposed facts. A located quotation proves where text was found; it does not establish that the proposed interpretation is correct. Astra may take several minutes and resumes its original response across worker restarts. Removing a private copy purges its document text after any pending upload settles, while historical fingerprints and saved candidate versions remain. Public certificate editions derived from that copy are withheld. [Actual source-workflow qualification](docs/evidence/source-workflow-qualification.json) covers both providers, restart recovery, cancellation, candidate placement and private-copy deletion.

## Sandbox buyer workflow

Open **Studio**, review the exact service quote, accept the service scope and optionally select wallet saving. Complete official PayPal sandbox approval, return and confirm the approved payment. A wallet becomes active only after the owned completed order exposes a saved token and an independent token read confirms the same customer. A missing token remains pending.

To exercise automatic amendments, keep the paid order **unfulfilled**, enable its explicit $25 policy, then apply a labelled sample service event. +$8 consumes the gross allowance; +$20 or +$60 afterward must require another approval. The sample event does not claim a live stock change. An uncertain response is reconciled; it never starts a new blind payment.

**Deliver & download dossier** fulfills that digital order and ends automatic changes/cancellation. Before delivery and within 24 hours, request its full compensating sandbox refund. Later requests are preserved for support review; no outside message is sent by this application. Revoke wallet consent to stop future use immediately, with provider deletion tracked independently.

## Security and evidence

Secrets, local plans, browser recordings and private evidence are ignored by Git. Wallet identifiers, private financial authorities and core operation documents use tenant-bound AES-256-GCM at rest, with a purpose-derived key from the project's `AUTH_SECRET`. Preserve that secret when moving the same database between environments. Public DTOs omit token/customer/payer identifiers. Client input never selects a merchant or a payment amount.

Manufacturer documents and software-publisher documentation are linked and hashed. A supported-looking value without its source, an unreviewed critical fact, a conflict or an unknown prevents overall verification. **Model verified** and **Physically tested** are separate claims. Current physical tests and human review are not complete.

This repository remains private while implementation and evidence are being assembled. Publication, the final film and submission are separate release steps. Local private plans are not needed to run the source.

## License

Application code is [MIT licensed](LICENSE). The [third-party inventory and preserved notices](docs/THIRD_PARTY_NOTICES.md) cover the payment core, fonts and declared native/data licenses. The installed Channel3 SDK has no declared license; external licensing clarification remains an open release gate. Product illustrations and synthesized test signals are original; no third-party product photography or identifiable participant footage is reused.

## Additional system packs

The **Systems** workspace supports a desk with independent displays and a shared two-to-six-person podcast station. Each has exact equipment, source-bound constraints, immutable previewed editions, an assembly guide, equipment-passport bindings and scoped agent reads. The podcast pack also renders a graph-bound synthesized routing audition. Manufacturer review, physical testing and complete hardware cost stay explicitly unresolved. See [the pack workflow and local validation guide](docs/domain-packs.md).
