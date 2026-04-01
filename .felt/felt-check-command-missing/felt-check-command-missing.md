---
title: '[ralph:3] felt check command missing cycle detection'
status: closed
created-at: 2026-01-12T22:04:04.725196+01:00
closed-at: 2026-01-12T22:05:31.211447+01:00
outcome: Added FindCycles() to graph.go that uses DFS to detect cycles in the existing graph (vs DetectCycle which checks prospective edges). Updated check command to call both ValidateDependencies and FindCycles. Added test for cycle detection. The check command now matches its documented behavior of detecting both dangling refs and cycles.
---

(felt-check-command-missing)=
# [ralph:3] felt check command missing cycle detection
