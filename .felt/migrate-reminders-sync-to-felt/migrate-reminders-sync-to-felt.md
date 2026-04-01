---
title: Migrate reminders-sync to felt + kind filtering
status: closed
tags:
    - loom-dev
created-at: 2026-01-13T22:40:23.387749+01:00
closed-at: 2026-01-13T22:40:23.387761+01:00
outcome: |-
    Completed migration of reminders-sync from dots to felt system.

    ## Changes
    1. **reminders-sync.py migrated to felt**
       - CLI: `dot` → `felt`
       - Directory: `.dots/` → `.felt/`
       - JSON schema: `issue_type` → `kind`, `description` → `body`
       - Status values: `in_progress` → `active`, `done` → `closed`

    2. **Kind-based filtering added**
       - Only syncs `kind=task` fibers
       - Threads, specs, decisions, questions excluded from Reminders
       - `SYNC_KIND = "task"` constant for easy configuration

    3. **Cleanup**
       - Deleted `.dots/` directory
       - Removed old `dot` skill, created new `felt` skill for Claude Desktop
       - Closed obsolete dots-related fibers
       - Removed `threads/dots-dev/` worktree

    4. **Deduplication**
       - Cleaned up ~40 duplicate reminders from dot era drift
       - Reset state file for clean 1:1 mapping

    ## Final state
    - 40 reminders ↔ 40 task fibers
    - Bidirectional sync on session start
    - Due dates working
---

(migrate-reminders-sync-to-felt)=
# Migrate reminders-sync to felt + kind filtering
