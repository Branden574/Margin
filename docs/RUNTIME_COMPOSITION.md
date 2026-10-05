# Explicit Canvas service composition

`apps/api/src/runtime-composition.ts` exports `createCanvasRuntime(config, dependencies)`. It composes the existing identity, LMS, assignment-authoring and student-work services. It does not listen on a socket, load environment variables, migrate a database, create accounts or installations, seed approvals, run workers, or configure a scanner. `apps/api/src/index.ts` does not call it, and the production startup rejection remains in place.

## Inputs and ownership

`CanvasRuntimeConfig` accepts an existing `IdentityConfig`, four PostgreSQL `PoolConfig` values (`identity`, `lms`, `assignments`, `work`), and independent 32-byte LMS lookup and assignment resource HMAC keys. The identity configuration supplies its own independent 32-byte session and identity lookup keys. All four values must differ. The factory snapshots key bytes and mutable identity allowlists before asynchronous OIDC discovery, so later caller mutation does not change the constructed configuration.

The four database configurations require distinct, appropriately restricted logins. The existing repositories enforce verified database TLS and check their runtime role, ownership, conflicting memberships and durable settings during transactions. Successful construction is not a database readiness check; PostgreSQL pools connect lazily. There is no runtime migration or automatic role provisioning.

`CanvasRuntimeDependencies` requires explicit, caller-owned instances:

- `keys: KeyManagementProvider`, used for encrypted assignment and work metadata.
- `artifacts: ArtifactReader`, which must authenticate the pinned immutable object/version and encrypted content.
- `sources: AssignmentSourceGateway`, which must check current authority, inspection approval and actual exact-version object availability.
- `signer: AssignmentDeepLinkSigner`, with the institution-configured tool response signing key.

There is no fallback provider. The existing `AwsKmsKeyProvider`, `S3EncryptedArtifactRepository` and `IngestionAssignmentSourceGateway` can satisfy these contracts when their infrastructure and credentials are independently configured. The gateway still needs its separate ingestion runtime and reader repositories; these remain owned by its caller. The HTTP factory never receives inspection or student-work provisioning database credentials.

`oidcTests` is an explicit synthetic issuer transport seam already restricted to `NODE_ENV=test`. Optional `resolveLmsKey` is the existing trusted server-only LMS key resolver; omission uses the installation's registered remote JWKS. Neither option is read from an environment flag. Ordinary construction performs configured OIDC discovery, with the existing HTTPS endpoint allowlists and bounds.

## Dependency ordering

The factory creates the LMS repository first, then supplies `authorizeLmsSession: principal => lmsRepository.authorizeSession(principal)` to identity construction. Existing identity authentication therefore rechecks the current LMS registration, account link, course and enrollment for every LTI session.

The assignment service uses that same LMS repository as authorizer and installation repository. The LMS service delegates session issue/authentication to the identity service, and delegates `onVerifiedLaunch` to `assignmentService.captureVerifiedLaunch`. This hook executes only after signature, launch/replay and enrollment validation and after the durable LMS session binding has committed. The assignment hook separately rechecks the launch's current scope.

The explicit LMS return allowlist contains `/canvas/author` and `/canvas/work`, the current assignment hook's return paths. The factory does not implement browser screens at those paths. Existing API routes remain `/api/auth/session`, `/api/assignments`, `/api/assignments/selection`, `/api/assignments/selections/:id/complete`, `/api/assignments/work`, `/api/assignments/work/source`, and `/api/assignments/work/operations`.

## Returned services and shutdown

`apiServices` can be spread into `createApi` alongside separately reviewed transport, storage and admission options. Generic document sync is independently supplied if configured. The factory supplies no local bearer identities and does not change the generic-route rejection of LTI sessions. `assignmentsConfigured` and `assignmentWorkConfigured` describe service presence, not operational or production readiness.

`publicJwks()` returns a fresh clone of the signer's public JWKS snapshot. It exposes no private key material, cannot be changed by mutating a prior returned value, and rejects after close. It is not an HTTP publication endpoint. Public key publication/institution registration, signing-key loading and coordinated rotation remain separate work. Synthetic platform launch keys and tool response keys are distinct in the integration fixture.

The caller must stop accepting requests and drain active requests before calling `close()`, then close its borrowed providers/gateway repositories. The factory closes only its constructed repositories/services in reverse construction order and zeros its own copied configuration keys. Close is idempotent, attempts every owned cleanup if one fails, and preserves cleanup failures. Partial construction also closes already constructed resources; a cleanup failure preserves the original construction error in an aggregate error. Existing identity internals and immutable strings/KeyObjects are subject to their existing lifecycle and garbage collection; this is not a guarantee that every derived secret byte has been erased from process memory.

## Disposable integration evidence

Run `MARGIN_REQUIRE_POSTGRES_TESTS=1 npx vitest run tests/runtime-composition.postgres.test.ts` with the repository PostgreSQL binaries available. The fixture applies the real migrations to a disposable Unix-socket database, uses eight separated non-owner logins, and sends certificate-verified HTTPS requests through the real API handler. Only fixture administration creates its organizations, mappings and initial teacher document/version/grant; the absent upload-to-registry bridge is not simulated as a working HTTP endpoint.

The fixture uses a real generated one-page PDF, the actual encrypted S3 envelope adapter and an explicitly synthetic in-memory SDK transport. Its deterministic inspection adapter accepts only that exact known fixture and asserts its known page geometry. It supplies no malware-scanning evidence and is never selectable in runtime configuration. No AWS or Canvas service is contacted.

The signed journey covers teacher Deep Linking launch, authenticated assignment creation and CSRF, tool JWT verification with public JWKS, student resource launch, pending work reservation, separate worker provisioning, authenticated source delivery, idempotent annotation append/catch-up and a fresh session for the same durable work. It also covers signature failure, replay, missing account mapping, uninspected sources, source/enrollment revocation, object outages, generic-route denial, key/JWKS ownership and construction/cleanup failures.

This is backend integration evidence. It does not establish browser Canvas framing/cookie behavior, connected author/student screens, production storage permissions, a scanner deployment, a scheduler, a live Canvas installation, recovery operations or 100,000-user capacity. New-source intake, environment-driven bootstrap and production deployment remain separate gates.
