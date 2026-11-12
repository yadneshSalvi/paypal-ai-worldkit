# Purpose-built systems

The **Systems** section adds two reusable packs alongside the creator workbench. A system has its own goal, exact device identities, graph, configuration and immutable editions. Creating or changing one does not replace the creator graph.

| Pack | Documented scope | A useful failure to explore |
| --- | --- | --- |
| A desk for two views | MacBook Air M2 (13-inch, 2022) or M3 (13-inch, 2024), Dell U2723QE, direct native USB-C display paths and the included MagSafe power set | Two USB-C sockets do not give the M2 two native external display engines. M3 dual-display mode requires the documented closed-lid setup. |
| Every voice, its own track | Two to six local voices, original Zoom PodTrak P4 or P8, SM58-LC microphones, MDR-7506 headphones and local SD recording | The P4 has four local microphone inputs. Both models send a stereo USB mix; that mix is not a separate file for every microphone. P8 track files require the corresponding setting. |

Each manufacturer claim links to a source document with a retrieval timestamp and SHA-256 fingerprint. Sources are stored as public links and factual notes; the application does not distribute the original manuals. These packs have **zero genuine human reviews and zero physical tests**. A modeled constraint can pass while the overall certificate remains unresolved. Missing, rejected, conflicting or changed source evidence cannot become a positive capability merely because a setting was selected.

## Working with a system

1. Open **Systems** and create a named project from a pack.
2. Change the goal, exact equipment, operating conditions or budget. The illustration continues to show the saved edition.
3. Preview the change. Inspect the before/after values, all requirements and remaining evidence questions. A changed participant or display count is labeled as a goal change.
4. Save that exact preview. Its graph, source set, certificate and configuration become the next immutable edition.
5. Open **Assembly** for source-linked instructions and individual cable experiments. The podcast pack can audition the saved routing using generated tones. A missing input is silent; no audio from a physical recorder is implied.
6. Use **Versions** to inspect a past edition or prepare a restoration using the current pack. Restoration creates a new edition.

The equipment passport includes the exact pack profiles. Ownership is an explicit user claim tied to the current passport item, version, profile hash and quantity. A single owned item cannot fill two simultaneous positions unless the confirmed quantity permits it. Changing or archiving an item makes its old ownership binding stale. The system will require a corrected preview before that binding can be saved again.

Complete equipment cost remains unknown until exact, current offers, necessary accessories, shipping and tax are attached. No physical-equipment purchase or automatic merchant checkout is included in these packs.

## Evidence and agent access

The evidence dossier exports the exact edition, certificate, source fingerprints, assembly instructions and current freshness. It is private and uncached.

An owner can create a `kit:verify` grant for one specific system for up to one hour, bounded by the workspace expiry. The bearer secret is shown once; command receipts retain only its grant identity and expiry. Retrying an uncertain grant creation returns the same grant identity, not a second grant. If the first secret was lost, revoke that grant and create a new one.

The standard `verify_kit` MCP tool accepts the saved `packrev_…` edition ID and its full graph hash. The same scoped evidence is available at:

```text
worldkit://domains/{projectId}/{editionId}/{graphHash}/certificate
worldkit://domains/{projectId}/{editionId}/{graphHash}/assembly
```

Every read checks the current session, grant scope, exact project ownership and graph identity. The response distinguishes the original certificate from current source and equipment freshness. Archiving a project ends its grants while retaining its owner-visible history. These grants do not authorize editing, source review, physical verification, payment access or purchasing.

## Persistence and validation

The additive `wk_domain_*` tables retain append-only editions, previews, command receipts, events and grant associations. Project updates require the next edition or archival. Tenant and project foreign keys prevent a current pointer from naming another system's edition. Every command is bound to an owner, request ID and input hash. Preview application checks the current edition, graph, project version, pack/source edition, expiry and equipment bindings again inside the transaction.

The independent test suites are `tests/domain-packs.test.ts` and `tests/domain-packs.integration.ts`. They exercise manufacturer limits, rejected capabilities, missing/reused ports, source drift, real passport confirmation, immutable history, concurrent application, idempotency, current authority and actual MCP Streamable HTTP transport. The audio tests inspect the PCM data and silent missing channels, rather than treating a successful download as a soundcheck.

For a separate local fixture, reserve ports **4565** and **55565**, then run:

```sh
node --import tsx scripts/local-domain-packs-qa.ts
node scripts/run-domain-packs-qa.mjs test
node scripts/run-domain-packs-qa.mjs build
node scripts/run-domain-packs-qa.mjs start
```

The launcher creates a new PostgreSQL cluster with a limited application role and an owner-only configuration under `.local/domain-packs-unit/`. Re-running it resumes that exact cluster; it does not recreate projects or extend sessions. The application uses the distinct `wk_domain_packs_qa` cookie and `.next-domain-packs-qa` build directory. Provider calls are disabled, and the database test guard rejects unrelated databases.
