---
title: sharing felt
status: closed
tags:
    - spec
created-at: 2026-02-24T14:17:18.493363+01:00
closed-at: 2026-02-24T14:34:03.447438+01:00
outcome: 'Implemented: felt setup claude prints CLAUDE.md snippet (philosophy/rhythm/discipline, no CLI — hook carries that); felt setup codex installs idempotent shell wrapper into zshrc/bashrc with felt hook session injection; cmd/integration_test.go covers full CLI via integration build tag; CI step added. Snippet design: taste/why layer only — users adapt it. CLI reference lives in hook output.'
---

(sharing-felt)=
felt is ready to share with Claude Code and Codex users. Three things need to exist: (1) `felt setup claude` prints a full CLAUDE.md/AGENTS.md snippet after installing hooks, (2) `felt setup codex` installs a shell wrapper into the user's RC file, (3) the full CLI is covered by integration tests that run in CI.

## Desired State

**`felt setup claude`** — after installing the SessionStart hook, prints a suggested CLAUDE.md snippet to stdout. The snippet covers: philosophy (fibers as documentation, DAG, file like water), rhythm (`felt` before work / comment as you go / close with outcome), discipline (2-3 word titles, outcomes say why, decisions in their own fibers), and CLI reference. Dense but not bloated — matches the quality of the felt section in the global CLAUDE.md.

**`felt setup codex`** — installs a `codex()` shell wrapper into `~/.zshrc` (zsh) or `~/.bashrc` (bash), detected from `$SHELL`. The wrapper runs `felt hook session` and injects context via `--config "developer_instructions=..."`. Idempotent: running it twice doesn't duplicate the function. `--uninstall` cleanly removes it. Prints the same snippet as `setup claude` (framed as AGENTS.md suggestion).

**Integration tests** — `cmd/integration_test.go` with `//go:build integration` tag. Tests build the binary into a temp dir via `TestMain`, then exercise the full CLI: `init`, `add`, `show`, `ls`, `edit` (including close with outcome), `comment`, `link`/`unlink`, `upstream`/`downstream`, `ready`, `rm --force`, `tag`/`untag`, `setup claude`, `setup codex`. Each test uses an isolated temp directory. All pass.

**CI** — `.github/workflows/ci.yml` has an explicit `go test -tags integration ./cmd/ -run TestIntegration` step after the existing unit test step.

## Context

- `cmd/setup.go` — existing `setupCmd` + `setupClaudeCmd`. Add `setupCodexCmd` here, and the `claudeMDSnippet()` + codex RC helpers.
- `cmd/setup_test.go` — new file for unit tests of the snippet and RC install/uninstall logic.
- `cmd/integration_test.go` — new file, `package cmd_test`, `//go:build integration`. `TestMain` builds binary; `felt()` / `mustFelt()` helpers run it in a given dir.
- `.github/workflows/ci.yml` — add integration test step.
- The codex shell function pattern lives in `~/loom/shell-functions.sh` — match that idiom exactly.
- Sentinel comments for idempotency: `# felt integration — added by felt setup codex` / `# end felt integration`.

## Evidence

```bash
go test ./cmd/ -run TestClaudeSnippet -v        # snippet content
go test ./cmd/ -run TestCodex -v                # RC install/uninstall logic
go test -tags integration ./cmd/ -run TestIntegration -v   # full CLI
go build . && ./felt setup claude               # visual check: snippet printed
go build . && HOME=/tmp/x SHELL=/bin/zsh ./felt setup codex && cat /tmp/x/.zshrc
```

CI passes on a push to a branch before merging.

## Open Questions

- Is the CLAUDE.md snippet the right length? Too short and agents miss the rhythm; too long and users skip it. Aim for something a new user would actually read — err toward concise. The user will steer between iterations.
