# Reading tools

The local PDF editor provides a reading panel with play, pause/resume, stop, voice selection and six speeds from 0.5× to 2×. It also offers reflowed page text, text sizing, focus mode, four optional color overlays and a keyboard-adjustable reading ruler on the PDF. These appearance choices stay in the current editor session and do not change the saved PDF or annotations.

## Speech and privacy

`useReadAloud` owns a `ReadingController` while the panel is open. It uses only enumerated voices whose browser-provided `localService` value is `true`, assigning that exact voice before each utterance. Missing or removed local voices stop playback with an explanation. There is no fallback to a remote voice, no application speech API, and no storage or logging of extracted text or voice preferences. The browser and operating system remain the trust boundary for the local-service declaration; this is not an independent network audit of an installed voice.

Speech progress comes from native speech events. Sentence tracking follows the current utterance or a reported boundary; word tracking requires actual word-boundary events from the chosen voice. The browser's character position is approximate. Voices without word events cannot provide synchronized word tracking. Changing voice or speed during playback restarts the current sentence; changing either while paused waits for Resume.

The controller holds one utterance at a time, uses bounded chunks and preserves the original UTF-16 offsets. It prevents PDF text from being interpreted as SSML by substituting full-width angle brackets in speech-only strings. Displayed and copied page text remains unchanged. Page/document/revision changes, panel closure, editor exit and workspace lock cancel the current reader. Cancellation invalidates queued callbacks. A startup/resume deadline reports a stalled speech engine rather than inventing playback progress.

This implements selectable PDF text reading. OCR, translation, dictionary lookup, speech recognition, audio-file export and legally licensed speech redistribution are not provided by this panel. Text order follows the PDF's extraction order and may differ from its visual layout.

Reference: [Web Speech API specification](https://webaudio.github.io/web-speech-api/) defines voice locality, pause/resume/cancel semantics and the approximate character offsets used by boundary events.

## Text extraction and permissions

`readPageText` streams text from PDF.js, with a 20-second deadline, at most 200,000 UTF-16 units and 20,000 fragments per page, and bounded producer chunks. It checks limits before retaining another fragment and refuses the whole result on a limit or error. It never silently truncates a page. Cancellation interrupts abandoned streams; loading, empty, restricted and failed extraction are separate states.

A PDF with unrestricted permissions or COPY allows reading and the Copy text button. COPY_FOR_ACCESSIBILITY alone permits reading with Copy text disabled and native copy/cut events suppressed in the reading region. If neither permission is present, extraction is refused. These are viewer behavior controls, not cryptographic DRM or protection against a browser developer tool. The original PDF and its owner-defined flags remain authoritative.

`usePageText` binds results to PDF identity and page index. `usePdf` also binds its returned proxy to Blob identity, so a replaced revision cannot expose an old page before effect cleanup. Document search uses the same bounded extractor and checks its cancellation generation after awaited extraction before publishing snippets.

## Accessibility and verification boundaries

The panel labels every control, returns keyboard focus to Read aloud when closed, and announces playback status/errors without announcing every word. Follow spoken text can be turned off. Focus mode hides annotation controls and disables drawing interaction; Escape or Exit focus mode restores the editing view. The ruler and tints are visual overlays with no pointer events and are hidden from assistive technology. Text size changes reflowed text without altering PDF coordinates. The comfortable reading font and existing theme preferences apply to the panel.

Controller tests use a deterministic injected engine; they verify lifecycle, stale callbacks, settings, range integrity and failure behavior rather than actual sound output. Extraction tests use bounded synthetic producers. Browser workflow and manual results are recorded separately in [verification](VERIFICATION.md) and [manual verification](MANUAL_VERIFICATION.md). Neither these checks nor an available voice establish audible quality, native screen-reader usability or WCAG certification across supported devices.
