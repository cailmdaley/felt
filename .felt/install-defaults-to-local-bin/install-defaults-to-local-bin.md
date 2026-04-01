---
title: Install defaults to ~/.local/bin
tags:
    - decision
created-at: 2026-03-16T15:04:20.169111+01:00
outcome: Changed install.sh default from /usr/local/bin to ~/.local/bin to avoid sudo on the curl|sh path. Falls back to /usr/local/bin if writable. Warns if target not on PATH.
---

(install-defaults-to-local-bin)=
# Install defaults to ~/.local/bin
