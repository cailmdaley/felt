# Writing tests

This guide is for anyone, human or agent, adding a test to felt and shuttle.
It answers four questions: where the test goes, which tier it runs in, which
fixture or generator to reuse, and how to write a property. The commands for
running each suite are in [layout.md](layout.md#tests).

Run `cd ui && npm test` for the board's unit and integration tests.
Run `cd ui && npm run e2e` for every headless harness browser journey: workspace (including header, living-report, radial, Tree and Globe journeys), document request budgets, and performance budgets.
The command builds both bundles, runs every suite even when one fails, and exits nonzero on any failure.
It reuses the shared headless browser when available; `SHARED_BROWSER=1` starts or reuses it explicitly.
The `*-live.mjs` probes require a live daemon and are opt-in, separate from this harness gate.

`cd ui && npm run e2e:change` builds the change-reader ES-module harness and checks every virtual diff window, including open shadow DOM, against an independent parse of real `git diff` output.
The fixtures cover story excerpts, tests, remaining hunks, folded generated files, hostile filenames and a blocked lazy Go grammar chunk, on desktop and phone.
The source of truth is Git's changed side, line number and text, not the CLI bundle's hunks or the highlighting library's parser.
The full `npm run e2e` recipe and CI include this gate.
Set `CHROME_PATH` to a headless Chrome executable, or install Chromium with `npx playwright-core install chromium`; the browser helper also supports the shared headless browser.
`CHANGE_DOM_INJECT_LOSS=1 npm run e2e:change` removes rendered changed rows before comparison and must exit nonzero.
The unit contract test and browser gate create their own disposable Git histories; neither needs an origin remote or old commits in the source checkout.

`scripts/check-codex-tui.sh` is an opt-in native Codex launch check for a host
with Codex, tmux, and an existing Codex auth file. It launches the executable
directly in a private tmux server and temporary `CODEX_HOME`, waits for both
the TUI banner, workspace path and input composer, then closes its private
terminal and stops Codex's private managed daemon. It copies the host's own
`auth.json` into that temporary home and sends no model prompt.

## Production boot gate

`daemon/test/shuttle/application_boot_test.exs` compiles production BEAMs once per suite in a private `MIX_BUILD_PATH`, with `REBAR_BASE_DIR` isolating dependency compiler state too, independent of release builds.
Separate VMs verify the loaded BEAM path and production environment, enable every production child, use real Go CLIs and isolate operator files.
A synthetic Tailscale CLI drives sixteen probes against reserved `.invalid` names.
The healthy case reaches ready; the FIFO case keeps HTTP diagnostics live beyond sixteen seconds, refuses dispatch, and recovers in the same daemon after an external writer replaces the registry.
The realistic case uses 3,000 managed fibers and real tmux on a private socket, delays inventory eighteen seconds, then requires ready and all documents cached.
Codex is an external executable stub. These gates require tmux, preserve production quarantine and read the dirty-I/O scheduler count from release VM arguments.
A new production child belongs in the independent manifest in `test/support/production_boot.exs`.

## Real Hark pause probe

`daemon/test/shuttle/meeting_pause_real_test.exs` runs the installed Hark CLI against a private `HARK_DIR` and a live Hark `PauseMonitor` with synthetic PCM, without opening audio devices or loading recognition models.
It checks both track gates, transcript pause/resume markers, repeated requests, and restoration of mic-only versus mic + system capture.
With Hark installed in a Python environment, run from `daemon/`:

```bash
SHUTTLE_TEST_HARK_PYTHON=/path/to/hark/venv/bin/python mix test test/shuttle/meeting_pause_real_test.exs --include integration
```

The environment's `bin/hark` must be beside that Python executable.
The normal suite excludes this integration probe.

## Native filesystem I/O

`daemon/test/shuttle/fs_test.exs` exercises caller-owned raw operations with `file_server_2` suspended in an isolated VM.
An exact-path source audit covers all daemon modules; only `shuttle/fs.ex` may use the file APIs behind that boundary.
The suite also checks raw stream read-ahead, explicit buffer options, universal timestamps in a negative-offset host zone, and protected-store exclusion diagnostics.

## Required real Codex plugin tests

CI's Go job and `make test-linux` install checksum-pinned Codex 0.166.0 with
`scripts/install-test-codex.sh` and set `FELT_REQUIRE_REAL_CODEX=1`. Under that
flag, a missing or too-old Codex is a failure, not a skip. The Linux image key
includes the installer checksum so changing the pin rebuilds the image.

`TestCodexHookTrustRealPrivateAppServer` and
`TestCodexHookTrustRealLiveRefresh` use isolated HOME/CODEX_HOME directories,
private stdio App Servers, and a loopback-only inference stub; no account,
operator session, shared daemon, or public inference endpoint is involved.
They cover trust, live migration, Go-only and skills-only updates, and require
`skills/list` to discover enabled, readable `felt-skills:felt` and
`felt-skills:shuttle` skills. The migration probe also observes old skill paths
vanishing and the live inventory finding the replacement names.

## Real Claude message delivery

`scripts/check-claude-auto-mail.py --shuttle /path/to/built/shuttle` is an opt-in transport probe for a host with Claude Code installed.
It starts real Claude Code with a private home, configuration, mailbox and loopback-only inference stub; it uses no account, operator session, live daemon or public inference endpoint.
Build the checkout's CLI into a temporary directory and pass its absolute path rather than installing it.

The probe checks mid-tool delivery, a realistic four-second inference gap, interruption of a tool after a queued message, native fallback after the final tool, parent-only mail during a subagent, stopped-worker wake, and API-failure recovery.
Transport cases explicitly allow native inbound messages and require exactly one main-thread reply to each unique token.
The subagent case checks that no child inference request contains the parent's mail.
A separate default-policy case omits `crossSessionInbound` and checks that headless Claude holds a native message for approval and Shuttle reports the hold rather than claiming delivery.
Daemon tests also run the production recovery CLI against a private mailbox; Go tests exercise bounded retries, crash ownership, sender notices, order and context limits.
The replies come from the deterministic stub, not a public model; this tests the installed harness's transport behavior, not authenticated inference.
Use `--mode` to select cases and `--output` to retain API requests, hook inputs/outputs and receipts at a chosen path.

## Real Rex tests

`daemon/test/shuttle/terminal/rex_real_test.exs` and `internal/shuttlecli/terminal_rex_real_test.go` start a private Rex server on a temporary Unix socket with its own state directory.
They run when Rex is installed and skip when it is absent.
The daemon suite launches sibling workers without a live family root, checks one session with ordered, labelled windows, then stops both and checks that the owned session is gone.
`terminal/rex_families_test.exs` covers family resolution, concurrent sibling launches, window-local close, exact-window reveal, viewer tabs and human-window preservation with the fixture-backed runner.
Point all test CLI calls at that socket, stop the isolated server in cleanup, and never create or destroy sessions on the operator's server.

`terminal/codex_rex_real_test.exs` is an opt-in native Codex messaging check.
With the checkout's Go CLIs first on `PATH`, run it with
`SHUTTLE_TEST_CODEX_AUTH="${CODEX_HOME:-$HOME/.codex}/auth.json" mix test test/shuttle/terminal/codex_rex_real_test.exs --include integration`.
It copies only that auth file into a temporary `CODEX_HOME`, starts a private Rex server, and sends short model prompts in a temporary workspace outside the repository.
It delays Codex startup beyond capture timeout, restarts the Poller, and requires the acquired UUID in both the fiber and ledger before sending real CLI messages by address and fiber.

## What a test is for

**A test names the failure it catches.** Before writing one, say what bug
would turn it red. A test that only restates the code (it asserts a constant
equals itself, or that a mock received what the test just handed it) catches
nothing and breaks on every refactor. Leave it out.

**Every test is seen to fail.** Once a test passes, break the behaviour it
names: flip the condition, drop the header, delete the binding. Watch the
test go red for that reason, then restore the code. A test nobody has seen
fail cannot be told apart from one that cannot fail.

**Pass state in; don't change the world.** When the code under test depends
on ambient state (the time zone, environment variables, `PATH`, `HOME`, the
clock, a registered process), make that state a parameter and set it per
test. Don't set it process-wide, and don't rerun the whole suite once per
value. This is what lets the suites run concurrently:

| Ambient state | Elixir (daemon) | Go (CLIs) | TypeScript (board) |
|---|---|---|---|
| env, app env, `PATH` | `Shuttle.Test.Env` (`daemon/test/support/env.ex`); lib reads only through `Shuttle.Env` | the injected `sysenv.Env`; tests build one with `sysenvtest` | n/a |
| named singletons | `Shuttle.Test.Env.start_scoped!/server!`; lib reaches them through `Shuttle.Env.server/1` | per-invocation app value; no package-level seams | inject the instance at the owning controller |
| time zone | n/a | n/a | the `Zone` parameter in `ui/src/board/civilDay.ts` |
| the clock | pass `now` | pass `now` | pass `now` or a clock; fake timers only in `stateful` tests |

Guards hold these seams. In the daemon, `env_guard_test.exs` fails on a
global read in `daemon/lib` and on a global write in an async test. In Go,
`internal/sysenv/guard_test.go` fails when production code under `internal/`
reads the process (`os.Getenv`, `os.UserHomeDir`, `exec.LookPath`,
`exec.Command`, the standard streams) other than through a `sysenv.Env`. In the board,
`ui/test/zoneReads.test.ts` fails on a local-zone `Date` read outside
`civilDay.ts`. These guards read source: they catch a direct call, not every
way a path or a variable can reach the process. Isolation is the seam's job,
and each seam needs a test of its own that a miss stays inside it, as an
executable missing from a scoped `PATH` does.

**Never reach the operator's machine.** Fixtures use a fresh home, store and
config with synthetic data. The daemon's `test_helper.exs` and
`operator_files_guard_test.exs`, and the Go `TestMain` fences, pin every
operator file under a temporary root. When you add a new operator file to the
code, pin it there too.

**Wait on events, not on time.** Synchronise on a message, a monitor,
`:sys.get_state`, a channel or a promise. When the behaviour under test *is*
a timeout, shrink it through config (for example `:dispatch_call_timeout_ms`)
and pin the production default with its own assertion. A sleep used as the
success path is a flake waiting for a loaded machine. A generous outer wait
does not rescue a short inner one: if a task's call carries a two-second
deadline, a thirty-second `Task.await` around it still fails when the call
does. Make incidental deadlines failure-only all the way down, and tag the
tests whose subject is a deadline `:timing`.

## 1. Where does it go?

Tests sit beside the code they cover, grouped by the contract they pin: the
promise the code makes to a product entry point (a CLI verb, an HTTP route, a
daemon process, a board view). Before adding a file, find the contract below
and add your test to its file.

**Daemon** (`daemon/test/`):

- **Dispatch lifecycle and quarantine:** `shuttle/poller_test.exs`, `dispatcher_test.exs`, `dispatch_integration_test.exs`, `continuation_test.exs`, `standing_role_test.exs`, `lifecycle_store_test.exs`, `daemon_heartbeat_test.exs`, and `shuttle_web/controllers/{api,lifecycle,quarantine,kill}_controller_test.exs`.
- **Worker execution:** `app_workers`, `codex_app_transport`, `tmux`, `tmux_server`, `worker_watcher`, `worker_process`, `runner`, `kitty`.
- **Remotes and the tailnet:** `remotes_test.exs` (Go/Elixir parity fixtures in `test/fixtures/remotes/`), `tailnet_peers`, `tailnet_dial`, `remote_registry*`, `remote_{fiber,temporal}_registry`, `fleet_controller`.
- **Owner routing:** `origin_router`, `file_relay`, `relay_helpers`.
- **Host identity and listener policy:** `host_test.exs` (parity fixtures in `test/fixtures/host/`), `host_capabilities`, `proc_net_tcp`, `peer_gate_plug`, `peer_plug`.
- **HTTP ingress and file security:** `file_controller_test.exs`, `cors`, `large_body_parser`.
- **Operator paths and settings:** `config_files`, `felt_stores`, `projects`, `data_dir`, `harness_paths`, and the `config`, `felt_stores`, `projects` and `choose_folder` controllers.
- **Fiber documents and writes:** `fiber_doc`, `fiber_documents_admission`, `frontmatter_edit`, and the `fiber`, `fiber_documents`, `felt_edit` and `felt_nest` controllers.
- **Events and projections:** `event_stream`, `events_parity`, `activity_fold`, `file_tail`, `sent_files_projection`, `waiting_tracker`.
- **Temporal read APIs:** the `activity`, `commits`, `sent_files` and `sessions` controllers, and `temporal_composite`.
- **Session and commit history:** `session_ledger`, `session_link`, `session_resume`, `commit_ledger`, `transcript`.
- **Messaging:** the `messaging`, `deliver`, `attachments` and `claim` controllers.
- **Meetings:** `meeting_test.exs`, `meeting_transcript_relay_test.exs`, `capture_controller`, `meeting_audio_socket`.
- **Startup and readiness:** `application_boot`, `readiness`, `build_stamp`, `log_level`, `log_rotator`.
- **Test-support guards:** `env_guard_test.exs`, `env_isolation_test.exs`, `operator_files_guard_test.exs`.

**CLIs** (`internal/`):

- **Fiber model, storage, resolution and moves:** `internal/felt/` (`storage_test.go`, `felt_test.go`, `move_refs_test.go`, `check_test.go`, `lock_test.go`).
- **felt verbs:** `internal/feltcli/*_test.go`, one file per verb.
- **sync and hooks:** `feltcli/sync_test.go`, `hook_test.go`.
- **Plugin setup and receipts:** `feltcli/setup_test.go`, `plugin_*_test.go`, `runtime_receipt_test.go`.
- **Shuttle schema and the agent registry:** `internal/shuttle/`.
- **Lifecycle verbs:** `shuttlecli/lifecycle_test.go`, `create_test.go`, `reshape_test.go`, `handoff_test.go`.
- **Host identity and doctor:** `shuttlecli/foundation_test.go`, `host_class_test.go`, `runtime_receipt_host_test.go`, `doctor_test.go`.
- **Remotes and tunnels:** `shuttlecli/remotes*_test.go`, `tunnels_test.go`.
- **Daemon install and deploy:** `shuttlecli/daemon_*_test.go`, `deploy*_test.go`, `supervisor_test.go`, `launcher_test.go`.
- **Status and owner routing:** `shuttlecli/status*_test.go`, `remote_lifecycle_test.go`.
- **Events and the commit ledger:** `shuttlecli/hook_*_test.go`, `events_test.go`.
- **Messaging:** `internal/messaging/`, plus `shuttlecli/message*_test.go` and `send_file_test.go`.
- **Source policy:** `feltcli/hygiene_test.go`, `dependency_test.go`, `docs_test.go`, `help_test.go`.

**Board** (`ui/`):

- **Civil days and instants:** `src/board/civilDay.test.ts`, `civilDay.properties.test.ts`, `test/zoneReads.test.ts`.
- **Desk classification and ordering:** `boardRules.test.ts`, `KanbanComposite.test.ts`, `deskBands.integration.test.ts`, `deskOrdering.test.ts`, `moveDestinations.test.ts`.
- **Desk input:** `keymap.test.ts`, `deskKeyboard.integration.test.ts`, `longPress`, `dismissGesture`, `mobile`.
- **Dispatch actions:** `boardWire.test.ts`, `daemonApi`, `startPrompt`, `KanbanModal.verdict`.
- **Chronicle:** `src/board/views/chronicle*.test.ts`, `temporalData.test.ts`, `vocabulary.test.ts`.
- **Meetings and the phone:** `meeting.test.ts`, `src/phone/*.test.ts`, `src/forms/meeting*.test.tsx`.
- **Settings:** `src/forms/settings/`.
- **Styles and accessibility:** `ui/test/*.test.ts`.
- **The document workspace:** `src/board/workspace/`, owned by the document-workspace effort; it follows these conventions as it is rewritten.
- **Browser-only behaviour** (layout, focus, real media, animation): `ui/e2e/workspace.mjs`.

## 2. Which tier?

| Tier | What | Who runs it |
|---|---|---|
| the suites | `go test ./...`, `mix test`, `npm test` — all concurrent; each aims to finish in under a minute on a laptop, a target rather than a guarantee | every change, every lane |
| full | `make test` plus `make test-linux` (CI's Ubuntu: dash as `/bin/sh`, `/proc`, systemd) | before pushing; CI |
| browser | `npm run e2e`, which reuses the shared browser (`bin/shared-browser`) when one is running | changes to anything the board draws |
| opt-in | real harness smoke, the stranger-bootstrap container, `integration`-tagged tests | when touching what they cover |

A test belongs in a browser only if a browser is the only place it can be
decided: real layout, focus order, media playback, animation. Anything
decidable from a pure function or a DOM fragment belongs in vitest.

## 3. Which fixture?

Reuse before writing. Each language has one place for shared support:

- **Daemon:** `daemon/test/support/`.
  - `Shuttle.Test.Env`: scoped env, app env and `PATH`, and scoped servers.
  - `Shuttle.Test.FakeCli`: fake executables. They are content-addressed and warmed once, and vary their behaviour by scoped env, never by a rewritten script. On macOS a freshly written executable costs about a second on its first exec.
  - `FeltStoreRunner`: an in-memory felt store behind the runner seam.
  - `PollerHelpers`: `start_poller!` and `make_fiber`.
  - `ApiConn`, `StubPostClient`, `StubGetFileClient`, `ForwardStub` and `Ledgers`.
- **CLIs:** each package's `test_helpers_test.go`, plus `sysenvtest` for an injected environment and fake commands. Use `newStore`/`seedFiber` for stores on disk and `serveDaemon` for a fake daemon (`shuttlecli`; `daemonStub` in `provenance_test.go` routes by path).
- **Board:** `ui/src/board/testFixtures.ts` (`card`, `response`, `captureFetch`), `testDevices.ts` (`matchMediaFor` and the device presets), and `ui/harness/workspace-fixtures.ts` for the browser harness.

Parity between the Go and Elixir implementations of the same resolver is a
shared fixture table under `daemon/test/fixtures/<resolver>/`, read by both
suites. A change to one implementation changes the table, and the other
suite holds it to the same answers.

## 4. How to write a property

Write a property when a rule holds over a wide input space: a resolver, a
parser, a normaliser, an ordering, a state machine, a round trip. Write
separate examples when you have a few distinct stories. When the inputs are
a finite set the product declares (key bindings, routes × content types),
iterate *the declaration itself*, so that a new entry is covered without
editing the test.

- Libraries: **fast-check** in the board (see `civilDay.properties.test.ts`), **StreamData** in the daemon, and Go's native fuzzing or `testing/quick`.
- Check the rule against an independent oracle (`Intl` formatting for a day, a brute-force model for an ordering), or as an invariant: idempotence, a round trip, invariance under permutation, monotonicity. A property that recomputes the implementation proves nothing.
- Keep generators narrow enough to read as documentation, and bias them toward the edges: DST transitions, empty inputs, unicode, the boundary values.
- Keep runs bounded and seeded: board properties pass an explicit `seed` and `numRuns` (200 is the common value), and daemon properties use `max_runs: 100`. A property should cost well under a second and fail the same way twice.
- Keep a named example beside the property for each regression worth naming, with its story in a comment.
- Mutate the rule (off-by-one, a dropped case) and watch the property go red before you trust it.

## Gotchas

- In vitest, `toEqual([])` passes against `[undefined, undefined]`. Use `toStrictEqual` or `toHaveLength` when the absence of elements is what you're asserting.
- A mutation tool's kill sets overstate redundancy. A test that kills nothing another test doesn't can still pin what operators can't express: a numeric boundary, precedence, state across calls, or the opposite-sign twin of a time-zone bug. Read before you cut. `ui/scripts/mutation-subsumption.mjs` with `ui/stryker.chronicle.config.json` is the worked example. It needs `disableBail`, or it records only the first killer of each mutant.
