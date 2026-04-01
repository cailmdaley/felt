---
title: felt on/off made idempotent
status: closed
tags:
    - '[felt]'
    - decision
created-at: 2026-01-22T15:52:34.949104+01:00
closed-at: 2026-01-22T15:52:40.996831+01:00
outcome: 'on: automatically reopens closed fibers, clears closure metadata. No --reopen flag needed or available. off: idempotent on already-closed fibers, updates reason if -r provided otherwise no-op. Explicitly no backwards compatibility — removed --reopen entirely rather than keeping as deprecated no-op. Commits: ca1f9f0 (implementation), 4eb5143 (docs). Hook template embedded in binary so reinstall required for hook output to update.'
---

(felt-on-off-made-idempotent)=
# felt on/off made idempotent
