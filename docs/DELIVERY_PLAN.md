# Delivery plan for the full Margin brief

The intended outcome remains the complete original product brief and security addendum. The present encrypted local foundation is a starting point, not a substitute for the cloud, collaboration, education, administration and security work. [The requirements matrix](REQUIREMENTS_MATRIX.md) maps each source section to current code, separate automated/manual evidence and unresolved gates.

This plan is ordered by dependencies and risk. It does not supply invented dates, throughput claims or completed checkboxes. Work that can be implemented and tested locally should continue while external provisioning is arranged; missing cloud credentials do not prevent editor work, protocol design, fixtures or infrastructure code. External credentials and legal decisions must not be simulated and presented as real integrations.

## Delivery invariants

- Keep current documents, URLs and encrypted data readable across migrations. Add versioned migrations and recovery tests before changing formats; never silently reset a vault.
- Keep the extension small. PDF/OCR/conversion work belongs in browser workers or isolated backend jobs, never an unrestricted content script or normal API request handler.
- New annotation behavior must have rendering, persistence, undo/redo, export and accessibility semantics together. A toolbar button is not a feature by itself.
- A local save, server receipt, scan approval, synchronized annotation and durable backup are different acknowledgments. UI wording must reflect the actual state.
- Enforce identity and policy server-side for every operation, job, realtime room and object grant. UI role selection is not authorization.
- Encrypt each sensitive artifact and apply tenant-aware key, retention and deletion policies. Use standard cryptographic libraries and managed key services; independently review envelope/package protocols.
- Keep unsafe server uploads quarantined until actual trusted inspection approves release. Do not use test scanner stubs in the application or relabel local browser imports as scanned.
- Preserve user work during errors and transitions; make failed saves retryable and visible. Document the remaining crash-before-commit boundary until recovery checkpoints address it.
- Record automated, actual browser, native extension, physical-device, staging and independent-review evidence separately. Each change has a concrete acceptance gate before it is described as complete.

## P0 — Make the existing application accessible and reviewable

**Scope:** B-V1, B-P2, B10, B28, S33.01; current local workflows.

Verify the exact HTTPS origin in the user's actual browser with ordinary certificate verification, not a test-only exception. Keep one origin throughout the walkthrough because hostnames/ports identify different local vaults. The user enters their own passphrase; preserve their documents and use disposable test copies for destructive checks. Record actual visible passes/failures in [manual verification](MANUAL_VERIFICATION.md), leaving automated checks in [verification](VERIFICATION.md).

Complete the manual route checklist below and fix observed failures. Confirm direct document routes, Back/Forward, draft/save guards, mobile navigation and error recovery. Make local-versus-cloud boundaries visible where the user chooses uploads, assignments, export or integration setup. Do not invent cloud states to make the interface appear complete.

**Exit evidence:** actual browser access and end-to-end import/edit/save/reload/export/reimport; remaining implemented routes exercised with recorded failures resolved or explicitly tracked. This is a local usability milestone, not production release.

## P1 — Establish identity, authorization and durable platform boundaries

**Scope:** B1, B9, B21–B24, S33.02–05, S33.09–16, S33.18, S33.20–25, S33.31.

Implement a modular API with separate repositories, authorization, storage, key management and job interfaces. Integrate PostgreSQL through versioned migrations and least-privilege runtime roles. Extend the current schema proposal with actual sharing/class/assignment grants, policy hierarchy and tenant-safe constraints. Carry trusted identity into transactions and test pool reuse/context reset; SQL session variables must not authenticate a caller.

The configurable OIDC/BFF and PostgreSQL identity foundation now exists with signed-token, session, authorization and runtime configuration tests; see [identity contract](IDENTITY.md). It has no real IdP configuration or completed provider walkthrough. Integrate a production identity provider for Google/Microsoft OAuth and OIDC, with a SAML strategy for schools. Implement secure sessions, rotation, protected refresh credentials, expiry, revocation, active-device management and MFA/step-up for privileged roles. If cookies are used, include CSRF defenses and secure cookie policy. Replace the local UI role preference with separately enforced server roles; retain an honest local mode while cloud enrollment is optional.

Bind cached data and encryption keys to authenticated identities and an explicit offline policy. Design account switching, logout, forced revocation, shared-device locking, cache clearing and maximum offline retention together. Decide and document the threat model for local key recovery and whether any feature claims end-to-end encryption. Do not imply server OCR/AI can inspect content while simultaneously claiming the server can never decrypt it.

Provision private object storage, managed KMS, secret management and private networking with infrastructure as code. Implement envelope-key wrapping/rotation/rewrapping and a future customer-managed-key contract. Separate environment identities/secrets. Add durable restricted audit storage, initial encrypted backup jobs and account/document deletion foundations.

**Exit evidence:** isolated staging deployment with real IdP/KMS/DB/object store; authenticated identity and role matrix; same-tenant peer/cross-tenant/expired/revoked access denial; safe migrations; key rotation and recovery tests; no publicly accessible data store. Production release remains closed.

## P2 — Complete the document editor and accessibility foundation

**Scope:** B2, B5–B6, B10–B13, B14.3, B19–B20 local behavior, B29.

This track can proceed while platform provisioning is pending. Consolidate reusable accessible controls without rewriting functioning workflows. Add measured render and memory budgets, worker cancellation/timeouts, range/progressive remote loading when available, and image-heavy/annotation-heavy fixtures. Assess SharedWorker or WASM only when measurements justify them. Retain independent annotation storage and bounded canvases.

Deliver missing editor capabilities in coherent increments:

1. **Drawing and selection:** pencil/marker semantics, pressure-sensitive rendering, smoothing, snap, resize/rotate handles and broader keyboard equivalents. Arrows, solid/dashed/dotted line styles, center insertion and keyboard movement are now implemented locally. Add explicit text-box/sticky-note models and tool preference/pinning.
2. **Reusable content:** annotation bank, custom stamps/symbols, image placement, links and equations. Validate imported assets/URLs and include undo/export behavior. Typed/drawn visual signatures and three preset feedback stamps are now implemented locally with persistence/undo/export; cryptographic document signatures remain separate future work.
3. **Page management:** range selection/reorder/extract/split, crop/resize and inserted document/image pages. Preserve annotation coordinates through transforms and expose encrypted batch exports.
4. **Content and forms:** select an appropriately licensed engine for existing PDF text editing/replacement, forms and any cryptographic signatures. Define supported PDF/form types and failure behavior rather than silently flattening unsupported content.
5. **Reading/accessibility:** UI text scaling/reflow, reading ruler/focus mode/color overlays, dictionary, richer speech controls (pause/resume/voices/word/sentence tracking), speech-to-text and accessible annotation authoring. Browser speech availability is not guaranteed offline audio support.
6. **Export:** preserve required encryption for every exported format; add interoperable encrypted format choices where feasible, editable annotation interchange and font coverage that avoids unnecessary Unicode rasterization. Keep original export and annotated export clearly distinct.

**Exit evidence per increment:** operation/model tests, persistence/undo/export round trips, actual keyboard/touch/stylus use, screen-reader alternatives, known unsupported format behavior and measured performance on a representative corpus. “Full PDF editing” is not complete merely because page operations pass.

## P3 — Build the production upload and isolated processing pipeline

**Scope:** B3, B21, B25, B27–B28, S33.04, S33.06–08, S33.18, S33.21–24.

Move upload receipts, reservations and finalization to transactional/shared storage. Implement private multipart object uploads with narrowly scoped expiring grants, bounded chunk concurrency, checksums, idempotent finalization, retry jitter, refresh/crash continuation and credential-safe automatic reconnect. Define deduplication within authorized scopes so checksum discovery does not reveal another tenant's files. Reconcile cancelled, expired and abandoned sessions with scheduled cleanup and quota release.

Introduce a durable queue plus transactional outbox. Store explicit upload/verification/scanning/processing/ready/quarantined states with versioned scan decisions. Workers must have process/container CPU, memory, wall-time, decompression/page/complexity limits, restricted temporary storage, no unnecessary egress and scoped object credentials. A JavaScript timeout alone is not a sandbox. Clean temporary plaintext and derived artifacts on success, failure and termination.

Connect actual structural validation and malware scanning. Keep quarantine closed on missing scanner, timeout, corrupt output or policy failure. Add progress/cancel/retry APIs and correlation IDs from browser through receipts/jobs/output. Allow early interaction only with a defined inspection and partial-content policy; do not bypass the security boundary to claim faster loading.

**Exit evidence:** real object-store and scanner integration; malformed/bomb/pathological corpus contained within limits; process termination cleanup; storage/queue outages and retry/replay; refresh/reconnect upload continuity; shared quota correctness; ready/quarantine access enforcement. Initial 100-concurrent-upload staging test precedes increasing load.

## P4 — Add OCR, conversion and rich document inputs

**Scope:** B4, B6.3–B6.5, B7, B13.3–B13.4, S33.02/S33.06–08.

Implement automatic no-useful-text detection and an accessible OCR offer. Run OCR asynchronously through the isolated job boundary, preserve original appearance, store encrypted text/layout/confidence data and make results selectable/searchable/copyable/highlightable/readable. Add language selection, rotation/layout handling, cancellation and failure recovery. Translation is a separate policy-controlled processor.

Add DOCX/PPTX and practical XLSX conversion with explicit fidelity and licensing boundaries, plus wider image formats. Google documents use authorized export APIs in P7. Converters and OCR workers must reuse encryption, quotas, scanning and retention controls for every output/thumbnail/temp artifact. Audio/video annotations require size/format controls, captions/transcripts where appropriate and encrypted media lifecycle management.

**Exit evidence:** representative classroom/document corpus with visual and semantic comparisons; clean async UI; OCR text accuracy/fidelity measures with limitations; resource containment; encrypted output and deletion coverage. Licenses/provider credentials must be real before claiming format or integration support.

## P5 — Implement collaboration, offline synchronization and durable history

**Scope:** B5.6, B8–B9, B19–B20, B29.2, S33.05/S33.10/S33.19/S33.23.

Choose and document a CRDT or other deterministic conflict strategy after identifying semantics for strokes/text/comments/page transforms/deletes. Define stable operation IDs, authenticated actor IDs, document revisions, causal dependencies, schema validation and size/rate limits. Page transformations must not silently invalidate concurrent annotation coordinates.

Implement a durable local outbox, authenticated document-scoped realtime rooms, server ACK/replay cursors, missed-message recovery, idempotence and revocation. Presence/cursors/selections are ephemeral and must expire independently of durable annotations. Permit room subscription only after current document grants are checked; enforce policy again for each accepted operation and after permission changes.

Add comment replies/visibility, local/remote save indicators, reconnect/sync states and explicit conflict/recovery UX. Persist snapshots/checkpoints and operation compaction for version listing, attribution, restore and deleted-annotation recovery without duplicating a complete PDF for every mark. Implement private/specific-person/class/org/link sharing with expiry and policy controls.

**Exit evidence:** multiple independently authenticated clients; concurrent edit convergence; offline edits and reconnect replay; duplicate/missed/out-of-order messages; revoked-room denial; crash recovery; version restore under concurrent changes; explicit bounded recovery limits. Local Web Locks do not satisfy this phase.

## P6 — Deliver classroom workflows and school administration

**Scope:** B12, B14–B16, B24, S33.05/S33.09–15/S33.23–25/S33.27.

Replace local assignment simulation with server-managed classes, enrolled students, per-student document/submission records, teacher review and delivery of feedback. Support templates/reuse, due dates, submission monitoring, annotate/review/return cycles and simplified student views. Enforce editing locks/time limits, teacher-only/student-visible layers, answer masking, private comments and rubrics in the operation/API layer, not only in controls.

Build administrator user/teacher/student/group/school/district/license management; SSO/integration configuration; audit/reporting; hierarchical feature/security policy by district/school/class/group/user. Include effective-policy explanations, shortcut assessment policy, external-sharing and offline-cache controls, AI restrictions, forced session revocation and MFA requirements.

Create reusable annotation/feedback banks with ownership and intentional sharing. Design narrowly scoped, expiring, authorized support access with an audit trail; no permanent universal customer-document access. Implement account/organization deletion and retention/legal-hold workflows with clear logical/physical stages.

**Exit evidence:** separate student/teacher/admin identities complete actual delivery/submission/feedback flows; privilege escalation and student-to-student/teacher-only/district routes fail securely; policy inheritance and override tests; shared-device manual testing; teacher/student usability study. A local role dropdown cannot satisfy this gate.

## P7 — Connect cloud drives, LMS providers and extension identity handoff

**Scope:** B1.3, B4.2–B4.3, B16 integrations, S33.11/S33.17/S33.23.

Define provider adapters for discovery/import/export/assignment delivery/revocation and tested token handling. Implement Google Drive/Classroom and Microsoft OneDrive/Teams first where authorized test tenants exist, then Canvas, Schoology, Dropbox and Box. Support Google Docs/Slides/Sheets export semantics. Store refresh credentials server-side under managed secrets/encryption and restrict scopes/payloads; handle expiring consent, token revocation, provider limits, webhooks and idempotency.

Extend the MV3 launcher only when a verified workflow needs it. Implement authenticated application handoff and validated origin/message contracts without exposing tokens in URLs, page DOM or persistent extension storage. Use content scripts only for narrowly justified detection/integration and treat all page content as hostile.

**Exit evidence per provider:** registered OAuth application, correct consent/redirects, sandbox tenant workflow, expiry/revocation tests, policy-enforced import/share, real Chrome install and extension-worker suspension/restart behavior. Listing a provider logo or adapter interface is not integration completion.

## P8 — Add privacy-conscious administration analytics, observability and optional AI

**Scope:** B17–B18, B25, S33.14–15/S33.22/S33.25–28/S33.32.

Create a minimal event taxonomy and retention policy before collecting production events. Instrument upload/chunk/job/render/save/sync/reconnect failures and latency, memory pressure, queue depth and connection counts. Build aggregated DAU/WAU, document/assignment/annotation/OCR/storage/integration/error reporting with appropriate roles. Do not infer invasive student attention or behavior measures from available telemetry. Add support correlation views with content/credential redaction, restricted append-only audit storage and suspicious-activity alerts.

Implement optional AI through a policy-enforcing provider boundary. Add selected-passage explanation/definition/translation, summaries, quizzes/study guides, teacher questions/rubrics/worksheets and accessibility assistance in deliberate increments. Minimize text/metadata sent, label generated content, enforce student/org/provider controls and keep document workflows usable with AI fully disabled or unavailable. Record provider retention/training contracts and consent requirements. Test prompt injection and document-origin instructions as untrusted content.

Create incident-response ownership/runbooks for detection, containment, credential revocation, investigation, audit preservation, recovery and customer/legal notification.

**Exit evidence:** validated redaction, authorized aggregate dashboards, alert/response drills; AI policy denial cases and explicit user-visible transmission/provenance; provider failure cannot block core work; reviewed third-party data processing terms.

## P9 — Harden distribution and the software supply chain

**Scope:** B1 extension, B23, B31, S33.16–17/S33.29–30.

Extend current pinned dependencies/actions, lockfile, SBOM, dependency updates and CI checks with SAST, secret scanning, container scanning and DAST against staging. Protect release environments and deployment credentials, require review for production promotion, produce provenance/signatures where practical and retain build evidence tied to the commit. Publish extension artifacts only through trusted pipelines and complete native Chrome/Web Store/managed deployment review.

**Exit evidence:** trusted reproducible builds, retained SBOM/security results, reviewed release/promotion and rollback, native extension permission/message review, real installation/update tests. CI configuration is not evidence that a particular remote run passed.

## P10 — Prove reliability, safety, accessibility and release readiness

**Scope:** B-V/B2/B13/B24/B26–B27/B30 and remaining S33 production gates.

Build a representative workload model in documents/bytes/operations/concurrency, not registered-user count alone. Exercise 100 and 1,000 simultaneous uploads and 10,000 connected users only after the relevant services exist. Test image-heavy/500-page PDFs, thousands of annotations, many collaborators, long sessions, network degradation, browser crash/power loss, expired identity, object-store failure, worker death and reconnect storms. Run on inexpensive ChromeOS hardware and school-like networks as well as developer machines.

Define SLO denominators/windows and measure the requested targets: 99.95%+ core availability, 99.9%+ supported upload success and crash-free sessions, ~100ms common UI responses, ~50ms annotation visual feedback and ~300ms ordinary API p95 where feasible. These are targets until sustained measurements support them. Establish capacity/cost limits and rollback criteria.

Complete manual keyboard/screen-reader/touch/zoom/reflow/contrast/voice and classroom usability evaluation against WCAG2.2AA. Commission independent penetration testing of auth, tenant isolation/IDOR, files, extension, realtime, keys and internal support privileges. Repair findings and retest. Define RPO/RTO, restore remote encrypted backups with separately controlled keys and time a disaster-recovery drill. Exercise incident response.

Obtain privacy/security counsel review for FERPA/COPPA, applicable state/international laws, district contracts, age/consent, data processing/subprocessors, residency, retention/deletion/backups and notifications. Technical tests cannot certify legal compliance.

**Release gate:** every required matrix row has linked implementation and applicable evidence; remaining limitations are deliberate, approved scope decisions rather than silent omissions. No unresolved critical/high security issue, data-loss defect, or false save/quarantine state. Production claims are limited to measured and reviewed facts.

## PM — Build the original scrollytelling marketing site in parallel

The additive marketing brief has its own deliverable: Next.js, React, TypeScript, Tailwind and Framer Motion, with GSAP only for a demonstrated need. Keep the site separate from the Vite editor/runtime. Use reusable product-window, upload/save/status, toolbar, comparison, security and narrative-scene components plus centralized tokens. Prefer static/server-rendered content, limited interactive islands, optimized local assets, and lazy/offscreen animation control. Preserve a complete reduced-motion and mobile story with semantic text, keyboard operation, focus and contrast.

Cover the supplied hero, speed/upload interruption, annotation, toolbar, large-document, save recovery, collaboration, offline, OCR, accessibility, teacher/admin, security, comparison, benchmark, Chromebook, command, generic before/after, trust, testimonial, final-platform and CTA sections. Design for students, teachers, schools, district IT, accessibility teams and general document users. Navigation and CTA destinations must actually exist; an unpacked development extension is not an available Chrome Store product. Demo request forms must not claim delivery without a configured destination.

Use the requirements matrix as the product-truth source. Label unfinished features and illustrative simulations conspicuously. Do not portray mocked presence, synchronized grades, automatic crash recovery or OCR as live capability. Do not fabricate benchmark numbers, customer testimonials, certifications or competitor deficiencies. Establish a dated primary-source record per comparison claim and qualify plan/deployment differences. Unknown competitor features remain unverified; Margin planned capabilities say Coming soon. Hide benchmark numbers until reproducible hardware/browser/network/document/method/date evidence exists. Add metadata/SEO for the requested document-workspace terms without claiming absent capabilities.

**Exit evidence:** built site with all required narrative sections and working destinations, actual desktop/mobile/reduced-motion walkthrough, accessibility checks, measured LCP/INP/CLS/bundle budgets and a complete claims/source review. The site can describe future product plans without declaring the full application complete.

## PC — Deliver Canvas through bounded, standards-based milestones

The current [Canvas foundation](CANVAS.md) implements normalized launch verification, durable identity/course/resource bindings, inspected immutable sources, encrypted teacher masters, signed Deep Linking returns and private student provisioning. The `/canvas/work` browser route provides restricted editing, encrypted persistence and explicit synchronization; `/canvas/author` provides source discovery, encrypted drafts, exact creation retries and native selection return. The explicit composition factory and synthetic PostgreSQL/HTTPS/browser evidence are tracked in [verification](VERIFICATION.md). Default live-provider composition remains unconfigured. Immutable submission capture and internal encrypted annotation materialization are implemented behind explicit composition. Delivery, teacher review, grades/rosters, full author settings, production operations and real institution verification remain unfinished.

The [submission and read-only review contract](CANVAS_SUBMISSIONS_PLAN.md) distinguishes implemented capture, cross-tab preparation/recovery and internal materialization from planned provider context, delivery receipts and teacher review. Public status remains processing; internal materialization cannot confirm Canvas submission. Hosted scheduling, terminal processing failure/requeue and abandoned-chunk retention are still required.

The Canvas brief adds a full integration; it does not replace the application or security objectives. Follow current official Instructure and 1EdTech documentation before defining any endpoint, claim, scope or supported workflow. Track source/date in `docs/CANVAS.md`. Do not scatter Canvas IDs or responses throughout the editor: add generic LMS interfaces and installation-scoped adapters.

1. **Launch foundation:** typed provider/launch models; registered issuer/client/deployment/organization mapping; OIDC initiation; cryptographic JWT checks for issuer/audience/authorized party/signature/nonce/state/timestamps/message/version/target; atomic expiring replay repository contract; safe course/role context. Use actual signed JWT fixtures. Server-side session mapping comes only after verification. Production/beta/test endpoints differ; do not derive hosted issuer/JWKS from an institution hostname. A cross-site `form_post` cannot blindly depend on a SameSite=Lax BFF cookie. Use an explicitly supported top-level flow until platform storage or another standards-compliant browser binding is implemented; never skip state/nonce to make an iframe work.
2. **Student work:** durable installation/user/course/assignment mappings, idempotent per-student copy-on-write provisioning, server-confirmed autosave, submission preconditions and durable idempotent receipts/retry. Keep local-save and confirmed Canvas-submission states distinct. Canvas downtime must not block annotation.
3. **Teacher creation/review:** real Deep Linking resource selection/response, assignment policies, teacher review/student navigation, separate student/feedback layers and attempt history. No hand-copied launch URLs or frontend-controlled permission grants.
4. **Grade/roster/state:** verified AGS and NRPS clients with documented least scopes and authorized endpoint allowlists; server credential custody; idempotent grades and observed confirmation; sections/dates/timezones/late/resubmission rules from authoritative Canvas context. Investigate rubric limitations and make internal-only rubrics clear.
5. **Administration/operations:** integration install/test/disconnect UI, durable LMS sync jobs/outbox/dead-letter handling, scoped API/file import/export, documented event/webhook support or incremental rate-aware polling, audit/health alerts and retention. Test revoked installations and cross-tenant tuple confusion.
6. **District qualification:** full user journey in a real authorized Canvas development tenant; student/teacher/admin separation, duplicate/outage/rate-limit/timeout/refresh/offline/reconnect/security tests, browser cookie/iframe behavior, load and independent review. A successfully validated launch cannot satisfy this milestone alone.

Add the requested Canvas story and `/integrations/canvas` page through PM, labeling the workflow planned until these milestones are connected and verified. Source current Kami Canvas facts before comparison. The current encryption requirement applies to Canvas-derived files/exports too; resolve interoperability explicitly rather than quietly sending a plaintext-at-rest export because a submission API expects PDF.

External needs: authorized Canvas test institution and administrator, developer key/client and deployment registrations, public HTTPS redirect/JWKS endpoints, minimal approved scopes, actual launch identities/course/assignment fixtures, and server-side signing/credential storage. No external installation, account creation, credential issuance or deployment is implied by local protocol work.

## Manual walkthrough for the currently implemented product

This checklist defines work to perform, **not work already performed**. Results belong in [manual verification](MANUAL_VERIFICATION.md). Automated equivalents stay separately identified in [verification](VERIFICATION.md). Use non-sensitive disposable documents and the exact verified origin; have the user enter credentials.

| Order / area                      | Interaction to exercise                                                                                                      | Expected observable result                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| M01 Access/vault                  | Open exact HTTPS origin; create/confirm passphrase or unlock; wrong passphrase; lock/reload/unlock                           | Normal certificate verification succeeds; workspace opens; wrong passphrase fails; lock removes visible content; correct unlock restores it |
| M02 Primary document path         | Import real PDF, open, add text/pen/highlight/shape/comment, wait for save, reload/unlock                                    | Render and controls work; save changes to confirmed local persistence; annotations survive reload                                           |
| M03 Editor tools                  | Select/move, edit text, erase/delete, undo/redo, all available shapes, color/custom color/width/highlight opacity            | Each mark renders predictably; undo/redo restores exact local state; no inactive feature controls                                           |
| M04 Reading/navigation            | Thumbnails, page number/previous/next, zoom/reset/fit, find/selectable text, copy page text, speech start/stop/speed         | Correct page/search result; copy success or actionable permission fallback; speech behaves according to available voices                    |
| M05 Comments                      | Create, locate, edit and delete comments; export long/Unicode note                                                           | Notes remain associated with correct pages; exported appendix retains full text; no implied remote recipients                               |
| M06 Page operations               | Rotate/duplicate/insert/add/move/delete with undo/redo; merge PDF; extract one page                                          | Page counts/order/marks update correctly and persist; last-page deletion is prevented                                                       |
| M07 Encrypted export/import       | Export annotated PDF package; import it again; try other-vault package passphrase; separately export original/index          | `.margin` is encrypted; annotated reimport shows flattened marks/full appendix; original/index content distinctions are clear               |
| M08 Library creation/organization | Blank document, rename, copy, star/unstar, colored folder creation, move into/out of folder, use template                    | Correct views update; copied annotations persist; template creates an editable copy                                                         |
| M09 Library discovery/removal     | Search, grid/list, sort, All/My/Sample tabs; single/bulk trash/restore; permanently delete disposable copy                   | Filters/order/navigation work; restored documents remain readable; permanent delete requires explicit confirmation                          |
| M10 Import variants/errors        | Browse/drop PDF/PNG/JPEG/.margin; unsupported renamed PDF; dismiss failed import; CORS source-link fallback                  | Supported files open; invalid file is not added; errors preserve originals and offer useful next steps                                      |
| M11 Save/navigation safety        | Unsaved text then browser Back; save then Back; second tab same document; pending draft then cross-tab lock                  | Draft refusal retains text; successful save permits navigation; second writer blocked; safe lock flush/refusal visible                      |
| M12 Settings/help/commands        | Display name, all themes, reading font, reduced motion, shortcut preference, help, command search/keyboard shortcuts; reload | Preferences persist; controls remain readable/focused; disabled shortcuts respect local setting                                             |
| M13 Local assignments             | Teacher draft/document/class/date/instructions→ready; Student open/submit; Teacher feedback/return; filters/reload           | Status and feedback persist in this browser; no claim of actual class delivery or authenticated role enforcement                            |
| M14 Routing/mobile                | Direct routes and browser Back/Forward; narrow viewport menu/dialogs/library/settings/assignments/editor; keyboard focus     | Correct route remains usable; guards retain unsaved work; controls reachable without hidden overflow/focus traps                            |
| M15 Optional API                  | With real configured local token, upload/pause/resume/cancel; disconnect/retry; refresh then explicit resume                 | Progress reflects acknowledged chunks; pause never claims success; original stays safe; finalized content remains quarantined               |
| M16 Production offline            | On that preview's separate origin, prime vault/assets; offline reload/unlock/open/edit/create/import; return online          | Cached shell/workers run and local changes persist; no unsupported remote-sync success message                                              |
| M17 Native extension              | Actual unpacked install, configured workspace, popup/context-menu HTTPS handoff, unlock/import, worker restart               | Minimal permissions; valid source handed off after user action; invalid/CORS paths explain fallback; no secrets in URLs                     |

The existing injected quota failure, abandoned lock timeout, tampered ciphertext, synthetic500-page canvas count, API owner denial, TLS-version and PostgreSQL policy fixtures remain **automated evidence** unless separately reproduced and recorded manually. Actual browser trust is an independent first gate; a test fixture accepting a local certificate cannot replace it.

## External dependencies and decisions

| Need                                                                                                                         | Why it is required                                                                       | Work possible before it is supplied                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Cloud account/project, approved region/domain, budget and deployment authority                                               | Real private DB/object storage/queue/Redis/network/CDN, public TLS, staging/load testing | Infrastructure modules, runtime interfaces, local integration fixtures and workload model                    |
| IdP tenant and Google/Microsoft/OIDC registrations; SAML test organization                                                   | Login/SSO/MFA/rotation/revocation and school policy                                      | Session/authorization contracts, callback validation and negative tests with explicit fixtures               |
| OAuth apps and sandbox tenants for Drive/Classroom/OneDrive/Teams/Canvas/Schoology/Dropbox/Box                               | Consent scopes, provider reviews, redirects, actual LMS/drive actions                    | Adapter contracts, import/export UX, error mapping and recorded fixture tests clearly labeled synthetic      |
| Managed KMS/secret manager/workload identities; CMK policy                                                                   | Real key wrapping/rotation/recovery and environment separation                           | Provider interface, envelope compatibility/migration tests and threat analysis                               |
| Malware scanner, isolated compute and OCR/conversion technology/licenses                                                     | Real inspection, format support and resource-isolated processing                         | Job/state model, quarantine tests, worker resource configuration and synthetic clean/unsafe fixture handling |
| AI provider contract/credentials and district policy decisions                                                               | Optional AI with retention/training guarantees and authorized transmission               | Disabled-by-default provider boundary, payload minimization, policy/provenance UI and denial tests           |
| Chrome publisher/deployment accounts and managed-device test tenant                                                          | Trusted extension publication/update and school policy qualification                     | Build/permission/message checks and unpacked local package preparation                                       |
| Inexpensive Chromebooks, stylus/touch devices, screen readers, school-network simulations and representative authorized PDFs | Performance/accessibility/fidelity claims and long-session reliability                   | Synthetic stress fixtures, timing instrumentation and test protocols; no hardware claim                      |
| Teacher/student/admin usability participants                                                                                 | Validate classroom simplicity and real workflows                                         | Scripted scenarios and accessibility alternatives with synthetic identities                                  |
| Independent security reviewers and privacy/security counsel                                                                  | Cryptographic/protocol review, penetration testing, FERPA/COPPA/contracts/notifications  | Traceable threat boundaries, test evidence, data inventory and draft policy/runbooks                         |
| Operations owners and recovery/retention policy                                                                              | RPO/RTO, on-call, incidents, physical deletion/backups/legal holds                       | Automated backup/restore fixture and draft procedures; no operational guarantee                              |

Never commit credentials or paste them into documentation. Use secure local/provider configuration. Request exact credentials, permissions or decisions only when their absence blocks a concrete integration step; continue independent authorized work in parallel.

## Tracking and handoff

Keep feature work traceable to requirement IDs and one phase. Each change records what works, why, automated checks, applicable manual evidence, migration/security consequences and unresolved limits. Update the matrix when code changes, not merely when a plan is written. Maintain [architecture](ARCHITECTURE.md), [production readiness](PRODUCTION_READINESS.md), [local security](LOCAL_SECURITY.md) and [backend security](security-backend.md) as implementation evolves; never replace a failing observation with a planned outcome.

There is no defensible completion date or production-scale claim before these gates and external dependencies are resolved. Progress should be reported as completed capabilities with evidence and the next concrete gate, while the full requested goal remains open.
