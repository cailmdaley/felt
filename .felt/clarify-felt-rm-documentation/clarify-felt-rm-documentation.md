---
title: Clarify felt rm documentation
status: closed
tags:
    - ralph:2
depends-on:
    - doc-review-surface-improvements
created-at: 2026-01-13T01:06:13.850092652+01:00
closed-at: 2026-01-13T01:06:34.762225652+01:00
outcome: Changed docs from 'fails if dependencies exist' to 'fails if other felts depend on it'. The original was ambiguous - could mean 'if this felt has deps' vs 'if anything depends on this'. The actual behavior is the latter.
---

(clarify-felt-rm-documentation)=
# Clarify felt rm documentation
