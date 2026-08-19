# Codebase layout and tests

## Codebase layout

```
felt/
├── AGENTS.md                contributor spine — invariants + daily loop
├── CLAUDE.md                symlink to AGENTS.md
├── CONTRIBUTING.md          contribution guide
├── README.md               public front door (CLI-first)
├── LICENSE / LICENSE-APACHE / NOTICE   MIT + daemon's Apache-derived split
├── Makefile                 build (cli/daemon/build) + daemon lifecycle
├── bootstrap.sh             full from-source bootstrap (make install)
├── install.sh               public release-binary installer (curl | sh)
│
│   # felt CLI — Go (the data layer)
├── main.go  go.mod  go.sum
├── cmd/                     cobra commands; `felt shuttle <verb>` = cmd/shuttle*.go
├── internal/felt/           core felt logic (storage, parsing, graph, search)
├── internal/shuttle/        shuttle: block schema + agent registry (agents.builtin.json + user layer)
├── claude-plugin/           plugin payload for Claude Code + Codex
├── scripts/release.sh       bumps plugin manifests + commits + tags
│
│   # shuttle daemon — Elixir/OTP (the dispatcher)
├── mix.exs  mix.lock
├── bin/shuttle              tracked shell shim, the daemon's front door
├── bin/rel/                 the built daemon release (bin/rel/bin/shuttled), gitignored
├── lib/                     Elixir source
│   ├── shuttle/poller.ex      discover + eligibility + retry queue
│   ├── shuttle/dispatcher.ex  agent resolution, tmux launch
│   └── shuttle_web/           agent-API HTTP endpoints (/api/v1/...)
├── config/                  Elixir env config (dev/test/prod endpoint settings)
├── priv/                    daemon assets (e.g. mystra/bake.mjs)
├── share/                   keep-alive templates (launchd plist, systemd unit)
├── test/                    Mix test suite
│
│   # the board UI — TypeScript
└── ui/                      the board UI; `npm run build` → ui/dist (served by :4000)
    ├── src/board/views/     the four registered views (day · week · chronicle · shelf) + ViewRegistry contract
    └── harness/             offline visual-verification harness — `npm run harness`
                             (detail panel) / `npm run harness:board` (board chrome +
                             temporal views) build self-contained bundles into
                             ui/harness-dist/ and ui/harness-board-dist/, openable
                             over `file://`. They mount the REAL components against a
                             mocked daemon, which is the only way to look at the board
                             from a sandbox: the live :4000 is unreachable there.
```

`deps/` and `_build/` are Mix-managed and gitignored.

## Tests

```bash
make test                  # go test ./... + mix test + the board suite + the plugin hooks
go test ./...              # Go (felt CLI)
mix test                   # full Elixir suite
mix test --only focus      # tagged subset
cd ui && npm test          # the board suite; runs vitest TWICE, under two
                           # pinned TZs (America/Los_Angeles, Europe/Paris)
bash scripts/test-plugin-hooks.sh  # the shell hook shims, HOME and PATH sandboxed

# Opt-in real harness smoke. Opens real Claude/Codex/Pi CLIs in tmux,
# sends no prompt, captures the idle pane, then kills the smoke sessions.
SHUTTLE_REAL_HARNESS_SMOKE=1 mix test --only integration test/shuttle/real_harness_smoke_test.exs
```

**The board suite runs twice on purpose, and CI does not run it at all.** The
second pinned offset is where the civil-day logic breaks, so a hand-run `npx
vitest run` can go green on a change `make test` would fail. CI type-checks and
builds the bundle (`npm run build`) but never invokes vitest — `cd ui && npm
test` is a local-only gate, which makes it the easiest one to skip and the one
worth not skipping.

The real harness smoke is deliberately outside ordinary `mix test`. It uses
tmux session names like `shuttle-harness-smoke-<harness>-<unique>`, records
captures under `_build/test/shuttle_harness_smoke/`, and skips harnesses that
are not available in `bash -l`.
