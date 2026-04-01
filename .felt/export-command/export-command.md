---
title: Export command
status: closed
tags:
    - tapestry
depends-on:
    - felt-tapestry-export
created-at: 2026-03-14T13:48:09.987148+01:00
closed-at: 2026-03-14T13:52:31.173349+01:00
outcome: Implemented felt tapestry export with a new internal/tapestry package for evidence reads, config flattening, DAG export, artifact copying, and manifest updates. Added the tapestry/export Cobra command with default ~/.felt/tapestries/data/{name} output handling and helpful missing-repo messaging. Added tests for spec tag extraction, evidence filtering, and staleness; verified with go build . and go test ./... .
---

(export-command)=
# Export command
