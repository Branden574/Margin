# Planned Canvas submission and read-only review contract

**Status: design only, October 7, 2026.** None of the APIs, tables, workers or delivery states below is implemented by this document. Current student work saves/synchronizes annotations; its controller explicitly reports `not-submitted`. This bounded next increment addresses C11–C13 and establishes immutable history for C19. Grading, feedback layers, rubrics, roster navigation, automatic resubmission and restricted assessment rendering remain separate work.

## Reuse and missing boundaries

- [Student controller](../apps/web/src/lib/assignment-work/controllerTypes.ts) and [encrypted repository](../apps/web/src/lib/assignment-work/repository.ts): draft flush, explicit bounded sync/catch-up, exact operation retries and local conflict preservation. A resolved `sync()` can still leave work queued; it is not submission readiness.
- [Work service](../apps/api/src/assignments/work/service.ts), [manifest decoder](../apps/api/src/assignments/work/manifest.ts) and [sync operations](../apps/api/src/sync/operations.ts): current launch/source/target authorization, immutable encrypted operations, bounded decoding, ordered locks and final database-only state rechecks. Factor narrow shared internal helpers; do not broaden the student-only `WorkPool` into a teacher/worker credential.
- [Verified launch hook](../apps/api/src/assignments/service.ts), [LMS types](../packages/lms/src/types.ts) and [Canvas service preparation](../packages/lms/src/canvas.ts): signed installation/resource/user/service context. Durable bindings currently retain subject/course digests, not recoverable external user IDs or AGS endpoints. `prepareServiceRequest()` requires a live in-memory verified launch; it is not a durable job authorization mechanism. No Canvas token exchange or submission sender exists.

## Visible journey and immutable boundary

1. Student chooses **Submit assignment**. The route runs its editor leave guard and `flushLocal()`, pauses mutation, and verifies current identity. It requires a hydrated local copy, no unsaved failure, no pending/uncertain/conflicting operations, no catch-up requirement and a fresh server cursor. Incomplete bounded synchronization presents **Continue syncing**; it never silently submits a partial queue.
2. The server freezes exactly that cursor using an atomic comparison under the same target-document lock used by append. A racing append either precedes the comparison and produces `submission_cursor_changed`, or follows the frozen boundary and remains a later draft. Browser `readOnly` alone supplies no exclusion guarantee.
3. The committed attempt pins the authenticated source/version/receipt, page geometry and complete encrypted operation prefix through that cursor, with an authenticated request fingerprint. A separate bounded job validates/materializes the frozen annotation state and rechecks exact-object availability before delivery. The attempt's identity/content boundary cannot change; processing failures preserve it and the working draft.
4. Display **Preparing submission**, **Waiting for Canvas**, **Sending**, **Confirmation pending**, **Could not deliver**, or **Submitted to Canvas at …**, according to a durable receipt. Local save, outbox insertion and an HTTP 202 never imply Canvas submission. Lost responses recover the same request/attempt; they do not create another one.
5. After Canvas confirmation, the authoring teacher can read the frozen attempt from a verified assignment/review launch. Later student edits never alter that view. Initial scope permits one attempt per work; further attempts fail explicitly until authoritative Canvas attempt/date policy is integrated. No invented late/missing status.

Before network dispatch, a new atomic encrypted repository `prepareSubmission()` must verify the empty queue, hydration and exact applied cursor while storing the immutable request and a shared local barrier. This closes the same-cursor race with an unsent edit from another tab. NEW annotation enqueues are refused while the barrier is unresolved; exact already-persisted annotation retries remain idempotent. Vault lock/session replacement clears displayed authority and retains ciphertext; recovery requires a fresh matching verified identity.

A negative response alone cannot clear that barrier: another tab may already be dispatching the same request. Release requires an authenticated durable capture receipt or a terminal server request rejection/fence that is atomically incompatible with future capture. After authenticated immutable Margin capture, explicit **Continue draft** clears the barrier and remounts the editor even if Canvas delivery is still queued/unknown; later edits are labeled excluded from the attempt. Unknown capture outcomes keep the exact request pinned. Mutable submission state belongs in a separately decoded envelope with monotonic `revision`, outside `manifest.assignment`, whose current client/repository comparisons require immutability.

## Proposed minimal HTTP contract

All routes require current LTI identity and exact assignment/resource scope. Mutations additionally require existing same-origin CSRF validation. No payload accepts tenant, owner, student, course, source, Canvas user ID, endpoint, score or provider token. Unknown fields are rejected; mutation JSON is at most 1 KiB with a five-second input deadline. UUIDs are canonical; cursor integers are 0–100,000; timestamps are server-issued UTC ISO strings. Responses are private/no-store.

```ts
type SubmissionStatus = {
  id: string;
  requestId: string;
  attempt: 1;
  frozenCursor: number;
  frozenAt: string;
  revision: number; // monotonically increasing status revision
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
    | null; // no provider body or tokens
};
type SubmissionPage = { submissions: SubmissionStatus[]; nextCursor: string | null };
type SubmissionRequest =
  | { requestId: string; state: 'captured'; submission: SubmissionStatus }
  | { requestId: string; state: 'rejected'; code: 'cursor_changed' | 'attempt_exists' };
```

| Proposed route                                                         | Input / result                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/assignments/work/submissions`                               | `{requestId: UUID, expectedCursor: integer}` → `{submission: SubmissionStatus, duplicate: boolean}`; 202 for accepted incomplete work, 200 for an already-confirmed exact retry |
| `GET /api/assignments/work/submission-requests/:requestId`             | `{request: SubmissionRequest}` for a durable capture or terminal rejection; absent/unauthorized results never release the local barrier                                         |
| `GET /api/assignments/work/submissions?after=…`                        | Current student's history, at most ten entries; optional base64url cursor at most 128 characters; cursor never grants authority                                                 |
| `GET /api/assignments/work/submissions/:id`                            | `{submission: SubmissionStatus}` within current student's launched work                                                                                                         |
| `POST /api/assignments/work/submissions/:id/retry`                     | `{}`; requeues only the exact eligible attempt and immutable provider request; never changes content, timestamps or attempt number                                              |
| `GET /api/assignments/review/submissions?after=…`                      | Current author-teacher's launched assignment, confirmed attempts only: `{submissions: Array<{id, frozenAt, confirmedAt}>, nextCursor}`; same ten-item bound                     |
| `GET /api/assignments/review/submissions/:id`                          | `{submission: {id, frozenCursor, frozenAt, confirmedAt}, pages: Array<{id,index,width,height}>}`; at most 2,000 authenticated pages                                             |
| `GET /api/assignments/review/submissions/:id/source`                   | Authenticated frozen original PDF stream; no storage URLs or keys; existing ordinary-policy delivery restrictions remain                                                        |
| `GET /api/assignments/review/submissions/:id/operations?afterCursor=…` | Existing `CatchUpResult` shape, capped at the frozen cursor, 100 operations / existing response-byte bound; supports the read-only renderer                                     |

Missing provider/context is `submission_unconfigured` before accepting an attempt. Unfinished provisioning/processing, cursor mismatch, conflicts and exhausted quota fail explicitly. A retry response means queue acceptance unless the same receipt already proves confirmation. Opaque review IDs only locate records; they grant no access. The first review UI needs no roster, names, score controls or student navigation beyond the authorized attempt list.

POST returns HTTP 409 `{request: SubmissionRequest}` for a durably fenced cursor/attempt rejection. Other errors do not prove a terminal outcome. After current authorization and exact request-payload validation, look up an existing request outcome **before** comparing today's mutable document cursor; the draft may legitimately have advanced after capture. Same-ID retries always recover that original outcome. Never replace a failed request's cursor or silently choose a new request ID.

## Durable service context and provider contract

Only the verified resource-launch hook may capture an encrypted context containing external LTI subject, exact resource identity, issuer/client/deployment, registration version, line-item endpoint and granted scopes. Bind it to internal installation/course/student/work identities and the existing HMAC mappings. Recheck those mappings at capture; never reconstruct external IDs from irreversible digests. Changed endpoint/resource/registration requires a new reviewed binding, not silent replacement beneath queued attempts. Preserve provenance after logout without requiring the originating session to stay alive; current enrollment/installation/source revocation still blocks jobs.

Add a separate server-only client-assertion/token provider with administrator-configured HTTPS token endpoint, scope ceiling, signing key reference and endpoint allowlist. Borrow caller-owned providers through optional composition; no default credentials or fake-success fallback. Background dispatch uses current durable authorization, not a replayed launch JWT. Tokens, assertions and provider bodies never reach browser storage or logs. Key/token operations and network requests remain outside database transactions.

The provider interface must distinguish `confirmed(receipt)`, `rejected(code)`, and `unknown` outcomes, with an explicit exact-attempt reconciliation path. Pin request bytes, original `timestamp`, `submission.submittedAt` and review identity before the first send. A transport timeout after dispatch is unknown, not a failed submission or permission to issue a fresh request. Never assume Canvas supports a generic idempotency header.

Canvas's [Score API](https://developerdocs.instructure.com/services/canvas/resources/score) documents submission creation for the first line item associated with a resource, or one without a resource link, when grading progress is `PendingManual`/`FullyGraded`. Without `scoreGiven`, it need not assign a grade. `preserve_score` defaults **false**; send `preserve_score: true` and `prioritize_non_tool_grade: true`. Its unchanged `submission.submittedAt` avoids incrementing an attempt on retry. The proposed request uses `Submitted`/`PendingManual`, no score, and an authenticated review link where supported. A generic score ACK/result URL alone does not establish the intended submission or review attachment; validate the line-item association and qualified provider receipt. The documented [Result response](https://developerdocs.instructure.com/services/canvas/resources/result) lacks submission attempt/timestamp fields, so it cannot by itself reconcile that identity. Unproven delivery remains `uncertain`.

The [Line Items DTO](https://developerdocs.instructure.com/services/canvas/resources/line_items) exposes `resourceLinkId`, but documents no primary-line-item flag or creation-order guarantee. Do not guess eligibility from the first returned row. Exact eligibility and submission/attempt receipt proof remain explicit adapter and staging gates; no broader REST scope is requested by default to fill this gap.

Canvas describes [submission content in SpeedGrader](https://developerdocs.instructure.com/services/canvas/external-tools/lti/file.assignment_tools) and a separate [LTI client-credentials exchange](https://developerdocs.instructure.com/services/canvas/oauth2/file.oauth#accessing-lti-advantage-services). The exact signed review-launch target/claims and confirmation strategy require an authorized test tenant before enablement. Do not treat a URL parameter as a verified student or submission claim, or add every teacher to students' normal sync grants.

## Migration, encryption and retention contract

Proposed `009-submissions.sql` (confirm the next unused number when implementing) creates a `margin_submissions` schema with an immutable request-outcome ledger, immutable attempts, encrypted verified service-context revisions, immutable processing/delivery receipts and bounded leased outbox rows. Enforce unique `(work_id, request_id)` plus the initial one-attempt-per-work constraint. Same request ID/different cursor or payload fails; captured attempt, request outcome and initial queue commit atomically. Terminal rejection uses the same request/work lock ordering and excludes every later capture of that request. Receipt recovery authenticates ciphertext and current authority, not merely row existence.

Separate submission request, context-capture, delivery-worker and teacher-review credentials use forced RLS, no owner/BYPASSRLS membership, and mixed-role/SET-ROLE rejection across existing pool guards. Teacher reads require current author ownership, teacher enrollment and the current resource-bound assignment; no peer/co-teacher sharing by inference. Workers claim only due rows with bounded leases, attempts and backoff; stale claims cannot complete or replace receipts. Use ordered authority/source/target locks and post-lock rechecks for final state transitions; preserve the existing SQL deadlines.

Encrypt private context, snapshots, receipts and any generated artifacts with tenant/attempt/source/cursor-bound authenticated context. Reuse the exact private source and frozen annotations first; no PDF duplication/export is needed for read-only review. Canvas cannot render Margin's encrypted package as an ordinary PDF: do not attach ciphertext while claiming interoperable PDF delivery, make a permanent public URL, or silently weaken encrypted-export requirements. Any later Canvas file-upload path requires an explicit compatible delivery/retention design, policy authorization and completion of asynchronous file processing before confirmation.

Immutable history requires retention references for the source, operation prefix, wrapped keys and receipts; existing deletion/compaction cannot invalidate a retained attempt silently. Define institution-configured retention, legal holds, deletion/tombstone and backup/key-destruction behavior before hosted enablement. Do not cascade attempts from expired sessions, retain launch JWTs unnecessarily, or add an infinite retention default. Preserve minimal idempotency/tombstone evidence according to that policy so deletion cannot reopen an old request as a new attempt. Administrative revocation prevents future reads/dispatch; it cannot retract content Canvas already accepted.

## Acceptance and rollout gates

1. **Local durability:** disposable PostgreSQL tests for exact retries after draft advancement, payload mismatch, cursor-versus-append ordering, terminal rejection versus concurrent capture, missing operation/corrupt envelope rejection, rollback after each write, immutable historical reads, source/key retention references and session retirement.
2. **Authorization/races:** peer/course/tenant/OIDC denial; author-only review; registration/resource/owner/enrollment/source revocation before preparation, during key/object waits, while acquiring locks and before final commit; late worker/lease and receipt replay rejection. No KMS/object/network wait inside final transactions.
3. **Recovery:** lost response before/after provider acceptance, crash between provider result and receipt commit, duplicate delivery, 401/403/429/5xx, exhausted retries and confirmed-attempt retry. Frozen request/timestamps remain identical; uncertainty never discards work or creates a new attempt. Backoff honors bounded provider retry guidance.
4. **Browser:** real repository/client/controller tests plus manual local-fixture verification of draft flush failure, incomplete bounded sync, same-cursor unsent cross-tab edits, duplicate dispatch versus negative response, atomic local barriers, explicit draft continuation, offline send, vault lock/session replacement, refresh/relaunch and read-only teacher history. Fixture confirmations are explicitly synthetic.
5. **External enablement:** authorized institution/developer key, scoped AGS permissions, registered reachable HTTPS/JWKS/review targets, real teacher/student/resource/line-item journey, unchanged existing grade on submit/retry, visible SpeedGrader frozen content and verified duplicate/attempt behavior. Real storage/scanner/worker composition and retention operations are separate deployment prerequisites. No 100,000-user readiness claim without load/recovery qualification.

Implement and review in three checkpoints: immutable attempts/status with synthetic-provider tests; durable verified service context and qualified delivery/reconciliation; authorized read-only review and the real-tenant walkthrough. Keep production/bootstrap gates unchanged until the applicable gates pass. No infrastructure or institution action is authorized by this plan itself.
