---
title: Fix workflows.md shorthand-with-flags examples
status: closed
tags:
    - ralph:4
depends-on:
    - doc-review-surface-improvements
created-at: 2026-01-13T01:15:37.014985277+01:00
closed-at: 2026-01-13T01:16:08.047880195+01:00
outcome: 'Fixed workflows.md examples that incorrectly used shorthand with flags. The shorthand ''felt title'' only works for simple titles without flags. Changed ''felt X -p 1'' and ''felt X -a dep'' to ''felt add X -p 1'' and ''felt add X -a dep''. Confirmed the bug was real by testing: ''felt X -a dep'' fails with ''unknown shorthand flag''.'
---

(fix-workflows-md-shorthand-with)=
# Fix workflows.md shorthand-with-flags examples
