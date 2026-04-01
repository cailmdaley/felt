---
title: Tapestry file export
status: closed
created-at: 2026-03-14T22:11:25.691906+01:00
closed-at: 2026-03-14T22:13:39.683932+01:00
outcome: 'Added linked-file export to internal/tapestry: export now scans node and fiber body/outcome markdown for inline-code and markdown-link file references, copies existing project files into outDir/files using flattened names, rewrites exported paths to files/{flatName}, and covers extraction/flattening/rewrite behavior with package tests.'
---

(tapestry-file-export)=
# Tapestry file export
