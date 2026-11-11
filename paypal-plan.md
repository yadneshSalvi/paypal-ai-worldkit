# WorldKit PayPal integration contract

Contract revision 1, 2026-11-11. This is an implementation contract, not a claim of completed payment qualification.

## Scope and delivery order

The full product retains graph-bound itemized WorldKit Studio sandbox checkout, captured receipts, refund compensation, consent-bound saved-wallet repair, cumulative authority and revocation, official PayPal approval, verified webhook intake, recovery and scoped Agent Toolkit reads. The first workbench milestone establishes graph/quote/tenant contracts and consumes the immutable shared payment core. Follow-on payment execution is gated by actual WorldKit buyer approval and resource ownership; Fracture Lab's receipts and saved tokens never qualify this merchant.

Active SDK boundary: `@fracture/paypal-core` 0.2.2 installed from `vendor/fracture-paypal-core-0.2.2.tgz`, SHA-256 `eb23321fafb98dbf85d3eafdddd249b4c8d50010c5c44f91dd80bc817392d660`. SDK `paypal` 2.29.0 is pinned by that package to Git commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`. No direct SDK request implementation is introduced in the first milestone. The map and shipped core source were read before this sheet. Future Vault/Toolkit additions must extend this sheet before changing those adapters.

## Baseline and configuration

Greenfield repository: no pre-existing application, test runner, typecheck or build. Node 22.22.3 and npm 10.9.8 verified. Use ESM, strict TypeScript and Next.js Node route handlers. Planned checks: `npm run typecheck`, `npm test`, `npm run build`. No CommonJS/ESM error-class mixing inside application code.

`.env` contains isolated project credentials and local PostgreSQL; `.env.local` contains only Vercel OIDC. Neither is published. Environment must be `sandbox`, base URL exactly `https://api-m.sandbox.paypal.com`, isolation marker nonempty. The SDK has no environment enum; the shipped adapter uses `serverOptions.baseUrl`. A long-lived lazy provider retains the SDK OAuth cache. Logging is explicitly off, no per-call body logging, no credential-bearing request objects in model prompts or public evidence. `retry.maxRetries=0`, per-attempt timeout 15 s, complete-call signal 25 s in core; writes are never blindly retried. OAuth2 uses client credentials at `/v1/oauth2/token`, held entirely server-side.

WorldKit uses a PostgreSQL store. No filesystem or process-memory payment authority. Public judge sessions are tenant-scoped and sandbox-only. The merchant sells verification/assembly support and a declared sandbox kit; catalog search does not order physical goods from a retailer.

## Frozen application boundary

`PaymentCore({store,provider,policy})`: `execute(command)`, `reconcile(scope,operationId)`, `recover(scope)` and `listReceipts(scope)`.

`PaymentCommand` requires `scope {tenantId,projectId}`, stable `operationId`, semantic `businessKey`, `intentId`, durable `providerRequestId`, `payloadHash(action)`, `action` and `approval {id,version,digest,expiresAt}`. The domain computes IDs from the accepted quote/amendment, never a browser click. Repeated keys with a changed payload are rejected. A quote binds graph hash, verification, merchant policy, amount, currency, items, expiry and buyer session.

`PaymentPolicy.authorize` reloads current durable authority before claim and dispatch. It returns allowed/reason/resourceIds/currency/maximumMinor/approvalId/approvalVersion/**approvalDigest**. Refunds also require an authoritative remaining-balance reservation; checkout requires exact allowed origins; saved wallets additionally require the exact consent object and expiry.

Core `PaymentAction` calls retained for this product:

| Action | Required members | Optional members and reason |
|---|---|---|
| `create_order` | `money {currency,minor}`, `intent: CAPTURE`, `customId` | `items`: exact quote itemization; `experience`: official approval return/cancel origins; `savedWallet`: only qualified current consent |
| `capture_order` | `money`, `orderId` | none |
| `refund_capture` | `money`, `captureId` | `orderId`: correlation for unknown refund reconciliation |

`CheckoutItem`: name, positive integer quantity, positive integer unitAmount in the same currency, optional stable short SKU. One purchase unit, 1–100 items, quantity 1–9999, name/SKU ≤127 chars. BigInt sum(unitAmount × quantity) equals exact total. Tax/shipping/discount are zero sandbox fixtures in this contract; unknown real landed costs remain separate. No physical-goods claim is inferred from these service lines.

## SDK operation map (read 2026-11-11)

All methods take the flat request below plus optional `RequestOptions {signal,retry,logging}`; all use OAuth2. Root imports only. `.asApiResult()` is selected immediately on the returned ApiPromise. A thin success must be checked for IDs/status/amount, not trusted because HTTP is 2xx.

| SDK operation/signature | Wire | Request fields used by shipped core | Return and inspected members |
|---|---|---|---|
| `orders.createOrder(Orders.CreateOrderRequest)` | POST `/v2/checkout/orders` | body required `OrderRequest`; optional header `payPalRequestId`→`PayPal-Request-Id`, `prefer`→`Prefer` (`return=representation` overrides SDK `return=minimal`) | `Order`: id/status; purchaseUnits/payments/resources; approval links allowlisted |
| `orders.getOrder(Orders.GetOrderRequest)` | GET `/v2/checkout/orders/{id}` | required path `id` | `Order`: id/status, one purchase unit and exact amount, captures/refunds |
| `orders.captureOrder(Orders.CaptureOrderRequest)` | POST `/v2/checkout/orders/{id}/capture` | required path id; optional payPalRequestId, prefer; optional body `{}` required locally to send `application/json` | `Order`: capture id/status/amount required |
| `payments.getCapturedPayment(Payments.GetCapturedPaymentRequest)` | GET `/v2/payments/captures/{capture_id}` | required path `captureId`→`capture_id` | `CapturedPayment`: id/status/amount |
| `payments.refundCapturedPayment(Payments.RefundCapturedPaymentRequest)` | POST `/v2/payments/captures/{capture_id}/refund` | required captureId; optional payPalRequestId, prefer; optional body `RefundRequest {amount,customId:operationId}` | `Refund`: id/status/amount/customId |
| `payments.getRefund(Payments.GetRefundRequest)` | GET `/v2/payments/refunds/{refund_id}` | required path `refundId`→`refund_id` | `Refund`: id/status/amount |

SDK sends a generic per-call `Idempotency-Key` on non-GET calls; it is **not** application idempotency. PayPal's supported request-ID field carries the committed provider request identity. SDK pagination/streaming is absent; these resource reads are individual objects, so neither is needed here.

Error arms (all `Error` models are imported only as an alias if needed; the application currently consumes core errors):

| Method | `payload.kind` → status |
|---|---|
| createOrder | error→400, error2→401, error3→422, error4→default; undeclared if default body does not decode |
| getOrder | error→401, error2→404, error3→default; undeclared fallback |
| captureOrder | error→400, error2→401, error3→403, error4→404, error5→422, error6→500, error7→default; undeclared fallback |
| getCapturedPayment / getRefund | error→401, error2→403, error3→404, error500→500 **no body**, error4→default; undeclared fallback |
| refundCapturedPayment | error→400, error2→401, error3→403, error4→404, error5→409, error6→422, error500→500 **no body**, error7→default; undeclared fallback |

These arm names are operation-specific, never a shared status switch. Core translates six `PaypalError.kind` leaves; non-family programmer/configuration/abort errors are not silently swallowed. Decode failure on 2xx and missing required resource data remain unknown. Authentication/encoding failure before dispatch is not_sent.

## DUPLICATE CLAIMS

| Write | Durable claim | Rejects duplicate | Catch | Enforcement |
|---|---|---|---|---|
| create order | shared SQL payment operation keyed by tenant/project/businessKey | SQL uniqueness and immutable payload check | SqlPaymentStore.claim driver-aware conflict handling | shipped `src/store.ts`; WorldKit domain call TBD |
| capture order | same store; business key `capture:<domain-order>` | SQL uniqueness | same shipped method | shipped core; domain call TBD |
| refund capture | same store plus resource reservation | SQL uniqueness and locked remaining balance | same shipped method | shipped core; domain call TBD |

No direct SDK writes bypass these claims. Definite refusals permit explicit controlled retry; uncertain writes retain their claims. Test the domain policy before provider entry and the presence of the claim from inside the fake transport.

## UNKNOWN OUTCOMES

| Write | Reread | Reference | Enforcement | Fault test |
|---|---|---|---|---|
| create order | getOrder only when an order ID was observed | known order ID | shipped provider.reconcile | shared conformance; WorldKit test TBD |
| capture order | getOrder then getCapturedPayment | domain-owned order ID and exactly matching capture | shipped provider.reconcile | WorldKit test TBD |
| refund capture | getCapturedPayment then getRefund, or owning-order refund with exact customId | captured refund ID / operation ID | shipped provider.reconcile | WorldKit test TBD |

A lost create with no known resource has no supported request-ID lookup. It remains `pending_reconciliation`; the UI does not start a new order. This is an explicit retained provider limitation, not an invented search or user approval blocker for the workbench. Refund amounts alone never prove an individual refund.

## CROSS-OPERATION INVARIANTS

| Invariant | Legal set | Enforced where | Test |
|---|---|---|---|
| tenant owns kit/quote/order | current authenticated tenant rows | WorldKit repository + policy (TBD) | cross-tenant denied, provider never called |
| quote equals accepted graph/verification | immutable revision+certificate+quote digest | policy (TBD) | stale or altered graph denied before claim |
| amount/currency/itemization immutable | accepted quote rows | policy and core | altered total refused; exact integer sum |
| provider resources belong to this domain | captured application ownership mapping | policy (TBD) | arbitrary account resource denied |
| capture requires actual payer approval | current provider order + application accepted quote | core provider preread + policy | unapproved order never captured |
| repair authority cumulative, current, narrow | versioned consent/cap/expiry/revocation, categories/vendors/unfulfilled items | future repair ledger | +8/+20 and concurrent +15/+15 under +25; no refund replenishment |
| saved token belongs to buyer/merchant | actual approved Vault/token ownership records | future Vault adapter/policy | wrong-token/wrong-buyer/revoked consent denied |

## OPTIONAL FIELDS

| Field | Required by | Set? |
|---|---|---|
| PayPal-Request-Id | duplicate/unknown rows | yes, durable claim's stored value |
| Prefer | reconciliation needs complete resource | `return=representation` |
| SDK capture body | qualified endpoint content-type requirement | empty `{}` |
| customId on order/refund | graph-bound correlation / unknown refund row | domain ID / stable operation ID |
| items, item_total | user-required exact merchant itemization | quote-derived, reconciled |
| experience context | supported payer approval | exact return/cancel origins, NO_SHIPPING for service offer |
| savedWallet | explicit current qualified payer consent | omitted until qualification and consent |
| payPalMockResponse, partner attribution, client metadata, auth assertion | nothing in current user flow | omit |
| fields query on getOrder | no current requirement | omit |
| invoice IDs, noteToPayer, shipping/tax/discount overrides | nothing in active contract | omit |

## WHEN THE API SAYS NO

Applies independently to create, capture, refund and each read:

| Provider result | App HTTP/outcome | Customer message | Proof required |
|---|---|---|---|
| caller-data 4xx except 401/403/429 | same 4xx | allowlisted provider reason + next action | injected reason appears at boundary |
| 401/403 | 502 | Payment service is unavailable. Your kit is saved. | credential refusal mapped |
| 429 | 503 | PayPal needs a moment. Try again shortly. | quota classification |
| 5xx or write connection/timeout/decode | pending_reconciliation | We’re confirming this payment with PayPal. Your kit is safe. | reread attempted, no speculative second write |
| auth/encode before sending | not_sent | Review the payment setup. Your kit is saved. | no business request, no reconciliation read |
| read failure | 502 | We couldn’t refresh the payment yet. | no false absence/success |

## Further full-scope units (explicitly not delivered by the first workbench)

1. Official approval UI and WorldKit create→approve→capture→refund receipts; bind each to certificate/quote. Inspect create receipt for an immediate saved-wallet capture before any capture call.
2. Vault setup approval, token exchange/ownership/revocation; save-during-purchase qualification remains separate. Maps `map/operations/vault.md` read, exact model member expansion happens before that adapter is implemented. Tokens stay private and project-specific.
3. Cumulative repair claims, current-policy executor, supplemental-approval fallback, notification and compensating undo.
4. Toolkit 1.11.0 exact schema allowlist and ownership proxy; configured actions alone are insufficient. Wire-test any write before enabling it; guarded core stays authoritative.
5. Stable deployed authentic PayPal webhook registration and signature verification; durable recovery cron and genuine delivery evidence.

## REQUIRED READING / provenance

- MUST load `typescript-integrate-paypal` and `typescript-getting-started`: loaded from repository-local `.agents/skills` before implementation.
- MUST load `typescript-error-handling`: loaded, including family/status distinctions.
- MUST load `typescript-client-initialization`: loaded; SDK map's actual flat serverOptions supersedes the generic companion's environment example.
- MUST load `typescript-testing`: loaded; real SDK fetch seam and claim-before-dispatch tests required.
- Installed `paypal/sdk-map.md`, Orders/Payments/Vault maps and immutable core README/types/provider source read 2026-11-11. No handwritten direct SDK request is in the initial scope; future additions load their applicable companion skills and revise this contract first.

## Assumptions and capability gates

Project sandbox credentials and isolated PostgreSQL exist. Actual WorldKit buyer approval, payment operations, saved consent, webhook delivery and authority-race tests are still pending. This sheet never counts shared-core Sample tests as project Live evidence. Full product gates remain in the private build ledger; the UI must expose truthful capability states and never offer a fake working payment button.

## Revision 2 — active WorldKit commerce and Vault adapter, 2026-11-11

The first workbench is implemented and verified. The active delivery now includes WorldKit's own live sandbox digital-service checkout, wallet setup fallback, saved-wallet amendments and refunds. A $12 Studio service quote itemizes an $8 source-linked routing dossier and a $4 connection/assembly guide. Its immutable complete graph and unresolved evidence are attached; it does not sell retailer fulfillment or assert a physical compatibility guarantee. The original declared sandbox hardware-kit/amendment fixture workflow remains a separate full-scope unit. Real purchase of physical items is outside authorization.

The parent is preparing a new immutable core for save-on-success during buyer-present purchase. Until its exact consent-bound contract and tests are delivered, the primary save-during-purchase gate remains open; the separately labelled Vault setup fallback below is functional work, not evidence that the primary gate passed.

### Active additional operation contract

All six Vault operation signatures, wire paths, typed error arms and source models were read from installed `paypal/map/operations/vault.md` and `src/models/*`. No deep imports. All calls use OAuth2 and `.asApiResult()`, logging off, retries zero and a 25 s complete-call signal. No streams are involved. Current SDK client is retained behind the shared provider's sandbox validation and OAuth cache. Secrets and full provider responses never enter browser DTOs or model inputs.

| Operation | Exact flat request used | Inspected success | Typed API error arms |
|---|---|---|---|
| vault.createSetupToken | `{payPalRequestId,body:{customer:{merchantCustomerId},paymentSource:{paypal:{description,usagePattern:"IMMEDIATE",usageType:"MERCHANT",customerType:"CONSUMER",permitMultiplePaymentTokens:false,experienceContext:{brandName,locale,returnUrl,cancelUrl,shippingPreference:"NO_SHIPPING",userAction:"CONTINUE"}}}}}` | SetupTokenResponse.id/status/customer.id/customer.merchantCustomerId/paymentSource.paypal.payerId; HTTPS sandbox PayPal approval link | error400,error2=403,error3=422,error4=500,undeclared |
| vault.getSetupToken | `{id: ownedSetupId}` | exact returned id; APPROVED is required before exchange; customer association | error403,error2=404,error3=422,error4=500,undeclared |
| vault.createPaymentToken | `{payPalRequestId,body:{paymentSource:{token:{id:ownedApprovedSetupId,type:"SETUP_TOKEN"}}}}` | PaymentTokenResponse.id/customer.id/customer.merchantCustomerId/paymentSource.paypal.payerId; must reread returned token before activation | error400,error2=403,error3=404,error4=422,error5=500,undeclared |
| vault.getPaymentToken | `{id: ownRecordedTokenId}` | exact token id, wallet type, exact own customer association, and same recorded payer where present | error403,error2=404,error3=422,error4=500,undeclared |
| vault.listCustomerPaymentTokens | `{customerId: ownRecordedCustomerId,pageSize:20,page:1..5,totalRequired:true}` | bounded customer token set; only exact owned customer and unique consent description can help reconcile an unknown exchange, otherwise remain unknown | error400,error2=403,error3=500,undeclared |
| vault.deletePaymentToken | `{id: ownRecordedTokenId}` | HTTP204; subsequent get404 is positive deletion reconciliation | error400,error2=403,error3=500,undeclared |

The SDK-generated generic Idempotency-Key is not authority. Setup and exchange carry durable UUID PayPal-Request-Id. Delete has no such supported field; one durable claim precedes its single dispatch and unknown results are read before any further action. Unsupported optional payer data, shipping address, native app switch, billing plan and partner fields are omitted.

### Durable claims and unknown outcomes

`wk_vault_operations` claims each `(tenant,consent,operation-kind)` before any business endpoint. It stores body hash, durable request id, state and the safe response identity. A changed body on the same key is rejected. Unknown writes cannot be retried. A lost setup create without an ID remains unknown because the API has no supported request-id lookup. An exchange may reconcile only from an owned approved setup/customer plus exact unique consent marker; a mere matching amount or arbitrary account token is not proof. The saved-token status becomes active only after an independent ownership read. Revocation is committed locally before provider deletion and never waits for remote availability.

`wk_financial_authorities` binds exact commands to accepted current quote, graph hash, tenant and resource ownership. `wk_repair_claims` reserves gross incremental spend under a locked current policy before issuing a payment authority. Core SQL claims still precede transport. Cumulative authority includes pending/unknown claims; successful refunds do not restore that gross allowance. +8 then +20 against +25 must escalate the second request. Concurrent +15 requests cannot both enter the provider. Goal changes, owned-item replacement, vendor/category changes and fulfilled items are refused by the domain. Current consent version/digest/expiry/revocation is reloaded before dispatch. Wallet saving alone grants zero spending authority.

Refund authority uses the owned completed capture and current observed provider balance with the core reservation. Refunds are compensating records, not a rewrite of the original receipt or repair log. No physical shipment is implied by this digital-service qualification.

### Required implementation tests

Real SDK fetch-wire tests must assert exact v3 bodies/headers, one dispatch on duplicate/timeout, thin/mismatched ownership response rejection, APPROVED-before-exchange, local revocation-before-delete, HTTP204 handling, 403 vs404 semantics and credential-free errors. PostgreSQL integration tests must prove tenant/resource isolation, quote/graph/amount mutation refusal, claim-before-provider, concurrent cap locking, current policy revocation and unknown reservation retention. Actual WorldKit buyer approval and live receipts remain separate from sample tests. Standard checkout and saved-wallet creation must inspect a returned COMPLETED order/capture before deciding whether any capture call is needed.

All TypeScript companions applicable to the active adapter have now been read in full: authentication, calling-endpoints, models and configuration-resilience in addition to the prior mandatory gate, getting-started, error-handling, client-initialization and testing. The installed source, not generic examples, determines actual SDK member names and flat request placement.

Current official documentation cross-check (2026-11-11): https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal (updated October 14, 2026) and https://developer.paypal.com/sdk/js/v5/save-with-purchase/paypal (updated October 1, 2026). The latter contains contradictory introductory wording; supported request schemas and actual qualified sandbox outcomes, with explicit current consent, determine capability labels. No production eligibility or production identity assurance is inferred from anonymous private judge sessions.

## Revision 3 — immutable core 0.2.3 adopted

Archive `vendor/fracture-paypal-core-0.2.3.tgz` SHA-256 `4cf25ef38b1138a20b561be37cb6a33952c6e96ea7e1eaf33506fb0e8113a341` verified and installed. README, `dist/types.d.ts` and checkout authority contract read before integration. The SDK pin is unchanged. First purchase may now carry `saveWalletOnSuccess:{consentId,consentVersion,consentDigest,usageType:"MERCHANT"}` only with buyer-present experience and a matching current `saveWalletConsent` decision plus expiry. The savedWallet and first-save fields are mutually exclusive. IDs stay out of the provider request; the SDK receives ON_SUCCESS/MERCHANT and its declared CONSUMER/false defaults.

Additional use of existing `orders.getOrder({id})`: only an exact domain-owned completed order may reveal `paymentSource.paypal.attributes.vault.id/status/customer.id`, after checking the order id, purchase-unit customId and exact amount. This data is not a public payment receipt. Token/customer/payer/setup identifiers are encrypted at rest with AES-256-GCM and tenant-bound authenticated context, with a purpose-derived key from the isolated project's AUTH_SECRET. A separate v3 token read must confirm that exact customer before wallet activation. No token read means no active wallet. This is an implementation contract, not a claim of WorldKit runtime vault qualification.

## Revision 4 — authenticated event intake and owned-resource reconciliation

This unit retains the installed immutable core 0.2.4 and the existing SDK pin. Baseline before edits: 85 unit tests, 52 PostgreSQL tests, TypeScript and the production build pass. The source-reading deployment is frozen separately at fe77de0. Existing settled purchases, refunds, gross repair spending and retired consents are preserved.

The installed SDK map exposes Orders, Payments, Vault, Transaction Search and Subscriptions, but no Webhooks API. Use the shipped `PayPalWebhookVerifier` from the package root of `@fracture/paypal-core`; do not invent an SDK webhook method. Its constructor is `(SandboxConfig, registeredWebhookId, transport?: typeof fetch)`, and `verify(rawBody: string, headers: Headers)` returns `{verified: boolean, transmissionId: string}`. `sandboxConfig()` remains the only credentials/host source. The verifier rejects placeholder `WEBHOOK_ID`; simulator payloads cannot be represented as genuine app callbacks. Its existing REST exception calls OAuth at `/v1/oauth2/token` and postback verification at `/v1/notifications/verify-webhook-signature`, preserving the raw event JSON under `webhook_event`. Header-derived fields are `transmission_id`, `transmission_time`, `cert_url`, `auth_algo`, `transmission_sig`; `webhook_id` is server-owned. A non-SUCCESS result is rejected; provider/auth/transport failures leave delivery unaccepted so the provider can retry. No raw request, signature or credentials are logged or returned to the browser.

Current primary references, checked 11 November 2026: [PayPal listener and verification guide](https://developer.paypal.com/api/rest/webhooks/rest/) and [event names](https://developer.paypal.com/api/rest/webhooks/event-names/). The v2 capture event is `PAYMENT.CAPTURE.DECLINED`; the v1 `DENIED` spelling is also retained for received legacy events. `PAYMENT.REFUND.PENDING` and `PAYMENT.REFUND.FAILED` are distinct supported notifications. Unknown authenticated types are retained as unsupported evidence, never guessed into a money transition.

### Additional contract rows

| Operation | Request and success contract | Authority and error handling |
| --- | --- | --- |
| Verify callback | Exact raw UTF-8 body and original PayPal verification headers, plus configured registered webhook ID. SUCCESS is required before intake | No tenant is taken from callback input. Size and header limits precede postback. Missing/invalid signatures are rejected; verification unavailability is retryable. Timestamp is evidence, not a freshness gate that would reject PayPal's documented three-day redelivery window |
| Read owned order | Existing `SandboxPayPalProvider.read("order", providerOrderId, signal)` uses `orders.getOrder({id}).asApiResult()`; requires returned order ID plus supported child capture/refund IDs, status and amounts | Provider ID must already be in `wk_commerce_orders` / `wk_payment_resources`. Child membership comes from the reread order, not an arbitrary callback string |
| Read owned capture/refund | Existing `.read("capture", captureId, signal)` / `.read("refund", refundId, signal)` use the already documented Payments methods | Previously recorded ownership, fresh order membership, or a fresh provider refund's exact canonical capture-parent link is required. An unreadable or failed response remains pending and cannot imply absence, completion or an amount |
| Reconcile accepted operation | Existing `PaymentCore.reconcile(scope, operationId, signal)`; scope and operation come only from the owned domain order | Reconciliation reads the original operation. It never invokes `execute`, `retry`, buyer approval, capture, refund, token saving or future-charge authority |

### Durable writes / duplicate claims / unknown outcomes

There is no additional financial provider write in this receiver unit. Postback verification is repeatable verification of a delivery, not a money operation. Intake commits an event keyed by `(provider, provenance namespace, event ID)` before acknowledging it; every delivery attempt has a separate local UUID even if the provider repeats the same transmission ID. Changed raw bodies under a canonical event ID are retained as conflicts and are not applied twice. Durable worker leases, retry scheduling and dead-letter state survive process restarts. Raw body and selected verification headers are encrypted with purpose-bound authenticated context; public evidence contains hashes and allowlisted status only.

### Cross-operation invariants and optional fields

An authentic callback is a signal to reread provider state, not authority to transact. Unowned account resources are ignored; a known parent may schedule a read but never automatically establish an unverified child. The reducer retains gross captures and all individual refund identities, refuses conflicting amounts/currencies/parents, and never replenishes repair spending. Reversed or disputed states suspend dependent authority without erasing paid history. An expired browser session does not prevent read-only reconciliation of an already accepted operation, and does not regain mutation permission. No caller chooses payee, amount, SDK mock headers, webhook ID, token or arbitrary provider URL. There are no new optional SDK request fields.

Required tests cover altered raw bytes, invalid-then-valid delivery, repeated identical transmission IDs, canonical payload conflict, tenant/resource denial, a callback that precedes local resource indexing, lease loss after a provider read, retry/dead-letter recovery, observed refund/reversal and no financial dispatch. Existing actual 12+8 USD sandbox records remain closed. Root owns authentic endpoint registration/resends and any actual sandbox mutation used to qualify this work. Sample cryptographic/provider tests never close the live-delivery gate.

### Required reading and resolved boundaries

The integration/getting-started/error-handling/client-initialization/testing skills and installed core verifier/provider types are the governing references; prior adapter companions remain applicable. The installed SDK map, shipped verifier REST implementation, owned domain repository and official event documents resolve the operations above. No new SDK method or provider mutation is needed. The exact registered webhook ID and a genuine signed delivery remain runtime capability gates owned by the integration lead; unavailable configuration is reported without fabricating a successful callback.

Observed local validation for revision4:101unit/SDK checks,78PostgreSQL checks, TypeScript and the production build pass. Eleven focused payment callback cases cover duplicate transmission IDs, unresolved-event authority/delivery holds, core-before-domain resource recovery, lost-capture reconciliation, partial refund/gross-claim retention, reversal, pending-to-completed refund, cross-tenant ambiguity, wrong amount, unexpected order identity and expired-lease fencing. Fourteen HTTP guard/reload checks pass. These use explicit Sample adapters and perform no new financial provider mutation. Authentic registration/delivery/resend and hosted qualification remain open; existing12+8USDsettled/refunded evidence is unchanged.

## Revision 5 — graph-bound Living Repair and controlled merchant commitments

Baseline: unchanged source 4fc341a4ba2d8344f4e635c2a6c4a204547372aa passes 101 unit/SDK checks and TypeScript. The installed `paypal` root resolves and its 2.29.0 map and the immutable core 0.2.4 contracts were read. This unit changes domain policy, persistence and UI; it introduces no SDK endpoint, credential, transport, host, retry or logging change. All Orders/Payments request fields, errors, omitted optional fields and unknown-outcome limitations above remain authoritative. The integration, getting-started, error-handling, client-initialization and testing skills govern this unit. Existing adapter companions govern those unchanged adapters.

WorldKit Studio controlled kit demonstrations have their own versioned commitments, exact line identities, fresh authority and gross claims. Their original baseline is explicitly a Sample merchant commitment, with no inferred retailer order or payment. A later actual PayPal sandbox amendment is separately labelled Live · Sandbox. The legacy digital dossier policy and its fully refunded $12/$8 qualification cannot authorize this scope. A positive kit change needs fresh buyer approval or a separately accepted `controlled_kit_amendments` policy tied to a current owned wallet; a saved token alone permits nothing. Current catalog prices and unknown retailer landed costs remain separate from the controlled merchant's explicit USD quote, zero test shipping/tax and fulfillment simulation.

| Operation | Durable claim and duplicate boundary | Unknown outcome / ownership | Enforcement and required test |
| --- | --- | --- | --- |
| Create amendment order | One immutable amendment/quote and one gross claim, locked on commitment and policy, before an encrypted existing financial-authority row and core operation; stable business key and provider request ID | Reconcile the original core operation only. Lost create without provider ID stays pending; no replacement order or restored allowance | Living Repair commerce boundary; duplicate delivery/acceptance and lost-response tests |
| Capture buyer-approved amendment | Existing owned order, exact proposal/quote/graph hash, current commitment and one capture operation | Existing core order/capture rereads; an immediate capture returned by create is never captured again | Living Repair dispatch and existing capture transport; immediate-create/capture tests |
| Credit or compensate an amendment | Separate immutable compensation consent binds order, capture, amount, current remaining balance and original proposal; unique compensation operation | Read owned capture and individual refund resources. Pending/partial/unknown results retain the operation, current kit and gross-spend history | Living Repair refund policy; partial/timeout/refusal/restart tests |
| Restore merchant commitment | No financial provider operation. Current version, unfulfilled exact lines, current stock, technical checks and authoritative money observation are required in one transaction | A paid-but-uncommittable change enters support/compensation. Original revisions, charges and certificates stay immutable | Merchant commitment transaction; concurrent edit, stock failure, shipment, and failure-after-refund tests |

The browser supplies identifiers, expected hashes and explicit narrow choices, never amount, payee, arbitrary SDK fields or provider resource IDs. An amendment records the complete before/after bundle, changed components and offers, dependency closure, critical-fact checks, exact source identities, certificate, merchant quote, source mode and expiry. Same-variant merchant changes keep their technical identity; a variant change reruns affected requirements and preserves all hard goals and owned equipment. Candidate discovery and MCP proposals grant no purchase permission.

At every financial dispatch the domain reloads the accepted amendment, commitment version/fulfillment, policy revocation/expiry, wallet consent/version, candidate/quote/graph hash, merchant, currency, categories, exact offer condition, vendor scope and pending plus consumed gross cap. Refunds never replenish the cap. A within-cap unavailable wallet produces `requires_payment_approval`; above-cap produces `awaiting_consent`. Cancellation cannot release unknown money claims. Already accepted operations can continue read-only reconciliation after browser expiry or policy revocation.

Compensation and 24-hour undo are fresh, conditional requests. Restoration checks original stock, current cost, exact graph feasibility, later amendments, simulated shipment and the recorded return policy. A more expensive restoration requires a separately approved supplemental payment. A successful refund followed by a failed restoration remains a refund plus `partial_support_needed`, never a fictitious rollback. Notifications use a durable in-app outbox; retries cannot dispatch money.

Local qualification uses a new database schema, port 4506, empty/blocked financial credentials and explicit Sample provider adapters. Root alone owns original/hosted schema migration, provider configuration, actual financial qualification and deployment. Authentic market deliveries and human/physical reviews remain evidence gates, not invented fixtures. No new SDK lookup is open; actual live qualification is separate from source implementation.

Observed local validation for revision 5: 114 unit/SDK checks and 108 PostgreSQL checks pass, including 13 new unit checks and 30 new integration cases. The retained production review build passed TypeScript and build checks. Root's native review completed the exact $8 Sample amendment, separate conditional undo consent, $8 Sample refund and restoration with both graph versions retained. Committed and restored mobile states were checked at 390 pixels; the committed document measured 390 pixels with no horizontal overflow. This is local Sample qualification only: zero actual financial or subscription provider writes, no authentic market callback claimed and no new human or physical compatibility review.


## Revision 6 — scoped official Toolkit evidence reads

Implementation contract: `plans/ACTIVE_TOOLKIT_READS.md` (private), summarized here for a fresh clone. Pin official `@paypal/agent-toolkit@1.11.0`; enable only `get_order` and `list_transactions`. Resolve server-owned order/capture/custom ID/amount from the accepted WorldKit sandbox order, require exact expected graph hash and current tenant/grant, and revalidate ownership before OAuth, GET and disclosure. Only `payment:read` grants can call the new MCP tool; existing kit permissions do not include payment evidence.

Use the public CJS OpenAI Toolkit entry and its public Axios request middleware seam with per-call AsyncLocalStorage. Require exactly one OAuth POST and one owned-resource GET on the fixed sandbox origin, bounded reporting query, timeout/body limit and no redirect/retry. Validate the observed wire response independently because Toolkit reporting may turn upstream failure into an empty result. Persist an idempotent request plus safe immutable observation; duplicate requests never redispatch. Reporting absence is inconclusive. No model-controlled provider identifiers, no write tools, no raw PII and no financial projection mutations. Actual installed transport tests, PostgreSQL authority/race tests, local UI checks and actual sandbox reads are separate evidence gates; none is claimed merely by this contract. Existing pinned APIMatic payment core 0.2.4 is unchanged.
