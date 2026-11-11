# Exact engineering review and scoped collaboration

The engineering reading room at `/review` separates source extraction, proposed corrections, independent engineering decisions and physical evidence. It is an additive application unit. Existing source documents, model drafts, candidates, kits, certificates and financial records are never rewritten by a review or promotion.

The isolated qualification uses original fictional source text, an original fictional recorder illustration and explicitly **Sample** principals. It establishes software behavior only. Actual human-reviewed coverage and physical tests remain zero. The root in-app browser qualification is recorded in `docs/evidence/engineering-review-native-root-qualification.json`. Genuine identity/qualification examination, technical review of the actual corpus and hosted promotion remain separate evidence gates; consult the receipts for the exact observations.

## Authority and identity

An existing creator session becomes the owner of its own review workspace without replacing that session or its data. A creator can propose editions, register principals, prepare deliberate copy-link invitations, revoke a link or person, approve an image crop, promote an eligible scope and withdraw a current promotion. Creator authority never supplies an independent engineering decision.

A specialist invitation names exactly one tenant, kit, profile and source document. Its role is one of reader, editor, reviewer or adjudicator; its expiry cannot exceed the creator session or seven days. The invitation is deliberately copied by the creator. No email, invitation delivery or external message is sent. Roles cannot be changed in place: revoke the old capability and create a new scoped invitation. The principal remains the same.

An invitation token is hashed for lookup and encrypted for an idempotent private response. It arrives in a URL fragment, which the join page removes before inspecting it. Explicit scope acknowledgement redeems it once, generating a new credential that is returned only in an HttpOnly, SameSite=Strict cookie. It carries no creator, payment, ownership, publication, catalog or tool authority. A specialist cookie takes precedence on the review API so a creator cookie cannot accidentally enlarge the active review role.

Every read and command checks current tenant, actor, capability version, role, expiry and revocation. Commands serialize on the workspace and record immutable, actor-bound request intents. A retry cannot change its command body, evade revocation or apply twice. A failed command keeps the previous saved state. Bounded JSON intake, same-origin writes, no-store responses, no-referrer policy and no-index headers cover the review, invitation, text and image surfaces.

The operator attestation policy is `worldkit.engineering-review.1`:

- A browser token or display name establishes access, not a real-world identity or expertise.
- Actual decisions require a separately examined human identity and a current qualification with `engineering` expertise. Simultaneous operating-mode claims additionally require `simultaneous`; image geometry requires `geometry`.
- A stable identity digest is unique within the workspace. A second invitation, browser or alias cannot become a second reviewer. A principal cannot replace its established identity digest. Qualification renewal creates another immutable attestation.
- The creator's identity and every other author's identity must be established and bound into a fresh human edition before independent actual review can count. The creator can receive an identity-only attestation; this does not grant reviewer authority.
- Every contributing author remains in the edition chain. Both actor identity and established real-world identity exclude self-review. Fictional Sample authors cannot author human editions.
- Revoking a capability or actor, replacing or expiring a qualification, or allowing a session to expire removes its current authority. Original votes and their reasons stay readable by still-authorized collaborators.

The browser has no qualification endpoint. After genuine examination, an authorized operator can use:

```sh
node --env-file=.env --import tsx scripts/qualify-engineering-reviewer.ts /private/attestation.json
```

The manifest must be owner-only (0600), at most 16 KB, and include tenant/actor IDs, stable identity/evidence SHA-256 digests, examined expertise, method, issuer, expiry, and explicit `examinedOriginalIdentityEvidence`, `examinedQualifications`, `realHumanParticipation` acknowledgements. Retain original identity and qualification evidence privately; do not put it in the repository or invitation. The operator seam refuses every synthetic QA runtime. It was not invoked to manufacture human qualifications during this unit.

## Immutable editions and corrections

An edition contains its policy, provenance, authors and identity attestations, correction reason, predecessor, exact proposal version and canonical content hash. The binding names:

- The kit revision and graph hash at review/promotion time.
- Exact manufacturer, model, variant, firmware, OS, application and operating conditions.
- Source document ID, original document hash, normalized-text hash and source-head version.
- The candidate plus its source-identity hash and immutable extraction draft/hash.
- The previous promoted profile head and approved image/crop identity.
- Typed predicate/value/unit/conditions, stable target and claim identities, and exact page/start/end/excerpt-hash anchors.

Manufacturer and software-publisher evidence may support actual source review. Catalog descriptions, fictional sources and physical-test labels cannot acquire manufacturer authority. A related product's manual does not match the exact candidate identity. Source anchor validation recomputes the saved normalized text and selected bytes; edits cannot invent an excerpt hash.

There is one chain per tenant, exact profile, document and provenance. Reopening the same candidate returns its chain. Changing the kit or extractor cannot create a blank history to evade dissent. Sample rehearsal and actual human review have separate chains; neither contributes authority to the other. A new document opens a new source review, and dependent kits remain visible in source impact.

Corrections make new editions. Votes never transfer between editions. Original critical extraction obligations cannot disappear or become optional. Rejected, unresolved and disputed predicates remain explicit in subsequent editions even if they were initially optional; changing the claim ID does not remove the predicate obligation. Omitting or renaming a disputed predicate fails closed. The application retains up to 60 editions per chain, with a visible capacity boundary rather than silently dropping the chain.

Accept/reject/unresolved decisions require reasons and capture the exact edition, capability version, qualification and person. Critical simultaneous-mode predicates always require two distinct currently authorized qualified principals, including when their category is changed. A disagreement cannot be outvoted or erased by revoking the dissenter. Resolution is a separate adjudication of the exact retained review-decision-set hash by two distinct qualified adjudicators. A later review changes that hash and invalidates the earlier resolution. A corrected disputed predicate likewise requires two adjudicators in its new edition. A claim with no known value or exact supporting passage cannot be accepted through voting.

## Source-backed port maps

Each port has stable identity and label, with separate critical assertions for connector, direction, signal, protocol list, channel count, power in watts and resource sharing. These fields each bind source passages and conditional modes. Their typed validation is independent of the illustration. An unknown connector, direction, channel count or resource remains unknown, and an incomplete map cannot become eligible.

The creator approves a private image's exact original hash, rights/context description and normalized crop. Image anchors carry that asset ID, image hash, crop hash, normalized coordinates, visible face and label placement. A changed crop invalidates all old coordinates. The editor offers numeric coordinates and keyboard movement (arrow keys move 1%; Shift moves 5%) as well as a labelled rail for hidden or unsupported locations. An old crop can be explicitly rebound, beginning at the center so the new coordinates must be reviewed. Original fictional illustrations remain marked Sample and cannot establish actual geometry.

The source reader serves only the named saved document to an authorized scope, in chunks of at most 12,000 characters. Selecting up to 1,200 characters creates an exact source anchor. This is a private capability surface; the existing public evidence and certificate projections do not acquire full manufacturer text or reviewer identities.

## Promotion, new graph use and historical proofs

Promotion rechecks every binding and current authority under the transaction. All applicable critical predicates, port-field predicates and recorded conflicts must pass. Accepted facts and their exact conditions are enumerated. Promotion creates an immutable scoped profile, advances its versioned head and records impact on dependent revisions, requirement witnesses and enabled connections. It does not edit a kit or purchase history.

An eligible human edition may create a profile with reviewed facts within its listed conditions. Physical performance remains `not_performed`. A Sample promotion keeps every fact's human review pending, keeps the map `review_pending`, and adds an unknown critical technical-scope fact. It cannot turn an actual kit green or raise actual human coverage.

The creator adopts a promoted profile through the existing explicit equipment preview/confirmation workflow. Cached equipment confirmations and every new saved graph recheck current source, crop, profile head and reviewer authority. Row locks make these checks atomic with revocation or supersession. A stale preview cannot acquire a reviewed profile after revocation. The immutable engineering facts remain available after a valid graph adoption: the promotion retains its original graph binding, while subsequent graphs receive their own compiler checks against the same exact source/operating scope.

Withdrawal appends a reason and clears the current head. Supersession creates another immutable profile. Expiry, revocation, source/image changes and withdrawal make the profile unavailable for new use; retained facts and existing certificates keep their original values and provenance. Existing public-source deletion/expiry rules remain in force. The source-impact view and reading room identify dependent kits requiring fresh work, with current revisions first and an explicit 100-revision inspection bound.

## Reading-room workflow

From **Proof → Source library**, open **Engineering reading room**. The creator sees current exact candidates and review chains; the **People & access** desk manages principals, narrow roles, expiries and revocation. The review desk provides unknown/conflict/accepted queues, source excerpts and private reading, exact conditions, port maps, recorded reasons, independent decisions and exact-set adjudication.

**Propose changes** keeps a local draft and its original optimistic version if another collaborator saves. Saving requires a correction reason. Stale bindings require explicit rebase acknowledgement; changed documents require a source candidate for the new document. A changed crop must have its anchors rebound. **Editions & comparison** compares typed assertions, source anchors, operating conditions and ports, and lets the reader inspect earlier decisions. **Scope & affected kits** shows enumerated promotion scope, withdrawals and dependent proof witnesses. The consumer workbench retains its existing navigation.

Controls use ordinary labels, visible focus, native form semantics, keyboard text selection and coordinate inputs. Queue panels become horizontally scrollable on narrow screens; forms and the source reader stack. Current authority refreshes every 15 seconds while the page is visible and on focus, and every command checks immediately. Native viewport/focus observations must be recorded independently; CSS and HTTP checks alone do not establish browser usability.

## Isolated qualification and native handoff

Use a separate source checkout with its own installed dependencies and build output. Never build over a protected running checkout. The launcher accepts no original database or provider credentials:

```sh
node scripts/engineering-review-qa.mjs --init
node scripts/engineering-review-qa.mjs --test tests/*.test.ts
node scripts/engineering-review-qa.mjs --test tests/*.integration.ts
node scripts/engineering-review-qa.mjs --build
node scripts/engineering-review-qa.mjs --start
node scripts/engineering-review-qa.mjs --script scripts/qualify-engineering-review-http.ts
node scripts/engineering-review-qa.mjs --script scripts/seed-engineering-review-native.ts
```

`--init` creates a random local PostgreSQL database owned by a separate non-superuser, non-creator role. Configuration is in ignored `.local/engineering-review-qa/runtime-private.json` (0600). Existing configuration is retained; there is no reset command. The launcher starts at `127.0.0.1:4532`, uses `.next-engineering-qa`, blanks project dotenv variables and all provider credentials, and sets `WORLDKIT_DISABLE_PROVIDERS=true`. The creator cookie is `wk_engineering_qa`; the specialist cookie is `wk_engineering_reviewer_qa`. These cookies cannot replace protected original sessions.

The native seed writes ignored `.local/engineering-review-qa/native-private.json` (0600). It contains exact URLs, edition fingerprints and isolated cookies. Re-running it retains its existing data and deadlines. Do not copy its credentials into reports, screenshots, Git or shared chat. Native work uses these fictional fixtures only:

1. **Review fixture / creator:** Open the exact source-bound edition. Verify 18 targets, a simultaneous-mode disagreement, a blocked promotion, actual human review 0 and physical tests 0. Inspect the retained acceptance/rejection and read the source passage.
2. **Blake / first adjudicator:** Clear the creator context or use the supplied specialist credential. Select `simultaneousUsbRecording`, accept its exact scope with an explicit Sample reason, and record adjudication. One adjudication must leave it conflicted.
3. **Casey / second adjudicator:** Record a second distinct adjudication of the same decision-set hash. Both reasons and the original dissent remain visible. Return to the creator by clearing/leaving specialist mode. Explicitly acknowledge the scope and promote the Sample profile. Coverage stays 0 actual / 0 physical. Inspect affected requirement/connection witnesses and withdraw the current Sample profile from the impact tab.
4. **Unused Drew invitation:** Open the supplied fragment link in a separate isolated context. The URL must lose its bearer fragment; the named Sample reader sees a narrow scope and explicit acknowledgement. Redeem once, verify a reader cannot edit or vote, and verify reusing the same link fails. Creator-side revocation must close that reader's next command immediately and its visible read after refresh/polling.
5. **Editing fixture:** Use its creator cookie and clear any specialist cookie. Open **Propose changes**. Tab to INPUT A's anchor and move it with arrows; verify numeric coordinates change while source-backed connector facts stay unchanged. Choose label placement and rail/anchor modes, select an exact source passage with the keyboard, add it to the selected claim, write a reason and save a new edition. Compare both editions and verify previous source fingerprints/decisions remain retained. Test browser reload and stale-version recovery without losing saved history.
6. **Stale fixture:** Observe the explicit stale source-head state. A decision/promotion must remain blocked. Use explicit rebase to create a new source-bound edition, leaving the earlier hash visible in history.
7. Repeat representative source reading, decision and anchor editing at 360/390/768/1280 widths. Check document overflow, visible keyboard focus, labelled inputs, tab order, horizontal queues, 200% zoom and reduced motion. Record actual failures and corrections. These observations are the root/native gate, separate from this unit's local service and HTTP evidence.

The HTTP suite publishes and then withdraws only its own fictional certificate to compare unchanged payload bytes. It never operates on original public records, original sessions, original manufacturer copies or money. Failure logs and JSON receipts remain in the isolated ignored evidence directory. The committed success receipt excludes bearer credentials and database secrets.

The deterministic source/runtime manifest records the source commit and tree, every reviewed source digest, dependency lock and installed package identity, independent build ID and hashes, trace boundaries, test/log fingerprints, isolated role properties and private-value scan. Native observations attach to that exact build. Hosted migration/promotion belongs to the root and is not implied by a local build or a Sample review.

Remaining full-product work includes genuine engineering profiles and port maps across the corpus, independent adjudication of the held-out extraction reference, physical rig and novice studies, broader domain packs and upgrades, provider/event qualification, original media and final release work. Completing this software unit does not complete WorldKit or any of the other projects.
