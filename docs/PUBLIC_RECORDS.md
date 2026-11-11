# Immutable verification records and assembly guides

WorldKit can prepare a shareable verification record from one saved kit revision. The certificate, connection map, assembly guide, JSON and QR identify the same immutable edition. Preparing or reviewing an edition does not publish it. Publication is an explicit privacy decision, not an independent engineering review or a physical test.

This implementation is deployed on the stable WorldKit site. The isolated database/HTTP tests, native mobile/print review, additive production migration, hosted MCP/publication checks and original-record continuity are recorded in [the hosted qualification receipt](evidence/certificate-hosted-qualification.json). The public example is a labelled Sample; independent human engineering review and physical testing remain unperformed.

## Owner workflow

Open **Proof → Certificate**. Enter a public title, then prepare the current revision. The exact public projection is visible in the certificate and guide previews. Review both the display fields and the limits of the claim, then save the review. A separate confirmation and **Publish this edition** action make that already reviewed payload public. A failed or interrupted request retains its request identity for a safe retry.

The title is deliberately entered for this public edition. Goal prose, equipment notes, photo locations, participant or reviewer identities, source quotations, private-file URLs, catalog sessions, grants and payment records are not copied. The public display includes device identities, selected modes, sourced facts, review states, requirements, witnesses, connection identifiers, safe public references and fingerprints. An owner must inspect those fields before sharing; they can themselves describe a sensitive configuration.

Each action checks the persisted owner session, current kit revision and graph hash. Review and publication also check the exact edition version, content hash, source authority and share generation. A changed graph, unavailable source, new source head or intervening publication requires a new preview. No public GET reruns verification or silently refreshes the saved results.

## Editions and withdrawal

- `/record/<slug>` follows the current published edition.
- `/record/<slug>/e/<number>` identifies one immutable edition.
- Add `/guide` for the connection guide or `/print` for the complete printable record.
- `/api/public-records/<slug>/e/<number>` returns the same public projection and current availability. Add `/qr` for the QR PNG or `/guide` for its guide data.

Slugs contain 24 random bytes. They provide an unguessable address, not an access-control promise once the owner shares that address. QR data always points at the numbered edition on the configured `WORLDKIT_PUBLIC_URL`. It never follows a mutable current-edition redirect and never derives its origin from a request Host or preview hostname. A deployment requires an explicit stable HTTPS origin; loopback HTTP is limited to local development.

**Withdraw all public editions** closes the current link and every previously published edition, guide, print, JSON and QR endpoint. A later fresh preparation and review can publish a new edition; it cannot revive an old withdrawn edition. Drafts are never public. The private edition history remains available to its owner while that workspace is active.

Public routes send `Cache-Control: private, no-store, max-age=0, must-revalidate`, CDN no-store headers, a no-index instruction and a no-referrer policy. Public JSON and QR return 410 after withdrawal; the human-facing page displays a generic closure without the payload. Unknown or private editions return 404. Session expiry and missing source authority also withhold the payload.

An already-open page checks sharing every 15 seconds and on focus, pageshow and visibility return. It hides content while reconnecting, after an offline event, when a check fails, when its last check exceeds 30 seconds, or when the saved session expires. Print requests first check access again. This is bounded online revocation, not recall of a screenshot, printout, downloaded JSON or other copy already made by a reader. The printed QR invites a fresh availability check.

## Source sharing and historical facts

Public records carry exact source hashes and safe public manufacturer or software-publisher reference URLs. They never serve a private document copy or quotation. Public reference URLs reject credentials, queries, fragments, explicit ports, IP literals and private or reserved hostnames. References are links, not a fresh retrieval or a claim that the current web page still matches the saved hash.

A fact derived from a saved private source version binds the publication to that document's availability. Removing the private copy, beginning deletion, or making its document record unavailable immediately withholds dependent public editions. This holds even if the same manufacturer source also appears in the bundled library. Historical facts and their fingerprints may still remain in the owner's private immutable revision; removing a document is not a claim that those private facts were erased.

A newer source version invalidates a still-unpublished preview. An already-published edition can remain readable while its bound document is still available, with an explicit changed-source notice. Its facts are historical and are not rerun or relabelled as current. A newer kit revision likewise labels an old edition as superseded without changing its content hash. Missing or malformed source authority fails closed.

## Model, physical and review scope

The strict public schema retains the source mode, model status, exact variant and profile version, selected firmware/OS/app modes, fact states, fact-level review states, all requirement outcomes and saved witnesses. Projection checks the graph/certificate identity and recomputes the consistency of result and review counts from those saved inputs. It refuses a contradictory green summary or a missing referenced source.

`physicalTest` is always `not_performed` for this unit. Unknown or unreviewed critical facts remain visible. Owner publication does not add a human fact review. No field in this unit asserts physical equipment ownership, delivery, hardware performance, electrical safety or independent reviewer agreement.

The guide is generated from the saved connections used by the certificate. A disabled connection remains a labelled disabled path in the diagram, connection list, guide and printed output. It cannot be checked as an enabled step. The original diagram shows logical routing; it is not a photograph or an accurate drawing of physical jack positions. Personal reading reminders are local UI state and never change evidence or create a physical-test result.

## Scoped MCP resources

The existing Streamable HTTP MCP endpoint adds these resource templates:

```text
worldkit://records/{revisionId}/{graphHash}/{recordId}/certificate
worldkit://records/{revisionId}/{graphHash}/{recordId}/assembly
```

Both require the existing `kit:verify` scope and the same `authorizeKit` checks as the verification tool. Resource listing and reads recheck the persisted grant, session expiry and allowed kit. Reads also bind the exact revision, graph hash and owner-scoped edition. Revoked, expired, narrowed, foreign and stale grants are denied, even if the caller has a previously authenticated in-memory principal. Reads share the verification rate/concurrency guard. These resources expose the safe saved projection, not source text or financial data, and add no mutation or payment capability.

MCP authority is private workspace authority. Public withdrawal closes the unauthenticated public endpoints; it does not pretend to revoke the owner's existing private history or an independently authorized workspace grant. Revoke that grant separately to stop private MCP reads.

## Persistence and deployment

`scripts/migrate.ts` installs four additive tables: `wk_record_shares`, `wk_record_editions`, `wk_record_intents` and `wk_record_events`. The schema does not rewrite kit, source, session or financial history. An edition trigger prevents payload, content hash, source binding and identity changes, and permits only draft → reviewed → published → withdrawn with an incremented version. Existing lifecycle timestamps cannot be rewritten.

The payload contract is `worldkit.public-record.v1`. The additive SQL is version one of this publication lifecycle in `src/server/public-record-db.ts`; this repository has no numeric database migration ledger. The exact release commit and file hash identify the migration to apply. Install it before promoting traffic, then verify the four tables and `wk_record_editions_immutable` trigger. Running initialization again preserves existing editions.

Mutations lock the persisted session, kit and share before editions and source authority. Tenant/request identity plus a canonical input hash make concurrent duplicate requests idempotent; reuse with a different input is refused. A replay returns the present persisted state, so retrying an old publish after withdrawal does not resurrect or report a currently shared record. Competing publications use the same share-generation check. Session expiry is checked again before commit.

The production migration, stable origin, host cache behavior and hosted qualification remain the deployment owner's responsibility. Do not run the isolated QA launcher against a production database or substitute its deliberately disabled provider configuration for a live environment.

## Isolated local qualification

Use Node 22 and an independent local PostgreSQL instance with permission to create a dedicated QA database:

```sh
node scripts/certificate-qa.mjs --init
node scripts/certificate-qa.mjs --test tests/*.test.ts
node scripts/certificate-qa.mjs --test tests/*.integration.ts
node scripts/certificate-qa.mjs --build
node scripts/certificate-qa.mjs --start
```

In another terminal, run the actual HTTP suite and create its disabled/historical native specimens:

```sh
node scripts/certificate-qa.mjs --script scripts/qualify-certificate-http.ts
node scripts/certificate-qa.mjs --script scripts/seed-certificate-native.ts
```

This launcher uses only `worldkit_certificate_qa`, port 4508, the `wk_certificate_qa` cookie and `.next-certificate-qa`. It preserves existing fixtures and never resets a database. It blanks private `.env` variable names before Next starts, supplies a separate local authentication secret, and disables real payment access at the provider accessor. Model, catalog, Blob and payment credentials are empty. Private QA cookies and secrets stay under ignored `.local/certificate-qa`.

The HTTP suite exercises separate review and publication, duplicate publication, current and immutable reads, QR decoding, unknown links, real MCP transport parity and revocation, graph supersession, disabled paths, withdrawal and expired sessions. Its fixtures are declared Sample and its automated review actions are not human engineering review. The native pass separately checks keyboard use, a 390 px layout, the actual print output and already-open withdrawal. Safe receipts are in `docs/evidence/`; recordings, screenshots and session cookies stay private.

After the deployment owner installs the migration and promotes the same source, run this separate portable suite against the exact stable origin:

```sh
node --import tsx scripts/qualify-certificate-hosted.ts --origin https://paypal-ai-worldkit.vercel.app
```

For a protected deployment before promotion, add `--public-origin https://paypal-ai-worldkit.vercel.app` while `--origin` identifies the unique deployment. The former changes only the expected immutable public link and QR target. The receipt records `requestOrigin` and `publicOrigin` separately. The deployment owner supplies any private protection transport; this application and script add no production protection bypass.

It creates two new Sample workspaces and exercises private/origin/tenant boundaries, separate review, concurrent publication, no-store HTML/JSON/QR, real QR decoding, external MCP resource reads/revocation, disabled-path supersession, all current/historical withdrawals and an old publish retry. It withdraws its own editions and revokes its own grant. It does not read or mutate an existing workspace, call a financial/catalog/model/storage provider, or alter session expiry or source records. Private cleanup authority is saved under ignored `.local/certificate-qualification` before publication so an interrupted run can be resumed safely; only safe counts and observations enter the receipt. A local rehearsal requires port 4508 and a separate `--evidence` path. Native browser/print and source-availability tests remain separate evidence.

## Full product scope remains open

This unit does not replace the remaining 60-device engineering and relationship review, source collaboration and upgrade workflows, reviewed domain packs, scoped PayPal Agent Toolkit reads, genuine held-out human adjudication, authentic market delivery and ownership qualification, physical rig and engineer checks, consenting novice studies, original release media or the final release process. Their evidence must be collected separately or the absence disclosed. No test here manufactures a reviewer, participant, equipment measurement or financial-provider observation.
