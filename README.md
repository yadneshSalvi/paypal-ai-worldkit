# WorldKit

A creator workbench for turning a goal into a complete physical-system plan, with exact equipment profiles, source-linked checks, an audible routing model and a durable sandbox purchase record.

The application is implemented and running locally. It remains under active development; physical testing, independent source review, the complete library/evaluation corpus, several broader integrations and release assets are still open. See [evidence and limitations](docs/WHAT_VERIFIED_MEANS.md).

## Run locally

Use Node **22.x** (tested with 22.22.3), npm 10.9.8 and PostgreSQL. The application uses its own database, credentials and PayPal sandbox merchant. Do not point it at another project's payment store or wallet.

```sh
npm ci
cp .env.example .env
# Fill in your own isolated development credentials and PostgreSQL URL.
npm run db:migrate
npm run dev
```

Open http://localhost:4106. Each browser gets a private, durable sample workspace with a seven-day opaque session. The workbench also supports http://127.0.0.1:4106; loopback aliases are permitted only on that port with matching Host checks. Deployed writes require the exact configured public origin.

```sh
npm test
npm run test:db
npm run typecheck
npm run build
```

The core test suite uses deterministic sample providers. Credentialed qualification scripts (`qualify:catalog`, `qualify:models`) make real read/model requests and may consume the configured account's credits. `verify:mcp` talks to the running local server using a short-lived private grant. It never moves money.

## What works

- A spatial graph and accessible connection list, four architecture comparisons, requirement editing, source inspection, explicit failure witnesses and deterministic repairs.
- Immutable PostgreSQL revisions/certificates, optimistic version checks, tenant isolation, append-only events and durable job records.
- Real Channel3 discovery, current product details/options, similar products, category and price-history adapters. Fresh retailer URLs are excluded from persisted snapshots; original diagrams are used instead of unlicensed product images.
- Direct OpenAI and Gemini structured goal proposals. Models propose; the deterministic compiler decides verification.
- Actual Web Audio routing from the saved graph, isolated model buses, downstream disconnection behavior and downloadable PCM WAV files. The original test signals are labelled **Modelled**, not a hardware recording.
- Scoped Streamable HTTP MCP tools: `verify_kit`, `repair_kit`, `quote_kit`. An actual external SDK client has matched the browser's immutable certificate and tested stale/foreign/revoked requests. These tools do not authorize payment or mutate a saved kit.
- The **Studio** view offers an itemized $12 digital routing dossier and connection guide, with graph-bound PayPal sandbox create/approval/capture, save-during-purchase consent, owned-order/token reads, separately labelled Vault setup fallback, revocation and compensating full refunds before delivery within 24 hours.
- A separate $25 cumulative repair authority for unfulfilled Studio digital service orders. Server-owned sample events exercise actual sandbox saved-wallet payment when that account is qualified. Pending claims count; refunds do not restore the allowance; a larger change requires new approval.

A catalog product is not retailer procurement. The Studio service does not sell or ship physical gear. Its dossier preserves unresolved compatibility facts. Actual WorldKit live payment capability is recorded separately from sample SDK/database tests and from another project's payment evidence.

## Integrations and boundaries

| Integration | Current implementation |
| --- | --- |
| APIMatic PayPal | `paypal` 2.29.0, Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`; typed Orders, Payments and Vault calls. This is not `@paypal/paypal-server-sdk`. |
| Shared guarded executor | Immutable `@fracture/paypal-core` 0.2.3 archive, SHA-256 `4cf25ef38b1138a20b561be37cb6a33952c6e96ea7e1eaf33506fb0e8113a341`. Domain policy, PostgreSQL claims, exact cents, supported PayPal request IDs and conservative reconciliation. |
| Channel3 | Official `@channel3/sdk` 4.9.0 and real account-qualified product reads. Selected options and offer condition are preserved. |
| OpenAI / Gemini | Direct server-side SDKs, structured schemas and prompt/input/output hashes; no secrets in prompts. |
| MCP | Official SDK 1.32.2, exact scopes and schema checks; no financial tools. |
| Storage | PostgreSQL for authority/state; private object-storage integration remains an active workstream. |
| Hosting | Next.js 16.4.6 / React 19.3.1, Vercel-ready Node 22 configuration. Hosting qualification is separate from local build success. |

The [PayPal implementation contract](paypal-plan.md) records the actual SDK maps, authority boundaries, error/unknown-state handling and revision history. [APIMatic setup](APIMATIC_SETUP.md) preserves skill provenance. The shared package's provenance is in `vendor/`.

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
