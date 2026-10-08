# Explicit Canvas service composition

`apps/api/src/runtime-composition.ts` exports `createCanvasRuntime(config, dependencies)`. It composes identity, LMS, assignment-authoring and student-work services, with an optional capture/materialization/teacher-review pipeline. It does not listen on a socket, load environment variables, migrate a database, create accounts or installations, seed approvals, run workers, or configure a scanner. `apps/api/src/index.ts` does not call it, and the production startup rejection remains in place.

## Inputs and ownership

`CanvasRuntimeConfig` accepts either the existing `IdentityConfig` (default `authentication: 'oidc'`) or `authentication: 'lti-only'` with `LtiIdentityConfig`, four PostgreSQL `PoolConfig` values (`identity`, `lms`, `assignments`, `work`), and independent 32-byte LMS lookup and assignment resource HMAC keys. The identity configuration supplies its own independent 32-byte session and identity lookup keys. All four values must differ. The factory snapshots key bytes and mutable identity allowlists before asynchronous OIDC discovery, so later caller mutation does not change the constructed configuration.

The four database configurations require distinct, appropriately restricted logins. The existing repositories enforce verified database TLS and check their runtime role, ownership, conflicting memberships and durable settings during transactions. Successful construction is not a database readiness check; PostgreSQL pools connect lazily. There is no runtime migration or automatic role provisioning.

`CanvasRuntimeDependencies` requires explicit, caller-owned instances:

- `keys: KeyManagementProvider`, used for encrypted assignment and work metadata.
- `artifacts: ArtifactReader`, which must authenticate the pinned immutable object/version and encrypted content.
- `sources: AssignmentSourceGateway`, which must check current authority, inspection approval and actual exact-version object availability.
- `signer: AssignmentDeepLinkSigner`, with the institution-configured tool response signing key.

An optional caller-owned `sourceCatalog: AssignmentSourceCatalog` enables metadata-only teacher source discovery. `IngestionAssignmentSourceCatalog` can provide it using an independently configured ingestion runtime repository. The factory snapshots this reference with the other dependencies and does not close it or its repository. Omission leaves discovery explicitly unavailable; it does not disable the existing create-by-verified-source contract or infer ready candidates from sync documents. Catalog entries label object availability as unchecked, and creation still uses the required source gateway's full verification.

There is no fallback provider. The existing `AwsKmsKeyProvider`, `S3EncryptedArtifactRepository` and `IngestionAssignmentSourceGateway` can satisfy these contracts when their infrastructure and credentials are independently configured. The gateway still needs its separate ingestion runtime and reader repositories; these remain owned by its caller. The HTTP factory never receives inspection or student-work provisioning database credentials.

`oidcTests` is an explicit synthetic issuer transport seam already restricted to `NODE_ENV=test`. Optional `resolveLmsKey` is the existing trusted server-only LMS key resolver; omission uses the installation's registered remote JWKS. Neither option is read from an environment flag. OIDC construction performs configured provider discovery, with the existing HTTPS endpoint allowlists and bounds. Explicit LTI-only construction has no issuer/client secret or discovery request, rejects OIDC transport overrides, and disables standalone login/callback. It uses the same secure session, CSRF, expiry and current LMS-authority checks, accepts only sessions explicitly marked LTI, and still needs operator-provisioned installations/account links/course enrollments. It does not derive authority from browser role preferences.

## Dependency ordering

The factory creates the LMS repository first, then supplies `authorizeLmsSession: principal => lmsRepository.authorizeSession(principal)` to identity construction. Existing identity authentication therefore rechecks the current LMS registration, account link, course and enrollment for every LTI session.

The assignment service uses that same LMS repository as authorizer and installation repository. The LMS service delegates session issue/authentication to the identity service, and delegates `onVerifiedLaunch` to `assignmentService.captureVerifiedLaunch`. This hook executes only after signature, launch/replay and enrollment validation and after the durable LMS session binding has committed. The assignment hook separately rechecks the launch's current scope.

The explicit LMS return allowlist contains `/canvas/author`, `/canvas/work` and `/canvas/review`, matching the signed assignment hook. The separate web application implements those screens; this factory provides their backend services. Existing API routes remain `/api/auth/session`, `/api/assignments`, `/api/assignments/selection`, `/api/assignments/selections/:id/complete`, `/api/assignments/work`, `/api/assignments/work/source`, and `/api/assignments/work/operations`.

## Optional frozen-submission pipeline

Supply `submissions: { databases: { capture, processor, reviewer, sourceReader }, captureEnabled, processingDeadlineMs? }` to construct the entire optional pipeline. Each database value is a dedicated `PoolConfig`; its login must have only its corresponding `margin_submission_runtime`, `margin_submission_processor`, `margin_submission_reviewer` or `margin_ingestion_reader` role. Apply migrations 009–012 first using separate operator credentials. No role is created or combined by this factory. The reader has its own owned pool even when the caller's source gateway also has a reader.

This adds `assignmentSubmissionService` and `assignmentReviewService` to `apiServices`, plus an explicit `materializeSubmission(signal?)` method. A call processes at most one leased job. No timer, public worker endpoint or Canvas delivery is started. `captureEnabled: false` disables the student submission service calls while retaining explicitly composed teacher review and processing of already captured work. Omitting `submissions` omits all three capabilities. A malformed partial configuration fails construction; no substitute provider or synthetic source is selected.

`keys` and `artifacts` remain borrowed and must support all configured services. The [local encrypted artifact adapter](LOCAL_ARTIFACTS.md) implements the object contract for development without claiming AWS, managed KMS or malware-scanning behavior. See [private Canvas sandbox plan](CANVAS_SANDBOX.md).

## Returned services and shutdown

`apiServices` can be spread into `createApi` alongside separately reviewed transport, storage and admission options. Generic document sync is independently supplied if configured. The factory supplies no local bearer identities and does not change the generic-route rejection of LTI sessions. `assignmentsConfigured` and `assignmentWorkConfigured` describe service presence, not operational or production readiness.

`publicJwks()` returns a fresh clone of the signer's public JWKS snapshot. It exposes no private key material, cannot be changed by mutating a prior returned value, and rejects after close. It is not an HTTP publication endpoint. Public key publication/institution registration, signing-key loading and coordinated rotation remain separate work. Synthetic platform launch keys and tool response keys are distinct in the integration fixture.

The caller must stop accepting requests and drain active HTTP requests before calling `close()`, then close its borrowed providers/gateway repositories. Closing rejects new materialization calls, aborts admitted calls and awaits their bounded public promises before closing the owned pools. Provider calls that ignore cancellation can outlive those public promises; processor/reviewer admission closes and their existing late-result cleanup remains in force. This does not claim to drain every underlying borrowed transport. The factory closes only its constructed repositories/services in reverse construction order and zeros its own copied configuration keys. Close is idempotent, attempts every owned cleanup if one fails, and preserves cleanup failures. Partial construction also closes already constructed resources; a cleanup failure preserves the original construction error in an aggregate error. Existing identity internals and immutable strings/KeyObjects are subject to their existing lifecycle and garbage collection; this is not a guarantee that every derived secret byte has been erased from process memory.

## Disposable integration evidence

Run `MARGIN_REQUIRE_POSTGRES_TESTS=1 npx vitest run tests/runtime-composition.postgres.test.ts` with the repository PostgreSQL binaries available. The fixture applies the real migrations to a disposable Unix-socket database, uses separated non-owner logins, including the four optional submission/reader accounts, and sends certificate-verified HTTPS requests through the real API handler. Only fixture administration creates its organizations, mappings and initial teacher document/version/grant; the absent upload-to-registry bridge is not simulated as a working HTTP endpoint.

The earlier fixture cases use a generated one-page PDF, the actual encrypted S3 envelope adapter and an explicitly synthetic in-memory SDK transport. The new LTI-only submission journey instead uses the real encrypted local filesystem adapter and reopens both it and the service graph before materialization and again before teacher review. PostgreSQL retains captured work, encrypted chunks and completion receipts across those service restarts. Its deterministic inspection adapter accepts only that exact known fixture and asserts its known page geometry. It supplies no malware-scanning evidence and is never selectable in runtime configuration. No AWS or Canvas service is contacted.

The signed journey covers teacher Deep Linking launch, authenticated assignment creation and CSRF, tool JWT verification with public JWKS, student resource launch, pending work reservation, separate worker provisioning, authenticated source delivery, idempotent annotation append/catch-up and a fresh session for the same durable work. It also covers signature failure, replay, missing account mapping, uninspected sources, source/enrollment revocation, object outages, generic-route denial, key/JWKS ownership and construction/cleanup failures.

The added journey authenticates the frozen answer after restart, excludes a later draft edit, checks exact hashes/source/pins and role boundaries, and still reports no Canvas confirmation. It also covers disabled capture, omitted pipeline services and cleanup failures. These are backend integration checks with synthetic launches and a generated source, not a restarted database process, a machine-power-loss test or a live platform connection.

This is backend integration evidence. It does not establish browser Canvas framing/cookie behavior, connected author/student screens, production storage permissions, a scanner deployment, a scheduler, a live Canvas installation, recovery operations or 100,000-user capacity. New-source intake, environment-driven bootstrap and production deployment remain separate gates.
