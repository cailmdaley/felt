# felt + shuttle — Contributor & Operator Notes

One repo, one checkout, four artifacts:

- **felt CLI** (`cmd/felt`, Go) — a lean memory and note-keeping tool for
  Markdown fibers. It preserves unknown frontmatter as opaque data, including
  `shuttle:` blocks, and knows nothing about Shuttle.
- **shuttle CLI** (`cmd/shuttle`, Go) — the network and orchestration layer
  built on felt. It owns Shuttle's schema, host and fleet configuration,
  lifecycle, messaging, and resolved fiber views.
- **shuttle daemon** (`daemon/`, an Elixir/OTP Mix release) — the dispatcher.
  It shells out to `felt` for fiber content and writes, and to `shuttle` for
  orchestration. It polls the fiber tree, launches terminal workers,
  exposes a `:4000` snapshot/control API, and watches each worker.
- **the board UI** (TypeScript, `ui/`) — four full-page views over the fiber
  tree and the fleet's session/commit ledgers (Desk kanban, Chronicle, the
  Board canvas of sent work, and the Globe of the whole fleet), plus a settings sheet on `⌘,` over every host's
  operator files. It keeps the map and renders no conversation: that lives in
  Rex. The daemon serves it at `http://127.0.0.1:4000/`.

felt owns fiber storage and generic frontmatter. shuttle owns the network and
orchestration; the daemon is the production dispatcher.

**Fibers are ordinary Git-synchronized documents; execution is host-owned.**
Before `felt sync`, agents commit the store's dirty fiber changes, including
other sessions' edits and daemon lifecycle writes; mixed commits are fine.
Sync before substantive work and publish with `felt sync --push`. Resolve Git
conflicts with the work's context. Role charters live at `roles/<role>` or `<mount>/roles/<role>`
(docs/concepts/roles.md) and have no host owner. A constitution's `shuttle.host` selects the daemon
allowed to execute it; synchronizing its file does not transfer execution.
Armed cross-host creation and control use the owner daemon's existing APIs; the owner writes its store directly, independently of Git archive state.
The daemon never runs Git or `felt sync`; a missing document returns not-found with its host and identifier.
Remote-owned live state comes from the owner daemon; an unreachable-owner fallback to an archive copy is explicitly marked stale.
The live board uses those same owner-routed APIs for host-local content and control.

## Where everything else lives

This file is the spine: orientation, invariants, and the daily loop. Depth
lives in the docs site (`docs/`, published to
<https://cailmdaley.github.io/felt/>).

| Looking for | Read |
|---|---|
| Architecture stance, stores/views, the `shuttle:` block, platform story | [`docs/dev/architecture.md`](docs/dev/architecture.md) |
| Make targets, restart discipline, the deploy ritual, remote deploy, UI bundle | [`docs/dev/build-and-deploy.md`](docs/dev/build-and-deploy.md) |
| Poller eligibility, stores vs picker projects, prompt structure | [`docs/dev/dispatch.md`](docs/dev/dispatch.md) |
| `shuttle` CLI and daemon surface, sanity ladder, symptom debugging | [`docs/dev/operating.md`](docs/dev/operating.md) |
| Event stream + ledger writer/reader contract | [`docs/dev/event-stream.md`](docs/dev/event-stream.md) |
| Plugin integration, `scripts/release.sh`, release candidates | [`docs/dev/releasing.md`](docs/dev/releasing.md) |
| Codebase layout, test suites | [`docs/dev/layout.md`](docs/dev/layout.md) |
| Writing a test: where it goes, tiers, fixtures, properties | [`docs/dev/testing.md`](docs/dev/testing.md) |
| Installing a daemon, keep-alive, Rex, Remote Control | [`docs/shuttle/installation.md`](docs/shuttle/installation.md) |
| Stores, agents, host classes, remotes, Tailscale | [`docs/shuttle/configuration.md`](docs/shuttle/configuration.md) |
| macOS TCC and other sharp edges | [`docs/shuttle/troubleshooting.md`](docs/shuttle/troubleshooting.md) |
| Fiber model, frontmatter, cross-project stores | [`docs/concepts/`](docs/concepts/) |
| CLI verbs, daemon HTTP API | [`docs/reference/cli.md`](docs/reference/cli.md), [`docs/reference/api.md`](docs/reference/api.md) |

For daemon Elixir/OTP changes, read the `practices/elixir` felt practice (`felt show practices/elixir`).

## Critical invariants

- **A host's terminal backend launches its workers.** `host.json` selects
  `terminal`: `tmux` (default) or `rex`. Shuttle's worker name is the identity
  each backend renders; on Rex, the daemon-written session/window/block binding
  is authoritative, with one session per constitution family and one window per
  worker. Remote Control and Hark use the selected backend too. Shuttle starts a
  missing Rex server but never stops one, so daemon restarts and CLI installs
  preserve sessions. Details: [`docs/dev/architecture.md`](docs/dev/architecture.md#platform-story),
  [Rex setup](docs/shuttle/installation.md#rex-terminal-backend).
- **Execution backends own conversations; shuttle owns task assignment and observation.**
  Claude, Codex and Pi workers use the selected terminal backend. Existing
  conversations retain their native identity across daemon restarts; a closed
  terminal viewer does not mean its conversation has died. `shuttle attach`
  opens the existing worker session when supported by the selected backend.
- **felt is the fiber library; shuttle owns Shuttle's schema and behavior.**
  felt preserves a `shuttle:` block as opaque frontmatter and never validates
  or resolves it. The shuttle CLI uses felt's Go library to read and write
  fibers. The daemon shells `felt` for fiber content and generic fiber writes,
  and `shuttle` for Shuttle-owned operations, including resolved reads through
  `shuttle ls` and `shuttle show`. Do not import either CLI package into the
  daemon. A test enforces the one-way import rule: felt packages cannot depend
  on shuttle or messaging packages.
- **Shuttle lifecycle writes are serialized with polling.** The board's
  `resume` and `rest` run inside the owning daemon's Poller, and the daemon's
  own writes go through the CLI's locked document writer, which refuses stale
  state. At boot, `shuttle contract` must match `daemon/lib/shuttle/contract.ex`;
  the daemon holds on a skew. Details: [`docs/dev/dispatch.md`](docs/dev/dispatch.md#lifecycle-writes).
- **Live host-addressed content and control use `Shuttle.OriginRouter`.**
  The composite board carries each row's `origin` back to the daemon for
  requests such as `/api/v1/fibers/:id?body=true` and `/file`, so it can display
  that host's current content and artifacts without waiting for Git sync.
  Route requests for host-local assets and execution through the selected
  daemon. Ordinary synchronized notes, including role charters,
  are read and edited locally; they do not need an origin registry.
- **The Shuttle CLI owns the agent registry.** It layers the embedded
  `internal/shuttle/agents.builtin.json` with
  `~/.config/shuttle/agents.json` (or `SHUTTLE_AGENTS_FILE`). The user file can
  set `builtins: "restrict"` to replace the shipped layer on one host. Records
  merge wholesale by id; `overrides` patches `default_effort`, and
  `shuttle agents effort <id> <level>|--reset` is the structured writer.
  `shuttle agents init` seeds a complete example. A malformed user file fails
  with its path; a missing one is silent. The daemon reads resolved agent
  records through `shuttle ls`/`shuttle show` and shells `shuttle agents
  resolve` when it has no fiber record to read. There is no daemon-embedded
  registry. Loom's `setup.sh` separately owns interactive Pi's global
  `~/.pi/agent/settings.json`; this registry does not configure that default.
- **Remote daemons come from the tailnet, with `~/.config/shuttle/remotes.json`
  for exceptions.** Each daemon discovers same-user tailnet peers that answer
  `/api/v1/version` and names them by the `host` id they report; the file adds
  hosts outside the tailnet and overrides or suppresses discovered ones. The
  daemon and the Go CLI merge the two with the same pure resolver, kept in
  parity by shared fixtures; the CLI takes discovered peers from the local
  daemon and never probes the tailnet. Nothing about hosts is baked into a
  build. Details: [`docs/dev/architecture.md`](docs/dev/architecture.md#the-fleet),
  [Connect your machines](docs/shuttle/remotes.md).
- **No personal hostname or path in the published surface.**
  `internal/feltcli/hygiene_test.go` scans `daemon/config/`, `daemon/lib/`,
  `cmd/`, `daemon/share/`, `ui/`, `bin/`, every `.md` file, `Makefile`, and
  `scripts/bootstrap.sh`. Keep host-specific details in fibers.
- **`shuttle.agent` drives agent selection.** The `shuttle:` block's `agent:`
  field resolves against the registry. The default agent is `claude-opus`.
- **`shuttle.host` drives daemon affinity — strictly.** A daemon dispatches a
  block iff `block.host == own_host_id`. The id comes from `SHUTTLE_HOST`, then
  `~/.shuttle/host`, then the normalized OS hostname; `shuttle host seed`
  writes the identity explicitly. The daemon takes `SHUTTLE_HOST` or asks
  `shuttle host --json` once at boot and freezes the answer; it does not boot
  if shuttle cannot answer. There is no `"local"` default and no `nil`
  wildcard: an absent or empty `host:` is unowned and ineligible on every
  daemon. `shuttle install` and `shuttle repeat` stamp `host` by default. The
  same predicate gates orphan resurrection, so a remote restart can't
  re-grab another host's fiber.
- **Two kinds; one resting place.** `shuttle.kind` is `oneshot` or
  `standing` (which carries a cron `schedule:` and has no review: a run's exit
  re-arms it, a run that needs the human asks, `rest` pauses the schedule and
  `close --tempered=false` retires it). The CLI
  (`shuttle.NormalizeKind`), the daemon (`Poller.block_kind`) and the board
  read a `pinned` kind as `oneshot`, and `shuttle check` warns about it. A
  constitution at rest is `status: open` + `horizon: stashed`, drawn in
  Resting; `shuttle rest` puts it there without review. "Role" names only an
  identity under `roles/`, never a kind of constitution. A constitution with
  `shuttle.role: <role-slug>` and `shuttle.seat: true` is a seat of that office (`shuttle seat`); at rest
  the board draws it in the Roles band, and its lifecycle is unchanged.
- **`shuttle.project_dir` is required for armed installs.** `shuttle install`
  and `shuttle repeat` require `--project-dir`; workers start there instead of
  falling back to the felt store.
- **Shuttle CLI and daemon lifecycle have one command tree.** Local Shuttle
  writes validate before writing and work offline; `snapshot` and `dispatch`
  ask the daemon. `shuttle daemon start|stop|status|release|reset|install|uninstall`
  manages the daemon and its supervisor. `shuttle version` reports the running
  daemon version or local Mix release version; `shuttle doctor` diagnoses host
  and daemon state.
- **No tag predicate for dispatch — two gates, both explicit.** A fiber is
  Shuttle-managed iff it carries a `shuttle:` block. It dispatches iff (1) its
  felt `status` is `active` and (2) fresh autonomous work is not held by the
  boot quarantine. Every boot holds fresh launches in `pending_launch` until
  `shuttle daemon release` (an opted-in host may release itself after a proven
  hard-kill bounce, never after an asked-for restart); workers that were running
  restore without it, due standing occurrences keep their scheduled
  authorization, and force-dispatch bypasses it. There is no `enabled` flag.
  Tags are free-form qualitative noticings. Details:
  [Boot quarantine](docs/shuttle/lifecycle.md#boot-quarantine),
  [`docs/dev/dispatch.md`](docs/dev/dispatch.md).

## The daily loop

```bash
make build                 # both Go CLIs + UI + daemon release
make build SKIP_UI=1       # ditto, leaving ui/dist to whatever put it there
make cli                   # build felt and shuttle
make cli-install           # install both Go CLIs → ~/.local/bin
make restart               # rebuild UI + release, then stop + start
make status / make logs    # daemon status / tail the daemon log
```

**Worktree builds never touch the host daemon.** `make build` and `make daemon`
only build local artifacts. `make restart` selects and cycles only from the main
checkout; `make start` follows the existing selection and is also main-checkout-only.
Linked-worktree restart only builds and prints deployment
guidance, and linked-worktree stop refuses a foreign release. Deploy a committed
worktree revision with `bin/shuttle-deploy --hosts local --ref <commit>`, or run
`make restart` in the main checkout.

`npm ci` is stamped on `ui/package-lock.json` and runs only when the lockfile
moves; `npm run build` runs every time.

Editing `daemon/lib/*.ex` needs `make restart` (a restart without `make daemon` is a
no-op — the release runs compiled BEAMs). Editing either Go CLI needs `make cli`.
Editing `ui/` needs `cd ui && npm test` and `go test ./internal/feltcli -run Hygiene` (the hygiene scan covers `ui/`, harness fixtures included), then `make restart` from the root.
Changing anything the board draws also wants a look at it: `cd ui && npm run
harness:board` builds a self-contained bundle with a mocked daemon that opens
over `file://`, which is the only way to see the board where `:4000` is
unreachable — and the only way to stage states a live fleet will not hold
still for.
Source builds require Go, Elixir/OTP, Node/npm, and Python 3 on each host.
Python 3 publishes the release symlink atomically.
To cycle a supervised daemon directly, use
`launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon` or
`systemctl --user restart shuttle-daemon`.

### Tests

```bash
make test                  # go test ./... + mix test + the board suite + the plugin hooks
go test ./...              # Go (felt and shuttle CLIs)
make test-linux            # the Go suite in a Linux container, as CI runs it
make mix-test              # full Elixir suite (shells felt and shuttle: make cli-install first)
cd ui && npm test          # vitest, once, under TZ=America/Los_Angeles
```

**macOS is not CI's platform.** `/bin/sh` is bash on macOS and dash on CI's
Ubuntu runner, and `/proc`, systemd and tmux differ too, so shell scripts and
OS-facing Go can pass locally and fail on CI. Before pushing changes there,
run `make test-linux` (`scripts/test-linux.sh [go test args]`; Apple's
`container` CLI, or docker). Cached runs take seconds.

**The board suite runs once, under one pinned zone.** `npm test` pins
TZ=America/Los_Angeles, a negative-offset DST zone, so view code that defaults
to the host zone renders deterministically and away from UTC. Zone coverage
does not come from the pin: every zone-dependent computation lives in
`ui/src/board/civilDay.ts` and takes its zone as a parameter,
`civilDay.properties.test.ts` checks its laws across the IANA zone database,
and `ui/test/zoneReads.test.ts` fails on a local-zone `Date` read anywhere
else.
CI runs `npm test`, then type-checks and builds the bundle with
`npm run build`.

### Deploying

Restarting the daemon preserves terminal workers: the terminal backend owns
their processes, while Shuttle owns their watchers. Every daemon cycle arms the
boot quarantine, and a daemon route change ships with its matching UI
(`make build` builds both).

A worker deploys its own verified change with `bin/shuttle-deploy`
(see [Landing changes](#landing-changes)):

```
resolve one commit → push → on each host, under its deploy lock: build the SHA
→ install the CLIs → activate → verify the fresh daemon → release its quarantine
→ fast-forward the clean checkout → refresh harnesses
```

Locks, leases, deadlines, cancellation, logs, rollback, cluster builds and
harness refresh: [`docs/dev/build-and-deploy.md`](docs/dev/build-and-deploy.md).
Fetched-release users do not need this helper.

## License

The repo is **MIT** (both Go CLIs + UI). The shuttle daemon (`daemon/lib/`) contains
code derived from OpenAI's Symphony under the **Apache License 2.0**, preserved
in `NOTICE` and `LICENSE-APACHE`.

## Landing changes

Run the targeted local tests before pushing; use the full suite for broad changes.
CI is feedback, not a landing or deployment gate: do not wait for CI after pushing.
The repo's SessionStart hook prints the cached latest completed main CI result when red and refreshes it in the background for the next session.

Each lane lands its own work. It commits on a branch or worktree, runs the
suites its change touches, rebases onto `origin/main` and reruns them if `main`
moved, then pushes `main` linearly. It deploys to the hosts the change affects
(`bin/shuttle-deploy --hosts ...`, then `shuttle daemon release`): a UI-only
change goes to the hubs whose board is opened; daemon or CLI changes go
fleet-wide, a contract or route change with its matching UI. The per-host
deploy lock serializes concurrent lanes; a lane that finds it held waits for it.
Verify the hosts and report the landed SHA and hosts. A host that needs the
human's MFA is reported and skipped.

No PRs and no long-lived branches: iteration happens on `main`, one small
improvement after another, rather than across review boundaries. Hold a landing
only for a failing or unrun required local test; an open design question gets a
decision fiber and a best call, not a pending branch. Screenshots that would have
gone in a PR body go to the human with `shuttle send-file` and into the fiber.

## Contributing

See `CONTRIBUTING.md`.
