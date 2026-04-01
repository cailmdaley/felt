---
title: PDF.js canvas for file modal
tags:
    - decision
created-at: 2026-03-30T00:28:28.078114+02:00
outcome: Replaced iframe with renderPdfAllPages in TapestryStaticFileModal.ts. iframes ignore CSS width on mobile; canvas respects it. Reused existing renderPdfAllPages from ArtifactMedia.ts — zero new code, just the right import. Committed in portolan (source) and tapestries (built output via docs submodule).
---

(pdf-js-canvas-for-file-modal)=
# PDF.js canvas for file modal
