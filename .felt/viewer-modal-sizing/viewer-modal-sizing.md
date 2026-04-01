---
title: Viewer modal sizing
depends-on:
    - pdf-js-canvas-for-file-modal
created-at: 2026-03-30T11:12:28.436506+02:00
outcome: 'FileViewerModal (the main app''s .file-viewer-* modal, NOT TapestryStaticFileModal) had max-height:90vh with .file-viewer-pdf hardcoded at height:70vh. Changed modal to height:94vh and PDF container to height:100% so it fills available space. Native browser resize:both was already present (bottom-right corner grip). Key lesson documented in CLAUDE.md: two separate file viewer modals exist — FileViewerModal for localhost, TapestryStaticFileModal for static deploy.'
---

(viewer-modal-sizing)=
# Viewer modal sizing
