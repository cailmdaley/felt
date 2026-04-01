---
title: felt show --body flag doesn't exist
status: closed
tags:
    - felt-cli
depends-on:
    - felt-cli-inline-body-access
created-at: 2026-01-17T14:25:11.422416+01:00
closed-at: 2026-01-17T16:28:05.455344+01:00
outcome: Done. Added --body/-b flag to felt show that outputs only the body (for piping).
---

(felt-show-body-flag-doesn-t)=
Tried `felt show remote-sessions-35dbe9b6 --body` to see fiber content inline.

Got: `unknown flag: --body`

Had to manually `cat` the fiber file instead.

**Desired:** `felt show <id> --body` prints the markdown body after the metadata, or maybe just make it default behavior.
