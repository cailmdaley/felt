---
title: 'Status model: tasks vs knowledge fibers'
status: closed
tags:
    - decision
created-at: 2026-02-10T20:52:37.010146027+01:00
closed-at: 2026-02-10T21:36:56.182223732+01:00
outcome: 'Implemented: status opt-in (no status by default), close-reason→outcome, kind→tags, felt ls shows only tracked fibers. Backward compat reads old fields and migrates on write.'
---

(status-model-tasks-vs-knowledge)=
Fibers just exist. Status is opt-in. Kind merges into tags.

## The decision

### Before

Every fiber got `status: open` on creation. `close-reason` was the only way to record conclusions. `kind` was a separate field with conventional values (task, decision, question, spec, doc). `felt ls` showed everything.

### After

| Field | Required | Notes |
|-------|----------|-------|
| title | yes | The fiber |
| body | no | The content |
| outcome | no | The conclusion — decisions, answers, results. Any fiber can have one. |
| status | no | Opt-in tracking: open → active → closed |
| tags | no | Freeform. Absorbs what kind used to do. |

### What changes in code

- `close-reason` → `outcome` in YAML field name. Read both for backward compat.
- `kind` → migrated to tags. Read `kind` on parse, emit as tag. Eventually drop.
- `felt add "title"` creates a fiber with no status (just title + created-at)
- `felt add "title" --status open` or `felt add "title" -s open` creates a tracked fiber
- `felt add "title" -r "the answer"` sets outcome without status
- `felt off <id> -r "..."` sets outcome. Also sets status=closed if fiber has a status.
- `felt on <id>` sets status=active (creates status if fiber didn't have one — entering tracking)
- `felt ls` shows only fibers with a status by default
- `felt ls --all` shows everything
- `felt find` searches everything regardless of status

### Migration

- Existing fibers with `status: open/active/closed` keep working
- Existing `close-reason` reads as `outcome`
- Existing `kind` reads as a tag
- On next write, fields migrate to new names
