# WorldKit

A creator workbench for turning a goal into a complete physical-system plan, with exact equipment profiles, source-linked checks, an audible routing model and a durable sandbox purchase record.

The inventory and source-reading integration checkpoints are running at [WorldKit on Vercel](https://paypal-ai-worldkit.vercel.app). Hosted checks include an actual manufacturer PDF, private storage, Gemini reading, saved candidate and tenant isolation. It remains under active development; physical testing, independent source review, complete engineering port maps, several broader integrations and release assets are still open. See [evidence and limitations](docs/WHAT_VERIFIED_MEANS.md).

## Run locally

Use Node **22.x** (tested with 22.22.3), npm 10.9.8 and PostgreSQL. The application uses its own database, credentials and PayPal sandbox merchant. Do not point it at another project's payment store or wallet.

```sh
npm ci
cp .env.example .env
# Fill in your own isolated development credentials and PostgreSQL URL.
npm run db:migrate
npm run dev
```

Open http://localhost:4106. Each browser gets a private, durable sample workspace with a seven-day opaque session. A deployment-wide PostgreSQL backstop admits at most 30 new workspaces/hour and 200/day; an existing cookie reopens its current workspace and existing work remains usable. The workbench also supports http://127.0.0.1:4106; loopback aliases are permitted only on that port with matching Host checks. Deployed writes require matching Host and Origin for the configured public URL or the exact server-provided Vercel deployment hostname. Other preview or branch aliases are not automatically trusted.

```sh
npm test
npm run test:db
npm run typecheck
npm run build
```

The core test suite uses deterministic sample providers. Credentialed qualification scripts (`qualify:catalog`, `qualify:models`) make real read/model requests and may consume the configured account's credits. `verify:mcp` talks to the running local server using a short-lived private grant. It never moves money.

## What works

- A spatial graph and accessible connection list, four architecture comparisons, requirement editing, source inspection, explicit failure witnesses and deterministic repairs.
- Immutable PostgreSQL revisions/certificates, optimistic version checks, tenant isolation, append-only events and resumable jobs with leased workers, bounded retries, cancellation and durable attempt receipts.
- Real Channel3 discovery, exact variant refresh, category/attribute browsing, condition/price/dimension filters, observed price history, product URL lookup and workspace-scoped attribution. Fresh retailer URLs are excluded from persisted snapshots; original diagrams are used instead of unlicensed product images.
- An equipment passport with private photo upload, editable model region proposals, user-confirmed crop search, exact model/ownership review, quantities, accessories, condition and history. Placing or correcting an item previews the whole kit, commits an immutable profile and preserves older proofs. Unknown engineering facts remain unknown.
- Direct OpenAI and Gemini structured goal and photo-region proposals, saved as recoverable jobs. Models propose; the deterministic compiler decides verification.
- A reading room for 60 exact manufacturer-source candidates. Private document copies, source fingerprints, selected text pages, traceable model proposals, unanswered review questions and immutable candidate versions remain separate. Saving a candidate never approves its claims or records ownership. [Source-reading method](docs/SOURCE_READING.md).
- An engineering reading room with actor-bound specialist roles, expiring single-use copy-link invitations, exact immutable review editions, source and port-map editing, keyboard image anchors, retained disagreements, two-person critical adjudication, guarded scoped profile promotion and dependent-kit impact. Sample software qualification stays separate from genuine human review and physical evidence. [Review policy, isolated qualification and native protocol](docs/ENGINEERING_REVIEW.md).
- Sixty retained primary-provider source drafts contain 478 located proposals, 216 unknowns, three conflicts and one rejected proposal. All 858 citation anchors match the retained source text. The separate 323-assertion, 30-device held-out run finished across Astra and Gemini; its reference remains an unreviewed AI draft, so human accuracy and semantic support precision are not reported. [Corpus audit](docs/evidence/corpus-library-qualification.json).
- Actual Web Audio routing from the saved graph, isolated model buses, downstream disconnection behavior and downloadable PCM WAV files. The original test signals are labelled **Modelled**, not a hardware recording.
- Scoped Streamable HTTP MCP tools: `verify_kit`, `repair_kit`, `quote_kit`. An actual external SDK client has matched the browser's immutable certificate and tested stale/foreign/revoked requests. These tools do not authorize payment or mutate a saved kit. PostgreSQL enforces 60 verifications/minute, 5 repair proposals/hour, 2 quotes/minute and at most 2 concurrent tools per grant.
- A deployed **Proof → Certificate** workflow prepares an exact public-safe preview, records its explicit review, then publishes it through a separate action. Immutable editions, logical connection maps, source and rule fingerprints, mobile assembly guides, A4/Letter print views and edition-specific QR codes retain unresolved facts and `physicalTest: not_performed`. Withdrawal closes all public editions; private source removal and session expiry also withhold dependent public records. Scoped MCP certificate and assembly resources use the existing kit grant. Native mobile/print and hosted publication/MCP checks passed; [the release receipt](docs/evidence/certificate-hosted-qualification.json) records migration and original-data continuity. [Public record contract and isolated QA](docs/PUBLIC_RECORDS.md).
- The **Studio** view offers an itemized $12 digital routing dossier and connection guide, with graph-bound PayPal sandbox create/approval/capture, save-during-purchase consent, owned-order/token reads, separately labelled Vault setup fallback, revocation and compensating full refunds before delivery within 24 hours.
- A separate $25 cumulative repair authority for unfulfilled Studio digital service orders. Server-owned sample events exercise actual sandbox saved-wallet payment when that account is qualified. Pending claims count; refunds do not restore the allowance; a larger change requires new approval.
- A local **Living kit** milestone with exact-variant merchant alerts, signed Channel3/PayPal receivers, duplicate/conflict receipts, durable recovery, fresh stock review incidents and private notifications. Payment callbacks only reread accepted resources and preserve gross history. Authentic deployed callbacks and subscription create/cancel qualification remain pending. [Receiver and ownership contract](docs/LIVING_KIT.md).
- A persisted **Repair workshop** that follows an incident through dependency tracing, exact alternatives, critical-fact checks, immutable proposals and controlled merchant commitments. Fresh kit authority, cumulative gross limits, interrupted-operation recovery, separate compensation and conditional undo are complete in the explicit Sample workflow. Sample engineering premises, actual catalog observations and PayPal sandbox receipts retain separate labels. [Living Repair contract and local workflow](docs/LIVING_REPAIR.md).

A catalog product is not retailer procurement. The Studio service does not sell or ship physical gear. Its dossier preserves unresolved compatibility facts. WorldKit's own observed buyer-present $12 capture, save-during-purchase, $8 saved-wallet amendment, $20/$60 escalation, full $8+$12 refunds and token deletion are recorded in [project qualification evidence](docs/evidence/paypal-worldkit-qualification.json). These observations remain separate from sample SDK/database tests and another project's payment evidence.

## Integrations and boundaries

| Integration | Current implementation |
| --- | --- |
| APIMatic PayPal | `paypal` 2.29.0, Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`; typed Orders, Payments and Vault calls. This is not `@paypal/paypal-server-sdk`. |
| Shared guarded executor | Immutable `@fracture/paypal-core` 0.2.4 archive, SHA-256 `5c03e848a603c91f98f213c9bfee2e5e4ccb00fd54946ae349945c55f53c3f0f`. Domain policy, PostgreSQL claims, exact cents, supported PayPal request IDs and conservative reconciliation. |
| Channel3 | Official `@channel3/sdk` 4.9.0 and real account-qualified product reads. Selected options and offer condition are preserved. |
| Living Kit events | Svix 2.10.0 raw verification, PayPal postback verification, encrypted original receipts, exact ownership routing and leased read-only projection. Local tests are Sample; authentic delivery proof is a separate gate. |
| OpenAI / Gemini | Direct server-side SDKs, structured schemas and prompt/input/output hashes; no secrets in prompts. |
| MCP | Official SDK 1.32.2, exact scopes and schema checks; no financial tools. |
| Storage | PostgreSQL for authority, immutable revisions, model request identities and leased jobs; private Vercel Blob for sanitized equipment photos and manufacturer source copies. Full source text is never served by the public evidence API. |
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

Application code is MIT licensed. Bundled third-party context and the immutable payment core retain their original licenses and provenance. Product illustrations and test signals in this implementation are original; no Channel3 product photography or identifiable participant footage is reused.
