# Margin: design and research

## Direction

A quiet, paper-like learning workspace with warm neutrals, terracotta actions, generous typography, and document content as the visual anchor. Navigation stays predictable; document tools appear in context. The wordmark, document covers and interface artwork were created for this build.

Workspace hierarchy: persistent navigation, compact search/status bar, welcome and primary import action, recent document previews, folders, then a sortable file library. Editor hierarchy: document title and save state, focused tool strip, bounded PDF canvas, optional page and comment panels.

Interaction: restrained document-card lift, fast menu/dialog reveal, and visible import/save feedback. Reduced motion removes transitions. Keyboard focus remains explicit.

## Mobbin references inspected through the connected MCP

- [Craft document library](https://mobbin.com/screens/0013c292-428b-41ae-9a1c-39cfc5d8e204): visually quiet navigation, clear folder boundaries, whitespace and one primary work area.
- [Coda workspace](https://mobbin.com/screens/98a98454-48c1-4d00-a659-85cd02e75f26): visual document discovery above a scannable list with filter tabs.
- [Notion document](https://mobbin.com/screens/57363461-9d4f-4b99-869e-4cc8216f3b20): restrained sidebar, readable page width, secondary actions outside the content.
- [Dropbox PDF editor](https://mobbin.com/screens/d044eaa7-45ad-4a57-a5e4-d6eb821262d6): page navigation, contextual drawing controls, and central document surface.
- [Evernote PDF annotation](https://mobbin.com/screens/a0122c80-f094-4ca9-b902-0e28d6e172c7): compact task-specific tools and separation of document content from application chrome.

These are design references, not copied assets or layouts. Screenshots and logos are not bundled in Margin.

## Supplied research

Read the three-page “Kami’s Features and Strengths.pdf” and the attached product brief. Key requirements used: keep the extension lightweight; use a worker for PDF rendering; persist edits locally; keep annotations separate from source PDFs; make save and upload states truthful; avoid a permanently visible wall of tools; make classroom workflows simpler.

The PDF contains anecdotal performance reports and inferred descriptions of Kami’s architecture. It also uses internal citation tokens without resolvable source URLs. These are research hypotheses and product goals, not independently verified statements about the current competitor. No competitor performance claims appear in the product.

## Product boundaries

This repository is an executable local foundation, not a claim of production scale or legal compliance. Shipping capability and remaining work are recorded in PRODUCTION_READINESS.md. Sample documents are identified as samples. Local storage is not labeled cloud sync. Browser data clearing can remove local documents, so encrypted document export is available. Teacher/student modes are local workflow views, not authorization roles.
