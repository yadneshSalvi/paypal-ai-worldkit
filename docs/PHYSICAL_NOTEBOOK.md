# Physical test notebook

Open **Test notebook** in the workbench header, or `/bench`. Choose a saved creator system, desk or shared-podcast edition. The notebook binds its graph, profiles, sources, rules and existing certificate without changing them. A report contains declared conditions, timed operator observations, original-file fingerprints and review of one sealed manifest. This software does not establish that equipment was assembled or that a real engineer participated.

The implemented workflow has focused pure, real HTTP/PostgreSQL and mounted-interface qualification. Production Blob delivery, actual equipment, original participant recordings and independently established reviewers remain separate acceptance gates. Local tests use new controlled workspaces and explicitly generated or fictional evidence; no physical test or actual human review is counted.

## Complete workflow

1. Choose **Sample rehearsal** to exercise the workflow with generated tones and a generated diagram, or open an **Operator-recorded report** for observations the operator will actually make. These report modes cannot be exchanged later. No test has happened merely because a report exists.
2. Record the exact hardware revision, firmware, host/software versions, recording/stream settings, storage, power, hubs/cables, monitoring and predeclared duration. Confirm each bound model. Optional serial values are encrypted server-side; the report and exports contain only keyed fingerprints. Substitution requires a new verified system graph and report.
3. **Start** fixes the conditions and records server time. Append each source-alone and simultaneous observation, the required camera/stream, monitoring and power observations, or the display/lid/input protocol for a desk. Record failures and uncertainty as well as successes. **Finish** preserves the actual elapsed interval, including an early stop. A timer is not proof of equipment operation.
4. Declare each original's media type, byte count, provenance and dated private-review rights, including participant permission where necessary. Upload the original, explicitly verify its bytes, then attach it to the appropriate protocol step. Each step is distinct: upload completion never silently changes an edition or a checked review consent. WAV inspection computes channel envelopes, peaks, RMS, clipping counts and duration from supported PCM/float bytes. It does not infer microphone independence or physical origin. Unsupported encodings retain explicit inspection limits.
5. **Seal** the exact manifest. Incomplete evidence and failed observations remain visible. A sealed report cannot be reopened or rewritten; another test needs a new report. Historical editions remain readable and preserve their original conditions and hashes.
6. Invite an existing specialist identity or an unestablished person to that one sealed edition. Invitation access alone grants no qualification. The invitation is masked, explicitly redeemed, and exchanged for an HTTP-only scoped credential. A Sample reviewer exercises software behavior with zero actual reviews. Genuine review requires separately established current creator/reviewer identities, relevant engineering expertise and distinct real principals through the existing operator attestation seam. Revocation ends access/current support but preserves original decisions and qualified contradictions.

Positive review remains an **independently reviewed report under exact recorded conditions**. It is not a general compatibility, acoustic-quality, duration or electrical-safety certificate. An observed failure remains a failure even when a reviewer supports the report's accuracy. Missing original tracks, shorter measured interval material, unknown conditions and unperformed steps are not filled by a badge. The old modeled certificate continues to say `physicalTest: not_performed`.

## Private originals and retention

Production uses the pinned private Vercel Blob SDK. Browser uploads go directly to an exact random private path with a short-lived size/type-constrained token and overwrite disabled; the server never proxies a 512 MiB upload through a Vercel request body. SDK-authenticated callbacks record arrival only. A durable, explicitly recoverable verification lease reads and hashes the original before an asset exists. Missed callbacks can be recovered by verifying the exact owned object under current authority. The fixed upload deadline is not renewed; already-arrived bytes can still be verified while the workspace and rights remain current.

Original files are streamed unchanged; this differs from the equipment-photo workflow that sanitizes/re-encodes pictures. File types are limited to WAV, MP3, MP4, WebM, PNG, JPEG and PDF. Limits are 512 MiB per file, 32 upload intents per report and 2 GiB declared per workspace. PDF originals are download-only. Authenticated range requests keep audio/video seekable without publishing a Blob URL. Owner and exact-edition reviewer access, file rights, withdrawal and workspace expiry are rechecked. A file signature and SHA-256 establish neither origin nor consent.

Withdraw an original, or remove a rejected/unverified upload, to deny application access immediately. Its immutable declaration and hash remain. Deletion is reported only after the private store acknowledges it; failure remains explicitly retryable. Removal waits for already-issued direct upload tokens to expire. Actual provider upload/deletion races remain part of the separate storage qualification. Late controlled writes are cleaned without making them available again. Expired rights/workspaces are also eligible for scoped retention cleanup. Immutable report/decision/hash history and sealed serial audit records remain retained; expiry does not renew a session or erase a reported failure.

The operator cleanup command defaults to a read-only preview and uses only paths from owned upload intents. It does not run from ordinary reads:

```sh
node --env-file=.env --import tsx scripts/physical-notebook-cleanup.ts
# Review the exact database fingerprint and candidates before applying.
WORLDKIT_PHYSICAL_MAINTENANCE=true node --env-file=.env --import tsx \
  scripts/physical-notebook-cleanup.ts --apply --database-fingerprint=<reviewed-fingerprint>
```

Schedule that operator command only after the actual private store, retention permissions and delivery/cleanup behavior have been qualified. No configured production schedule or successful production deletion is claimed by the local software tests.

## Evidence and recovery

Every mutation has a workspace/actor-scoped UUID and immutable input identity, with its result stored durably. Changed-body collisions, foreign report IDs, stale editions, expired grants and revoked authority are refused. Browser recovery is explicit with the same command/body; remounting never posts automatically. Refresh/context changes invalidate drafts and checked consent. Private serial values and invitations are excluded from persistent browser journals.

Private owner exports include the exact report, permitted original metadata and review history, without plaintext serials. Redacted exports retain graph/profile/source/condition/file/decision fingerprints while omitting names, original filenames, free-form private text and private URLs. An export creates no public file-sharing link. Public certificates are never silently upgraded by this notebook.

The local controlled file store is available only with all of `WORLDKIT_QA_MODE=physical-notebook`, `WORLDKIT_DISABLE_PROVIDERS=true`, `WORLDKIT_PHYSICAL_LOCAL_STORAGE=true` and an owned absolute `WORLDKIT_PHYSICAL_LOCAL_DIR`. It cannot fall back to provider storage. Isolated HTTP/DB tests additionally require the dedicated loopback role/database/port checked by `tests/support/isolated-database.ts`. A valid signature generated with an explicit test key is labeled a controlled signature test, not authentic provider delivery.

Relevant implementation: `packages/physical-notebook`, `src/server/physical-notebook*`, `/api/physical-notebook`, `/bench`, and the additive initializer in `src/server/physical-notebook-db.ts`. The installed Blob SDK is 2.9.0; the [official client-upload contract](https://vercel.com/docs/vercel-blob/client-upload) and [private-storage contract](https://vercel.com/docs/vercel-blob/using-blob-sdk) define the provider integration. Actual provider qualification remains pending until recorded separately.
