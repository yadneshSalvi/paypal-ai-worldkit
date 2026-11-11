# Source reading and the device corpus

WorldKit has collected primary manufacturer documents for 60 exact hardware candidates. A collected document is not a reviewed device profile. Candidate facts and port maps remain pending; no human reviewer or physical test is invented by this pipeline.

## Trace from a document to a candidate

1. Choose an exact model, generation and variant from the source library. The manufacturer URL comes from the versioned corpus, not a model-generated link.
2. Save a private document copy. The service records the raw SHA-256, normalized-text SHA-256, retrieval time and parser version. HTML visible text and structured product data are separate text pages; PDF page numbers correspond to the parsed document.
3. Select the pages to read and a provider. The provider receives the exact identity, questions and source text, with source content treated as untrusted data. Reference answers, account credentials and payment authority never enter that request.
4. Validate each proposed value's type, unit, scope and quoted passage. A located passage gets UTF-16 offsets and an excerpt hash. Missing answers, invented quotations, wrong units and wrong scopes remain unknown or rejected; contradictory passages remain explicit.
5. Inspect the proposal, keep unanswered review questions and explicitly acknowledge its pending review before saving an immutable candidate. A candidate has no inferred port map. Equipment identity and ownership are separate confirmations, and the deterministic compiler rechecks placement.

A model can locate a quotation while misunderstanding it. `located_pending_review` means exactly that. It is never a synonym for technically verified. All exported candidate facts force reviewer and review date to null until the separate review workflow records an actual review decision. Existing kit revisions keep their original profiles and source versions when a new document or proposal is saved.

The source API returns short excerpts, manufacturer links, anchors and fingerprints. Full source documents and text remain private. Removing a private copy cancels dependent work, waits for an active upload to settle, deletes the Blob and purges full text. Review history and immutable evidence fingerprints remain; a new extraction needs a fresh private copy.

## Durable model requests

Source jobs persist a dispatch intent before an external call. OpenAI uses a background response with its provider ID stored independently of worker leases. Pending polls yield the worker and do not exhaust the ordinary failure budget. A restart polls the saved response instead of creating a new one. The provider's temporary background-retention limit still applies: an unavailable response remains an explicit unresolved result, never grounds for silently dispatching a replacement.

Gemini's synchronous transport also records intent before dispatch and its response before parsing. If the process loses the response, that operation is indeterminate and is not automatically dispatched again. Cancellation prevents application of later output; an existing OpenAI response is retrieved and cancelled where still active. Provider observations are retained even when they cannot be applied.

These guarantees are exercised by the [actual workflow](evidence/source-workflow-qualification.json), [transport qualification](evidence/source-provider-transport-qualification.json), and synthetic persistence/concurrency tests. The original interrupted transport attempts are preserved in [their separate record](evidence/source-extraction-transport-v1-interrupted.json).

The [browser qualification](evidence/source-browser-qualification.json) records an actual Gemini reading, reload recovery, an unanswered review question and the exact saved candidate appearing in Equipment. Responsive and keyboard checks are recorded separately from those provider observations. [HTTP checks](evidence/source-http-qualification.json) exercise session/origin isolation and the compact identity selector. The [runtime packaging check](evidence/source-runtime-qualification.json) reconstructs Next.js's traced PDF dependencies and parses the recorded manufacturer PDF with filesystem access outside that package denied. This local macOS check does not establish that the hosted Linux parser works; that remains a deployment check.

## Frozen evaluation

The corpus has 30 development and 30 held-out devices with no family overlap. The held-out reference was frozen before provider evaluation and contains **323 assertions**, including **311 critical assertions**, across **30 devices**. It is an **AI-authored, source-based draft awaiting two independent human reviewers**. It is not a human-reviewed gold standard.

The evaluator measures typed agreement with that draft, explicit abstention, validator rejection and quotation location. It does not report human source-support precision or technical accuracy; those values remain null. Source hashes, reference hash, instruction hash, provider IDs, token counts, durations and failed attempts remain recorded. The reference and model instruction are not revised to improve agreement after seeing held-out answers. OpenAI was selected as the primary library proposal source before this run; Gemini alternatives are retained separately rather than selected by answer agreement.

The current machine-readable state is in [the evaluation record](evidence/source-extraction-evaluation.json); `completion` distinguishes an active batch from a finished one. A successful provider response still may contain unknown, rejected or mistaken claims. The library can therefore contain useful source proposals while every critical human-review gate remains open.

## Reproduce with your own credentials

Use Node 22 and the project's `.env`. These commands call actual document/model services and use the configured accounts. Private raw documents and provider checkpoints are written below the ignored `.artifacts/` directory.

```sh
node --env-file=.env --import tsx scripts/collect-device-corpus.ts
node --env-file=.env --import tsx scripts/evaluate-source-extractor.ts --verify-only
node --env-file=.env --import tsx scripts/evaluate-source-extractor.ts
node --env-file=.env --import tsx scripts/extract-development-corpus.ts
node --env-file=.env --import tsx scripts/export-corpus-proposals.ts
node --env-file=.env --import tsx scripts/qualify-source-workflow.ts
```

Run one process per batch directory. Restarting a batch uses its existing case/provider identities and retains terminal failures. `--retry-failed` is deliberately refused: a changed transport requires a separately versioned run. Export requires every primary-provider case to have reached a terminal state; failures remain unknown candidates and are disclosed, not replaced with invented facts.

Upstream documents may change or become unavailable. Retrieval failures are preserved as availability records. A new download must match the frozen raw and text fingerprints before it can reproduce the original evaluation. Otherwise preserve it as a new source version and keep the original evaluation's availability limit explicit.
