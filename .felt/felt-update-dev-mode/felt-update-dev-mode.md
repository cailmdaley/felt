---
title: felt update dev mode
status: closed
created-at: 2026-03-14T16:11:44.497382+01:00
closed-at: 2026-03-14T16:13:31.208103+01:00
outcome: 'Implemented: --link flag on felt setup skills writes ~/.felt/dev-source marker. felt update checks for it and does git pull + go build from source instead of downloading a release.'
---

(felt-update-dev-mode)=
When installed via --link, felt update could detect the source checkout and do git pull + go build instead of downloading a release binary. Track dev installs via a marker file (e.g. ~/.felt/dev-source-path).
