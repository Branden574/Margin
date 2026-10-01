# Margin

**Room for your ideas.** A calm document workspace for reading, annotating and teaching, with a lightweight Chrome extension.

Margin takes its name from the place where questions, sketches and discoveries begin. The original visual direction combines warm paper, terracotta and restrained document tools. [Design references](docs/DESIGN.md) were inspected through the connected Mobbin MCP; the supplied Kami research informed the requirements.

This is a runnable local foundation. It includes real PDF editing, encrypted browser persistence, encrypted exports and a tested HTTPS upload service. Cloud identity, multi-user collaboration, OCR and school integrations are not provisioned. See the [release gates](docs/PRODUCTION_READINESS.md).

![Margin document workspace with original sample documents](docs/images/margin-workspace.png)

## Run locally

Requires Node.js 22+, npm and OpenSSL.

```sh
npm ci
npm run setup:dev
# On macOS, approve trust for this local server certificate:
npm run trust:dev
npm run dev
```

Open **https://127.0.0.1:5173**. Setup creates a 30-day self-signed server certificate and random API secrets under the Git-ignored `.local/` directory, with private file permissions. It never changes certificate trust or prints secrets. The certificate cannot act as a certificate authority.

On macOS, `npm run trust:dev` requests trust for that exact certificate, constrained to SSL on `127.0.0.1` in your user login keychain. Approve the macOS prompt yourself. It imports only the public certificate, preserves normal certificate validation, and does not change system-wide trust. `npm run check:tls` checks the result; `npm run untrust:dev` reverses it. Reload the preview after approval. Other operating systems need their own development-certificate trust setup.

If the preview reports `ERR_AUTHORITY_INVALID`, the server certificate is not trusted by the browser. The in-app browser may have no “proceed anyway” control. Complete the trust step instead of disabling HTTPS or certificate checks. If the browser still caches the error after trust is verified, close and reopen the preview tab.

Create a strong workspace passphrase. Documents and metadata are encrypted in this browser's IndexedDB. The passphrase is never stored or sent to the API. **There is no passphrase reset.** Keep it safely: it is also needed to open exported `.margin` packages in another workspace. Lock the workspace from the sidebar when finished, especially on shared devices. Locking first saves edits across open tabs and refuses to discard an unfinished draft.

The original sample documents make the workspace immediately usable; they are labeled as samples. Import PDF, PNG, JPEG or an encrypted `.margin` export. For an export from another workspace, enter its original passphrase in the upload dialog. Ordinary supported files are limited to 100 MiB, 2,000 PDF pages or 24 megapixels per image.

### Optional local upload service

In another terminal, after setup:

```sh
npm run dev:api
```

Copy `MARGIN_API_TOKEN` from your private `.local/api.env` into **Settings → Encrypted server storage**. Do not commit or share that file. The browser holds this token only in memory; refreshing or locking clears it. The API binds to loopback, uses HTTPS and expires its development identity after one hour. Restart the API for another development session.

Use **Upload encrypted copy** in a document's menu. Uploads have acknowledged progress, pause/resume, digest checks and encrypted filesystem receipts. Completed files remain **quarantined** until an isolated scanner is configured; a completed transfer is not a usable cloud backup or annotation sync. Production mode is intentionally refused.

## Working capabilities

| Area            | Available now                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Library         | Search, recent files, folders, starred documents, list/grid, sorting, copy, rename, move, Trash/restore and permanent deletion                   |
| Reader          | Worker-rendered PDF, bounded thumbnails, zoom, page navigation, text search and browser read-aloud                                               |
| Annotations     | Pen, highlight, text, comments, rectangle/ellipse/line, eraser, selection, bounded undo/redo and local autosave                                  |
| PDF pages       | Rotate, duplicate, insert blank, move, delete, merge and extract                                                                                 |
| Exports         | Annotated PDF and complete comment appendix inside an authenticated encrypted `.margin` package; encrypted original and metadata-index exports   |
| Local classroom | Assignment drafts, instructions, class/due date, student submission state and teacher feedback/return                                            |
| Preferences     | Teacher/student views, light/dark/high contrast, comfortable reading font, reduced motion and keyboard shortcuts                                 |
| Security        | Passphrase-encrypted vault, in-memory keys/tokens, cross-tab lock/save handshake, HTTPS-only transfer and authenticated encrypted server storage |
| Chrome          | Minimal Manifest V3 popup and context-menu link launcher                                                                                         |

Teacher/student views are workflow preferences, not authorization roles. Local assignments do not send work to another person. Read-aloud uses available browser voices; it does not perform OCR.

All exported document files are encrypted to follow the security brief. A `.margin` package is not directly readable in a standard PDF reader; import it into Margin to view its contents. The metadata-index export is a reference file, not a whole-workspace restore archive. Original source files outside Margin are not changed or encrypted by the app.

The production web build caches the application shell and assets for offline use. Local documents can then be reopened and edited after unlocking without a network connection. Browser storage can still be cleared or evicted: keep encrypted exports and verify recovery. Development mode does not register the service worker.

## Chrome extension

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension`. The default workspace is `https://127.0.0.1:5173/`. See the [extension instructions](apps/extension/README.md).

The extension requests only `activeTab`, `contextMenus` and `storage`. It hands off an HTTPS document link for user-confirmed import. It rejects privileged URLs, plaintext HTTP and source links with credentials, query strings or fragments. CORS-restricted or signed links need a manual download/import. Native Chrome installation, managed Chrome policy testing and Chrome Web Store publication have not been performed.

## Verification

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:offline
```

Browser tests use isolated Chromium profiles and trust only their local test context. They never operate on your normal browser data. [Verification notes](docs/VERIFICATION.md) separate measured results from untested release requirements. [GitHub Actions](.github/workflows/ci.yml) runs compilation, security/integration tests, browser workflows, dependency audit and an isolated PostgreSQL schema check.

To preview the production web bundle locally:

```sh
npm run setup:dev
npm run build
npm exec -w @margin/web -- vite preview --host 127.0.0.1 --port 4173
```

Open **https://127.0.0.1:4173**. This is a separate browser origin and therefore a separate vault. The preview does not proxy the optional API. No public deployment is included.

## Repository

- `apps/web`: React/TypeScript workspace, PDF editor, encrypted vault, import/upload workers and service worker.
- `apps/api`: loopback-only HTTPS service with encrypted storage, authorization, quarantine and resumable uploads.
- `apps/extension`: dependency-free Manifest V3 launcher.
- `packages/core`: shared document, annotation, classroom and preference types.
- `infra/schema.sql`: PostgreSQL schema and fail-closed tenant/RBAC policy proposal, not yet connected to the API.
- `tests`: unit, integration and Chromium workflow tests.

Read the [architecture](docs/ARCHITECTURE.md), [local security model](docs/LOCAL_SECURITY.md), [backend security model](docs/security-backend.md) and [production readiness](docs/PRODUCTION_READINESS.md) before extending or deploying. Independent review, managed identity/KMS, malware scanning, operational backups, school privacy review and measured capacity remain necessary.
