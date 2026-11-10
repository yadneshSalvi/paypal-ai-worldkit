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
