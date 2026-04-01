---
title: Static viewer 404 handling
depends-on:
    - pdf-js-canvas-for-file-modal
    - tapestry-file-export
created-at: 2026-03-30T11:12:20.905297+02:00
outcome: 'TapestryStaticFileModal now pre-checks files before rendering. PDFs: fetch + content-type check before handing to PDF.js (SPA catch-all served HTML as PDF). Images: Image.onerror instead of raw innerHTML. Text/code: content-type guard rejects text/html for non-HTML extensions. All paths show ''File not found'' instead of rendering GitHub Pages index.html fallback. Also extracted .tapestry-file-* CSS from both index.html files into src/ui/tapestry-file-modal.css, imported via <link> tags.'
---

(static-viewer-404-handling)=
# Static viewer 404 handling
