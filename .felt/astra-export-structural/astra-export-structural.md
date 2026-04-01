---
title: ASTRA export structural wrappers and parent refs
status: closed
tags:
    - astra
    - felt
depends-on:
    - felt-v2-constitution
    - astra-export-generation
created-at: 2026-04-01T02:18:02.800582+02:00
outcome: 'ASTRA export now emits a real root analysis document with version/name plus structural wrapper inputs/outputs for directory-only parent nodes, and normalizes felt-style parent.<input> references to ASTRA ../<input> on export. Verified with go test ./internal/tapestry, go test -tags integration ./cmd, and PYTHONPATH=/Users/cd280747/Documents/projects/ASTRA/src Python validation against the sibling ASTRA source; the previous failure mode was semantic, not schema-only: root analyses lacked required fields and structural wrappers without inputs/outputs failed validation.'
---

(astra-export-structural)=
# ASTRA export structural wrappers and parent refs
