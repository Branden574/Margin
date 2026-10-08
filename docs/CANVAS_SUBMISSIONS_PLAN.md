# Canvas submission capture and remaining delivery plan

**Status: capture, internal materialization and preparation recovery implemented, October 8, 2026.** Margin can preserve one immutable assignment submission version in its own encrypted database, recover the exact request and display its student history. A separately composed internal worker authenticates the retained source and reconstructs the captured annotations. Capture is opt-in; its public state reflects processing or a durable preparation failure: no Canvas sender or acknowledgement exists, and the default API composition does not configure capture or the worker. The UI says **Preparing submission. Not submitted to Canvas yet.** This is partial progress on C11–C12 and immutable history for C19, not a completed Canvas submission journey. Teacher review, grades, feedback, rubrics, rosters, resubmission and restricted assessment rendering remain separate work.

## Implemented boundary

- [Submission service](../apps/api/src/assignments/submissions/service.ts), [HTTP adapter](../apps/api/src/submission-http.ts) and [migration 009](../infra/migrations/009-submissions.sql): encrypted request outcomes, one immutable attempt per work, a processing outbox marker, current launch/source/target authorization and retained source/history references.
- [Student controller](../apps/web/src/lib/assignment-work/controller.ts), [encrypted repository](../apps/web/src/lib/assignment-work/repository.ts) and [submission status UI](../apps/web/src/components/CanvasSubmissionStatus.tsx): draft flush, bounded sync/catch-up, durable preparation, exact request recovery, explicit draft continuation and separate save/submission states. A resolved `sync()` can still leave work queued; it is not submission readiness.
- [Browser client](../apps/web/src/lib/assignment-work/client.ts) and [decoder](../apps/web/src/lib/assignment-work/submissionDecode.ts): bounded same-origin HTTPS requests, fresh session/manifest checks before and after submission calls, immutable request inputs and opaque lifecycle-bound outcome proofs. No provider credentials, URLs or scores are accepted from the browser.
- [Verified launch hook](../apps/api/src/assignments/service.ts) and [Canvas service preparation](../packages/lms/src/canvas.ts) remain foundations for future delivery. Current durable bindings retain subject/course digests, not recoverable external user IDs or AGS endpoints. `prepareServiceRequest()` requires a live verified launch; it is not durable job authorization. There is no Canvas token exchange or submission sender.

## Current student journey and recovery

1. **Submit assignment** runs the editor leave guard and local flush, pauses mutation and checks current identity. The controller synchronizes within its existing bounds, then requires hydration, an empty operation queue, no local save failure, no catch-up requirement and matching applied/observed/server cursors. Incomplete synchronization reports that all saved edits must finish syncing; it never silently captures a partial queue.
2. `prepareSubmission()` atomically stores the exact `{requestId, expectedCursor}` and an encrypted local barrier after checking those durable conditions. A competing unsent edit from another tab either persists first and prevents preparation, or follows the barrier and is refused. Exact already-persisted annotation retries remain idempotent.
3. The server compares the requested cursor under the target-document lock used by append. It commits the request outcome, immutable attempt and processing marker together. A racing earlier append produces a durable `cursor_changed` rejection; a later append remains future draft work. Existing exact request outcomes are recovered before comparing today's cursor, so draft advancement cannot replace a captured attempt.
4. A lost response preserves the same prepared request. **Confirm saved submission** repeats that request; **Check submission status** reads its durable outcome/history. HTTP errors, cancellation and timeouts never clear the barrier. A bare 409 is not a rejection proof. Another tab may have committed the same request despite one tab's failed response.
5. After a current authenticated capture receipt or terminal fenced rejection, **Continue draft** explicitly clears the matching local barrier and reloads the editor. Later edits cannot change a captured version. A continued rejection may permit a new request; a captured attempt prevents additional attempts. An older request's continuation cannot release a newer barrier.

The binding extension is versioned and optional, preserving pre-submission vaults without resetting them. Local storage retains at most 32 request records; the server bounds its request ledger to 1,000 rows per work. Limits fail visibly without deleting prior intent. Vault lock or session replacement removes displayed authority and keeps encrypted records. Recovery requires a fresh matching launch and unlocked vault. Opaque outcomes expire with their verified snapshot (at most 60 seconds), session or client lifetime and cannot survive lock/reunlock. Transaction guards check authority during encryption/commit and again before releasing results; an error after commit does not prove rollback.

Submission state is separate from the immutable assignment manifest. Client/repository validation preserves newer revisions, rejects changed capture identity and prevents a confirmed status from changing. These future-facing status checks do not make a delivery worker exist: the encrypted capture remains revision 1 forever, while current protected processing metadata is projected over it. Failure, explicit reprocessing and internal completion advance the public revision. Internal completion remains `processing`; only a failed recoverable generation can advertise `retryAllowed`, and `confirmedAt` remains null.

## Implemented HTTP contract

Exactly three submission routes are implemented. They require a current LTI student session and exact launched assignment/resource scope; POST additionally uses existing same-origin CSRF validation. No payload accepts tenant, owner, student, course, source, Canvas user ID, endpoint, score or provider token. Unknown fields are rejected. Mutation JSON is at most 1 KiB with a five-second input deadline; cursor integers are 0–100,000. Responses are private/no-store. The browser limits request-response JSON to 16 KiB and history to 32 KiB, covering body reads with cancellation and deadlines.

```ts
type SubmissionInput = { requestId: string; expectedCursor: number };
type SubmissionStatus = {
  id: string;
  requestId: string;
  attempt: 1;
  frozenCursor: number;
  frozenAt: string;
  revision: number;
  phase: 'processing' | 'queued' | 'sending' | 'uncertain' | 'failed' | 'confirmed';
  confirmedAt: string | null;
  retryAllowed: boolean;
  errorCode:
    | 'snapshot_invalid'
    | 'source_unavailable'
    | 'delivery_unavailable'
    | 'authority_revoked'
    | 'provider_rejected'
    | 'confirmation_unavailable'
    | 'retry_exhausted'
    | null;
};
type SubmissionRequest =
  | { requestId: string; expectedCursor: number; state: 'captured'; submission: SubmissionStatus }
  | {
      requestId: string;
      expectedCursor: number;
      state: 'rejected';
      code: 'cursor_changed' | 'attempt_exists';
    };
type SubmissionPage = { submissions: SubmissionStatus[]; nextCursor: string | null };
```

| Implemented route                                          | Input / result                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/assignments/work/submissions`                   | `SubmissionInput` → `{request: SubmissionRequest, duplicate: boolean}`. HTTP 202 for current processing capture; HTTP 409 for a durable rejected outcome. HTTP 200 is reserved by the adapter for a confirmed outcome, which the current service cannot produce. |
| `GET /api/assignments/work/submission-requests/:requestId` | HTTP 200 `{request: SubmissionRequest}` for either captured or rejected stored outcomes. Missing request is 404; neither absence nor another error releases the local barrier.                                                                                   |
| `GET /api/assignments/work/submissions?after=…`            | HTTP 200 `SubmissionPage`: current student's captured history, at most ten entries; optional base64url cursor at most 128 characters. The initial one-attempt rule currently bounds actual history to one attempt.                                               |

The server checks current authority and authenticated stored identity before returning an exact retry. Same ID with a changed cursor fails; callers must not replace an uncertain request's cursor or silently choose a new ID. All dispatched capture failures are classified as uncertain by the browser client, including errors during post-response identity verification. Only a validated durable request outcome resolves that uncertainty; there is no automatic POST retry.

Composition must explicitly pass `PostgresAssignmentSubmissionService` to `createApi` via its `assignmentSubmissionService` option and opt into `captureEnabled: true`, with the dedicated database credential and real key provider. Omitted service or disabled capture returns `submission_unconfigured`; ordinary saved work remains available. There is no production/bootstrap enablement or synthetic-success fallback. Capture does not require a provider sender because it makes no delivery claim.

Per-attempt delivery retry and teacher review/source/operation routes are **planned, not implemented**. The later read-only review renderer must cap operations at the frozen cursor and verify current author-teacher assignment authority; opaque IDs alone grant no access. Roster, score and feedback controls are outside this checkpoint.

## Planned provider delivery and teacher review

Only the verified resource-launch hook may capture an encrypted context containing external LTI subject, exact resource identity, issuer/client/deployment, registration version, line-item endpoint and granted scopes. Bind it to internal installation/course/student/work identities and the existing HMAC mappings. Recheck those mappings at capture; never reconstruct external IDs from irreversible digests. Changed endpoint/resource/registration requires a new reviewed binding, not silent replacement beneath queued attempts. Preserve provenance after logout without requiring the originating session to stay alive; current enrollment/installation/source revocation still blocks jobs.

Add a separate server-only client-assertion/token provider with administrator-configured HTTPS token endpoint, scope ceiling, signing key reference and endpoint allowlist. Borrow caller-owned providers through optional composition; no default credentials or fake-success fallback. Background dispatch uses current durable authorization, not a replayed launch JWT. Tokens, assertions and provider bodies never reach browser storage or logs. Key/token operations and network requests remain outside database transactions.

The provider interface must distinguish `confirmed(receipt)`, `rejected(code)`, and `unknown` outcomes, with an explicit exact-attempt reconciliation path. Pin request bytes, original `timestamp`, `submission.submittedAt` and review identity before the first send. A transport timeout after dispatch is unknown, not a failed submission or permission to issue a fresh request. Never assume Canvas supports a generic idempotency header.

Canvas's [Score API](https://developerdocs.instructure.com/services/canvas/resources/score) documents submission creation for the first line item associated with a resource, or one without a resource link, when grading progress is `PendingManual`/`FullyGraded`. Without `scoreGiven`, it need not assign a grade. `preserve_score` defaults **false**; send `preserve_score: true` and `prioritize_non_tool_grade: true`. Its unchanged `submission.submittedAt` avoids incrementing an attempt on retry. The proposed request uses `Submitted`/`PendingManual`, no score, and an authenticated review link where supported. A generic score ACK/result URL alone does not establish the intended submission or review attachment; validate the line-item association and qualified provider receipt. The documented [Result response](https://developerdocs.instructure.com/services/canvas/resources/result) lacks submission attempt/timestamp fields, so it cannot by itself reconcile that identity. Unproven delivery remains `uncertain`.

The [Line Items DTO](https://developerdocs.instructure.com/services/canvas/resources/line_items) exposes `resourceLinkId`, but documents no primary-line-item flag or creation-order guarantee. Do not guess eligibility from the first returned row. Exact eligibility and submission/attempt receipt proof remain explicit adapter and staging gates; no broader REST scope is requested by default to fill this gap.

Canvas describes [submission content in SpeedGrader](https://developerdocs.instructure.com/services/canvas/external-tools/lti/file.assignment_tools) and a separate [LTI client-credentials exchange](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth#accessing-lti-advantage-services). The exact signed review-launch target/claims and confirmation strategy require an authorized test tenant before enablement. Do not treat a URL parameter as a verified student or submission claim, or add every teacher to students' normal sync grants.

## Implemented encryption and retention; remaining operations

[Migration 009](../infra/migrations/009-submissions.sql) creates `margin_submissions.requests`, `attempts` and a processing-only `outbox`. Unique `(work_id, request_id)` and one-attempt-per-work constraints retain exact intent. Captured or rejected outcomes are immutable under the runtime credential; a terminal rejection uses the same document lock as capture and excludes future capture of that request. Encrypted envelopes bind the request to organization/work/request/cursor and the authenticated source/provisioning/document/key pin. Retried reads authenticate ciphertext and recheck current authority and structural pins before release.

The dedicated `margin_submission_runtime` uses forced RLS and rejects mixed-role/SET ROLE credentials. It borrows the reviewed work authority helpers for current student/source/target checks without obtaining annotation or document-cursor mutation rights. Key operations stay outside final database transactions. The service admits at most two simultaneous calls per instance and uses a bounded service deadline; this is not a production capacity claim.

Foreign keys retain the source artifact, scan/storage/provisioning receipts, document version and annotation-key association. A separate no-login retention trigger owner protects the frozen operation prefix, page geometry and key rows independently of the caller's RLS visibility. Retention checks serialize with document capture/append locks; non-READ-COMMITTED history writes are refused to avoid stale-snapshot deletion races. Later operations beyond the frozen cursor remain appendable. This protects retained database history; it is not a deployed object-store retention policy.

**Still planned:** hosted processing scheduling and operator alerting, a delivery worker with reconciliation receipts, recoverable provider service context and scoped review credentials. No generated PDF or delivery artifact exists. Reuse the retained source and frozen annotations for future read-only review. Canvas cannot render Margin's encrypted package as an ordinary PDF; a later upload path needs an explicit compatible encryption/delivery policy, private storage and completed asynchronous processing before confirmation.

Institution-configured retention, legal holds, administrative deletion/tombstones, backup/key destruction and object-store enforcement remain hosted enablement gates. Current retention pins deliberately refuse changes; no purge/expiry workflow is implemented. Session retirement must not erase captured history, and deleting retained evidence must never reopen a previous request as a fresh attempt. Administrative revocation blocks future reads/dispatch; it cannot retract content already accepted by a provider.

## Internal materialization checkpoint

[Migration 010](../infra/migrations/010-submission-materialization.sql) adds a dedicated `margin_submission_processor` role, bounded queue leases, immutable encrypted chunks and an atomic encrypted completion manifest. [The worker](../apps/api/src/assignments/submissions/processing/worker.ts) is an explicit `runOne()` composition requiring caller-owned PostgreSQL, ingestion-reader, object-reader and key providers. It creates no public route, scheduler, provider request or Canvas confirmation. Existing application roles reject mixed processor credentials, including role membership usable through `SET ROLE`.

Preparation authenticates the captured request and source/provisioning pins, retrieves the exact immutable PDF version, verifies its hash and MIME, and rechecks its ready manifest. Browser-session retirement does not cancel an accepted capture; current student/teacher enrollment, installation, assignment/resource, source and target authority still apply. Source and key provider calls remain outside final database transactions. Authority locks and current statement checks fence every read, stage and completion; transactions explicitly use read committed.

Replay reads at most 100 operations per batch, stopping at the captured cursor even when later draft edits exist. It authenticates each operation, requires contiguous cursors and annotation revisions, validates document/version/page/actor and canonical byte totals, and retains tombstones and the editor's synchronized stacking order. The replay ceiling is 100,000 operations and 128 MiB of canonical input. Deterministic output chunks are at most 256 KiB each and retain explicit annotation layer order. Output is bounded by 2,048 chunks, 256 MiB and a 256 KiB manifest; exceeding any bound fails without publication.

Chunks are encrypted and staged under an exact attempt and lease claim. Exact duplicate staging authenticates existing ciphertext. The atomic completion checks every staged descriptor and ciphertext fingerprint against the encrypted manifest before publishing its internal receipt. Recovery authenticates that manifest and rechecks the current chunk fingerprints and authority. Partial chunks and materialization receipts are inaccessible to normal application credentials; this checkpoint provides no teacher review reader. Later retries use a new claim, so an old worker cannot finish a replacement attempt. Failed-claim chunks are retained; cleanup/retention operations remain unimplemented.

A worker admits one job at a time and keeps that slot occupied until the repository call settles. The processor separately limits supplied object/key provider promises to two in flight, retaining each slot until that promise settles even after its caller times out. When those slots are full, it refuses new claims before consuming a job attempt. An adapter that detaches transport work behind its own timeout still needs internal admission limits and deployed-provider qualification. Its deadline is at most nine minutes within a ten-minute lease; source retrieval has a 20-second bound, and key/database calls have their own deadlines. Source, data-key and output buffers are cleared after use; parsed JavaScript objects can only be released for garbage collection, not securely overwritten. Recovery drops replay data before additional I/O. Cancellation starts no new recovery calls. A lost completion response requires an authenticated durable receipt before reporting internal success.

At most ten claims are allowed per processing generation, with bounded retry delays. Migration 011 adds durable failure and explicit recovery described below. Operator alerting, scheduling and abandoned-chunk cleanup remain hosted-enablement blockers. The worker is not enabled in the ordinary application, and internal `materialized` is never treated as Canvas `confirmed`. The source PDF is verified but no flattened PDF/export/delivery package is generated.

## Durable preparation failures and explicit retry

[Migration 011](../infra/migrations/011-submission-outcomes.sql) separates immutable capture from mutable processing metadata. Precise invalid-content evidence fails immediately; provider/authentication errors that cannot distinguish corruption from an outage use bounded automatic retries. The tenth unsuccessful claim becomes a durable failure. Each settlement sweep changes at most ten expired tenth-claim or revoked jobs, so a process crash cannot strand them forever. Its qualifying metadata scan is not bounded to ten rows; production queue performance still needs measurement. Narrow failure bookkeeping releases no document bytes and cannot overwrite a completed receipt. Existing completed migration-010 jobs retain their encrypted payloads and gain revision 2 during migration.

A student with fresh authority may choose **Retry preparation** for the same immutable capture. Three processing generations are allowed in total, each with at most ten claims. A new generation clears old claim credentials, resets its claim counter and advances the status revision; stale workers remain fenced by their exact claim ID/token. This is not a new Canvas attempt and does not capture later draft edits. `snapshot_invalid` is not retryable; source availability, restored authority and exhausted transient retries may be, subject to the generation budget and all current authority checks.

| Route                                                                            | Contract                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/assignments/work/submissions/:id/reprocess`                           | Exact `{expectedRevision}` command; 202 accepted or 409 durable rejected outcome. Future revisions get an ordinary error without consuming a ledger entry. |
| `GET /api/assignments/work/submissions/:id/reprocess-requests/:expectedRevision` | 200 for the durable exact outcome and current status; 404 is absence, never proof of rejection.                                                            |

The natural command key `(submissionId, expectedRevision)` coalesces concurrent tabs. Durable accepted/rejected outcomes never change; accepted revision is exactly the requested revision plus one. A current/past revision can receive `revision_changed`, `not_retryable` or `retry_limit`. Future revision numbers cannot poison a later command. Replays return the same decision with the current submission status, without creating another generation. No retry caller supplies source, cursor, student, provider URL or grade data.

The encrypted local capture record has an optional retry checkpoint. It is committed before POST, retained across reload or uncertain responses, and resolved only by a live opaque proof of the exact durable outcome. A newer status, bare error or missing lookup cannot resolve it. **Confirm preparation retry** repeats the original tuple; no automatic POST retry occurs. The checkpoint does not create another editing barrier. Existing capture barriers still require **Continue draft**. The UI preserves the distinction between preparation, saved draft changes and actual Canvas confirmation.

## Evidence and remaining rollout gates

The repository contains [PostgreSQL capture/retention tests](../tests/submissions.postgres.test.ts), [HTTPS routing tests](../tests/submission.http.test.ts), [submission transport/provenance tests](../tests/assignment-submission-client.test.ts), [encrypted repository tests](../tests/assignment-work-vault.test.ts) and [controller recovery tests](../tests/assignment-work-controller.test.ts). These address local atomicity, exact retries, authority changes, corruption/refusal, barriers and recovery. Consult [verification](VERIFICATION.md) and [manual verification](MANUAL_VERIFICATION.md) for actual execution evidence and limitations; no CI or manual result is implied by this file.

Before completing the next checkpoints:

1. Connect the implemented materializer only after scheduling, operator alerting, abandoned-chunk retention and deployed-provider qualification are complete. Expand process-crash, retention, concurrency and resource measurements beyond local fixtures.
2. Capture durable verified service authorization, implement scoped token exchange and qualified delivery/reconciliation. Test lost acknowledgements, duplicate delivery, 401/403/429/5xx, immutable timestamps and unchanged existing grades. Unknown provider outcomes must remain uncertain.
3. Implement authorized author-teacher read-only review of retained attempts, then feedback/grades as separate features. Test peer/course/tenant/role/revocation boundaries before exposing any review bytes.
4. Run an authorized real Canvas teacher/student/resource/line-item journey: visible SpeedGrader content, exact attempt/receipt identity and duplicate behavior. Register reachable HTTPS/JWKS/review targets and verify institution scopes. Synthetic fixtures cannot establish this result.
5. Complete real provider/storage/scanner composition, retention operations, deployment/recovery and load qualification. No 100,000-user readiness claim follows from this checkpoint.

Capture and internal annotation materialization are implemented locally; provider delivery and teacher review remain future checkpoints. Production/bootstrap gates stay closed until their requirements are met. This document does not authorize infrastructure or institution changes.
