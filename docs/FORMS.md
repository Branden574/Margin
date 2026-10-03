# Existing PDF form filling

Margin can inspect and fill a supported subset of existing AcroForm fields. In the document editor, **Fill form** opens a staged dialog. The original document stays unchanged until **Save form changes** succeeds. The PDF parser, inspection, field updates and encoding run in a short-lived worker with a 60-second deadline; they do not execute on the UI thread.

## Supported behavior

- Single-line and multiline text, checkboxes, radio choices, dropdowns and single/multiple-selection lists.
- Existing values, labels, read-only flags, required fields, text length limits, valid options and radio no-clear behavior are checked before applying changes.
- All changed fields save together through `replaceDocumentWithAnnotations`, the existing encrypted IndexedDB transaction that stores the PDF revision, document metadata and the annotation snapshot. An editor history entry restores the entire prior form revision in one undo; redo restores the filled revision.
- Unchanged fields retain their original appearance streams. Only changed fields receive regenerated appearances. Changed text keeps its previous font size when it fits; otherwise the editor checks every wrapped and explicit line and shrinks the size down to a 6-point minimum. Answers that still cannot fit remain as drafts with an error. The form is not flattened and values remain fillable in supported PDF readers.
- Pending edits block route changes and vault locking. Closing the form or pressing Escape with changes requires an explicit discard choice. Validation errors keep the dialog and draft values open. A browser reload warns about pending changes; the unsaved draft is memory-only and does not survive a forced reload or crash.
- Filled PDF bytes remain encrypted at rest and travel inside the existing encrypted `.margin` export. Reopening the package requires the matching vault passphrase.
- Rotation and blank-page insertion preserve existing widget references and values. Copying, reordering, deleting, merging and extracting form pages fail with a visible explanation until widget-tree preservation for these operations is implemented and verified.

## Explicit limits

The current form editor accepts up to 100 fields, 200 choices per field, 16,000 characters per text field (or the PDF's smaller limit), 100 MB PDFs and bounded object/field trees. It rejects malformed/cyclic/duplicate field trees, invalid widget/page bindings, unknown field types or behavior flags and unsupported name escapes before calling pdf-lib's high-level form API. That API otherwise silently drops XFA data or unknown fields.

Signed/certified PDFs, XFA, scripts, automatic actions and interactive PDF actions are rejected for editing/export rather than rewritten. This conservative check also holds documents with ordinary action-based links unchanged. It is not a malware scanner or a digital-signature verifier.

Unsupported form features include new field creation, PDF signature fields, push buttons, rich-text/password/file-selection fields, editable or multi-selection dropdowns, and choice fields whose display label differs from their stored export value. Read-only fields remain visible but cannot be changed.

Changed text and choice appearances currently use the embedded standard Helvetica font. Characters outside its supported encoding cause an explicit error and retain the draft. Existing untouched Unicode fields and appearance streams remain unchanged; Unicode font embedding for new field values is not implemented. Existing font styling on changed fields may be replaced by the supported appearance provider.

The form editor saves locally; it does not submit to Canvas or other remote endpoints. Required-field checks here are local validation, not a claim of legal form completion or an institutional submission receipt.

## Verification

`tests/editor-forms.test.ts` covers field round trips, constrained values, unchanged appearances, Unicode refusal/preservation, required/read-only behavior, inherited/malformed text limits, inconsistent checkbox/radio appearance states, multiline fitting without clipping, optional clearing, widget-preserving rotation/insertion, blocked page operations, XFA/signatures/scripts and lowercase escaped names in compressed dictionaries, malformed field trees/options, encrypted storage/relock, annotation preservation, undo snapshot restoration and decrypted export contents.

Focused verification on October 2, 2026: 62 tests passed across forms, PDF structural operations, annotation export and storage; the web TypeScript check passed. This is automated Node verification. Manual in-app browser testing and additional PDF-reader interoperability checks are recorded separately by the root task and are not claimed by this document.
