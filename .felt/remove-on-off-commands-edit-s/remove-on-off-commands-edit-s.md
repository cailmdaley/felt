---
title: Remove on/off commands — edit -s covers status
status: closed
tags:
    - decision
depends-on:
    - read-time-fidelity-modes-for
created-at: 2026-02-11T00:37:00.405848634+01:00
outcome: 'on/off were convenience aliases for edit -s active / edit -s closed -o. Removed because: (1) no functional gap — edit -s does everything on/off did, (2) LLM self-assessment: on/off didn''t improve in-session performance, main value was cross-session continuity, (3) Recently Touched in the hook now provides that continuity for ALL fibers regardless of status, making the on→active signal redundant. The ceremony argument (mantra-like gesture of picking up work) didn''t outweigh the surface area cost.'
---

(remove-on-off-commands-edit-s)=
# Remove on/off commands — edit -s covers status
