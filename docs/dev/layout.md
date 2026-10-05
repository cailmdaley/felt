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
├── cmd/
│   ├── felt/main.go         felt CLI entrypoint
│   └── shuttle/main.go      shuttle CLI entrypoint
├── internal/
│   ├── feltcli/             felt command tree
│   ├── shuttlecli/          shuttle command tree
│   ├── felt/                fiber storage, parsing, and generic frontmatter
│   ├── shuttle/             Shuttle schema, registry, and orchestration
│   └── messaging/           Shuttle session and message transport
├── go.mod  go.sum           Go module
├── daemon/                  shuttle's Elixir/OTP Mix project
│   ├── mix.exs  mix.lock  .formatter.exs
│   ├── lib/                 dispatcher, poller, and HTTP API
│   ├── config/              environment configuration
│   ├── priv/                daemon assets
│   ├── rel/                 release environment template
│   ├── share/               launchd and systemd templates
│   └── test/                daemon tests and shared parity fixtures
├── bin/                     tracked operator and deploy helpers
│   └── rel/                 built daemon release (gitignored)
├── ui/                      TypeScript board; npm run build produces ui/dist
│   ├── src/board/views/     temporal and artifact views
│   ├── src/phone/           browser microphone, PCM worklet, relay, and audio session
│   └── harness/             offline visual-verification harnesses
├── claude-plugin/           Claude Code and Codex plugin payload
├── scripts/                 bootstrap, release, and verification tooling
└── docs/                    documentation, artwork, and mkdocs.yml
```

`daemon/deps/` and `daemon/_build/` are Mix-managed and gitignored.
The `shuttle` Go CLI manages the Mix daemon release and its BEAM launcher.
Run root Make targets for the daily loop; run direct Mix commands inside `daemon/`.
`make build` builds both CLIs, the UI, and the daemon; `make ui` builds just the board;
`make build SKIP_UI=1` leaves the bundle to whatever put it there.
The documentation builds from the root with `mkdocs build -f docs/mkdocs.yml`.

The board harness mounts the real board against a mocked daemon.
Run `npm run harness:board` inside `ui/` to build a self-contained bundle in
`ui/harness-board-dist/`. It opens over `file://` without a running daemon.

## Tests

```bash
make test                  # go test ./... + mix test + the board suite + the plugin hooks + the bootstrap shims
go test ./...              # Go (felt and shuttle CLIs)
make mix-test              # full Elixir suite; shells both CLIs on PATH, so `make cli-install` first
(cd daemon && mix test --only focus)  # tagged subset
(cd ui && npm test)        # the board suite; runs vitest TWICE, under two
                           # pinned TZs (America/Los_Angeles, Europe/Paris)
make plugin-hooks-test     # shell shims, Pi adapter, handoff policy and transcript pipe tests
bash scripts/test-plugin-hooks.sh  # the shell hook shims, HOME and PATH sandboxed
node extensions/pi/real-handoff.mjs  # opt-in real Pi engine; isolated synthetic provider, no credentials
bash scripts/test-bootstrap.sh     # bootstrap.sh's login PATH and fail-fast checks, HOME sandboxed

# Opt-in real harness smoke. Opens real Claude/Codex/Pi CLIs in tmux,
# sends no prompt, captures the idle pane, then kills the smoke sessions.
(cd daemon && SHUTTLE_REAL_HARNESS_SMOKE=1 mix test --only integration test/shuttle/real_harness_smoke_test.exs)
```

**The board suite runs twice on purpose, in both local tests and CI.** The
second pinned offset is where the civil-day logic breaks, so a hand-run `npx
vitest run` can go green on a change `make test` would fail. CI runs `npm test`
under America/Los_Angeles and Europe/Paris, then type-checks and builds the
bundle with `npm run build`.

### The stranger test: bootstrap in a clean container

`scripts/linux-container-acceptance.sh` checks that a stranger with a fresh
Linux account can go from a clone to a running daemon with
`scripts/bootstrap.sh` alone. It runs as root inside a disposable
`elixir:1.19` (Debian) container with the checkout mounted read-only at
`/src`: it installs the prerequisites a stranger would (tmux, git, jq, curl,
Node, npm, and the Go toolchain `go.mod` pins), creates an unprivileged user
with no systemd, clones `/src` as that user, and runs `bootstrap.sh --dry-run`
and then the full bootstrap. It passes when both Go CLIs are installed and run,
the release is built, `~/.shuttle/repo` names the clone, `shuttle-launch` is
installed, the tmux respawn loop is up, and `/api/v1/version` answers with a
healthy contract (`contract.ok`, expected equal to observed):

```bash
docker run --rm -v "$PWD:/src:ro" elixir:1.19 bash /src/scripts/linux-container-acceptance.sh
```

It prints `ACCEPTANCE-PASS`, or `ACCEPTANCE-FAIL: <step>` and exits 1. It
downloads packages and builds everything from scratch, so it takes minutes and
is not part of `make test` or CI; run it when changing `bootstrap.sh`,
`install-agent`, `shuttle-launch` or the build's prerequisites.

### Real harness smoke

The real harness smoke is deliberately outside ordinary `mix test`. It uses
tmux session names like `shuttle-harness-smoke-<harness>-<unique>`, records
captures under `daemon/_build/test/shuttle_harness_smoke/`, and requires the
harness wrappers to be available in `bash -l`.

### Harness authentication and test isolation

Ordinary tests use fake harness processes, sockets, and transcripts. They must
not launch an installed harness, run its setup against the operator's home, or
inherit authentication from the calling session. A temporary working directory
or `CLAUDE_CONFIG_DIR` alone does not isolate authentication.

Never copy, hardlink, or symlink live OAuth credentials into a test config.
A separate file still holds the same refresh token: a test process can rotate
or invalidate authentication used by the operator's sessions. Do not copy
account configuration, MCP credentials, or credential backups either. Fixtures
use a fresh home and config with synthetic data and a controlled environment;
they must not fall back to installed harness executables.

The felt CLI and shuttle CLI unit-test binaries each run behind a `TestMain`
fence (`internal/feltcli/testmain_test.go` and
`internal/shuttlecli/testmain_test.go`). The felt CLI fences its home, cache,
and config paths; the shuttle CLI fences its home, Shuttle config files, host
identity, and daemon URL. A test never reaches the machine's live daemon or its
fleet; one that needs a daemon starts an `httptest` server and sets
`SHUTTLE_DAEMON_URL` itself.

Real harness smoke is an explicit integration operation against the operator's
runtime. Even starting an idle CLI or running plugin setup can initialize or
refresh authentication. For authenticated messaging acceptance, use an
operator-started disposable receiver in its normal authenticated runtime, or
independently provisioned test authentication. Send through its registered
endpoint without duplicating its credential store or starting a second writer
for the same conversation. Do not automate login, logout, token refresh, or
credential restoration as test recovery.

If authentication fails, stop live probes and preserve evidence. Distinguish
file metadata and token-presence observations from auth-status output and model
errors; record observation times without recording secrets. An observation
after startup does not establish the state before the test. Keep authenticated
reply and active approval acceptance unverified until those checks actually
pass; a synthetic API-error response is not model-response evidence.
