---
title: Make felt edit flag-only
tags:
    - felt-cli
    - decision
depends-on:
    - felt-edit-body-flag-doesn-t
created-at: 2026-02-25T17:53:35.542683+01:00
outcome: Changed cmd/edit.go so 'felt edit <id>' with no flags returns an error instead of opening vi. Body replacement is explicit via --body, with overwrite messaging only when replacing existing non-empty body. Updated README/docs examples and added integration coverage for no-flag failure and body replacement semantics.
---

(make-felt-edit-flag-only)=
# Make felt edit flag-only
