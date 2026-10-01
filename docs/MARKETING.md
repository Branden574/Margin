# Margin marketing website

The independent website lives in `apps/marketing`. It does not replace `apps/web`, the encrypted local document workspace, and does not imply a hosted product, a Chrome Web Store listing, or a working school deployment.

## Run

From the repository root:

```sh
npm install
npm run dev:marketing
```

Open **http://127.0.0.1:3000**. This public-content preview uses loopback HTTP and never accepts real documents, Canvas credentials, or account passwords. Its **Try the web app** links open the separate HTTPS document workspace at **https://127.0.0.1:5173/** by default. Start and configure that workspace using the root README.

```sh
npm run build:marketing
npm run start -w @margin/marketing
npm run typecheck -w @margin/marketing
node --import tsx --test apps/marketing/tests/contracts.test.mjs
npm run check:budget -w @margin/marketing
```

`NEXT_PUBLIC_WORKSPACE_URL` sets the real workspace link at build time. It must use HTTPS, with no embedded credentials, query string, or fragment. `NEXT_PUBLIC_SITE_URL` sets the published site's HTTPS origin for social metadata. Omit it for a local preview, which uses `http://127.0.0.1:3000` and emits `noindex`. These values are public configuration, never secrets. No deployment was performed.

## Design and provenance

Visual direction: warm paper, ink, terracotta, generous type, a large document preview, then quieter dark chapters for architecture, page navigation, and security. Original document illustrations and product diagrams are implemented with HTML, CSS, and SVG. No competitor screenshots, logos, or customer assets are bundled.

Mobbin references inspected by the coordinating agent through the connected MCP:

- [Craft landing-page section](https://mobbin.com/sites/sections/58c31ff2-407c-4d33-933f-3b0a08528728): whitespace, direct headline, substantial product preview.
- [Craft second section](https://mobbin.com/sites/sections/81874e27-d807-48c6-8bf3-c2efd62b8c2f): large editorial pacing and clear content hierarchy.
- [Retool integrated surface](https://mobbin.com/sites/sections/dcbd55be-58cb-4e0e-9b70-cb4d184fa30a): dark product chapter with the interface integrated into the story.

These informed hierarchy, spacing, and contrast; they are not copied layouts or downloadable assets. The supplied Kami research remains product context, not evidence for current competitor performance. See [DESIGN.md](DESIGN.md).

Manrope's three Latin WOFF2 weights are served locally with `next/font/local`; its SIL Open Font License is included in `apps/marketing/public/fonts/LICENSE`. Georgia is the system serif accent. No external font requests are required.

## Implementation

Next.js App Router, React, TypeScript, Tailwind v4/PostCSS, Framer Motion, and Lucide. The page narrative, comparison, and policy content are server components with small interactive client surfaces. Lower demo components load on approach using `next/dynamic` and Intersection Observer. They currently share one deferred demo module rather than separate heavyweight packages. There is no PDF renderer, OCR model, video, analytics, or live upload client in the marketing bundle.

Reusable primitives: `Reveal`, `ScrollProgress`, `ProductWindow`, `AccessButton`, `WebAppLink`, `LazyDemo`, plus dedicated upload and Canvas scenes. Tokens in `app/globals.css` cover colors, type, spacing, borders, and restrained motion. Content is visible before reveal motion; it does not depend on an opacity-zero entrance. Reduced motion removes movement and automatic sequences. Running hero, reading, and architecture sequences pause offscreen; timers stop on hidden tabs. Automatic sequences have explicit pause/manual controls. Sticky stories become normal stacked content on small screens. Focus rings, labeled controls, native dialogs, range inputs, semantic tables, and a skip link provide keyboard paths.

## Implemented story and interactions

| Chapter         | Behavior and boundary                                                                                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hero            | Upload 12/38/72%, highlight, pen mark, comment, editable text, page insertion/reordering illustration, save state; play/pause/restart/step controls. No file is uploaded.                                                                           |
| Architecture    | Browser/worker/storage diagram, scoped cloud-planned lane, pauseable motion and expandable explanation.                                                                                                                                             |
| Upload recovery | Scroll/manual 68% interruption and verified-chunk continuation. The real companion API is described as encrypted quarantine storage pending scanning.                                                                                               |
| Annotation      | Eight switchable tool examples; actual editable note/comment fields. Image and equation tools remain planned. Signature preview describes locally available typed/drawn visual annotations, without identity verification or cryptographic signing. |
| Toolbar         | Student/teacher/power-user preset and add/remove tool concept. It does not change the actual workspace.                                                                                                                                             |
| Large PDFs      | Range/arrow/jump navigation from page 147 to 302 in a 347-page illustration. Only three synthetic previews exist; no PDF performance claim.                                                                                                         |
| Recovery        | Edit a note, wait for the simulated local save, close/reopen the illustration, toggle an offline example. Demo state is tab memory, not real durable storage.                                                                                       |
| Collaboration   | Fictional participants and a locally previewed reply. No message is sent.                                                                                                                                                                           |
| OCR             | Prepared text and translation, literal search/highlights. No image recognition, translation API, or voice service is called.                                                                                                                        |
| Accessibility   | Contrast/spacing toggles; reading ruler/focus concepts; word tracking with manual and pause controls. Actual web-editor read aloud uses available browser voices.                                                                                   |
| Teacher         | Local assignment-workflow illustration with explicitly fictional counts and prepared feedback. No student data or class delivery.                                                                                                                   |
| District        | Policy-scope/toggle concept; no actual policy enforcement or live institution counters.                                                                                                                                                             |
| Security        | Current local vault/HTTPS/API boundaries and links to specific security/privacy/disclosure pages. No certification claims.                                                                                                                          |
| Comparison      | Thirty product rows and eleven Canvas rows; per-claim official competitor sources. Unknowns stay unknown.                                                                                                                                           |
| Benchmarks      | All measurements pending, with reproducible methodology and target budgets. No invented bars, percentages, or speed claims.                                                                                                                         |
| Chromebook      | Original laptop illustration and explicit hardware-validation gap.                                                                                                                                                                                  |
| Command palette | Focused Ctrl/⌘+K, search, page insertion illustration, honest references to actual export/read-aloud tools; planned commands disabled.                                                                                                              |
| Before/after    | Range-driven reveal of two original conceptual layouts. It is not a Kami screenshot or competitor benchmark.                                                                                                                                        |
| Trust/pricing   | No fabricated testimonials, certifications, customer counts, or prices. Local source-edition access only.                                                                                                                                           |
| Canvas          | Eight-step scroll/manual concept and dedicated `/integrations/canvas` route: launch, copy, annotate, offline, reconnect, submit, teacher feedback, grade. All external actions remain visibly illustrative.                                         |

**Add to Chrome** opens real unpacked-extension setup instructions. **Sign in** explains the local vault and that hosted school identity is not provisioned; it links to the actual workspace. **Request a demo** opens a local evaluation-brief builder with copy/download, explicitly saying nothing is sent. There is no invented Store URL, sign-in service, contact endpoint, or success confirmation for an unperformed request.

## Canvas page

`/integrations/canvas` covers How It Works, Students, Teachers, IT setup, Security, Assignment Workflow, Grade Passback, Offline Recovery, and FAQ. It uses a conservative headline and an **Explore Canvas setup** CTA. It accepts no installation secrets or institution URLs. Setup is a readiness checklist and evaluation brief; it cannot falsely connect an institution.

The integration foundation elsewhere in the repository does not establish a real teacher → student → submission → review → grade workflow. This remains planned until a configured Canvas environment and full workflow testing exist. Local save, server save, submission confirmation, and grade confirmation are distinguished in both copy and illustration. There is no claim of affiliation with Instructure, certification, cheat-proof restrictions, or established rubric synchronization. See [CANVAS.md](CANVAS.md).

## Competitor evidence

Official pages checked by the research agent on **October 1, 2026** and linked beside relevant table claims:

| Claim                 | Official source and qualification                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core markup           | [Markup tool](https://help.kamiapp.com/kami-help-center/markup-tool): core highlighting/underline/strike/freehand/box tools.                                                                                  |
| Drawing               | [Drawing tool](https://help.kamiapp.com/kami-help-center/drawing-tool): basic drawing free; advanced bucket/ruler/protractor/compass paid.                                                                    |
| Collaboration         | [Kami features](https://www.kamiapp.com/products/kami-app/features/): collaboration, live feedback, sharing; no comparative latency claim.                                                                    |
| Offline               | [Offline mode](https://help.kamiapp.com/kami-help-center/offline-mode): prior online opening, most annotation tools, local save/resync; online-only tools and device-dependent read aloud.                    |
| Speech                | [Read Aloud](https://help.kamiapp.com/kami-help-center/read-aloud-tool): paid plans, voice/speed/pause controls.                                                                                              |
| OCR                   | [Text Recognition](https://help.kamiapp.com/kami-help-center/text-recognition-tool): all plans, selectable text for scans/images.                                                                             |
| Encryption            | [Privacy policy](https://www.kamiapp.com/privacy-policy/): vendor-stated TLS and encrypted-at-rest AWS/GCP storage; no independent audit claimed.                                                             |
| Canvas install/grades | [Canvas installation](https://help.kamiapp.com/kami-help-center/installing-the-kami-canvas-external-tool-integration): paid plan, course/site setup, gradebook sync.                                          |
| Assignment workflow   | [Creating Canvas assignments](https://help.kamiapp.com/kami-help-center/creating-kami-assignments-in-canvas): Assignments/Modules, External Tool workflow, document sources, Feature Control/Assessment Mode. |
| Teacher review        | [Kami and Canvas](https://www.kamiapp.com/lesson/kami-and-canvas-getting-started/): Class View and SpeedGrader.                                                                                               |

LTI 1.3 specifically, Canvas-specific offline recovery, submission recovery, provisioning internals, and integration audit logs were not established by those sources. “Not verified” never means absent. No competitor security, Chrome-permission, architecture, memory, or speed superiority claim is made. Recheck sources before any future publication.

## Verification and performance boundaries

Initial optimized build passed and generated the homepage, Canvas page, five policy/methodology routes, icon, and social image. Marketing TypeScript passed. Three focused Node tests cover insecure/credential-bearing CTA rejection, social-origin restrictions, and literal search with special punctuation. Run commands above for current results. Manual browser evidence belongs in [MANUAL_VERIFICATION.md](MANUAL_VERIFICATION.md) and the parent agent's final report; this implementation agent did not perform UI automation or a deployment.

The budget command sums gzip estimates for scripts referenced by the built homepage HTML. It excludes deferred chunks, HTML/RSC, CSS, and fonts, and is not a network trace.

Review targets, not measured field results: LCP <2.5s, INP <200ms, CLS <0.1; initial first-party JS <250KB compressed. Fonts are local, SVG/document assets are small, there are no videos, and lower interactive surfaces are deferred. No Lighthouse, field Web Vitals, real Chromebook, assistive-technology, school-managed Chrome, or real Canvas workflow result is implied by a successful production build.

Before hosting: set real public origins; recheck comparison claims; measure the production build on target mobile/Chromebook hardware; verify keyboard/reduced-motion/screen-reader behavior; establish real support/legal contacts and approved policies; complete institutional security review before using any school service. The public policy pages are development disclosures, not a DPA, contractual guarantee, or legal certification.
