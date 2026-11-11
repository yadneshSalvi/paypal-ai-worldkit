# Living Kit: alerts and authenticated observations

This checkpoint implements exact-product alerts, signed event intake, durable recovery, current catalog/payment reads, private notifications and a customer review surface. It has passed local SDK, PostgreSQL and production-build HTTP checks. **Authentic deployed deliveries and actual subscription creation/cancellation are still qualification gates.** Root browser qualification now passes for the live offer review and declared Sample lifecycle; deployment remains separate.

Open **Living kit** to inspect updates, equipment alerts and event receipts. The section and selected view survive reload. Add an alert from an active, catalog-bound equipment entry, refresh its exact variant and choose current merchant domains. Ownership of the equipment remains the passport's separate confirmation. An alert does not reserve stock, accept a substitution or authorize a charge.

## Provider setup

Register stable per-project HTTPS URLs. A production hostname can receive sandbox events; the payment provider remains sandbox-only. Preview deployments must not acquire another project's callbacks or subscriptions.

| Provider | Stable receiver | Required configuration | Event scope |
| --- | --- | --- | --- |
| Channel3 | `https://paypal-ai-worldkit.vercel.app/api/webhooks/channel3` | `CHANNEL3_API_KEY`, the endpoint's `CHANNEL3_WEBHOOK_SECRET` (`whsec_…`), optionally `CHANNEL3_WEBHOOK_SECRET_PREVIOUS` during rotation | `offer.price.changed`, `offer.availability.changed`, `offer.created`, `offer.deleted` |
| PayPal sandbox | `https://paypal-ai-worldkit.vercel.app/api/webhooks/paypal` | The isolated WorldKit sandbox client, its stable `PAYPAL_WEBHOOK_ID`, existing `AUTH_SECRET` | `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.FAILED` |

Use the event names the specific PayPal app actually supports; `DENIED` is retained for legacy deliveries. The setup owner registers endpoints and stores keys privately. Neither a nonempty key nor a simulator event closes the authentic-delivery gate. Normal application login must not intercept these two receivers. Preserve `AUTH_SECRET`: encrypted authorities, original operations and callback receipts depend on it.

Official contracts checked for this implementation: [Channel3 product subscriptions and webhooks](https://channel3.ai/docs/product-subscription-webhooks), [Svix signature verification](https://docs.svix.com/receiving/verifying-payloads/how), [PayPal verification and delivery](https://developer.paypal.com/api/rest/webhooks/rest/), [PayPal event names](https://developer.paypal.com/api/rest/webhooks/event-names/). Installed transports are Channel3 SDK **4.9.0**, Svix **2.10.0**, and the immutable guarded payment core **0.2.4**. The PayPal SDK has no webhook controller; the shipped verifier uses its documented postback REST exception. See [the PayPal contract](../paypal-plan.md).

The Channel3 envelope is `{id,type,timestamp,data}`. `data` binds `subscription_id`, `subject.product_id`, the exact `subject.selection` name/label pairs, `subject.domain` and locale. Changed events include their documented previous/current price or availability; create/delete carry the offer. Schema validation is explicit in `packages/webhooks/contracts.ts`. Retailer URLs are stripped from the operational signal and never become fetch targets.

## Subscription safety and recovery

The server refreshes the confirmed exact model before accepting an alert. Every option needs one exact selected value. Only current merchant domains may be selected; scopes split at 25 domains. Product, variant, merchant domains, four events and `en/US/USD` locale are hashed together. Sample and replay namespaces use independent scope identities and cannot be claimed by a live worker. Duplicate request IDs and reopened identical active alerts return the saved alert.

Before a create, the worker inventories existing account subscriptions. Existing matches are adopted read-only. A new create has a committed intent before dispatch. Channel3 can return an existing subscription for an idempotent scope, and the shared account does not provide a WorldKit ownership tag; even a successful create therefore remains **unconfirmed ownership** until an operator establishes its origin. No application browser action can assert provider ownership.

Canonicalization `409` waits 2/4/8/16/30 seconds, then uses five-minute background checks after ten minutes. Quota refusal uses bounded retry; it does not widen scope. An ambiguous write is reconciled by listing the original exact scope and is never blindly repeated. Pagination has cycle/page limits. Six failed reads preserve the original operation and expose a retryable review state. Subscription leases last 90 seconds; a late worker may retain an observation but cannot overwrite newer recovery.

Stopping an alert is immediate for its workspace. A remote cancellation requires both an exact operator ownership record and zero active consumers across workspaces. Shared, adopted or unconfirmed resources remain untouched. Expired sessions, changed equipment versions and archived items release their old watches. Cancellation intent is durable; an uncertain result reads the same provider ID rather than sending another delete.

The private `scripts/living-operator.ts` accepts one JSON input file. `inspect` is read-only. `attest_exclusive_ownership` changes local ownership authority and may make a zero-consumer subscription eligible for later cancellation; use it only after reviewing concrete account/provider evidence. Never infer exclusive ownership from a successful idempotent create.

```json
{"action":"inspect","subscriptionId":"<saved subscription UUID>"}
```

```sh
node --env-file=.env --import tsx scripts/living-operator.ts /private/operator-input.json
```

An attestation input additionally requires the exact `providerId`, `expectedScopeHash`, an actual operator `actor`, and a specific 40–2000-character `statement` explaining the ownership evidence. The tool records that statement and does not send a provider mutation itself. The resulting cancellation remains subject to consumer and lease checks. Fixture statements are explicitly synthetic and cannot qualify real ownership.

## Delivery and projection

The receiver bounds the actual raw UTF-8 stream to 1 MiB, rejects content encoding and validates signature headers. Svix verifies the untouched body with the endpoint's current or previous key and its timestamp tolerance. PayPal postback receives the original JSON and configured webhook identity; no five-minute delivery cutoff is imposed on PayPal's documented redelivery window. Verification failure is not acknowledged as accepted.

After authentication, `(provider, namespace, event ID)` identifies the canonical event. Every delivery gets a separate local UUID, including deliveries that reuse a transmission ID. Identical delivery retries increment the receipt count. Different raw bytes under the same event ID are encrypted and quarantined; they never replace the first signal. Unsupported authenticated envelopes become retained review records. Raw bodies and selected signature headers use purpose-bound AES-GCM encryption. Customer DTOs contain hashes, status and counts, not raw signatures or secret-bearing payloads.

Intake commits before returning HTTP200. Workers use 150-second fenced leases, per-resource serialization, six bounded read failures and dead-letter/retry state. Events arriving before local provider identity persistence wait for ownership for up to 15 minutes, then remain retained and unowned. A later identical delivery can revive an unowned event once exact ownership exists. Unrelated account events never become visible in a customer workspace.

The existing authenticated minute cron at `/api/jobs/recover` now advances model jobs, subscriptions and event recovery. The same process can be resumed by browser polling. Its response includes claimed checks and an aggregate `maintenanceErrors` count; individual retry/review state remains in the database. No hosting configuration change is required by this unit.

An offer event triggers a fresh read of its exact product/variant. A currently in-stock response resolves an old shortage. A current shortage, missing merchant or identity conflict creates one review incident per event/watch, with source mode, current response hash and saved revision. Stopping or changing the watch during the read prevents late notification. Each tenant gets its own retained snapshot identity. Notifications are available inside the private workbench only; no email, SMS or outside message is sent.

A PayPal event can only reconcile an accepted, encrypted operation and reread its already-owned order/capture or a freshly established refund child. Callback strings do not establish tenant ownership. Conflicting parents, currency, source or amount require review. Fresh resource timestamps protect canonical projection from old receipts; gross capture and individual completed refunds never disappear. Pending or adverse observations hold delivery and future payment authority. Refunds and reversals end the original standing policy without restoring its consumed/pending gross allowance. A reversal remains distinct from a refund. The callback runtime has no execute, capture, refund or retry-write interface.

## Qualification and current limits

[Root browser qualification](evidence/living-browser-qualification.json) passed on the local production build: actual saved H4 offers, unavailable-endpoint save gating, modal focus/Escape, Sample read/dismiss/stop persistence, three deliveries with one processing attempt, and layouts at 390/768/1280/1920 pixels. The original browser session and viewport were restored. No synthetic product ID was refreshed against the actual catalog, and no financial or subscription provider mutation occurred.

[Local qualification](evidence/living-local-qualification.json) records 101 unit/SDK checks, 78 PostgreSQL checks and a successful production build. [HTTP qualification](evidence/living-http-qualification.json) records 14 production-build access, origin, namespace, body-limit and reload checks. Contract/provider fixtures are **Sample**; this unit has made no new financial or subscription provider mutation. Preserve the earlier fully refunded $12+$8 qualification and retired wallet/policy.

`scripts/seed-living-sample.ts` creates a local sample shortage, one notification and three deliveries of one event for browser review. Its session cookie is written only to `.artifacts/living-ui-session.json` with owner-only permissions. Do not publish that file or attempt a real catalog refresh on its synthetic product ID. `scripts/qualify-living-http.ts` uses separate sample workspaces on port4106 and writes only an aggregate safe receipt.

The complete alternative-search → deterministic re-verification → amendment → current authority/approval → reconciliation → merchant commitment → notification/undo saga remains to be implemented. This checkpoint offers a review incident and an Explore entry point, not automatic stock substitution. Conditional restoration, partial compensation, source-update invalidation, retention/purge operations and full operator incident tooling remain open. Actual signed deliveries, provider retries across deployment, exclusive ownership, remote cancellation and hosted execution must be measured before those capabilities are advertised as qualified.
