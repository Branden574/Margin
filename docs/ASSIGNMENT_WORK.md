# Student assignment content and operations

The optional `PostgresAssignmentWorkService` and `handleCanvasWork` adapter connect a current verified LTI student launch to its already-provisioned private document. This is a backend increment, disabled in the default application. It does not connect the browser editor, schedule provisioning, call Canvas, submit work, return grades, configure a real scanner or provision cloud resources. No institution or production provider was used in the tests.

## Public contract

Explicit composition requires `createApi({ identityService, lmsService, assignmentWorkService, ... })`. Keep the existing `assignmentService` configured separately for reservation/authoring. The application must obtain `SessionPrincipal` from fresh identity authentication; external headers, request JSON and opaque document IDs cannot establish a principal.

| Route                                                         | Result                                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/assignments/work`                                   | Current assignment title, instructions and policy; own work is null, pending, or provisioned with student document/version/pages and cursor. |
| `GET /api/assignments/work/source`                            | Exact authenticated original PDF, only under the supported delivery policy.                                                                  |
| `GET /api/assignments/work/operations?afterCursor=0&limit=50` | Bounded committed operation catch-up using the existing sync result contract.                                                                |
| `POST /api/assignments/work/operations`                       | Existing append operation shape; supplied document/version must match the current launch's own work. Returns `{receipt}` only after commit.  |

The existing `POST /api/assignments/work` still takes `{}` and reserves work asynchronously. A `pending` response is not document availability. A `provisioned` manifest establishes authenticated database provisioning; only a successful source fetch establishes current object availability. No route accepts a worker claim, changes a readiness verdict, exposes source/teacher IDs, keys or object URLs, grants teacher-source access, or copies the teacher PDF into student storage.

Only current LTI student sessions are admitted. Teacher, viewer, administrative and ordinary OIDC sessions cannot use these student routes. Generic document/upload/sync routes still reject LTI sessions, and generic OIDC sync still rejects assignment-origin documents.

## Source delivery and policy boundary

Original PDF delivery currently requires `assessment: false` and `allowExport`, `allowCopyPaste`, and `allowReadAloud` all true. Any restrictive value returns `restricted_delivery_unavailable`; the assignment policy is not silently changed. Original bytes are downloadable and extractable once delivered, so this path does not claim DRM or enforcement of restrictive assessment delivery. A suitable restricted-content rendering path remains separate work.

The runtime authenticates the immutable master and independent encrypted completion receipt, including exact artifact/version/hash, scan approval, source storage receipt, student identity, private document/version and page geometry/IDs. It retrieves the exact authenticated artifact through `ArtifactReader`, checks the PDF media type, plaintext hash and 100 MiB bound, and rechecks current authority and unchanged encrypted state after retrieval. Storage receipt presence is never substituted for a successful object read. Range requests are unsupported because the current envelope authenticates the whole object.

Reads have a 20-second object deadline and two active reader slots per service. The HTTP adapter additionally holds at most two PDF response slots until the response finishes, closes or fails, covering slow clients after object retrieval. Its 35-second deadline aborts pending work and closes an overdue started response. Returned buffers remain intact while Node flushes the response, then are cleared on finish/close; failures and late abort-ignoring reader results are cleared too. No-store, nosniff and no-referrer headers apply. Revocation cannot retract bytes already delivered.

## Authorization and transactions

Apply migration `007-assignment-work-runtime.sql` after migrations 001–006. Use a separate login inheriting only `margin_assignment_work_runtime`, verified PostgreSQL TLS, and explicitly supplied reviewed KMS/storage adapters. The runtime rejects mixed service roles, superuser/bypass/role-creation privileges, and inherited or SET-ROLE-capable table ownership. The default entry point and production startup gate remain unchanged.

Forced RLS derives the selected assignment from the current session's verified resource link and course binding. Work must belong to that student and match the pinned installation version, subject/course digests and resource digest. A fresh matching launch can access the same work after the originating audit session is retired. Live sessions, memberships, accounts, installation, course, enrollments, links, assignment, source approval, target document and owner grant are rechecked; a stored receipt is not permanent authorization.

The role can read only the current launch's master, own completion receipt/target key/pages/operations and the selected teacher source's encrypted ingestion records. It receives minimal status columns for the current student and internally selected teacher, not identity hashes, session hashes or other students' content. It cannot create documents, grants, readiness approvals or claims. Teacher annotation keys and operations remain inaccessible. Column-scoped lock privileges permit `FOR SHARE`; rejecting write checks prevent authority mutation. Document locks use the existing cursor/byte-counter privileges and do not grant identity-column writes.

Encrypted rows are captured in a committed transaction. Master/receipt/key unwrap and source object I/O occur outside final transactions. Before releasing content or committing an operation, the service acquires authority/source/target locks in a consistent order, rechecks current authorization after any wait, and compares authenticated state to the captured snapshot. Source and authority locks remain held through commit. No external provider is called under those final locks. A transaction-local database-only ingestion check verifies exact readiness and revocations.

## Student annotations

The adapter reuses the generic sync operation decoder/commit helper, without widening generic sync authorization. `put` requires its annotation type in immutable `allowedTools`; deletion requires `eraser`. The current seven annotation types remain the protocol's supported types. Local-only tools outside that protocol are not implicitly supported.

Operations retain canonical request comparison for operation-ID retries, annotation revision/page/version conflicts, authenticated encryption under the private student document key, cursor and byte quotas, bounded catch-up, and one atomic operation/annotation/cursor/outbox commit. Saves after an uncertain response must retry the same operation ID; an aborted request does not prove rollback. `Saved` can mean database commit only, never Canvas submission or grade delivery.

Annotation requests check current database source approval but do not download the original PDF or call Canvas per edit. An object-storage outage prevents source delivery while leaving already-saved annotations recoverable, provided their current authorization and database approval remain valid. This is not an implemented browser offline bridge or realtime transport.

## Verification and remaining gates

`tests/assignment-work-runtime.postgres.test.ts` uses disposable PostgreSQL with migrations 001–007, local test keys, a synthetic storage provider and explicitly synthetic scan reports. It exercises provisioning-to-source-to-edit/catch-up, private receipts/keys, exact content checks, idempotency/conflicts/deletion, tool/delivery policy, current/fresh/expired launches, tenant/peer/role isolation, receipt/geometry/key tampering, authority revocation during remote work and lock waits, and transactional outbox rollback. Existing provisioning, sync and mixed-role suites cover their preserved contracts.

`tests/assignment-work-routes.test.ts` uses real HTTPS, identity, origin and CSRF code with synthetic session/work services. It checks routing, headers, request limits, generic denial, response-byte disposal, disconnect cancellation and source admission recovery. This is HTTP composition evidence, separate from the PostgreSQL and signed-LTI protocol suites.

Provider IAM/KMS/S3/scanner verification, institution registration, launch/student editor composition, browser recovery/synchronization, restricted rendering, submissions, teacher review and grade passback remain unconnected. Full-object source reads, RLS query cost, concurrent workload capacity and 100,000-user readiness have not been qualified.
