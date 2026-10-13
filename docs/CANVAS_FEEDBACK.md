# Captured-submission feedback

Implemented and locally verified October 13, 2026. This extends the local Canvas service composition with teacher feedback. It does not deliver a Canvas submission, score, rubric, or grade.

## Workflow

An assignment's current author teacher opens a completed frozen submission through its verified resource launch. The student overlay stays read-only. General comments and a separate teacher annotation layer are saved as private feedback drafts. **Return feedback** publishes exactly the saved revision; editing afterward creates a private draft while the student continues to see the last returned revision.

The student's current assignment launch may read only its own released feedback. The returned-feedback viewer verifies the original PDF's document/version binding, byte count, and SHA-256. It shows that source and the returned teacher layer. It does not substitute the student's current mutable annotations for the captured submission's marks.

The teacher's local draft and pending command are encrypted in the workspace vault and scoped to application origin, organization, user, submission, and snapshot pin. Save and return use distinct request identifiers and an expected revision. If the response is lost, recovery checks the exact persisted request; a later revision is not evidence that the original request succeeded. Conflicting revisions preserve the local draft until the teacher chooses the saved version.

## Boundaries

- `margin_feedback.drafts`, `releases`, and `commands` contain encrypted envelopes bound to the organization, work, submission, snapshot pin, and revision or command identity. Published releases and command outcomes are immutable to runtime credentials.
- Migration 014 adds separate tables, policies, and a dedicated `margin_feedback_runtime` role. It does not add columns to the existing tables included in the v1 capture fingerprint. Existing captures retain their original authority projection.
- Every service operation checks current session, launch, author or student ownership, enrollment, installation, source, and target authority. Final transactions recheck authenticated state under authority locks. Key-provider calls run outside those final transactions.
- Feedback credentials cannot edit student annotations, captures, source documents, or processing jobs. Existing service credentials reject mixed feedback-role membership. Choosing a local teacher/student dashboard does not grant this access.
- Comments are bounded to 16,000 characters. Feedback has at most 500 annotations and 192 KiB of canonical content. The initial tool set includes text, pen, highlight, comment, rectangle, ellipse, line, and text stamps, constrained to captured page geometry.
- Audio/video feedback, rubrics, scores, comment banks, verified roster names, multiple attempts, and Canvas grade delivery remain separate requirements.

## Local configuration

The ordinary local installation remains at schema 13 until an explicit `enable-feedback` maintenance operation adds schema 14 and a dedicated private credential companion. It preserves the original configuration, credentials, encryption keys, bootstrap receipt, and captured work. The operation requires stopped API/workers, creates a private database backup, and records recoverable setup intent before applying the reviewed migration and login in one transaction.

An unpublished companion leaves feedback unavailable. Runtime composition accepts the optional dedicated feedback database configuration; it never reuses the read-only reviewer credential. Existing schema 12-to-13 upgrade and PostgreSQL certificate renewal remain separate operations.

## Verification scope

Focused tests exercise real PostgreSQL access isolation and encrypted persistence, as well as real HTTPS with synthetic identity/service fixtures. The actual in-app browser also exercised signed synthetic launches against the disposable real-service composition: student edits/capture, private teacher draft reload/save, explicit return, later private edits, returned-source verification, all eight mark types, and submission isolation. See [the manual record](MANUAL_VERIFICATION.md#captured-feedback-with-real-local-services--october-13-2026) and [optional setup](CANVAS_FEEDBACK_SETUP.md).

The initial not-ready feedback response exposed a polling recovery message defect. Initial load and later polling now share source/binding verification, with current authority checked immediately before publishing UI state. Focused regression tests cover failure followed by a successful first read. The later manual peer capture was already ready on its first feedback request, so that specific 409-to-200 timing recovery is automated evidence only.

These checks do not establish live Canvas registration or SpeedGrader behavior, production deployment, physical-device performance, or 100,000-user capacity. The student's returned view currently shows the original source and teacher marks; displaying the captured student annotation layer there remains a separate extension.
