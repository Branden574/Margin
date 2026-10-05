# Production readiness and release gates

**Margin is a working encrypted local foundation, not a production service or a complete Kami replacement.** The API binds to loopback and refuses `NODE_ENV=production`. No 100,000-user capacity, service-availability, legal-compliance, multi-user collaboration or competitor-superiority claim has been established.

## What is implemented

The browser stores documents, metadata, annotation operations, assignments, settings and upload receipts in a passphrase-derived AES-256-GCM vault. Keys and the optional API token remain in memory. Exports are encrypted `.margin` packages with generic filenames and encrypted document metadata; plain PDF download is not offered. The editor supplies real PDF rendering, annotation persistence, page operations, merge/extraction, search, page text and browser read aloud. The extension provides an explicit HTTPS document-link launcher.

Web and API transport require HTTPS with TLS 1.2 or newer. Local setup generates a self-signed certificate and protected development configuration; it does not install system trust or provide public PKI. The API uses authenticated envelope encryption for files and metadata, fixed tenant/user ownership, expiry/revocation checks, request limits, logical quotas, upload expiry, retention checks and authenticated deletion. Keys are supplied through a development key provider, not a managed KMS. See [local security](LOCAL_SECURITY.md) and [backend security](security-backend.md) for the precise boundaries.

**Server uploads remain quarantined in the runnable application.** No actual malware scanner or isolated structure-validation worker is configured, so finalization cannot approve a document for download. An encrypted storage acknowledgment is not a scan result. Local browser import and editing are independent of that quarantine mechanism and must not be described as malware-scanned.

Browser and server data also have different recovery boundaries. Clearing or evicting browser storage can remove the encrypted vault; there is no passphrase reset or cloud key recovery. Optional server upload stores source PDF bytes, not the separate annotation/comment operation log. Old HTTP-origin prototype data and original files elsewhere on disk are not retroactively encrypted or deleted.

## Verification evidence and limits

The commit-specific [verification record](VERIFICATION.md) is the authority for current results. It includes successful remote signature/arrow, form, reader and searchable OCR export workflows, followed by crop and student-work checkpoints with explicit failed CI stages. Passing an earlier revision does not verify subsequent changes. Automated browser coverage includes:

- Text persistence after page reload and vault unlock; shape undo/redo; duplicate-page undo/redo and encrypted export.
- Merging real PDF pages and extracting a standalone page in an encrypted package. Export tests decrypt with the synthetic test passphrase and inspect the resulting PDF.
- Blocking a second editor for the same document and acquiring its lock after the first closes.
- Refusing a cross-tab vault lock while a text draft is unfinished, then preserving the saved annotation through a successful lock and unlock.
- Exporting a 90-line Unicode comment across a complete notes appendix and retaining the original note after reload.
- Refusing browser Back for an unfinished draft or a quota-failed annotation, then allowing navigation after saving/retry; recovering from an abandoned cross-tab lock request.
- Importing a synthetic 500-page PDF, asserting at most six canvases, navigating pages 499/500 and reading the final page's text.

The actual in-app browser walkthrough verified typed signature insertion and keyboard movement, two independent drawn signature strokes, Undo stroke/Clear controls, a dashed arrow, preset stamp deletion and undo/redo, and recovery after an actual reload and vault unlock. The new automated tests separately check arrow geometry, line styles, SVG/PDF rendering, encrypted operation replay and encrypted export/decrypt round trips. Manual export delivery in this browser remains unresolved. See [manual verification](MANUAL_VERIFICATION.md). These visual signatures do not cryptographically sign documents or verify a person's identity; the current remote operation protocol does not accept the new tools yet.

Automated scans of 16 states (library, settings, assignments and editor in three themes; desktop/mobile onboarding; locked screens after theme changes) reported zero axe violations for WCAG 2 A/AA, 2.1 AA and 2.2 AA tags. This is a limited automated result, not an accessibility conformance assessment. It does not cover every dialog, assistive technology, device or interaction.

Storage tests exercise encrypted records and exports, wrong passphrases, ciphertext modification and record substitution, atomic rollback, manual-lock refusal, package portability and encrypted-file import. API tests exercise encrypted chunks/metadata, object substitution and wrong-key failure, owner isolation within and across tenants, expired/revoked identities, forged fields, quarantined download denial, quota/expiry behavior, authenticated recovery and deletion. Upload tests also cover chunk integrity, idempotency, incomplete uploads, pause/retry, restart and finalization. A real HTTPS fixture verifies certificate trust and rejects TLS 1.1. Extension tests reject HTTP and unsafe source URLs. These are automated local fixtures, not independent penetration testing or deployment evidence.

The standalone PostgreSQL proposal is disconnected from runtime storage. `infra/verify-schema.py` applies it in a disposable cluster and exercises seven tenant/authorization assertions. Separately, versioned migrations and actual PostgreSQL integration tests cover the optional identity, sync, LMS, assignment, ingestion and student-work services. These services remain disabled in the default application; reviewed deployment, browser integration and operational recovery are still required.

See [verification](VERIFICATION.md) for the complete run record. Use the current test output as the authority after further changes:

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
python3 infra/verify-schema.py
```

The last command requires a suitable local PostgreSQL installation. Browser tests use an isolated Chromium process that accepts only the development test-certificate setup; this does not change the host's trust store. Native extension installation, Chrome Web Store review and managed school policy behavior have not been verified by these checks.

## Remaining product scope

- Cloud identity, organization/user/group/license administration and authenticated teacher/student permissions. The current role selector is a local workflow preference.
- Remote annotation synchronization, real-time coediting, live presence, conflict resolution, durable acknowledgment and cross-device version recovery. Local Web Locks and operation logs do not provide these services.
- Production OCR, Office and Google document conversion, LMS/cloud-drive APIs, optional AI providers, remote assignment delivery and district reporting.
- Direct editing of existing PDF text, form creation and unsupported form variants, page resizing, bulk splitting into many files, image annotations, cryptographic document signatures, audio/video comments and richer annotation/teacher workflows. Supported existing form filling and page cropping/reset are implemented locally, with their limits in [forms](FORMS.md) and [crop](CROP.md). Typed/drawn visual signatures and three preset feedback stamps are available locally; custom stamp libraries are not.
- Durable product version history and recovery across devices. Current undo history is bounded and lasts for the editor session; exported PDFs flatten annotations and carry full comments in an appendix. Unicode text unsupported by the built-in export font is rasterized and loses text selection/searchability in that export.
- Broader assistive-technology, device and reading support. Local-voice controls, reading appearance/focus and printed-English OCR are implemented; browser speech still depends on installed local voices and is not guaranteed offline speech or transcription.

## Required before an internet beta

1. **Identity and authorization:** integrate tested OIDC/SSO and, where required, MFA; enforce tenant/class/document grants and account revocation. Bind local vaults to authenticated identity. Add secure session rotation and the appropriate CSRF protections if cookie authentication is introduced. Audit database, object-store and realtime access as one authorization path.
2. **Managed cryptography:** commission independent review of browser/server encryption and package formats. Implement managed KMS/HSM adapters, key rotation/rewrapping, recovery policies, least-privilege key access, operational secret management and customer-managed-key lifecycle tests. The local master-key file is not managed KMS, and a compromised unlocked process can access plaintext.
3. **Untrusted files:** provision isolated structural validation and malware scanning before releasing quarantined objects. Add tested parser resource budgets, file-complexity limits, worker termination, no-egress policies and conversion licensing. Browser workers and JavaScript deadlines do not provide hard server process isolation.
4. **Durable infrastructure:** connect managed PostgreSQL, private object storage and a durable queue. Replace process-local locks, quotas and rate limits with transactional/shared enforcement. Add scheduled cleanup for expired documents, abandoned uploads and orphan key sidecars; implement encrypted backups and recovery drills with keys stored separately.
5. **Collaboration reliability:** implement and test concurrent edits, reconnect replay, duplicate operations, missed acknowledgments, snapshot/restore and crash recovery before presenting network synchronization as complete.
6. **Performance and capacity:** measure large/image-heavy PDFs, long sessions, many annotations, memory pressure and upload interruption on inexpensive ChromeOS hardware and school-like networks. Load-test concurrency, regional failure and deployment recovery before setting SLOs or publishing capacity claims.
7. **Operational security:** finish production CSP/Trusted Types assessment, shared abuse controls, audit retention, restricted append-only audit storage, monitoring, incident response, dependency review, deployment/rollback and penetration testing. Preview security headers and local correlation logs do not constitute a full operational security program.
8. **Education privacy and accessibility:** complete keyboard/screen-reader/zoom/contrast/device testing and privacy/legal review of school contracts, age/consent requirements, FERPA/COPPA responsibilities, subprocessors, regional hosting, retention, exports, deletion and breach processes. Technical safeguards alone do not establish compliance.

## Verification matrix

| Scenario                      | Local evidence                                                                    | Remaining gate                                                             |
| ----------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Encryption at rest and export | Authenticated vault/envelope tests; portable encrypted export tests               | Independent review, managed KMS, rotation and recovery operations          |
| Transport                     | HTTPS application/API; trusted test certificate and TLS 1.1 rejection             | Public certificate lifecycle, deployed headers and edge configuration      |
| Corrupted/retried upload      | Digest, conflict, size, retry, pause and restart tests                            | Object-store multipart receipts, expired URLs and distributed failover     |
| Authorization                 | Same-tenant peer and cross-tenant object denial; expired/revoked local identities | OIDC/MFA, role/grant matrix, runtime RLS and realtime policies             |
| Quarantine                    | Unconfigured/failed inspection blocks API download                                | Actual isolated scanner, structural validation and release workflow        |
| Storage/retention             | Local logical quotas, expiry checks and authenticated deletion                    | Shared quotas, physical retention scheduler and backup deletion policy     |
| 500-page PDF                  | Synthetic fixture, maximum six canvases, final-page navigation/text               | Image-heavy documents, heap/latency profiling and low-memory devices       |
| Offline/save/lock             | Local encrypted operation persistence and cross-tab lock recovery                 | Cross-device reconciliation, power-loss tests and durable acknowledgments  |
| 100/1,000 concurrent uploads  | Not load-tested                                                                   | Staging load, bandwidth/queue limits and rollback drills                   |
| 10,000 live connections       | No production realtime service                                                    | Reconnect storms, fanout, authorization and regional failure               |
| Restore                       | Local encrypted filesystem snapshot test with a separate key                      | Managed backup, remote disaster recovery and tested recovery objectives    |
| School deployment             | Local app/extension artifacts and automated browser checks                        | Native/managed Chrome, school Wi-Fi, assistive technology and legal review |

Keep logs free of credentials, filenames and document content. Use correlation IDs and actionable recovery messages. State measured results separately from proposed targets, and preserve quarantine until an actual trusted inspection service approves release.
