---
title: Professional open source packaging
status: closed
tags:
    - spec
created-at: 2026-01-31T02:40:05.884858+01:00
closed-at: 2026-01-31T03:29:36.754005+01:00
outcome: 'All desired state achieved: CI green (workflows succeed), v0.1.0 released with 4 platform binaries (darwin/linux x amd64/arm64), go install and brew install cailmdaley/tap/felt both work, MIT LICENSE present, binaries gitignored not tracked, banner in README with badges, repo clean. Homebrew tap at cailmdaley/homebrew-tap. Note: goreleaser can''t auto-push formula (needs PAT), documented in separate fiber.'
---

(professional-open-source)=
# Spec

You are in a Ralph loop — meditative iteration toward a desired state.

## Orientation

You have fresh eyes. No context from previous iterations binds you — use that freedom. Survey the system as it actually is, not as someone described it.

You have broad authority to advance the state. The desired state below defines "done." Everything else is yours to decide: what to check, what to prioritize, how to contribute. Trust your judgment.

Update state discoverably. Commits, fibers, test results — not notes. The next iteration will find what changed by inspecting the system.

## Loop

Each iteration:

1. **Survey** — Launch quick Explore agents to understand current state. Check `felt downstream <spec-id>`, git log, tests, whatever seems most informative. You decide what to look at.

2. **Contribute** — Identify one major contribution that is relatively self-contained. Doing everything at once leads to context bloat; doing one thing well lets the next iteration verify and build on it. You can launch background sub-agents for minor parallel work, but keep your main focus singular. Start a sub-fiber for this iteration (`felt add "..." -a <spec-id>`), then update it as work unfolds — comments, status, what you tried.

3. **Felt** — Before exiting, use the `/felt` skill to extract decisions, patterns, lessons learned. File as fibers. Update CLAUDE.md if warranted.

4. **Exit** — Always `kill $PPID`.

## Practices

- Never spawn multiple agents editing the same file — partition by file, not feature
- Close your iteration's sub-fiber with what happened, not just that it happened
- When evidence shifts the direction, comment on the spec to reshape it — but sparingly. "This approach won't work because X" is worth noting; "I tried Y" is not

## Exit Rules

**Made ANY contribution:** `kill $PPID`. Do NOT close the spec fiber. The next iteration verifies with fresh eyes.

**Made ZERO contributions AND nothing left:** Close with `felt off <id> -r "..."`, then `kill $PPID`.

---

## Desired State

felt is a polished, installable open source Go CLI — the kind you'd pin on your GitHub profile.

Inspecting the repository shows:

1. **CI passes** — `.github/workflows/ci.yml` runs `go test ./...` on push and PR to main. Green badge in README.

2. **Releases exist** — Tagged versions (v0.1.0, etc.) with goreleaser-built binaries for darwin-arm64, darwin-amd64, linux-arm64, linux-amd64. GitHub Releases page populated.

3. **Install works** — `go install github.com/cailmdaley/felt@latest` succeeds. Homebrew tap at `cailmdaley/homebrew-tap` with `brew install cailmdaley/tap/felt`.

4. **LICENSE present** — MIT license file at repo root.

5. **Binaries not committed** — `felt` and `felt-linux` removed from git history (or at minimum from current tree). Binaries delivered exclusively via releases.

6. **Banner in README** — The rhizomatic fiber image (`nanobanana-output/an_elegant_github_repository_ban_1.png`) moved to appropriate location (e.g., `.github/banner.png` or `docs/`) and displayed at top of README.

7. **Clean repo** — No stray build artifacts. `.gitignore` updated if needed. `nanobanana-output/` removed or ignored.

Quality bar: someone discovering the repo sees a professional project — clear install instructions, CI badge, releases, thoughtful README with visual identity.

## Context

**Existing patterns:**
- Tests: `cmd/*_test.go`, `internal/felt/*_test.go` — run with `go test ./...`
- CLI: Cobra structure in `cmd/`
- Module: `github.com/cailmdaley/felt`
- README: solid content, needs banner + updated install section

**Files to create:**
- `.github/workflows/ci.yml` — test on push/PR
- `.github/workflows/release.yml` — goreleaser on tag push
- `.goreleaser.yml` — build config
- `LICENSE` — MIT

**Files to modify:**
- `README.md` — add banner, CI badge, update install instructions
- `.gitignore` — ensure binaries excluded

**Files to remove:**
- `felt` (binary)
- `felt-linux` (binary)
- `nanobanana-output/` (after moving banner)

**What NOT to change:**
- Core functionality — this is packaging only
- Test patterns
- Existing command structure

## Skills

None required.

## Comments
**2026-01-31 03:16** — Iteration 1: Added LICENSE (MIT) and CI workflow. Remaining: goreleaser, release workflow, banner, README updates, homebrew tap.
**2026-01-31 03:18** — Iteration 2: Added goreleaser config + release workflow. Remaining: banner, README (badge + install instructions), remove binaries from git, create homebrew-tap repo.
**2026-01-31 03:20** — Iteration 3: Added banner, CI badge, install instructions to README. Remaining: create homebrew-tap repo on GitHub, push commits, create first release tag.
**2026-01-31 03:25** — Iteration 4: homebrew-tap repo created, commits pushed, v0.1.0 released with all binaries. Note: release workflow can't auto-push formula (needs PAT with cross-repo write). Manually pushed formula; works. Remaining: fix workflow to use PAT secret, or document manual formula push process.
