---
title: Hook help alignment
status: closed
depends-on:
    - runtime-doc-alignment
    - felt-v2-constitution
created-at: 2026-04-01T02:21:02.94181+02:00
outcome: 'Aligned the runtime hook CLI reference with the consolidated v2 surface: edit flag examples, tree/ls/export/nest/migrate verbs, and directory-fiber path semantics. Fixed the docs guard to scan the actual bundled skills directory under package-test cwd and extended integration coverage so retired ''find'' is also enforced as an unknown command. Verified with go test ./cmd, go test -tags=integration ./cmd, and go test ./....'
---

(hook-help-alignment)=
# Hook help alignment
