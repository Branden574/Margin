# PDF page cropping

Open **Page options → Crop page**, or choose **Crop current page** in the command palette. Enter the amount to hide from each displayed edge, in physical PDF points (72 points = 1 inch), and inspect the live preview. **Apply crop** saves the visible page boundary and moves Margin annotations with that boundary. **Restore full page** reveals the page's complete MediaBox. Both actions support undo/redo and encrypted local persistence.

Cropping is not redaction: hidden text, images, widgets and annotations remain in the PDF and can be revealed by resetting the crop. The dialog explains this before saving. Reset previews the current view and states that additional hidden content will be revealed; it does not claim to preview those hidden areas.

The operation changes only CropBox on the selected page. Page count, original content streams, other pages, rotation, UserUnit, form widget coordinates, values and appearance streams are retained. Margin annotation coordinates shift by the exact difference between the old and new PDF.js viewport origins. They are not clamped, so hidden annotations return to their original location when the full page is restored. Any PDF byte change creates a fresh content revision and invalidates saved OCR; recognition can be run again.

Margins must be finite and nonnegative, and at least one point of width and height must remain. Supported page rotations are multiples of 90 degrees. Malformed or unsupported page geometry, restricted content modification, signed PDFs, XFA and unsafe document actions are refused through the existing editing audit. These operations do not resize or resample page content, edit original text, create forms, or remove signatures.

Parsing and encoding run in a short-lived worker with a 60-second deadline. The editor bounds the overall operation to 90 seconds and propagates cancellation to the worker and encrypted storage. PDF bytes, annotation positions and the new revision commit atomically; a stale content revision cannot overwrite a newer document. On an uncertain save outcome, the editor waits for the save to settle, clears incompatible undo history and reopens the durable state before allowing more edits. If it cannot read that state, editing stays paused until the document is reopened. No cloud service receives the PDF.

## Verification boundaries

- Core tests parse real PDFs with PDF.js at all four rotations, nonzero/inherited/reversed page boxes and UserUnit values. Bitmap crops match expected pixels, and source vector streams remain unchanged. Widget values/rectangles/appearance streams survive and remain fillable.
- Worker and encrypted storage tests cover invalid inputs, failure, time limits, cancellation during encryption and active IndexedDB writes, stale revisions, cross-tab commit races and negative annotation coordinates.
- The [manual record](MANUAL_VERIFICATION.md#crop-and-restore-walkthrough--october-5-2026) covers the actual in-app preview, validation, form retention, annotation alignment, undo/redo, reload, reset, dirty cancellation, keyboard focus and a confirmed 375×812 viewport.
- Remote browser tests cover encrypted download/reimport, form retention, accessibility and responsive layout. Their results must be tied to the exact tested commit; the in-app browser's encrypted file delivery remains separately unverified.

This feature does not establish production hosting, real Canvas interoperability or performance for 100,000 users.
