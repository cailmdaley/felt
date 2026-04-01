---
title: '[ralph:14] Fix ready command to exclude active felts'
status: closed
created-at: 2026-01-12T22:50:40.770856+01:00
closed-at: 2026-01-12T22:51:34.839891+01:00
outcome: Fixed Ready() to only return open felts, not active ones. Added test TestReadyExcludesActive. The spec said 'open with resolved deps' but the implementation was returning both open AND active.
---

(fix-ready-command-to-exclude)=
# [ralph:14] Fix ready command to exclude active felts
