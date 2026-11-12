# Explicit Sample entry

Opening WorldKit is inert. Initial rendering and `GET /api/workspace` may read the existing browser workspace; a missing or expired credential returns 401 and offers **Start Sample**. Neither a page visit nor a failed read creates, renews or reseeds anything.

Choosing **Start Sample** saves one private recovery record in browser session storage before sending the request. A second click cannot dispatch another request. On a lost or incomplete answer, **Recover this Sample** deliberately reuses the same original body. Reloading only reads; it never resends the operation automatically. An unavailable or malformed recovery store holds creation until the browser can preserve the original operation.

The strict `POST /api/workspace` body contains `kind: "start_sample"`, a UUID `requestId`, a cryptographically random 32-byte `recoveryKey` encoded as 64 lowercase hexadecimal characters, and `acknowledgedSample: true`. The recovery key is private authority: it stays out of URLs, DOM text and public receipts. The body is capped at 2 KiB of valid UTF-8 JSON and must come from the trusted WorldKit origin. Legacy empty POST bodies are refused.

The server stores an immutable receipt with a hash of that exact normalized command and an authenticated encrypted copy of the original opaque cookie. Admission counters, the new Sample graph and the receipt commit in one transaction. A failed commit consumes none of them. Deployment-wide limits remain 30 new workspaces per hour and 200 per day.

A new operation returns 201 with `X-WorldKit-Admission: created`. Recovery returns 200 with `recovered`; acknowledging an already valid cookie returns 200 with `existing`. Every success returns the exact request UUID in `X-WorldKit-Admission-Request` and the normal workspace DTO. Existing valid cookies are preserved. A recovered cookie uses the original absolute expiry, never another seven days. Recovery cannot switch a browser away from a different currently valid workspace.

Expired original receipts return 410. Only a separate deliberate **Start another Sample** action creates a new history. A receipt cannot be changed to extend the old deadline. Once consent to research or a scoped notebook grant ends, entry recovery does not restore those permissions.

The entry creates Sample equipment and computational checks. It invokes no model, catalog, merchant, payment or physical action. The source HTTP qualifier now requires an existing private cookie file from an explicit browser admission, rather than creating a workspace itself.

The affected entry controls cover installed React, actual loopback HTTP and isolated PostgreSQL: inert visits, double clicks, retained recovery after remount, malformed acknowledgements, storage refusal, concurrent identical/conflicting requests, a genuinely lost post-commit answer, current authority after a row-lock expiry, immutable encrypted receipts, bounded input, and atomic rollback. These controls are software evidence; hosted/native acceptance is recorded separately.
