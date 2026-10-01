# Local security model

Margin's local build now uses HTTPS transport and a passphrase-protected encrypted browser vault. This is a development foundation, not a certified school service. A compromised browser, extension, operating system or first-party script can read a document while it is unlocked. Client-side encryption cannot make that execution environment trustworthy.

## Local setup

Run `npm run setup:dev` to generate a 30-day self-signed localhost certificate and a private `.local/api.env` configuration. The script uses the system OpenSSL and Node's cryptographic random generator. Private files have mode 0600, live outside source/public assets and are Git-ignored. It never prints keys or tokens. It preserves existing files.

The web application runs at **https://127.0.0.1:5173**. The API runs at **https://127.0.0.1:4100**. Vite pins the local certificate as its API CA. Both require TLS 1.2 or newer; the browser/Node negotiate TLS 1.3 when supported. There is no plaintext fallback.

The certificate is self-signed. For browser development, explicitly trust this certificate on this development machine, or accept the localhost certificate warning for a temporary test. Do not disable certificate validation globally. Service workers may require explicit local certificate trust; browser end-to-end tests ignore this test certificate in their isolated Chromium process only. No system trust store is modified by setup. Replace this local certificate with a managed, publicly trusted certificate for a deployed web app. The local API refuses production mode.

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
