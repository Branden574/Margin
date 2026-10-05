# Local page recognition

Margin recognizes printed English on one PDF page at a time. Imported PNG/JPEG files already become PDF pages, so the same workflow covers them. Pages with fewer than 24 non-whitespace text characters offer recognition automatically; the reading panel also exposes an explicit recognition action.

The original PDF bytes and appearance remain unchanged. Recognition produces an encrypted companion record containing canonical text, word offsets, confidence and PDF-space quadrilaterals. Reading, copy, document search and the selectable overlay consume that same text. Selected words become ordinary editable highlight annotations. The panel labels recognized text and asks users to check the original because recognition can make mistakes.

## Execution and privacy

- Pinned Tesseract.js 7.0.0, core 7.0.0 and English data 1.0.0 run in a dedicated same-origin worker. No page pixels or text are uploaded; no runtime CDN is used.
- First explicit recognition downloads and verifies a roughly 23.4 MB public engine/model pack. The language file is an actual gzip file, served without HTTP `Content-Encoding`, preserving its digest and the engine's decompression contract.
- The worker response permits WebAssembly compilation and same-origin fetches. It cannot create child workers or fetch other origins. The preview document retains its existing `script-src 'self'`; general `unsafe-eval` is not added.
- PDF.js rasterization targets 200 DPI, capped at four million pixels and 4,096 pixels per side. PNG dimensions are independently checked before worker allocation. Rasters remain transient and are not stored in Cache Storage, IndexedDB or logs.
- One recognition engine job runs per tab. Initialization and recognition can be terminated immediately; a 90-second engine deadline and 180-second overall workflow deadline bound work. Page preparation has its own 30-second deadline. Cancellation, page changes, PDF replacement, navigation and vault locking discard abandoned results.
- Canonical output is limited to 200,000 UTF-16 characters and 20,000 words. Invalid or partial word hierarchies, malformed Unicode, invalid confidence/coordinates and oversized records fail without replacing saved OCR. Empty recognition is reported without storing a result.

PDF copy/accessibility extraction permissions are checked before recognition and before exposing stored text. Ordinary copy restrictions remain enforced in the UI; recognized highlights also require annotation permission. These UI controls are not DRM against privileged access to an unlocked browser.

## Revisions and recovery

Every PDF byte write atomically assigns a new content revision and removes old OCR. Metadata and annotation changes preserve that revision. Initial editor loading reads the blob and revision from one vault transaction; legacy documents receive a revision there. The save transaction accepts OCR only for an existing matching document revision. Deletion removes OCR atomically. Cancellation aborts queued or active OCR writes. Undoing a PDF-byte edit conservatively requires recognizing the page again.

The production service worker caches only the public pack after a user starts recognition. A readiness marker is written only after all allowlisted assets pass size and SHA-256 checks. Partial, corrupted or cancelled packs are not reported ready. A development preview without a controlling service worker explicitly says that its local server is still needed. Browser storage eviction can remove an offline pack; local encryption does not provide a backup.

## Searchable encrypted export

Export includes saved OCR for the current content revision as an invisible Unicode PDF text layer, inside the normal encrypted `.margin` package. Importing that package in another unlocked workspace produces ordinary native PDF text for reading, copying and search; it does not require transferring OCR companion records or running recognition again. Export does not rewrite the original stored PDF.

The export worker uses a pinned, bundled Noto Sans font and checks its byte count and SHA-256 digest before embedding a subset. The production shell caches that font for offline use. No document text goes to a font service. OCR text export requires both PDF copying and content-modification permissions. Existing native text takes precedence where it overlaps recognition, while scanned text elsewhere on a mixed page is retained. Unsupported glyphs, uncertain native overlap, unsupported geometry and inconsistent OCR records produce an explicit error rather than a partial export.

Limits are 100 recognized pages, 100,000 words and 1,000,000 UTF-16 characters per export, with the existing per-page limits still applied. Selected-page export includes only that page's recognition. PDF encoding runs in a short-lived worker with a 60-second deadline; the editor gives the complete export a 120-second deadline. Vault locking, navigation cancellation, or changed PDF revisions prevent delivery of an abandoned result. Paragraph spacing remains PDF-reader-inferred; this is not a tagged accessibility PDF.

## Evidence and remaining limits

Manual Codex-browser checks on October 5, 2026 used a synthetic three-page PDF: an image-only page, a blank page, and a cropped page with 180-degree PDF rotation and upright image content. Recognition, exact clipboard text, native local-voice playback/pause with word tracking, keyboard word/full-page selection, highlight geometry, two-page search, reload/unlock recovery, cancellation, blank-page reporting and byte-edit/undo invalidation were exercised. No personal document was used.

Unit coverage includes a real installed Tesseract worker recognizing generated PNG text, cancellation/timeout/stale-worker handling, geometry at four rotations and nonzero crop origins, bounded text resolution, encrypted persistence and commit races. Asset tests inspect real HTTPS development and preview response bytes/CSP, integrity failures and a simulated offline service worker. Remote browser results are recorded separately when that run completes; simulated service-worker checks alone do not prove browser offline operation.

This does not implement translation, batch OCR, other language packs, handwritten-text guarantees or equations/tables reconstruction. PDF export tests reparse actual Unicode text and geometry and compare rendered pixels, including cropped and rotated pages. Exact commit `dda7c39` passed [CI run 37334999077](https://github.com/Branden574/Margin/actions/runs/37334999077): 24 Chromium workflows with no retries, including actual encrypted download and reimport into a separate vault with native text on two pages and no OCR companion records. The production offline run also exported and reimported under the deployed-build CSP, using the cached font without external requests or application errors. The in-app preview prepares the encrypted export, but its actual download delivery remains unverified. Recognition accuracy across diverse documents, physical mobile/low-memory devices, assistive technologies and large concurrent deployments is unqualified. This work does not establish hosted or 100,000-user readiness.
