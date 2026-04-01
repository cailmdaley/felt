---
title: 'felt CLI: inline body access'
status: closed
tags:
    - felt-cli
    - spec
created-at: 2026-01-17T14:26:13.633756+01:00
closed-at: 2026-01-17T16:28:03.326543+01:00
outcome: 'Implemented. Standardized on ''body'' nomenclature: renamed --description to --body (-b) in add, added --body to show (outputs only body for piping), added --body to edit (sets body inline).'
---

(felt-cli-inline-body-access)=
Parent fiber for body-related CLI improvements.

Currently no good way to read/write fiber bodies inline:
- `felt show` only shows metadata
- `felt edit` doesn't have --body flag
- Have to manually cat/edit the .md files

Children track specific improvements.
