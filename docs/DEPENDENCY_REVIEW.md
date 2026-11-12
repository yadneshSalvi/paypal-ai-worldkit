# Dependency review

Reviewed on 12 November 2026 against source baseline `941e18a` and the official npm registry. **The reviewed tree still has 10 npm package findings: 9 high and 1 moderate. It is not audit clean.** The baseline had 11 findings: 10 high and 1 moderate. These counts include propagated dependency findings; they are not counts of distinct vulnerabilities.

The changes repair the LangChain serialization advisory and the three original LangSmith advisories. Six distinct advisory IDs remain across five underlying packages. The bounds below describe WorldKit's current exposure; they do not patch those remaining packages or establish zero risk.

## Package and integration identity

WorldKit retains the actual, pinned official `@paypal/agent-toolkit@1.11.0`, which was also the registry's latest version on the review date. The [official TypeScript Toolkit documentation](https://github.com/paypal/agent-toolkit/blob/main/typescript/README.md) identifies the package, configurable action inventory, OpenAI integration, `get_order` and `list_transactions` operations.

The installed package's public `./openai` export resolves to `openai/index.js`, a CommonJS bundle. `src/server/paypal-toolkit.ts` loads that public entry using `createRequire`. Its manifest, OpenAI JavaScript/types, LangChain JavaScript/types and AI SDK JavaScript were compared byte for byte with the [official 1.11.0 npm tarball](https://registry.npmjs.org/@paypal/agent-toolkit/-/agent-toolkit-1.11.0.tgz); the tarball's SHA-512 matches both registry metadata and `package-lock.json`.

| Artifact | Verified identity |
| --- | --- |
| Toolkit registry `gitHead` | `a3aa963960caf32912691a759879a8ce7a6018b2` |
| Toolkit tarball SHA-256 | `e0c5ca9bd01703c5646a94cb39dcb1ef0c85a99fd88ee59c34dae49800e1f805` |
| Installed OpenAI bundle SHA-256 | `4bc5b11ffeeed7241e18431551c80ed0719fe18809192c7c0d2d5f217927e532` |
| Toolkit's loaded PayPal server SDK | `@paypal/paypal-server-sdk@1.1.0` |
| WorldKit's existing financial core | `@fracture/paypal-core@0.2.4`, unchanged |
| Existing APIMatic SDK beneath that core | `paypal@2.29.0`, Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`, unchanged |

The Toolkit, its PayPal server SDK dependency, and the context-plugin APIMatic package named `paypal` are distinct packages. The local TypeScript integration and getting-started skills were read to establish that distinction. This review does not replace the Toolkit or WorldKit's existing financial adapter with another SDK. The two selected Toolkit operations construct their HTTP reads with Axios; constructing the Toolkit also loads the server SDK.

## Targeted repairs

Only two narrowly scoped overrides were added to `package.json`; npm generated the lockfile changes. Existing direct dependency pins and the earlier mathjs/CLI overrides remain in place.

| Dependency | Before | Reviewed resolution | Reason and qualification |
| --- | --- | --- | --- |
| `@langchain/core` under Toolkit `1.11.0` | `0.3.6` | `0.3.80` | Upstream's patched release in the `0.3` family for [serialization injection, GHSA-r399-636x-v7f6](https://github.com/langchain-ai/langchainjs/security/advisories/GHSA-r399-636x-v7f6). A synthetic metadata/secret-map regression failed on the original version and passes after the change. |
| `langsmith` under exact core `0.3.80` | Original tree: `0.1.68` | `0.6.0` | Fixes [prototype pollution](https://github.com/langchain-ai/langsmith-sdk/security/advisories/GHSA-fw9q-39r9-c252), [streaming redaction](https://github.com/langchain-ai/langsmith-sdk/security/advisories/GHSA-rr7j-v2q5-chgv), and [public prompt deserialization](https://github.com/langchain-ai/langsmith-sdk/security/advisories/GHSA-3644-q5cj-c5c7) advisories. |

LangSmith `0.6.0` is outside core `0.3.80`'s declared `^0.3.67` range. This is an explicit local qualification, not an upstream compatibility guarantee. The exact parent-version override limits its scope. Tests construct the real official LangChain Toolkit and invoke both structured reads through a synthetic Axios adapter, exercising its callback/context integration. They also verify that LangSmith drops hostile replica destinations and credentials from tracing headers. Other LangChain/LangSmith use cases are not qualified by these checks.

The first core-only candidate resolved LangSmith `0.3.87` and introduced [tracing-header SSRF, GHSA-v34v-rq6j-cj6p](https://github.com/langchain-ai/langsmith-sdk/security/advisories/GHSA-v34v-rq6j-cj6p). That candidate was rejected. The retained `0.6.0` resolution removes that finding as well. There was no automatic audit force-fix, Toolkit downgrade, major Zod override or removal of required features.

## Remaining advisories and actual exposure

The following versions and patched floors come from the official registry and the linked upstream advisories. A patched floor outside a parent's declared range is not treated as a safe automatic update.

| Underlying package | Installed version and advisory | Compatible repair decision | Current WorldKit path |
| --- | --- | --- | --- |
| `zod` | Toolkit and core copies: `3.25.76`; [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) reports every version below `4.6.6` | The latest compatible Zod 3 release is `3.25.76`; the registry offers no patched 3.x release. Replacing its root API with Zod 4 would violate these packages' contracts. WorldKit's own input schemas already use root Zod `4.6.7`. | **Loaded and reachable** in the OpenAI bundle's static tool-schema construction and bundled Zod-to-JSON-schema conversion. WorldKit does not pass user-defined schemas, collections or arbitrary arguments to it. |
| `@ai-sdk/provider-utils` | `2.2.8`; [unbounded response consumption, GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8) | The latest 2.x release is `2.2.8`; first patched release is `3.0.28`, which changes the provider dependency family. | The Vercel AI adapter is not imported by the production integration. A fresh-process load/construction receipt excludes this package. WorldKit's selected reads instead use its own bounded response reader. |
| `ai` | `4.3.19`; [filetype validation bypass, GHSA-rwvc-j5jr-mgvh](https://github.com/advisories/GHSA-rwvc-j5jr-mgvh) | Latest compatible 4.x is `4.3.19`; first patched stable release is `5.0.52`. A major adapter migration was not inferred from an audit recommendation. | Not loaded by the selected OpenAI entrypoint. These payment reads accept no uploaded file or filetype whitelist. |
| `jsondiffpatch` | `0.6.0`; [HTML formatter XSS, GHSA-33vc-wfww-vjfv](https://github.com/advisories/GHSA-33vc-wfww-vjfv) and [patch prototype pollution, GHSA-j4fx-xxwh-2485](https://github.com/advisories/GHSA-j4fx-xxwh-2485) | Patches start at `0.7.2` and `0.7.6`; the installed AI SDK pins exactly `0.6.0`. No unsupported substitution was made. | Not loaded by the selected entrypoint. WorldKit does not use its patch APIs or render its HTML formatter output. |
| `uuid` | `10.0.0`; [output-buffer bounds, GHSA-w5hq-g745-h8pq](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq) | Core declares `^10.0.0`; first patched release is `11.1.1`. No blanket major override was applied. | Not loaded by the selected entrypoint. The affected v3/v5/v6 APIs with caller-provided buffers are not exposed by WorldKit's payment read contract. |

The remaining package-level findings are `@ai-sdk/provider-utils`, `@ai-sdk/react`, `@ai-sdk/ui-utils`, `@langchain/core`, `@paypal/agent-toolkit`, `ai`, `jsondiffpatch`, `openai`, `uuid` and `zod`. The nested OpenAI `4.86.1` finding propagates from its Zod dependency; that nested OpenAI runtime is also absent from the selected entrypoint's module-load receipt. WorldKit's separate direct OpenAI dependency remains pinned at `7.55.0`.

Module-load exclusion is an observation of a fresh Node process constructing the qualified two-tool OpenAI inventory, not a claim that vulnerable files are absent from the installation or could never be imported. The direct Toolkit package and its Zod 3 runtime retain high audit findings. Enabling another Toolkit adapter, arbitrary native dispatch, user-defined tool schemas, LangSmith tracing/prompt pulls or file processing requires a new dependency and exposure review before use.

## Bounded mitigation for the two active reads

The existing adapter in `src/server/paypal-toolkit.ts` remains unchanged. The review verifies these controls through the actual installed Toolkit:

- `ToolkitReadInput` is a strict, fixed object of bounded scalars with only `get_order` and `list_transactions` as operations. Provider IDs, arbitrary native arguments, URLs and schemas are not external request fields. WorldKit resolves the existing owned order/capture binding before invoking the adapter.
- The wrapper constructs the native arguments itself. The native OpenAI dispatcher parses that internal JSON and invokes the selected function; the selected read functions do not validate external collections through Zod 3. Zod 3 remains present for static schemas.
- The CJS Axios singleton is scoped with `AsyncLocalStorage`. Exactly one sandbox OAuth POST followed by one exact owned resource GET is admitted. The reporting query has an exact capture, one page of at most 100, and one bounded search month. Conflicting duplicates, extra query keys, another origin, financial writes and extra requests fail before dispatch.
- The caller's authority callback runs before OAuth, before the resource read and before disclosure. The existing tests prove mid-flight revocation and concurrent ownership isolation.
- Every fetch uses `redirect: "error"` and the 20-second deadline. Each response stream is capped at 1 MiB and cancelled before parsing an oversized body. There is no transport retry. Failed HTTP responses or Toolkit-swallowed reporting errors cannot become a successful empty observation.
- The returned observation validates the exact order/custom ID/capture/amount/currency or exact reporting capture. Only a redacted allowlist and a body digest leave the adapter. Injected metadata stays inert. Payment state and original receipts are not reconciled or changed by these reads.

These bounds limit attacker-controlled work on the current path. They do not turn unpatched Zod 3, unused installed adapters or future imports into patched dependencies.

## Reproduction and evidence limits

Use Node `22.x` and npm `10.9.8`. No application environment file or provider credential is needed for these checks:

```sh
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
node --import tsx --test tests/paypal-toolkit.test.ts tests/dependency-exposure.test.ts tests/commerce-policy.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
npm audit --json --registry=https://registry.npmjs.org
npm audit --omit=dev --json --registry=https://registry.npmjs.org
```

The clean installation passes, followed by **35/35** affected checks, including 15 added exposure checks. The nonincremental typecheck passes. Both full and production-only audits report the stated 10 findings and exit nonzero because they remain; do not reinterpret that exit as an audit-clean result. Audit data can change after the review date.

The original audit, unmodified package/lock copies, first failing injection regression, rejected candidate audit, first test/typecheck failures and final command receipts are retained in private review evidence. The first new test run had an overly specific issue-count expectation; its corrected assertion verifies bounded errors without depending on one exact count. The first typecheck required an explicit child-process `NODE_ENV`; the child still inherits no credentials.

Only controlled synthetic fetch/Axios responses were used for Toolkit behavior. No application server, database, provider, model, financial or merchant endpoint was contacted, and no deployment qualification is implied. This review used the official registry and upstream package sources, documentation and advisories.
