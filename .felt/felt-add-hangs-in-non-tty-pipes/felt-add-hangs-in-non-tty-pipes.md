---
title: felt add hangs in non-TTY pipes — remove implicit stdin read
status: closed
tags:
    - decision
created-at: 2026-02-18T12:53:00.885322901+01:00
outcome: |-
    io.ReadAll(os.Stdin) in cmd/add.go blocked indefinitely when stdin was an open pipe with no data and no EOF — the exact scenario when Claude Code's Bash tool runs a command. The stdin detection checked (stat.Mode() & os.ModeCharDevice) == 0, which is true for any non-TTY, then called ReadAll which blocks on empty pipes forever.

    Considered three fixes: (1) stat.Size() > 0 check — breaks pipes since Linux reports size=0 for pipe buffers. (2) Goroutine + 100ms timeout — works but is a heuristic/race condition. (3) Remove implicit stdin entirely, require -b flag — clean, no edge cases.

    Chose (3). The documented workflow already uses -b with heredocs. Implicit stdin was undocumented convenience causing a real bug. Commit 1a63d62.
---

(felt-add-hangs-in-non-tty-pipes)=
# felt add hangs in non-TTY pipes — remove implicit stdin read
