---
title: 'felt add: -b shorthand for body/description'
status: closed
tags:
    - felt-cli
created-at: 2026-01-17T14:26:07.744876+01:00
closed-at: 2026-01-17T16:28:04.092265+01:00
outcome: Done. Renamed --description/-d to --body/-b in felt add.
---

(felt-add-b-shorthand-for-body)=
Tried `felt add ... -b 'body'` instinctively.

Got: `unknown shorthand flag: 'b' in -b`

The flag is `-d --description`, which makes sense, but `-b` for body is a natural alias.

**Suggestion:** Add `-b` as alias for `-d/--description`, or rename to `--body` with `-b` shorthand.
