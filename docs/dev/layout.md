# Codebase layout and tests

## Codebase layout

```text
felt/
├── README.md                public front door
├── AGENTS.md                contributor invariants and daily loop (CLAUDE.md links here)
├── CONTRIBUTING.md          contribution guide
├── LICENSE / LICENSE-APACHE / NOTICE
├── Makefile                 builds, tests, and daemon lifecycle from the repo root
├── install.sh               public release-binary installer
├── main.go  go.mod  go.sum   felt CLI entrypoint and Go module
├── cmd/                     CLI commands, including felt shuttle
├── internal/                felt storage and parsing; shuttle schema and registry
├── daemon/                  shuttle's Elixir/OTP Mix project
│   ├── mix.exs  mix.lock  .formatter.exs
│   ├── lib/                 dispatcher, poller, and HTTP API
│   ├── config/              environment configuration
│   ├── priv/                daemon assets, including mystra/bake.mjs
│   ├── rel/                 release environment template
│   ├── share/               launchd and systemd templates
│   └── test/                daemon tests and shared parity fixtures
├── bin/                     tracked operator commands, including bin/shuttle
│   └── rel/                 built daemon release (gitignored)
├── ui/                      TypeScript board; npm run build produces ui/dist
│   ├── src/board/views/     temporal and artifact views
│   └── harness/             offline visual-verification harnesses
├── claude-plugin/           Claude Code and Codex plugin payload
├── scripts/                 bootstrap, release, and verification tooling
└── docs/                    documentation, artwork, and mkdocs.yml
```

`daemon/deps/` and `daemon/_build/` are Mix-managed and gitignored.
The tracked `bin/shuttle` shim launches `bin/rel/bin/shuttled`.
Run root Make targets for the daily loop; run direct Mix commands inside `daemon/`.
`make build` builds the CLI, UI, and daemon; `make ui` builds just the board.
The documentation builds from the root with `mkdocs build -f docs/mkdocs.yml`.

The UI harnesses mount real components against a mocked daemon.
Run `npm run harness` or `npm run harness:board` inside `ui/` to build
self-contained bundles in `ui/harness-dist/` and `ui/harness-board-dist/`.
They open over `file://` without a running daemon.

## Tests

```bash
make test                  # go test ./... + mix test + the board suite + the plugin hooks
go test ./...              # Go (felt CLI)
make mix-test              # full Elixir suite
(cd daemon && mix test --only focus)  # tagged subset
(cd ui && npm test)        # the board suite; runs vitest TWICE, under two
                           # pinned TZs (America/Los_Angeles, Europe/Paris)
bash scripts/test-plugin-hooks.sh  # the shell hook shims, HOME and PATH sandboxed

# Opt-in real harness smoke. Opens real Claude/Codex/Pi CLIs in tmux,
# sends no prompt, captures the idle pane, then kills the smoke sessions.
(cd daemon && SHUTTLE_REAL_HARNESS_SMOKE=1 mix test --only integration test/shuttle/real_harness_smoke_test.exs)
```

**The board suite runs twice on purpose, in both local tests and CI.** The
second pinned offset is where the civil-day logic breaks, so a hand-run `npx
vitest run` can go green on a change `make test` would fail. CI runs `npm test`
under America/Los_Angeles and Europe/Paris, then type-checks and builds the
bundle with `npm run build`.

The real harness smoke is deliberately outside ordinary `mix test`. It uses
tmux session names like `shuttle-harness-smoke-<harness>-<unique>`, records
captures under `daemon/_build/test/shuttle_harness_smoke/`, and skips harnesses that
are not available in `bash -l`.
