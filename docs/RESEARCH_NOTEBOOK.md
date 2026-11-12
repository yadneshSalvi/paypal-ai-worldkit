# Research notebook

Open **Research notebook** from the workbench header, or `/research`, in an existing private workspace. Declare tasks, record dated permission and keep observations against the exact task, consent and system that were present. Opening a study never admits or renews a workspace, contacts a participant, or records a task result.

The notebook is deployed with [hosted and native qualification](evidence/notebooks-hosted-qualification.json), including exact protocol history, source variation and withheld text after withdrawal. It makes the planned research workflow usable. It does not independently establish a person's identity, experience, consent or performance. **Sample** studies contain fictional participants and outcomes. **Operator-recorded** studies retain what the operator declares; their mode cannot later become Sample or vice versa. Independently verified participant counts remain zero. The separate research acceptance gate still requires 5–8 consenting novice creators and an appropriately qualified audio engineer, with actual observations and scoped findings.

## Run a study

1. Choose one saved creator, desk or podcast system. The study retains its graph, source, profile, rule and certificate fingerprints. Give the study a question and edit the five starter tasks or declare your own instructions and success criteria before observing them.
2. Add a pseudonym and recorded experience level. Record the actual grant date, optional fixed expiry, consent version and reference. Private research and anonymous public aggregate permission are separate choices. Public aggregate permission cannot substitute for private permission. A private denial can be retained, but never enables a task. Sample participants require an explicit fictional-participant acknowledgement.
3. Start a specific task deliberately. Its saved start binds the exact permission and protocol. Only one unfinished interval may exist for that participant, including an interval whose permission has ended. Application timestamps measure the recorded interval, not independently observed human task time.
4. Record success, partial completion, failure, abandonment or unknown. Keep assistance and comprehension separate, with the operator's note and response. The application never infers success from a click or a completed timer. Failed and unknown results remain inspectable.
5. A retry is another explicit attempt linked to the original first attempt. A later success does not replace an earlier failure. Changing instructions creates another immutable protocol and a separate cohort; a running attempt can still finish against its original protocol.
6. Seal the study when its intervals have outcomes or have been closed without outcomes after permission ended. Sealing prevents more task or protocol work. A later participant withdrawal still changes current visibility and summary eligibility while preserving the sealed task history.

## Consent and source changes

Current private permission, the original permission at task start and the permission authorizing the recorded outcome all apply. A later declaration can permit new work; it cannot renew an earlier expiry or expand the earlier public scope. An original still-permitted attempt may finish after a new current consent declaration. When any required permission ends, its private text is withheld and its contribution to current summaries ends.

Withdrawal is permanent for that participant record. The UI withholds its pseudonym, consent reference, response and observation text. Immutable fingerprints and categorical history remain, and private audit records remain encrypted in the database; withdrawal does not claim that retained history was erased. An explicit **close without a task outcome** action resolves an unfinished interval after permission ends. It accepts no observation text or performance result, records an administrative closure and remains permanently outside scored summaries, even after later permission.

All awaited reads and the database transaction finish before the server evaluates expiry and projects private text and summary counts at the final response timestamp. A delayed source read cannot return text under permission that expired while it waited. The client also withholds stale private views and consent-dependent controls when a workspace or displayed permission expires, pending a fresh read.

A repair task can change the actual system. Such a change is a visible variation rather than a reason to erase or prevent the observation. The server captures the actual source revision and graph at both start and outcome, separately from the study baseline. Changed-system and missing-source attempts have separate counts. If a source is unavailable, a new task cannot start; an existing attempt can record abandonment or unknown. Clients cannot assert their own source identity or claim that it matched the baseline.

## Read the results

The main denominator uses only the **first attempt for each participant, task and exact protocol**: `success + partial + failure + abandoned`. Unknown, pending and currently excluded attempts remain separate. Retry records remain visible alongside the original result. Assistance and comprehension are independent dimensions; a guided success is not an unaided success. The board preserves separate protocol/task cohorts and discloses source variation. No metric combines Sample participants with operator-recorded people or treats either as independently verified people.

Private JSON and CSV exports contain the selected protocol's permitted records and relevant immutable history. Redacted exports contain only currently permitted aggregate results; they omit individual participant and attempt rows, pseudonyms, notes, responses, consent references and free-form study/task text. People who never permitted anonymous aggregation do not appear as an exclusion count in that public aggregate. Downloading does not publish a study or grant access.

CSV cells are quoted, and formula-like values with leading whitespace or control characters receive a literal-text prefix. This qualifies the generated bytes; it is not execution testing in every spreadsheet application.

## Recovery, storage and authority

Each mutation has an actor/workspace-scoped UUID, current study version and fingerprint. Changed-body collisions and stale study/consent references are refused. Unknown responses are recovered explicitly with the original command and UUID; mounting, refreshing, changing studies or reopening a tab never posts automatically. Drafts and checked acknowledgements are invalidated when their authority or exact context changes. Storage refusal leaves an action unsent.

Participant identities, consent references, withdrawal reasons and outcome text use purpose-scoped authenticated encryption and keyed fingerprints. Protocols, consent editions, task starts, outcomes, command receipts and activity are append-only. The study head must point to its next exact revision; withdrawn participants cannot be reactivated. The notebook never modifies a source graph, compatibility certificate, payment or provider receipt.

Limits are 40 studies per workspace, 20 tasks per protocol, 100 participants and 100 protocol editions per study, 50 consent editions per participant, 2,000 attempts per study and 10,000 research commands per workspace. JSON intake accepts at most 256 KiB of valid UTF-8 and cancels oversized streams. Owner authority and same-origin writes are required; foreign study identifiers remain private.

Nine additive `wk_research_*` tables are initialized through `initializeResearchNotebook`. `/api/research-notebook` exposes owner reads and commands; `/api/research-notebook/export` provides private/redacted JSON or CSV. The `/research` page keeps workspace admission server-owned. The isolated `research-notebook` QA mode has its own cookie, database role and database and does not use a physical-notebook fixture or external provider.

Software qualification uses fictional observations, actual local PostgreSQL/HTTP handlers and mounted React controls. It covers retained failures/retries, original/current permissions, lock-delayed expiry, source changes, withdrawal, administrative closure and lost-response recovery. Actual consented sessions and engineering findings remain separately pending. The accepted fallback is measured software/repair-authority evidence with that limitation displayed, while the complete study workflow remains available.
