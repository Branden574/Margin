# Backend and extension security boundary

The security appendix is implemented as a stricter local foundation. The backend fails closed without HTTPS and encryption configuration. This is not a production identity service, cloud KMS integration, malware scanner, legal compliance certification or independently verified claim of superiority.

## Transit and local configuration

Application HTTP is disabled, including loopback. The API uses Node HTTPS with `minVersion: TLSv1.2`; TLS 1.3 is negotiated when supported. The Chrome extension requires HTTPS for both its workspace and selected source link. The development certificate is supplied explicitly; the web development proxy must trust the configured certificate, not disable verification globally. Certificate trust is a local setup step, not public PKI issuance.

The API requires `MARGIN_API_TOKEN`, `MARGIN_MASTER_KEY` (canonical base64 of 32 random bytes), `MARGIN_TLS_KEY_FILE` and `MARGIN_TLS_CERT_FILE`. `npm run setup:dev` provisions protected local configuration outside document storage. The API does not print keys or tokens and never returns them from a discovery endpoint. Local session tokens expire one hour after process startup. They are not OIDC sessions, and restarting the process is not production token rotation.

`createApi` allows plaintext transport only with both `NODE_ENV=test` and the explicit `allowInsecureTestTransport` flag, for synthetic loopback test fixtures. The application entry point exposes no such flag and refuses `NODE_ENV=production`. Tests also establish an actual HTTPS connection with a trusted generated test certificate and reject TLS 1.1.

## Encryption at rest

`apps/api/src/encryption.ts` uses standard Node/OpenSSL AES-256-GCM, 256-bit random data keys, 96-bit random nonces and 128-bit authentication tags. The application does not implement a cryptographic primitive. Each write creates a fresh data encryption key and authenticated envelope. Both the logical object path and random generation ID are authenticated as additional data, preventing ciphertext or wrapped-key substitution between users, tenants and objects.

Each original document is stored as bounded encrypted parts plus an encrypted manifest. Upload chunks, filenames, checksums, ownership, upload receipts, retention fields and scanning results are encrypted as well. There is no plaintext document assembly file or plaintext sensitive JSON metadata. Finalization verifies chunks in memory and writes encrypted document parts. Downloads authenticate all parts and the complete checksum before sending any content; each part is authenticated again while streaming.

Ciphertext is separate from the wrapped-key sidecars under `key-envelopes/`. Sidecars contain algorithm identifiers, nonces, tags and wrapped keys, not filenames, user names, document content or raw data keys. Sidecars are written before atomically replacing ciphertext so interrupted writes cannot pair old ciphertext with a new key. Temporary files contain only ciphertext or wrapped-key metadata. File permissions are 0600; directories are 0700. Buffers holding data keys and internal sensitive temporary buffers are zeroed where practical. JavaScript garbage collection and a compromised running host remain outside a guarantee of perfect memory erasure.

The included `LocalKeyProvider` wraps data keys using the separately provisioned local master key. It is a development provider, **not cloud KMS**. `KeyManagementProvider` defines the wrap/unwrap boundary for a future managed KMS adapter and key-ID based customer/tenant key policies. Production requires KMS IAM policies, encryption context validation, key rotation/rewrapping, access audit and customer-managed-key lifecycle tests. Losing the master key prevents recovery; anyone who compromises both the running process/master key and its encrypted data can decrypt it.

Legacy plaintext `.json`/`.chunk`/`.bin` files are never accepted by the encrypted storage reader. No automatic plaintext migration or destructive deletion is performed. Operators must identify and securely retire any earlier development data separately. A crash between sidecar publication and ciphertext publication can leave an orphan wrapped-key sidecar; it contains no raw key or document data. A production garbage collector is still required.

## Authentication and authorization

Static local identity configuration binds each bearer token to an immutable tenant/user context for request processing. Client-supplied owner, tenant, role and other unsupported upload fields are rejected. Tokens are compared using constant-time digest comparison. Missing, expired or revoked identities receive 401.

Every upload and document lookup derives its path from both the authenticated tenant and user hashes. Stored ownership is also checked. A same-organization peer receives 404 just like a cross-organization caller on upload status/cancel and document download/delete. List results include only the authenticated owner's records. There is no sharing endpoint, implicit administrator override, support bypass, school-wide document visibility or client-controlled role grant. Classroom membership grants are unavailable until real identity and authorization infrastructure exists.

`GET /api/health` is a minimal public liveness endpoint; it returns no credentials or document metadata. CORS permits only the configured HTTPS development origins. Bearer tokens are explicit authorization headers, not automatically attached cookies. A future cookie session deployment must add its own CSRF protection and secure session rotation rather than inherit this local auth model.

## Untrusted upload handling

The API validates the allowed extension/media-type pairing, fixed file and chunk bounds, exact chunk length, per-chunk SHA-256, whole-file SHA-256 and initial format signature. Magic bytes are not a complete structure check or malware scan.

**The application entry point has no scanner or structural-validation worker. Every finalized upload remains quarantined. A quarantined document cannot be downloaded or enter a normal document workflow.** Upload acknowledgment means encrypted storage and integrity verification succeeded, not that the file is safe to render or share.

`inspectDocument` is an explicitly injected trusted adapter boundary for an isolated structure-validation and malware-scanning service. It has a 15-second deadline and bounded chunk access. Failure, timeout or an invalid decision quarantines the document. Tests inject a scanner result only for known synthetic fixtures; those stubs are never used by the application. A JavaScript timeout cannot terminate an uncooperative in-process parser, so production adapters must invoke restricted external workers with actual CPU/memory/process limits. No risky parser or converter runs in the API process today.

## Abuse, retention and deletion

Defaults: 128 MiB per file, 256 KiB–4 MiB per chunk, eight concurrent API requests, 25 active uploads, 512 MiB reserved/stored plaintext-size quota and 250 encrypted document manifests per local user. Per-IP, tenant and user request windows limit abuse. These are process-local safeguards, not distributed quotas or a public internet rate-limiting service. Encryption overhead and transient finalize copies make physical disk use larger than the logical quota.

Upload sessions expire after 24 hours. Expired receipts are cleaned when a later upload is created; expiration denies further upload access. Documents default to 30-day access retention. `DELETE /api/documents/:id` checks ownership and removes the primary encrypted manifest, encrypted parts and corresponding wrapped-key sidecars, including when the document has expired. It does not erase separately copied filesystem backups or browser exports. Expired document access is denied; idle-file physical retention needs a scheduled deletion service before deployment. Uploaded data is never publicly served or assigned a permanent public URL.

Operational logs use correlation IDs, normalized route names, hashed tenant/user identifiers, opaque upload IDs, timings and security outcomes. They omit tokens, filenames and document content. They are local logs, not an immutable audit ledger. Production requires a restricted append-only audit destination, retention rules, monitoring and incident response.

## Verified evidence

- Ciphertexts differ for identical plaintext; document content, filenames and user IDs do not appear in persisted chunk/manifest bytes or sidecars.
- Wrong master keys, ciphertext tampering and ciphertext substitution across object paths fail authentication.
- Tampered content returns an error before any document bytes are released.
- Unconfigured scans produce quarantine and block download.
- Same-tenant peer and cross-tenant status, cancellation, download, delete and list attempts are denied.
- Expired/revoked sessions and forged ownership fields are denied; quotas and upload expiry are exercised.
- An encrypted filesystem snapshot restores exact original bytes with its separately supplied key; the wrong key cannot restore it. This is a local restoration test, not a remotely managed backup or disaster-recovery guarantee.
- A real HTTPS test passes with a trusted generated certificate; TLS 1.1 is rejected. Extension URL tests reject plaintext HTTP even on localhost.

Run `npx vitest run tests/api.security.test.ts tests/api.uploads.test.ts tests/api.extension.test.ts`. See `docs/PRODUCTION_READINESS.md` for the broader deployment gates. Cloud identity/MFA, KMS, isolated scanning, document sharing grants, durable audit, managed secrets, formal penetration testing and operational disaster recovery remain required before production.
