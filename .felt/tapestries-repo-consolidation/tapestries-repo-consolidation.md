---
title: Tapestries repo consolidation
tags:
    - decision
created-at: 2026-03-30T00:28:29.387429+02:00
outcome: 'Three copies of tapestries repo (portolan/docs submodule, ~/.felt/tapestries/ deploy, ~/Documents/projects/tapestries standalone clone) collapsed to one. ~/.felt/tapestries/ is now a symlink to portolan/docs. Standalone clone deleted. One source of truth: edit portolan source → build:static → commit in docs submodule → push.'
---

(tapestries-repo-consolidation)=
# Tapestries repo consolidation
