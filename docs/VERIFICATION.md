# Verification record

Verified locally on October 1, 2026, on macOS/Apple Silicon with Node.js 22.22.2 and isolated Chromium. The repository is an encrypted local foundation; these results do not establish production scale, school privacy compliance or independent security certification.

| Check                  | Observed result                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript             | All workspace type checks passed                                                                                                                                                                              |
| Unit/integration suite | 71 tests across 10 files passed                                                                                                                                                                               |
| Browser workflows      | All 15 Chromium tests passed over local HTTPS                                                                                                                                                                 |
| Build                  | Web production bundle, Node API compilation and Manifest V3 permission/package validation passed                                                                                                              |
| Production offline     | All 26 emitted assets cached at their exact URLs; encrypted vault re-unlocked after offline reload; previously unopened PDF rendered; blank creation and PDF import workers worked offline; no browser errors |
| Accessibility          | Zero axe violations across 16 states using WCAG 2 A/AA, 2.1 AA and 2.2 AA tags                                                                                                                                |
| PostgreSQL proposal    | Schema applied and 7 isolation/authorization assertions passed in a disposable PostgreSQL 18.3 cluster                                                                                                        |
| Dependencies           | `npm audit` reported zero known vulnerabilities; CycloneDX inventory generated from the committed lockfile                                                                                                    |
| Local TLS proxy        | Health request through Vite to the API succeeded with the generated certificate as the explicit CA                                                                                                            |

## What the tests establish

Local certificate tests cover server-only leaf constraints, hostnames, key matching, private permissions, valid-pair reuse, and backed-up replacement of legacy, expired, incomplete or mismatched pairs. The migration test verifies that existing API secrets remain byte-for-byte unchanged. macOS certificate trust requires an explicit user action and is not established by these automated tests.

After user approval, native macOS verification accepted the local certificate for `127.0.0.1` and rejected an unrelated hostname. A temporary child certificate signed by the local server certificate was also rejected with `Invalid BasicConstraints.CA` and a key-usage failure, confirming that this certificate cannot issue trusted child certificates in the tested macOS verifier. The temporary child files were removed. Chromium rejected the hostname-scoped OS trust entry, consistent with its documented trust-store implementation; native verification alone does not establish in-app browser compatibility.

Storage tests inspect ciphertext records for document bytes, metadata, annotations, preferences and upload receipts. They cover incorrect passphrases, tampered/swapped records, atomic failure rollback, encrypted export portability, malformed package parameters and lock-versus-decryption/import races.

API tests exercise encrypted filesystem artifacts, tenant and same-tenant user isolation, expiration/revocation, rejected forged ownership fields, upload integrity and idempotency, interruption/restart, quotas, default quarantine, denied download, authenticated deletion, wrong-key restore failure and correct-key encrypted snapshot recovery. The TLS fixture uses a trusted local certificate and rejects TLS 1.1.

Browser tests cover actual local PDF import and editing, save/reload/unlock, page operations and encrypted exports, Unicode comment appendices, same-document writer exclusion, cross-tab lock refusal/recovery and abandoned lock timeout. Browser Back preserves unfinished drafts and annotations whose saves fail with an injected quota error; retry allows navigation once persistence succeeds. A synthetic 500-page fixture stays at six or fewer canvases and reaches the final page. Library, mobile navigation, settings and the explicitly local teacher/student assignment sequence also pass.

The production offline runner launches and removes its own temporary HTTPS preview. Its readiness request trusts only the generated local certificate; its browser pins that certificate's public key. It verifies the complete lazy asset graph, workers and locally bundled fonts. The same runner scans desktop/mobile onboarding; library, settings, assignments and editor in all three themes; and locked screens after changing themes. This is automated coverage, not a full assistive-technology or accessibility conformance assessment.

## Reproduce

```sh
npm ci
npm run setup:dev
npm run format:check
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:offline
npm audit --audit-level=high
npm sbom --package-lock-only --sbom-format=cyclonedx > /tmp/margin-sbom.json
```

`npm run test:offline` also runs the 16 production accessibility scans. `npm run test:a11y` targets an already running development server; `MARGIN_CHECK_URL` can choose another local HTTPS preview that uses the generated certificate.

With local PostgreSQL tools available, run `python3 infra/verify-schema.py`. It starts a private temporary cluster without a TCP listener and does not connect to an existing database. The schema is not used by the running API.

## Boundaries

No native Chrome extension installation, Chrome Web Store publication, managed school-device policy, low-memory Chromebook hardware test, real school/student data, production identity or cloud provider has been used in this verification. The 500-page PDF is synthetic; there is no measured throughput/SLO, image-heavy memory-pressure result or 100,000-user load result. The app has no deployed OCR, malware scanner, KMS, cloud collaboration, LMS integration or operational recovery service. See [production readiness](PRODUCTION_READINESS.md).

Repository CI is configured to repeat the checks on Linux. This local record does not predict a particular remote run; inspect the GitHub Actions result for the commit being reviewed.
