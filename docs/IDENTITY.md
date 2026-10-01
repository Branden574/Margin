# OIDC identity and PostgreSQL session boundary

This increment implements a real, configurable OpenID Connect backend-for-frontend and PostgreSQL session repository. It does not provision an identity provider, register a Cognito/Google/Microsoft application, seed production accounts, deploy AWS resources, or change the encrypted local vault. The existing optional API can select OIDC sessions instead of development bearer tokens. Its document storage remains the encrypted local filesystem, and ordinary uploads remain quarantined. This identity module alone does not make that API a production document service or establish 100,000-user capacity.

## Integration

The pinned API dependencies are `openid-client` 6.8.8 and `pg` 8.23.1. Import from `apps/api/src/identity/index.ts`:

```ts
const repository = new PostgresIdentityRepository({
  connectionString: databaseUrl,
  ssl: { ca: trustedDatabaseCa, rejectUnauthorized: true },
});
const identityService = await createIdentityService(
  {
    issuerUrl,
    clientId,
    clientSecret,
    applicationOrigin: 'https://workspace.example.edu',
    redirectUri: 'https://workspace.example.edu/api/auth/callback',
    sessionSecret, // independent 32 random bytes from secrets management
    identityHmacKey, // stable, independent 32 random bytes from secrets management
    allowedReturnPaths: ['/'],
    mfaAcrValues: configuredIssuerMfaAcrValues,
  },
  repository,
);
const server = createApi({ identityService, dataDirectory, keyManagementProvider, tls });
// On graceful shutdown, stop accepting requests, then await repository.close().
```

Do not pass development `identities` alongside `identityService`. A browser calls same-origin authentication/API routes; no credential-bearing cross-origin CORS is needed. The listener must use actual TLS, including when a reverse proxy is present. The auth adapter does not trust `X-Forwarded-Proto`, arbitrary Host headers, or client-provided user/organization/role headers. Root transport configuration must restrict trusted proxies and terminate public HTTPS correctly.

`createIdentityHandler(service)` returns an `(IncomingMessage, ServerResponse) => Promise<boolean>` handler. Mount it before protected document routes. `service.authenticateRequest(req)` returns:

```ts
{ principal: { sessionId, userId, organizationId, role, mfa,
               createdAt, expiresAt, lastSeenAt }, csrfToken }
```

Map `principal.organizationId` to the existing API's tenant identity and `principal.userId` to ownership. For **every cookie-authenticated mutation**, call `service.verifyCsrf(req, authenticated)` before changing data. Role values describe authenticated membership; they are not by themselves document/class permissions. This increment does not grant support staff or administrators universal document access. School/district scope, document sharing grants and administrative user-management routes remain subsequent work.

## Browser contract

| Endpoint                                               | Behavior                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/login?returnTo=/&organizationId=<uuid>` | Creates a bounded login transaction and redirects to the configured issuer. Both parameters are optional; an organization is required when the verified account has multiple memberships. The requested organization must match an active server-side membership. |
| `GET /api/auth/callback`                               | Validates the browser-bound transaction and OIDC response, issues a new opaque session, revokes a prior session cookie when present, and redirects to an exact allowlisted return path.                                                                           |
| `GET /api/auth/session`                                | Returns current server-owned principal and a CSRF token. Store the returned CSRF token only in application memory. A missing/expired/revoked session returns 401.                                                                                                 |
| `POST /api/auth/logout`                                | Requires exact `Origin` and `X-CSRF-Token`, revokes the current app session, and clears identity cookies. No body.                                                                                                                                                |
| `GET /api/auth/sessions`                               | Lists up to ten active sessions belonging to the current account, with opaque ID and timing metadata.                                                                                                                                                             |
| `DELETE /api/auth/sessions/:sessionId`                 | Requires exact `Origin` and `X-CSRF-Token`; can revoke only the caller's own session. No body.                                                                                                                                                                    |

All responses use `Cache-Control: no-store`. Both cookies use `__Host-` names, `Secure`, `HttpOnly`, `Path=/`, and `SameSite=Lax`, with no Domain attribute. Tokens are not put in localStorage, sessionStorage, URLs for application API access, or the Chrome extension. Logout revokes the **Margin app session**; it does not claim to terminate the identity provider's global SSO session. Provider logout/back-channel logout is not implemented in this increment. Every protected request reloads the session and current user/organization/membership state; privileged role promotion without an MFA session is denied.

The local vault remains a separate local encryption boundary. The integrating UI must not silently associate existing local documents with a newly signed-in account. Account-bound cache migration, offline retention policy, administrator-forced browser locking, and cross-device key recovery require their own implementation. No part of this module reads or modifies the current user vault.

## Protocol and credential handling

The flow uses authorization code, PKCE S256, independent random state and nonce, `response_mode=query`, and a five-minute authentication-age check. `openid-client` verifies the issuer, audience, expiration, nonce and authorization response; JWS signature verification against the configured provider's JWKS is explicitly enabled with `enableNonRepudiationChecks`. Unsigned tokens and unsupported signing algorithms are not accepted. The initial supported algorithms are RS256, PS256 and ES256, with RS256 by default.

Discovery accepts an exact configured issuer, never a user-provided discovery URL. Issuer, application, callback, and provider endpoints must use HTTPS. The callback is fixed to the application's `/api/auth/callback`. Provider endpoints must remain within the issuer's origin or an explicit exact-origin allowlist. Redirects from server-to-server identity requests are rejected; discovery/token/JWKS requests have an eight-second deadline and a 128 KiB response limit. PKCE S256 support must be advertised by the provider metadata. A provider-specific production integration still needs a real registered client and acceptance tests against its deployed configuration.

The confidential client secret stays on the server. Access, refresh and ID tokens are used transiently and are neither persisted nor returned. No refresh-token grant or unnecessary external user-info request is performed. After the maximum session lifetime, the user signs in again. The default absolute lifetime is one hour and idle timeout is 30 minutes; configured lifetimes are bounded to at most 24 hours. Successful login rotates the opaque session token. Its random 256-bit value appears only in the browser cookie and transient server memory; PostgreSQL stores its SHA-256 hash.

The five-minute login cookie contains state, nonce and PKCE verifier under standard AES-256-GCM authenticated encryption with a fresh nonce and application-origin binding. HKDF-SHA256 derives separate cookie and CSRF keys from the session secret. The database stores only a hash of state, expiry and one-use consumption marker; concurrent callbacks cannot consume the same attempt twice. The CSRF token is derived with HMAC-SHA256 and compared in constant time, alongside an exact Origin check.

Privileged roles (`school_admin`, `district_admin`, `owner`, `support`, `system_admin`) require a signed ACR claim equal to an operator-configured value that the issuer guarantees represents MFA. There are no guessed ACR values or a fallback that treats an arbitrary claim as MFA. If the allowlist is empty, privileged login is denied. An AWS Cognito deployment must configure and verify its actual claims/federation contract; naming Cognito does not prove MFA or SAML integration is configured.

Protect both secrets in environment-separated secret management. The identity HMAC key must remain stable: changing it changes identity lookup values, so rotation requires an explicit mapping migration and tested recovery. Rotating the session secret invalidates pending login cookies and changes CSRF derivation, but does not by itself delete existing database sessions; perform explicit session revocation when rotation follows an incident. Never log cookies, raw claims, client secrets, callback query strings, PKCE values, or access tokens.

## Database migration and provisioning

Apply `infra/migrations/001-identity.sql` once with a trusted migration role. It creates a separate `margin_identity` schema, independent of the earlier disconnected `infra/schema.sql` proposal. There are no sample users or memberships in the migration.

The migration creates a `NOLOGIN`, non-superuser, non-`BYPASSRLS` group called `margin_identity_runtime`. Give a dedicated restricted LOGIN role membership in that group. Do not run the application as the migration owner. The repository rejects superusers, `BYPASSRLS` roles, identity table owners and members of the separate provisioning group. Tables have enabled and forced RLS. Runtime can read narrowly scoped identity rows and insert/consume login attempts and sessions; it cannot create users, assign roles, change session ownership, extend absolute session expiry, or delete tables. User/organization provisioning remains a separate trusted administration operation.

A separate `margin_identity_provisioner` group supplies explicit RLS policies for trusted control-plane/operator provisioning, so non-superuser operators can provision accounts without disabling RLS. Its privileges cover identity/organization/membership creation, disabling users or organizations, changing membership roles/revocation, and revoking sessions. It cannot read session hashes, change session ownership, or extend session lifetime. Never grant this group to the application database login. These are privileged operator credentials, not school administrators' browser credentials; scoped administrative APIs remain future work.

After obtaining the exact verified issuer and subject from the organization's trusted identity administration process, compute:

```ts
identityLookupKey(identityHmacKey, exactIssuer, exactSubject);
```

This uses HMAC over an unambiguous JSON tuple. Provision that pseudonymous key in `margin_identity.users`, create the authorized organization, and add a membership using trusted administrative credentials. Do not identify accounts by email addresses or accept role/organization claims from an arbitrary browser request. No display names, email addresses, raw subjects, passwords or OAuth tokens are stored by this schema. Membership and session timing metadata still require encrypted database volumes/backups, restricted access and retention policies.

Every repository operation runs in a transaction, uses parameterized SQL and `SET LOCAL` context, and rolls back on failure. Context comes from verified OIDC identity or a supplied opaque session cookie's hash, never from identity headers. Custom PostgreSQL context variables are a defense-in-depth filter, not an independent authentication system or protection against a compromised trusted backend. Session authentication rechecks revoked membership, disabled user and disabled organization every time. A per-account transaction lock bounds live sessions during concurrent logins. Pool size is eight; connection, query, statement, lock and idle-transaction timeouts are bounded. Failed rollback discards the connection.

PostgreSQL network connections require verified TLS. Connection-string SSL overrides and `rejectUnauthorized:false` are rejected. Only a `NODE_ENV=test` Unix-socket connection can omit network TLS. RDS provisioning, backup encryption, database CA rotation, failover and restore drills remain deployment work.

Schedule deletion of expired login receipts and expired/revoked sessions under a separate maintenance role according to retention policy. This module deliberately does not give its runtime broad deletion rights. The HTTP adapter bounds concurrent requests and per-process request windows; shared edge/account/organization throttling and a durable security audit destination are still required before scaling replicas. No availability, legal compliance, penetration-test or capacity claim follows from these controls.

## Validation

```sh
npx vitest run tests/identity.test.ts tests/identity.postgres.test.ts
npx tsc -p apps/api/tsconfig.json --noEmit
```

CI sets `MARGIN_REQUIRE_POSTGRES_TESTS=1`; missing PostgreSQL tools then fail the suite instead of skipping its integration tests.

The protocol fixture is explicitly synthetic and lives only in tests. It signs real RSA JWTs, exercises the real `openid-client` code and JWKS verification, and checks PKCE, state, nonce, audience, signature modification, replay, cookie tampering, membership denial, MFA gating, redirect restrictions, CSRF, session rotation and logout. A certificate-verified HTTPS integration uses the actual `createApi` routes to exercise cookie login and deny a same-organization peer's upload access/cancellation. No OS trust is modified.

When local PostgreSQL tools are available, the repository suite starts a disposable Unix-socket-only cluster, applies the real migration, uses a non-owner restricted runtime role and verifies RLS, escalation denial, one-use callback concurrency, live membership/organization changes, owner-scoped session revocation, expiry, transaction rollback and rejection of privileged database credentials. It stops and removes that cluster afterward. Missing PostgreSQL executables skip that suite explicitly; a CI/release gate must require them. These tests do not establish that a real external issuer, deployed RDS database or public endpoint has been configured.

Primary protocol references: [openid-client authorization code grant](https://github.com/panva/openid-client/blob/main/docs/functions/authorizationCodeGrant.md), [JWT signature verification](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md), [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html), and [PostgreSQL row security](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).
