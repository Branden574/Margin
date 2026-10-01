# Margin Chrome extension

This is a lightweight Manifest V3 launcher. It opens your Margin workspace and hands off a user-selected HTTPS document link using `?source=`. It does not process PDFs, read page DOM, intercept downloads, authenticate users, or claim Google/LMS integration.

## Install locally

1. Run `npm run setup:dev`, then start the HTTPS web app with `npm run dev` from the repository root.
2. Open `https://127.0.0.1:5173/` and complete the local certificate trust setup described in the root README. The extension does not bypass browser certificate verification.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension`.
4. Pin Margin. The default workspace is `https://127.0.0.1:5173/`.
5. On a direct HTTPS PDF/image URL, click the extension action or right-click the link and choose **Open document link in Margin**. Unlock your local vault and confirm the import. Links blocked by CORS may require downloading and importing the file yourself.

Set a different workspace in the popup's **Workspace settings**. Every workspace and source link must use HTTPS, including loopback hosts. Plaintext HTTP is rejected. Changing the setting selects which workspace receives future links.

## Permission boundary

- `activeTab`: reads the active tab URL only after the user opens the action; no persistent website access.
- `contextMenus`: adds the explicit document action.
- `storage`: stores the workspace URL and transient error status; no document bytes or authentication tokens.
- No `host_permissions`, content scripts, remote scripts, web-accessible resources, `tabs` permission, or background PDF engine.

URLs with credentials, query strings, or fragments are deliberately rejected to avoid moving signed URLs or embedded access tokens into another site's URL/history. Download those documents and import them directly. Browser-internal and local-file URLs are rejected. Margin receives only the selected ordinary HTTPS URL, not page content.

`npm run build -w @margin/extension` validates packaging and the permission surface. Automated tests cover URL validation. Real Chrome installation, service worker suspension/restart, school-managed policy behavior and Chrome Web Store review remain manual release gates.

The extension never receives your vault passphrase or server token. Document encryption, quarantine and API authorization live in the workspace/backend; see [the security boundary](../../docs/security-backend.md).
