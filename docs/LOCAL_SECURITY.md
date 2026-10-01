# Local security model

Margin's local build now uses HTTPS transport and a passphrase-protected encrypted browser vault. This is a development foundation, not a certified school service. A compromised browser, extension, operating system or first-party script can read a document while it is unlocked. Client-side encryption cannot make that execution environment trustworthy.

## Local setup

Run `npm run setup:dev` to generate a 30-day self-signed loopback certificate and a private `.local/api.env` configuration. The script uses the system OpenSSL and Node's cryptographic random generator. Private files have mode 0600, live outside source/public assets and are Git-ignored. It never prints keys or tokens. It preserves the API encryption key and token. Valid matching server certificates are reused; expired, mismatched, broader-name or legacy CA certificates are replaced only after saving private timestamped backups. The generated certificate is a server-only leaf with critical `CA:FALSE`, no certificate-signing key usage, TLS server authentication purpose, and exactly one subject alternative name: IP `127.0.0.1`. Its common name is also `127.0.0.1`.

The web application runs at **https://127.0.0.1:5173**. The API runs at **https://127.0.0.1:4100**. Vite pins the local certificate as its API CA. Both require TLS 1.2 or newer; the browser/Node negotiate TLS 1.3 when supported. There is no plaintext fallback.

The certificate is self-signed. On macOS, `npm run trust:dev` prints its public SHA-256 fingerprint and requests user-account SSL trust for that exact certificate. The certificate itself restricts the hostname to `127.0.0.1` and disallows use as a signing authority. Approve any macOS prompt yourself. The helper imports no private key or general-purpose local CA, uses no system/admin trust domain, and does not ignore expiry or hostname errors. Setup never invokes this step automatically.

`npm run check:tls` verifies macOS trust without supplying a custom root. `npm run untrust:dev` removes this certificate’s user trust settings. The helper retains a public certificate copy for exact rollback even after local certificate renewal. Re-trust is needed after replacement. API master keys and encrypted document data remain unchanged.

Chromium's macOS trust implementation [ignores hostname-policy-scoped trust entries](https://chromium.googlesource.com/chromium/src/+/main/net/cert/internal/trust_store_mac.cc). The helper therefore uses SSL policy without a separate macOS hostname-policy string, with the single allowed IP enforced by the certificate SAN. It refuses to trust a certificate naming any other host. The exact public certificate is retained before the OS request; `npm run untrust:dev` removes its user trust settings even after certificate rotation. To migrate older trust, remove its trust before requesting trust for the replacement. Native `check:tls` success alone still does not establish browser acceptance; verify the actual preview without certificate exceptions.

The in-app browser may show a certificate-error page without a bypass option. After approving compatible trust, reload or reopen the preview. Do not disable certificate checks globally or change the application to plaintext HTTP. Browser tests use isolated profiles; production/offline checks pin the local certificate’s public key. Replace the local certificate with a managed, publicly trusted certificate for any deployed web app. The local API refuses production mode.

Run `npm run dev:api` after setup. To test server uploads, copy the `MARGIN_API_TOKEN` value from `.local/api.env` into the app's encrypted-server setting. The app keeps that token only in memory, not in localStorage/sessionStorage, and drops it on refresh or lock. This is local developer authentication, not school identity, MFA, SSO or a production session implementation. API identity is configured on the server, never taken from request document metadata.

## Browser vault

Create a strong passphrase of at least 12 characters. The passphrase is not saved or sent over the network. Standard Web Crypto PBKDF2-HMAC-SHA256 (600,000 iterations and random salt) derives a non-exportable AES-256-GCM key. Random nonces and authenticated store/record/vault bindings protect encrypted content against tampering and record swapping. Metadata, original PDFs, annotation operations, classroom records, settings and upload receipts are encrypted. The unlocked key exists in memory only. Public vault configuration contains salt, algorithm parameters, an encrypted verifier and a revision counter; it contains no passphrase or document content.

This implementation uses platform cryptographic primitives, not a new cipher. It still requires independent cryptographic/application review. PBKDF2 parameters follow [OWASP guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); AES-GCM uses the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams).

There is no passphrase reset or cloud key recovery. A forgotten passphrase makes the local ciphertext inaccessible. Exported `.margin` files are self-contained encrypted packages; keep the original vault passphrase to reopen them. The PDF inside an encrypted export includes the requested annotations. Standard plaintext PDF export is not offered under the user's security policy.

A local vault is one local identity; it is not an authenticated school account. The teacher/student selector changes the workflow only. Separate school accounts, remotely enforced retention, MFA, administrator revocation and policy-controlled caching remain production requirements. A future account integration must namespace vaults by authenticated identity and use server-enforced authorization.

## Previous prototype storage

The previous prototype used `margin-workspace` IndexedDB on its original HTTP origin. The encrypted build uses a separate `margin-vault-v1` database on HTTPS. It does not read, delete, or pretend to encrypt data left at another origin. No automatic destructive migration is performed. If sensitive data was placed into a previous prototype, recover/export that data using that version/origin and then deliberately remove its browser storage. New encrypted imports do not retroactively encrypt older copies or original source files on disk.

## Processing and caching

Import, PDF parsing/rendering, page transformations and export encoding run in workers with file/operation guards. Browser workers isolate execution from the main UI thread; they are not a server-grade process sandbox with hard OS memory quotas. Potentially hostile documents require production conversion/render workers isolated with container/process limits, no egress and narrowly scoped credentials. Browser limitations must not be presented as a complete defense against decompression bombs or parser vulnerabilities.

The service worker caches only same-origin application assets and the empty HTML shell. API responses, vault keys and decrypted PDFs are not cached by it. Browser storage eviction can remove encrypted data; it does not provide a retention guarantee. Exports and verified recovery are still necessary.

## Production boundary

Cloud KMS, managed keys, managed PostgreSQL, SSO/MFA, remote authorization, tamper-resistant audit sinks, malware scanning, private object storage, backup operations, incident-response staffing and penetration testing are not provisioned. See [backend security](security-backend.md), [production readiness](PRODUCTION_READINESS.md), and [architecture](ARCHITECTURE.md). No competitor-superiority, legal compliance, availability or 100,000-user capacity claim is made.
