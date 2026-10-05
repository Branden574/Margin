# Durable document annotation sync

The service in `apps/api/src/sync/` commits encrypted annotation operations, their current revisions, and a notification outbox to PostgreSQL in one transaction. It returns a receipt only after PostgreSQL confirms `COMMIT`. No process-local map, BroadcastChannel, Redis publish, or WebSocket acknowledgement is treated as persistence.

This is a bounded backend slice. It does not configure a cloud KMS, run an outbox dispatcher, deliver realtime messages, scan documents, store PDF objects, grant classroom access automatically, or adopt a local vault into an account. Those boundaries must be integrated deliberately. Capacity for 100,000 simultaneous users has **not** been tested or established.

Assignment-origin documents remain denied by this generic service. The separate [student work adapter](ASSIGNMENT_WORK.md) reuses internal operation commit/decoding with current LTI resource authorization and assignment tool policy; it does not relax generic access.

## Integration contract

```ts
import { PostgresSyncService, SyncError } from './sync/index.js';

const sync = new PostgresSyncService({
  database: {
    connectionString: syncDatabaseUrl,
    ssl: { ca: trustedDatabaseCa, rejectUnauthorized: true },
  },
  keyManagementProvider: managedKmsAdapter,
});

// Obtain principal from a fresh identity-service authentication on every request.
// Never construct it from a client actor, organization, role, or identity header.
const description = await sync.describeDocument(principal, documentId);
const receipt = await sync.append(principal, parsedRequestBody);
const page = await sync.catchUp(principal, {
  documentId,
  afterCursor: 0,
  limit: 50,
});
```

The existing `SessionPrincipal` supplies organization, user and session IDs. The identity service must authenticate the opaque cookie and enforce its OIDC/LTI policy immediately before these calls. An LTI principal must have passed the installation/course/enrollment liveness gate; this module does not replace that gate. The current HTTP API additionally denies general document-sync routes to LTI sessions until explicit course-bound document authorization is integrated. Sync also checks the stored session authentication method, revocation, absolute and idle expiry, enabled user/organization, current membership role, privileged-role MFA, and current document grant in PostgreSQL. The principal's supplied role and MFA flags cannot escalate a database membership.

The configured API exposes authenticated `GET /api/sync/documents/:id`, `GET /api/sync/documents/:id/operations?afterCursor=0&limit=50`, and `POST /api/sync/documents/:id/operations`. The host enforces HTTPS, exact application-origin validation, CSRF for mutation, 64 KiB JSON request bodies, and request rate limits. Deployment-specific distributed account/IP limits remain necessary across multiple API instances. A path document ID must match the operation body document ID. Return `Cache-Control: no-store`; do not log operation bodies, cookies, annotation text, or ciphertext buffers. Catch `SyncError` and return its `status`, `code`, safe `message`, and optional conflict `details`. Treat unexpected database/KMS exceptions as generic server errors, with a correlation ID. Database credentials, session hashes and KMS details must never reach browser errors.

Runtime synchronization is off by default. `MARGIN_SYNC_ENABLED=true` requires configured organization sessions and a separate protected `MARGIN_SYNC_DATABASE_URL_FILE` containing the restricted sync runtime connection string. Optional `MARGIN_SYNC_DATABASE_CA_FILE` supplies a trusted database CA; server certificate verification stays enabled. Startup never applies migrations or provisions grants. The current API still uses its local encrypted object-storage adapter and rejects `NODE_ENV=production`; enabling this slice does not remove that deployment gate.

An operation has exactly these fields:

```json
{
  "documentId": "server-provisioned UUID",
  "versionId": "server-provisioned UUID",
  "pageId": "server-provisioned UUID",
  "annotationId": "stable annotation UUID",
  "operationId": "unique retry-stable operation UUID",
  "baseRevision": 0,
  "kind": "put",
  "annotation": {
    "type": "text",
    "x": 80,
    "y": 90,
    "text": "An annotation",
    "color": "#102030",
    "strokeWidth": 2,
    "opacity": 1
  }
}
```

UUID placeholders above describe the contract; send actual UUIDs. `delete` operations omit `annotation`. An annotation revision starts at one; creating it requires `baseRevision: 0`. Editing or deleting requires its current revision. The server supplies actor, revision, cursor and timestamp. Unknown fields, including actor/org/privacy/grant fields, are rejected. Supported types are text, pen, highlight, comment, rectangle, ellipse and line. Pen strokes have 1–2,000 bounded points. Text is at most 16,000 characters and the entire operation at most 64 KiB. New editor types such as arrow, signature and stamp, and their extra fields, currently receive explicit validation errors; clients must preserve them locally until protocol support is added.

`append` resolves to `{ operationId, cursor, annotationRevision, duplicate }`. Retries are scoped to organization + document + actor + operation ID. An identical normalized operation receives the existing receipt, including after a service restart. Reusing that ID for different content returns `409 idempotency_conflict`. The same ID used by another actor never reveals the first actor's receipt.

`catchUp` returns `{ documentId, versionId, operations, nextCursor, hasMore, currentCursor }`. Each committed operation includes the input fields plus `actorId`, `cursor`, `annotationRevision`, and `committedAt`. Pages have at most 100 operations and approximately 1 MiB of serialized response data; continue from `nextCursor` while `hasMore`. Reads use a bounded committed cursor snapshot, then recheck authorization after decryption. `committedAt` is the database transaction's insertion timestamp, available only for operations that committed; it is not a global ordering key.

## Ordering, conflicts and work preservation

Every append takes the document row lock before reading or advancing its cursor. Different annotations can be edited independently without revision conflicts; their durable writes serialize briefly on that document. A cursor cannot become visible before an earlier cursor commits. Different documents use separate locks and independent cursors. PostgreSQL sequence allocation and wall-clock ordering are not used as catch-up cursors.

The transaction inserts the encrypted operation, changes annotation revision metadata, advances the document cursor and byte counter, and inserts the outbox record. Any failure rolls back all four. If the connection disappears during commit, the caller must retry the same operation ID: the outcome might already be committed. A `503 sync_busy` or key-service failure must leave the client edit pending locally.

A stale annotation revision returns `409 annotation_conflict` with `currentRevision` and `currentCursor`. A mismatched version returns `409 version_conflict` with `currentVersionId`; unknown or moved pages also fail explicitly. No conflict response overwrites or discards the submitted work. Clients must keep pending edits in their encrypted local store, fetch committed changes, and offer resolution or remapping. This slice does not implement CRDT merging, automatic same-annotation conflict resolution, document structural edits, or version migration. Initial version/page identities are immutable to runtime credentials.

## Grants and teacher-private content

The document owner, editors and viewers receive explicit grants. Membership in a school or organization alone grants no document access. Viewer/support organization roles cannot write even with an editor grant. Missing, revoked and foreign-organization documents return the same unavailable response. A grant change takes the document lock, so an already waiting append rechecks the grant before proceeding.

Teacher-private feedback is a separate server-provisioned document sync resource with `audience: 'teachers'`, its own version/pages, grants and cursor. Its grants must name authorized teaching/admin members. A student cannot read that resource even if an operator accidentally inserts a student grant. Do not mix private feedback into a student-visible operation log or selectively filter one shared cursor: that would expose activity and complicate recovery. The trusted classroom integration decides when and how feedback is released into an authorized shared resource.

`PostgresSyncProvisioner` is a trusted control-plane API using different credentials. `createDocument` receives server-derived document/version/page IDs and validated dimensions, an existing active owner, audience and optional editor/viewer grants. `setGrant(orgId, docId, userId, permissionOrNull)` adds, changes or revokes an explicit grant after validating membership. It cannot transfer document ownership. Neither method belongs on an unguarded browser route. The object ingestion/scanning service must establish safe content and trusted page metadata before provisioning; there is no client-settable safe status or claimed scan result here.

## Database and encryption setup

Apply `infra/migrations/001-identity.sql`, then `002-document-sync.sql`, with a migration owner. No production accounts, documents or memberships are seeded. The runtime login inherits only `margin_sync_runtime`; the separate control-plane login inherits `margin_sync_provisioner`. Neither can own tables, create roles/databases, bypass RLS, or be a superuser. The service also rejects inherited table ownership and mixed identity runtime/provisioner credentials. Migration ownership stays separate from both. Do not grant the sync runtime `margin_identity_runtime`: it needs narrow read access to the current session, not the ability to issue sessions or read session hashes.

All sync tables have forced row-level security. Request context is set with transaction-local parameters on a pooled connection and disappears on commit/rollback. Missing context sees no data. Only parameterized SQL receives identifiers. Runtime cannot insert grants, rewrite document versions/pages, update operation ciphertext, or read outbox rows. The provisioning role cannot read wrapped document keys or operation content. Outbox delivery is intentionally not configured; a future restricted worker may read metadata IDs/cursors and dispatch hints, after which subscribers must fetch through authorization again.

Network database connections require certificate-verified TLS and an explicit SSL configuration. Insecure DSN overrides are rejected. The only non-TLS allowance is `NODE_ENV=test` with a Unix socket and no connection string, used by the disposable tests. Pools have at most eight connections, five-second connection/statement limits, two-second row-lock waits and five-second idle-transaction limits. Transactions force synchronous commit and reject databases with `fsync` or `full_page_writes` disabled. Primary durability does not imply synchronous cross-region replication or disaster recovery; production topology and restoration drills remain necessary.

Each document gets a random 256-bit data encryption key. The injected `KeyManagementProvider` wraps it using the document's organization/document context. Each operation uses Node/OpenSSL AES-256-GCM, a fresh random 96-bit nonce, a 128-bit authentication tag, and authenticated context binding organization, document, version, page, annotation, actor, operation, base revision and cursor. Full annotation content is inside ciphertext. Wrapped keys live separately from encrypted operations. No unwrapped key is persisted or cached across requests; temporary key/plaintext buffers are cleared when feasible. KMS unwrap is bounded to three seconds; a key returned after timeout is cleared. Failed GCM authentication returns no partial plaintext.

Opaque IDs, membership/grant metadata, annotation revisions, timestamps, operation kind and ciphertext lengths remain database metadata. No document names or annotation text are stored in plaintext. This is server-side envelope encryption, not end-to-end encryption: the authorized service can decrypt content, and JavaScript strings cannot be reliably zeroized. `LocalKeyProvider` is used only in tests/local development; a verified managed KMS adapter and key-rotation/recovery policies are required before deployment.

The current bounded limits are 2,000 pages, 100,000 operations and 128 MiB encrypted operation payload per document. These are abuse/resource limits, not performance claims. Retention, compaction, deletion/key destruction, auditing, realtime delivery, malware scanning, OCR workers, cloud storage and deployment validation remain separate work.

## Verification

```sh
MARGIN_REQUIRE_POSTGRES_TESTS=1 npx vitest run tests/sync.postgres.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

The integration suite starts an isolated PostgreSQL cluster on a temporary Unix socket, applies the actual migrations, uses restricted login roles, and removes the cluster afterward. It uses only synthetic identities/content and an isolated test KEK. The separate HTTPS protocol fixture in `tests/identity.test.ts` verifies fresh cookie authentication, CSRF, request/body bounds, path/body ID matching and general-document denial for LTI sessions. Tests here cover real row-lock waiting and commit visibility, independent document progress, concurrent annotation writes, retry/body conflicts, restart recovery, transaction rollback on outbox failure, cross-organization/peer/viewer isolation, grant/session/membership revocation, teacher-private denial, RLS and permission checks, ciphertext tampering and KMS failure. With `MARGIN_REQUIRE_POSTGRES_TESTS=1`, missing PostgreSQL tools fail the suite rather than silently skipping integration coverage.
