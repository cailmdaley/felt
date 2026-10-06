# Writing tests

This guide is for anyone, human or agent, adding a test to felt and shuttle.
It answers four questions: where the test goes, which tier it runs in, which
fixture or generator to reuse, and how to write a property. The commands for
running each suite are in [layout.md](layout.md#tests).

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
- **Messaging:** `collaboration`, and the `messaging`, `deliver`, `attachments` and `claim` controllers.
- **Meetings:** `meeting_test.exs`, `capture_controller`, `meeting_audio_socket`.
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
- **Desk classification and ordering:** `boardRules.test.ts`, `KanbanComposite.test.ts`, `deskBands.integration.test.ts`, `deskOrdering.test.ts`, `queueProperties.test.ts`, `queueEdge.test.ts`, `moveDestinations.test.ts`.
- **Desk input:** `keymap.test.ts`, `deskKeyboard.integration.test.ts`, `longPress`, `dismissGesture`, `mobile`.
- **Dispatch actions:** `boardWire.test.ts`, `daemonApi`, `startPrompt`, `KanbanModal.verdict`, `composerImages.integration`.
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

- Libraries: **fast-check** in the board (see `queueProperties.test.ts` and `civilDay.properties.test.ts`), **StreamData** in the daemon, and Go's native fuzzing or `testing/quick`.
- Check the rule against an independent oracle (`Intl` formatting for a day, a brute-force model for an ordering), or as an invariant: idempotence, a round trip, invariance under permutation, monotonicity. A property that recomputes the implementation proves nothing.
- Keep generators narrow enough to read as documentation, and bias them toward the edges: DST transitions, empty inputs, unicode, the boundary values.
- Keep runs bounded and seeded: board properties pass an explicit `seed` and `numRuns` (200 is the common value; the queue properties run up to 1500), and daemon properties use `max_runs: 100`. A property should cost well under a second and fail the same way twice.
- Keep a named example beside the property for each regression worth naming, with its story in a comment.
- Mutate the rule (off-by-one, a dropped case) and watch the property go red before you trust it.

## Gotchas

- In vitest, `toEqual([])` passes against `[undefined, undefined]`. Use `toStrictEqual` or `toHaveLength` when the absence of elements is what you're asserting.
- A mutation tool's kill sets overstate redundancy. A test that kills nothing another test doesn't can still pin what operators can't express: a numeric boundary, precedence, state across calls, or the opposite-sign twin of a time-zone bug. Read before you cut. `ui/scripts/mutation-subsumption.mjs` with `ui/stryker.chronicle.config.json` is the worked example. It needs `disableBail`, or it records only the first killer of each mutant.
