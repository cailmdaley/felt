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
│   ├── harness/             offline visual-verification harnesses
│   └── e2e/                 document workspace browser suite
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
(cd ui && npm test)        # the board suite; vitest, once, under
                           # TZ=America/Los_Angeles
(cd ui && npm run e2e)     # builds the file:// harness and tests the workspace in system Chrome
make plugin-hooks-test     # shell shims, Pi adapter, handoff policy and transcript pipe tests
bash scripts/test-plugin-hooks.sh  # the shell hook shims, HOME and PATH sandboxed
node extensions/pi/real-handoff.mjs  # opt-in real Pi engine; isolated synthetic provider, no credentials
bash scripts/test-bootstrap.sh     # bootstrap.sh's login PATH and fail-fast checks, HOME sandboxed

# Opt-in real harness smoke. Opens real Claude/Codex/Pi CLIs in tmux,
# sends no prompt, captures the idle pane, then kills the smoke sessions.
(cd daemon && SHUTTLE_REAL_HARNESS_SMOKE=1 mix test --only integration test/shuttle/real_harness_smoke_test.exs)
```

**The board suite runs once, under one pinned zone.** `npm test` pins
TZ=America/Los_Angeles, a negative-offset DST zone, so view code that defaults
to the host zone renders deterministically and away from UTC. Zone coverage
does not come from the pin: every zone-dependent computation lives in
`ui/src/board/civilDay.ts` and takes its zone as a parameter,
`civilDay.properties.test.ts` checks its laws across the IANA zone database,
and `ui/test/zoneReads.test.ts` fails on a local-zone `Date` read anywhere
else (`src/board/workspace/` excepted, whose suite still guards on the pin).
CI runs `npm test`, then type-checks and builds the bundle with
`npm run build`.

### Browser checks

The workspace e2e suite, live workspace depth probe, and `themeScope` test use `ui/e2e/browser.mjs` and connect to the shared browser on port 9333 when it is running and healthy.
Set `SHARED_BROWSER=1` to start or reuse it explicitly; without a shared browser, these checks launch their local Chromium as configured.
Context options, including `colorScheme`, `reducedMotion`, `forcedColors` and `contrast`, behave the same in both modes.
The one-off scripts under `ui/scripts` retain their own browser launch paths.
Set `SHARED_BROWSER_PORT` to choose another port, and `CHROME_PATH` to select a fallback executable for checks that accept it.

`bin/shared-browser` supports `start`, `endpoint`, `status`, `stop`, and `reap [minutes]`; its logic lives in `ui/e2e/sharedBrowser.mjs`.
The browser it owns is the one whose processes carry its exact `--user-data-dir`, `$XDG_STATE_HOME/shared-browser/profile-<port>` (by default under `~/.local/state`).
It never records a PID and never signals a process without that argument, so another browser on a similar port, or with the same port and another profile, is left alone.
It hands out an endpoint only when the browser answering on the port is the one its own launch logged to `browser-<port>.log`; a port held by another browser is an error.

`start` and `endpoint` launch the browser when it is not running and refresh its idle clock; `status` reports `running`, `unresponsive` (alive but not answering CDP), `orphaned` (helpers whose browser process died) or `stopped`, with the PID, endpoint, process count, and RSS.
A browser that does not answer is reported, never killed: `stop` is the only way to end it.
`reap` defaults to 30 idle minutes; `SHARED_BROWSER_IDLE_MINUTES` changes that threshold.
It treats blank tabs and Chrome's internal New Tab targets as idle; any other page keeps the browser running.
`reap` also clears orphaned helpers and leaves an unresponsive browser alone.
`start`, `endpoint`, `stop`, and `reap` serialise on an `flock` taken through `perl`, which the OS releases when its holder dies.
The browser is found in Puppeteer's Chrome for Testing cache, a Chrome for Testing install, Playwright's cache for the revision `playwright-core` pins (honouring `PLAYWRIGHT_BROWSERS_PATH`, including `0`), `CHROME_PATH`, then system Chrome or Chromium; Playwright's headless-shell builds are not used.
It stays headless and muted, with `--use-mock-keychain` and `--password-store=basic`, so it never touches the login keychain.

Give every browser lane a unique `LANE` name so it gets a pinned tab in the shared Chrome instead of launching another browser:

```bash
LANE=tests-browser-1
agent-browser --session "$LANE" connect "$(bin/shared-browser endpoint)"
agent-browser --session "$LANE" --pin-tab tab new
agent-browser --session "$LANE" open http://127.0.0.1:4000/
agent-browser --session "$LANE" tab close
agent-browser --session "$LANE" close
```

The board e2e suite uses a fixed clock, Europe/Paris time, and a mocked daemon; it never operates real fibers.

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

Production code under `internal/` reads the process — environment variables,
home and working directory, executable lookup, child processes, standard
streams — only through a `*sysenv.Env` (`internal/sysenv`) handed down from
the command's entry point; `cmd/felt` and `cmd/shuttle` build it from the live
process, and each invocation gets a fresh command tree. A test builds an
isolated env instead (`sysenv.New`, or `sysenvtest.FromProcess` plus
`sysenvtest.FakeCommand` for fake executables on its own PATH), so tests run
with `t.Parallel()` and none mutates process state. `internal/sysenv`'s
`TestProductionReadsTheProcessOnlyThroughEnv` fails on a direct read outside
the seam; its allowlist names each deliberate exception and why.

The felt CLI and shuttle CLI unit-test binaries each run behind a `TestMain`
fence (`internal/feltcli/testmain_test.go` and
`internal/shuttlecli/testmain_test.go`), and each package's `testEnv(t)`
carries the same fence as a per-test env. The felt CLI fences its home, cache,
and config paths; the shuttle CLI fences its home, Shuttle config files, host
identity, and daemon URL. A test never reaches the machine's live daemon or its
fleet; one that needs a daemon starts an `httptest` server and points its
env's `SHUTTLE_DAEMON_URL` at it.

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
