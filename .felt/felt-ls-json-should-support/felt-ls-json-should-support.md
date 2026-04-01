---
title: felt ls --json should support --body flag to include body in output
status: closed
tags:
    - '[cli]'
created-at: 2026-01-19T00:07:33.313459+01:00
closed-at: 2026-01-19T00:10:15.880273+01:00
outcome: Implemented --body flag for felt ls --json. When set, includes body field in JSON output; when unset (default), body is excluded for performance. Also added --recent N flag for showing most recent fibers. Tested successfully, all tests pass, committed and pushed.
---

(felt-ls-json-should-support)=
# felt ls --json should support --body flag to include body in output
