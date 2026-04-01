---
title: v0.5.0 tag triggers Homebrew build
tags:
    - release
    - decision
depends-on:
    - add-goreleaser-and-release
    - goreleaser-cross-repo-push
    - professional-open-source
created-at: 2026-02-25T17:53:44.625338+01:00
outcome: Committed 76b82f6 on main (flag-only felt edit + docs/tests updates), pushed main, created/pushed annotated tag v0.5.0. Confirmed release workflow triggers on push tags matching v* and GoReleaser brews target is cailmdaley/homebrew-tap, so tagging v0.5.0 triggers automated release and Homebrew formula update when HOMEBREW_TAP_TOKEN is present.
---

(v0-5-0-tag-triggers-homebrew)=
# v0.5.0 tag triggers Homebrew build
