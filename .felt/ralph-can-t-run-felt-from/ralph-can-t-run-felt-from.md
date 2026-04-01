---
title: Ralph can't run felt from project dirs without .felt
status: closed
depends-on:
    - build-felt-dag-native-markdown
created-at: 2026-01-16T02:40:32.618067+01:00
closed-at: 2026-01-17T16:22:02.338059+01:00
outcome: 'Resolved by accepting felt''s directory-bound design rather than fighting it. Removed Repo field from show output—felt operates on cwd like git, so displaying a separate ''repo'' path was misleading. For the original problem (ralph can''t close fibers from other dirs): the answer is to cd to the tapestry first, or init felt in project dirs. This is intentional friction, not a bug.'
---

(ralph-can-t-run-felt-from)=
When ralph works in a project dir (e.g. ~/projects/hexarchy) that doesn't have .felt, iterations can't run felt commands to close fibers. Need to either: (1) tell Claude in system prompt to cd to tapestry first, or (2) have felt support --tapestry flag, or (3) always init felt in project dirs.
