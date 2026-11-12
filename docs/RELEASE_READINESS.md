# Setup and release readiness

This guide runs from the public source, `.env.example` and checked-in vendor archives. Private plans and historical operator credentials are not prerequisites. Source-input validation and the licensing inventory are bounded release checks; they do not establish provider eligibility, physical results, independent research findings or permission to publish third-party material.

## Fresh isolated development setup

Use Node **22.x**, npm **10.9.8**, Git and a local PostgreSQL instance. Git access is needed for the exact context-plugin PayPal SDK commit in the lockfile. Normal dependency installation runs that SDK's `prepare` build and may need native-addon build tooling when a prebuilt addon is unavailable. Keep a new checkout's dependencies and Next output separate from any running checkout.

```sh
npm ci
cp .env.example .env
```

The lock's GitHub dependency can resolve through SSH. If your environment uses HTTPS instead, a temporary Git rewrite preserves the same pinned commit without editing the lockfile:

```sh
GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
GIT_CONFIG_VALUE_0=ssh://git@github.com/ \
npm ci
```

Create a **new database and owner role** on your own development PostgreSQL instance. The following example assumes an instance already listening on loopback port `55432` and an administrative role named `postgres`; substitute your local admin role or port as needed. The password is entered at the prompt. These commands create new names and do not reset an existing database:

```sh
createuser --host=127.0.0.1 --port=55432 --username=postgres \
  --pwprompt --no-superuser --no-createdb --no-createrole worldkit_dev
createdb --host=127.0.0.1 --port=55432 --username=postgres \
  --owner=worldkit_dev worldkit_dev
```

If either name already belongs to other work, choose a fresh name. Configure `.env` locally with that role, its password and database name. Do not use another project's store or merchant credentials.

| Configuration | Fresh Sample setup |
| --- | --- |
| `DATABASE_URL` | Your new owner role and database, for example `postgresql://worldkit_dev:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:55432/worldkit_dev` |
| `AUTH_SECRET` | A new cryptographically random secret of at least 32 characters. It protects private authorities and encrypted records. |
| `CRON_SECRET` | A separate random secret of at least 24 characters for the recovery endpoint. |
| `WORLDKIT_PUBLIC_URL` | `http://localhost:4106` for the local workflow below. |
| `WORLDKIT_DISABLE_PROVIDERS` | Add `true` for the initial local Sample run. This gates PayPal/Toolkit and selected storage/identity paths; it is not a universal catalog/model switch. |
| `WORLDKIT_TOOLKIT_READS_ENABLED` | Leave the example's `0` until separately qualifying the two authorized sandbox reads. |
| Provider keys | Leave optional provider credentials empty for the initial Sample run. |

Keep `.env` private. Generate the secrets yourself; placeholders in `.env.example` are not working credentials. Preserve the same `AUTH_SECRET` when continuing to use the same existing database, because changing it prevents access to encrypted history.

Existing shell values can take precedence over `.env`, including a database URL from another project. After configuring the new file, use this separate subshell for the initial Sample run. It clears inherited connection/provider/storage values, then lets the normal commands load your new `.env`; it leaves the parent shell unchanged:

```sh
(
  set -e
  unset DATABASE_URL AUTH_SECRET CRON_SECRET WORLDKIT_PUBLIC_URL
  unset PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_WEBHOOK_ID
  unset PAYPAL_ENVIRONMENT PAYPAL_API_BASE_URL PAYPAL_PROJECT_ISOLATED
  unset CHANNEL3_API_KEY CHANNEL3_WEBHOOK_SECRET CHANNEL3_WEBHOOK_SECRET_PREVIOUS
  unset CHANNEL3_API_BASE_URL OPENAI_PLANNER_MODEL OPENAI_REASONING_EFFORT OPENAI_VISION_MODEL
  unset GEMINI_MODEL GEMINI_VISION_MODEL WORLDKIT_PHYSICAL_MAINTENANCE
  unset OPENAI_API_KEY GEMINI_API_KEY BLOB_READ_WRITE_TOKEN BLOB_STORE_ID VERCEL_OIDC_TOKEN
  unset WORLDKIT_QA_MODE WORLDKIT_PHYSICAL_LOCAL_STORAGE WORLDKIT_PHYSICAL_LOCAL_DIR
  export WORLDKIT_DISABLE_PROVIDERS=true WORLDKIT_TOOLKIT_READS_ENABLED=0
  npm run db:migrate
  npm run dev
)
```

The migrator creates and extends WorldKit's application and payment-core schema using the configured database owner. It is not a database reset or a provider qualification. Open `http://localhost:4106`; the server also admits the matching loopback alias `http://127.0.0.1:4106`. Use one origin consistently. Deployed writes require the configured public origin or the exact supported deployment hostname, not arbitrary preview aliases.

## Explicit Sample entry and recovery

An ordinary page visit only checks for an existing workspace. Choose **Start Sample** to create a private, durable Sample workbench and its original seven-day session. This entry action invokes no catalog, model, merchant, payment or physical operation.

The browser saves the admission request before dispatch. If its answer is lost or incomplete, choose **Recover this Sample**; it deliberately reuses that original request. Reloading does not resend creation, and recovery keeps the original absolute expiry. It cannot switch away from a different valid workspace. After expiry, **Start another Sample** is a separate deliberate action. Keep recovery data and cookies private. [Full entry contract](EXPLICIT_SAMPLE_ENTRY.md).

The Sample workbench contains labelled equipment and computational checks. Follow the guided creator journey, inspect unresolved evidence, compare complete systems and retain a test or research notebook. **Model verified**, **Sample**, **Sandbox** and **Physically tested** describe different evidence. A Sample record does not establish actual equipment ownership, a human study, a physical performance result or a retailer purchase.

Equipment image intake asks whether the selected file is a photograph or a Sample illustration before sending bytes. The saved label is immutable for the same normalized image in that workspace; a live model/catalog response does not turn an illustrated input into a photograph. File selection and cancellation send nothing. If an upload answer is lost, inspect the original saved image before another action. Equipment job polling resumes only that workspace's tasks, including its own expired-task recovery.

## Optional integrations

Configure optional providers only for the deliberate workflow you intend to exercise. Channel3 and model adapters use their keys even when `WORLDKIT_DISABLE_PROVIDERS=true`, so leave those keys empty and clear inherited keys for a provider-free Sample. Remove the additional PayPal/Toolkit disable flag only in a separately reviewed environment. Adding any key does not grant application authority.

| Integration | Configuration and limits |
| --- | --- |
| Channel3 | `CHANNEL3_API_KEY` and the documented API base URL enable catalog reads. Read qualification may consume account quota. Catalog results do not establish merchant procurement. The SDK licensing clarification below remains open. |
| OpenAI / Gemini | Add the chosen server-side API key and actual supported model IDs. `.env.example` records the configured defaults; account access is a separate check. Planning, vision and source reading make real provider/model requests when invoked. Models propose; the deterministic compiler decides verification. |
| Private Blob | Use `BLOB_READ_WRITE_TOKEN` for a **private** Vercel Blob store dedicated to this environment. Photos, manufacturer copies and notebook originals use authenticated tenant-scoped access. A public bucket is not a substitute. Actual upload/callback/deletion/retention qualification remains distinct from local source checks. |
| PayPal | Keep `PAYPAL_ENVIRONMENT=sandbox`, the sandbox API base URL and project-isolation marker. Use your own isolated sandbox merchant and buyer configuration. Official payer approval, exact resource binding, current authority and durable operation identity govern financial actions. Saved payment credentials do not reserve funds. |
| PayPal Toolkit | The pinned official `@paypal/agent-toolkit/openai` integration exposes only authorized `get_order` and `list_transactions` reads when explicitly enabled. Its fixed sandbox transport does not add payment authority. The known residual dependency findings and qualified override limits are in [the dependency review](DEPENDENCY_REVIEW.md). |
| MCP | Verification tools require an existing explicitly scoped grant and an exact saved kit/revision. They do not create payment authority. Use only the explicit-input verifier contract described below; obtaining a grant is an owner action. |

WorldKit's immutable `@fracture/paypal-core@0.2.4` archive uses the APIMatic-generated package **`paypal@2.29.0`**, pinned to Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. It is distinct from both `@paypal/agent-toolkit@1.11.0` and the Toolkit's `@paypal/paypal-server-sdk@1.1.0` dependency. The SDK ships its own map and build; do not substitute packages or vendor a different implementation to resolve an install failure. [PayPal contract](../paypal-plan.md) and [APIMatic provenance](../APIMATIC_SETUP.md).

The catalog/model/inventory qualification scripts are active external operations, not setup health checks. Do not run them as part of an unattended source check. The deployed cron recovery endpoint also needs its own reviewed schedule and secret; ordinary browser polling can resume local work.

## MCP verification with existing authority

This is a deliberate operator request to an explicitly selected running endpoint. It is separate from the offline checker below. First obtain an existing owner-issued grant for the intended kit and read the exact saved certificate/revision; the verifier does not create a workspace or a grant for you.

Prepare a private regular JSON file outside the public source. On Unix, set its mode to `0600`. Supply the original grant/workspace expiry values and the existing exact certificate/revision/graph values; do not replace an expired authority with an invented future date. The strict input has exactly these fields, with your real private values replacing the placeholders:

```json
{
  "schema": "worldkit.mcp-verification-input.v1",
  "endpoint": "https://your-owned-host.example/api/mcp",
  "token": "EXISTING_PRIVATE_BEARER_GRANT",
  "grantExpiresAt": "ORIGINAL_GRANT_EXPIRY_ISO",
  "workspaceExpiresAt": "ORIGINAL_WORKSPACE_EXPIRY_ISO",
  "revisionId": "EXISTING_EXACT_REVISION_ID",
  "expectedGraphHash": "EXISTING_64_HEX_GRAPH_HASH",
  "expectedCertificateId": "EXISTING_CERTIFICATE_ID"
}
```

Use your own absolute paths. The receipt path **and** that path plus `.journal.jsonl` must both be new; neither may already exist:

```sh
chmod 600 /absolute/private-input.json
npm run verify:mcp -- --input /absolute/private-input.json --output /absolute/new-receipt.json
```

The command loads no implicit `.env`. It connects through the official MCP SDK, lists tools, and calls only `verify_kit` with `freshness_policy: "historical"`. It checks the exact saved certificate, revision and graph before recording a new sanitized receipt and journal. It creates no owners, grants or quotes, invokes no repair/quote/payment action, and does not revoke the existing grant. Authorization and request-budget counters can change.

This bounded verification uses the server's stateless JSON transport. The client's optional server-push stream is declined before any GET is dispatched; the receipt records that boundary. It does not emulate a successful stream or claim to qualify a long-lived subscription.

Current expiry, revocation and kit/resource scope still apply; an existing grant can be refused. A failed or unknown verification remains in its new receipt/journal. There is no automatic retry or overwrite. An explicit later attempt needs a new output identity and the same still-valid existing authority. Keep the input and first outputs private; review any sanitized public excerpt separately. Historical checked-in evidence is never the output target.

## Read-only release-input checker

These two commands need only Node 22 and Git for Git mode. They do not load `.env`, install dependencies, import the application, contact a database/provider or execute package scripts:

```sh
node --experimental-strip-types --test tests/release-inputs.test.ts
node scripts/check-release.mjs
```

JSON output and an explicit, separately extracted source archive are supported:

```sh
node scripts/check-release.mjs --json
node scripts/check-release.mjs --archive ./release-source --json
```

Git mode selects tracked files plus ordinary unignored new files, respecting Git ignore rules. It does not descend into ignored dependency/build/private trees. Archive mode inspects only the explicit directory; use a clean extracted source archive, not a live checkout containing `.git`, dependencies or private state. It rejects symlinks and escaping paths without following them.

The checker validates package/lock root dependency declarations, full Git commit references, local vendor tarball SHA-512 integrity and relative Markdown filesystem links. Absolute site routes, external URLs and anchors have separate classifications; it does not crawl them or validate route/anchor existence. Fenced code and inline code examples are excluded from Markdown link checks. Its limits are 20,000 source files, 8 MiB per text input and 64 MiB per vendor archive.

Private environment files, local plans, raw private evidence, `.local`, `.next*`, `node_modules`, Git metadata and generated output are release-input failures. `.env.example` remains allowed. The check reads only public package/lock/Markdown inputs and included vendor bytes after path validation. A pass is not a general secret scan, a complete Markdown renderer, a security audit or a legal permission determination.

License output reports declared lock metadata only. Missing declarations are visible limitations and do not cause automatic package removal, license assignment or a failing input result. The application root's missing lock declaration is separate from the checked-in MIT license; Channel3's missing upstream declaration remains unresolved.

## Bounded application checks and existing evidence

After installing dependencies, the affected dependency controls can be run without a database or provider credentials:

```sh
node --import tsx --test tests/paypal-toolkit.test.ts tests/dependency-exposure.test.ts tests/commerce-policy.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The retained dependency review records a clean install, **35/35** affected checks and a nonincremental typecheck. Its full and production audits each retain **10 findings: 9 high and 1 moderate**. This release-input unit ran only its focused temporary-fixture controls and the read-only checker; it did not rerun application, database, browser, build or provider qualification. [Dependency scope and receipts](DEPENDENCY_REVIEW.md).

Database suites require their own fresh isolated QA database and suite-specific safety guards; do not aim `test:db` at an existing development or hosted store. A production build, actual provider flow and native review belong to a separately controlled exact-source qualification. Historical public receipts state their own source/date/coverage; a new source-input pass does not extend those claims. [Evidence meanings](WHAT_VERIFIED_MEANS.md), [remaining capabilities](REMAINING_CAPABILITIES.md), [current guided workflow](GUIDED_JOURNEY.md).

## Safe staging of an existing project

Use a separate source checkout with its own dependencies and build output. Keep the canonical running checkout, `.env`, private store and original receipts untouched while preparing the candidate. Give isolated QA a new database/user and independent secrets. Clear inherited provider/storage credentials, leave optional keys empty and retain the additional PayPal/Toolkit disable flag there.

For an explicitly authorized migration of the same existing data, preserve its `AUTH_SECRET` and ownership bindings. First take a consistent backup, verify restoration separately, and record the source revision plus table counts/content fingerprints. Review and apply only the intended additive migration. Do not reset, reseed, delete financial history or rotate encryption authority to make qualification pass.

Qualify the exact candidate source against the intended staging database and private storage, retain first failures and verify original-data continuity. Review provider scopes separately before any external operation. Promotion, public source publication and film/submission publication are explicit release actions owned by the release operator; this checker performs none of them.

## Open release gates

- The dependency tree retains the stated audit findings and narrow local override support limits.
- Channel3 SDK redistribution/license terms require external clarification. No MIT permission has been inferred from the application license, an absent manifest field or an unavailable upstream repository.
- The actual deployment platform's native-library notices and distribution requirements need review against the concrete runtime artifact. [Third-party notices and preserved sources](THIRD_PARTY_NOTICES.md).
- Genuine physical testing, independent human/research findings, authentic merchant eligibility/delivery, third-party media permissions and final original film/publication retain their separate evidence gates. They are not established by software-only checks.

