---
title: '[ralph:4] Validate non-empty titles in felt add'
status: closed
created-at: 2026-01-12T22:07:50.967851+01:00
closed-at: 2026-01-12T22:08:30.461884+01:00
outcome: Added title validation in felt.New() - empty/whitespace-only titles now return error. Added TestNewEmptyTitle test. CLI correctly rejects empty titles.
---

(validate-non-empty-titles-in)=
Empty titles produce hex-only IDs (e.g., 32913790) which violate the spec format {slug}-{8hex}. Fix: require non-empty titles in felt.New() and add test.
