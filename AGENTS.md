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
- **the board UI** (TypeScript, `ui/`) — three full-page views over the fiber
  tree and the fleet's session/commit ledgers (Desk kanban, Chronicle, and the
  Board canvas of sent work), plus a settings sheet on `⌘,` over every host's
  operator files. It keeps the map and renders no conversation: that lives in
  Rex. The daemon serves it at `http://127.0.0.1:4000/`.

felt owns fiber storage and generic frontmatter. shuttle owns the network and
orchestration; the daemon is the production dispatcher.

**Fibers are ordinary Git-synchronized documents; execution is host-owned.**
Before `felt sync`, agents commit the store's dirty fiber changes, including
other sessions' edits and daemon lifecycle writes; mixed commits are fine.
Sync before substantive work and publish with `felt sync --push`. Resolve Git
conflicts with the work's context. Role charters live under `roles/`
and have no host owner. A constitution's `shuttle.host` selects the daemon
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
| Installing a daemon, keep-alive, macOS TCC, sharp edges | [`docs/shuttle/installation.md`](docs/shuttle/installation.md) |
| Fiber model, frontmatter, cross-project stores | [`docs/concepts/`](docs/concepts/) |
| CLI verbs, daemon HTTP API | [`docs/reference/cli.md`](docs/reference/cli.md), [`docs/reference/api.md`](docs/reference/api.md) |

For daemon Elixir/OTP changes, read the `practices/elixir` felt practice (`felt show practices/elixir`).

## Critical invariants

- **A host's terminal backend launches its workers.** `host.json` selects `terminal` (`tmux` by default or `rex`); Shuttle's worker name is the identity each backend renders.
  On Rex, the daemon-written binding to session, window and block IDs is authoritative.
  Each constitution family has one session and each worker or viewer has one window; only block labels retain worker names for recovery.
  Family placement is fixed at launch, and closing a worker removes its window, then its session only if empty and daemon-created.
  Remote Control and Hark use the selected backend too. Rex auxiliary launches retain
  ownership, exit receipts and output in Shuttle-owned files; a changed server instance
  makes an old launch dead. Rex hosts need no tmux anchor.
  A Rex host also observes and stops existing tmux workers when tmux is available.
  On Linux, `bin/rex-install` installs the checksum-verified snapshot rootlessly; `"terminal": "rex"` selects it in `host.json`.
  Shuttle starts a missing server on `unix://<data dir>/rex/server.sock` with state in `<data dir>/rex/state`, requesting the Tailscale-identified port 7297 listener and falling back to local-only when startup fails.
  `SHUTTLE_REX_SERVER` wins over that endpoint or macOS discovery, and workers inherit it.
  macOS app activation runs only on macOS.
  Shuttle never stops the server: daemon restarts and CLI installation preserve sessions; `rex server stop` ends every session.
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
  `accept` and `resume` run `shuttle <verb> <fiber> --local` inside the owning
  daemon's Poller, serialized with its state changes. A poll read in flight sees
  the old document or the new one, whose status and `handed_off_at` land in
  one atomic write. `Shuttle.LifecycleStore` owns worker-exit, force-dispatch and migration writes.
  Migration applies two locked document patches through `shuttle migrate-documents`
  and journals resource ownership before changing the backend; unresolved recovery
  holds every launch, including force, cron and previously observed workers.
  The CLI's locked `standing-transition` checks the current run and human lifecycle state; `patch-document` refuses a stale source digest.
  At boot, `shuttle contract` checks level 35 against `daemon/lib/shuttle/contract.ex`; the daemon holds on a skew.
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
  for exceptions.** Each daemon's `Shuttle.TailnetPeers` reads the tailnet
  status (the LocalAPI over `defaults.tailscale_socket`, else over
  `bin/tailscaled-launch`'s `$HOME/.local/state/tailscale/tailscaled.sock` on
  Linux when it is a socket owned by this uid reached through real, private
  directories from `$HOME`, else the `tailscale` CLI; `"system"` forces the
  CLI),
  probes each same-user peer's `/api/v1/version`, and names every Shuttle daemon
  by the `host` id it reports; it refreshes every minute.
  When Tailscale is absent or failing, it retains recently verified peers for up to ten minutes after their last successful probe, then uses the file alone. The file adds hosts outside
  the tailnet and overrides discovered ones: a configured entry wins over a
  discovered peer of the same name or URL, `"enabled": false` suppresses one,
  and `defaults.discover: false` turns discovery off. The daemon
  (`daemon/lib/shuttle/remotes.ex`) and the Go CLI (`internal/shuttlecli`) read
  the file at runtime and merge it with the same pure resolver; the CLI takes
  discovered peers from the local daemon's `/api/v1/version` and never probes
  the tailnet itself. Nothing about hosts is baked into a build.
  `shuttle remotes list|add|rm|path` manages the file, and `list` (which shows
  each peer's source) doubles as the validator used by the board's settings
  sheet. Shared fixtures (`daemon/test/fixtures/remotes/`,
  `daemon/test/fixtures/tailnet_peers/`) enforce Go/Elixir parity.
  `internal/feltcli/hygiene_test.go` fails the build on a personal
  hostname or path anywhere in the published surface: `daemon/config/`,
  `daemon/lib/`, `cmd/`, `daemon/share/`, `ui/`, `bin/`, every `.md` file,
  `Makefile`, and `scripts/bootstrap.sh`. Keep host-specific details in fibers.
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
  `standing` (which carries a cron `schedule:`). A retired `pinned` still
  reads as `oneshot` in the CLI (`shuttle.NormalizeKind`), the daemon
  (`Poller.block_kind`) and the board, and `shuttle check` warns about it. A
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
  felt `status` is `active` and (2) fresh autonomous work is not held by boot
  quarantine. A restart parks fresh launches in `pending_launch` until
  `shuttle daemon release`. A worker that was already running is restored
  automatically: a finished turn reopens quietly, while durable hook evidence
  of an interrupted turn supplies the resume prompt; ambiguous turn evidence
  reopens quietly. Restorations do not release the quarantine. Due standing
  occurrences retain their scheduled authorization. On a host opting into
  `quarantine_auto_release`, a hard crash boot can release fresh dispatch if
  the previous daemon had been released,
  returned within the heartbeat window on the same machine, and did not
  crash-loop (`Shuttle.DaemonHeartbeat`). An asked-for restart — every deploy
  and operator restart, `make stop`, or re-running `bin/shuttle-launch` — leaves
  a stop marker and holds fresh dispatch. An unreleased hold survives hard
  kills. There is no `enabled` flag; force-dispatch bypasses the quarantine.
  Tags are free-form qualitative noticings.

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
else (`src/board/workspace/` excepted, whose suite still guards on the pin).
CI runs `npm test`, then type-checks and builds the bundle with
`npm run build`.

### Deploying

Restarting the daemon preserves terminal workers: the terminal backend owns their processes, while Shuttle owns their watchers.
Workers do not deploy for themselves: a verified change goes to the materializer seat (see [Landing changes](#landing-changes)), the one driver of `bin/shuttle-deploy`.

```
resolve one commit → push → preflight origin availability and default-branch freshness
→ on each host, under its deploy lock and tree lease: prepare the detached SHA root
→ make build + make cli-install → activate through the selected supervisor
→ verify SHA, fresh boot, canonical release_path, ready, contract.ok=true,
  reconciliation_hold=null and incarnation → release quarantine for that incarnation
→ fast-forward the clean regular checkout → refresh harnesses → prune
```

Automated quarantine release posts the verified `{incarnation, release_path}` as `expected` to `/api/v1/quarantine/release`; a replacement incarnation returns HTTP 409 and needs verification.

`bin/shuttle-deploy` uses the fleet in `~/.config/shuttle/remotes.json` and each host's login environment.
Every run builds the resolved commit in `<main-worktree>.deploy/<sha>`, including default and linked-worktree invocations.
Remote targets require that origin advertises history containing the commit; an implicit target must descend from the checkout's fetched upstream.
Use `--ref` for an intentional rollback; an explicit commit object has no ref to push.
The caller snapshots its entrypoint in memory, and serialized remote scripts travel on stdin rather than in SSH command arguments.
A ready target coalesces without another build or daemon cycle.
Host lock waits are bounded by `SHUTTLE_DEPLOY_LOCK_TIMEOUT_SECONDS` (3600 seconds), and name the holder.
The helper, transaction and local builds hold the locks until their last descriptor closes; preparation, harness and activation command shells drop the lock descriptors before launching children.
SSH stays attached. Observer EOF, a missed 60-second heartbeat lease or TERM/INT/HUP cancels waits and the owned transaction group, with TERM then KILL after three seconds. The observer sends heartbeats every 15 seconds. A killed deployer cannot leave a waiter that deploys later.
One absolute `SHUTTLE_DEPLOY_DEADLINE` bounds each attached transaction, including bootstrap, at two hours by default. Pointer selection through verified readiness, quarantine release and rollback receipt defers observer/signal cancellation; activation requires the readiness timeout plus one minute remaining on the deadline; finishing work does not. The hard deadline still terminates a stalled activation.
One private `~/.shuttle/deploy/last-run.log` is atomically published after lock acquisition, preserving a held transaction's diagnostics from waiters; there are no detached run records or result polling. Lock metadata names the executing node as well as PID/group. File creation does not change the login umask.
Logging ends at the completion token, independent of background FIFO writers. The bootstrap is fully framed before a login shell can read stdin; query captures and final completion have explicit frames. SSH uses bounded connection and keepalive waits, and scheduler builds get a bounded `srun --immediate=900` queue wait.
The bootstrap helper is built with capped Go parallelism under `~/.shuttle/deploy/tools`, and its shell waits for the binary to exit before removing the workspace, including on failures.
This ordering permits cleanup on NFS without an executing binary's `.nfs` file retaining the directory.
Tree leases live under `~/.shuttle/deploy/leases`.
Checkout refresh after release is a clean branch fast-forward only; a skipped refresh is advisory, never itself a host failure.
Pi is inspected after refresh, and a genuinely mismatched package still fails its harness check.
The previous release is recorded outside the deploy tree so coalescing retains the rollback root.
 A host marked `"build_ui": false` there is built
with `SKIP_UI=1` and has the deploy host's `ui/dist` rsynced in before the build
instead — for a cluster login node on a network filesystem, where `npm ci` alone
costs minutes. It brings each harness's felt plugin up to the new build
(Claude Code and Codex from the checkout itself, skipped when the receipt
already passes at `HEAD` from a clean build), and a host whose `felt setup
receipt` still fails afterwards fails, naming each unhealthy component and
its repair.
**Every daemon cycle and operator restart arms the boot quarantine**
— the cycle touches the daemon's stop marker and sends SIGTERM — so no fresh
oneshot dispatch proceeds until `shuttle daemon release` (cron-due standing constitutions
still fire). Only on a host that opted in does a hard-killed, previously
released daemon back within seconds and without churn releases fresh dispatch. A daemon
route change must ship with the matching UI; `make build` builds both.
Fetched-release users do not need this checkout deployment helper. Details:
[`docs/dev/build-and-deploy.md`](docs/dev/build-and-deploy.md).

## License

The repo is **MIT** (both Go CLIs + UI). The shuttle daemon (`daemon/lib/`) contains
code derived from OpenAI's Symphony under the **Apache License 2.0**, preserved
in `NOTICE` and `LICENSE-APACHE`.

## Landing changes

Run the targeted local tests before pushing; use the full suite for broad changes.
CI is feedback, not a landing or deployment gate: do not wait for CI after pushing.
The repo's SessionStart hook prints the cached latest completed main CI result when red and refreshes it in the background for the next session.

Work reaches `main` and the fleet through one seat, the felt materializer
(role `felt-materializer` in the store; `shuttle roles` finds it). Lanes share
one deploy lock per host and one quarantine, so landing is one worker's job.
A lane commits on a branch or worktree, runs the suites its change touches,
pushes the branch, and sends the seat a land request in the format its charter
gives; it does not rebase onto `main`, push `main` or run `bin/shuttle-deploy`.

The seat keeps `main` linear: it rebases each lane on `origin/main`, runs the
suites the diff touches, pushes, and batches ready lanes into one deploy, keeping
a contract or route change with its matching UI. It deploys
(`bin/shuttle-deploy --hosts ...`, then `shuttle daemon release`) to the hosts
the change affects: a UI-only change goes to the hubs whose board is opened;
daemon or CLI changes go fleet-wide. It verifies those hosts and reports the
landed SHA and hosts to the requester. A conflict that needs a judgment about
the work goes back to its lane; a host that needs the human's MFA is reported
and skipped.

No PRs and no long-lived branches: iteration happens on `main`, one small
improvement after another, rather than across review boundaries. Hold a landing
only for a failing or unrun required local test; an open design question gets a
decision fiber and a best call, not a pending branch. Screenshots that would have
gone in a PR body go to the human with `shuttle send-file` and into the fiber.

## Contributing

See `CONTRIBUTING.md`.
