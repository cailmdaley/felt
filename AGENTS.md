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
  orchestration. It polls the fiber tree, launches terminal or app workers,
  exposes a `:4000` snapshot/control API, and watches each worker.
- **the board UI** (TypeScript, `ui/`) — three full-page views over the fiber
  tree and the fleet's session/commit ledgers (Desk kanban, Chronicle, and the
  Board canvas of sent work), plus a settings sheet on `⌘,` over every host's
  operator files. The daemon serves it at `http://127.0.0.1:4000/`.

felt owns fiber storage and generic frontmatter. shuttle owns the network and
orchestration; the daemon is the production dispatcher.

**Fibers are ordinary Git-synchronized documents; execution is host-owned.**
Run `felt sync` before substantive work, read and edit the local store, then
commit intentional changes and publish with `felt sync --push`. Resolve Git
conflicts with the work's context. Roles and collaborators live under `roles/`
and have no host owner. A constitution's `shuttle.host` selects the daemon
allowed to execute it; synchronizing its file does not transfer execution.
The live board still uses owner-routed APIs for host-local content and control.

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
| Installing a daemon, keep-alive, macOS TCC, sharp edges | [`docs/shuttle/installation.md`](docs/shuttle/installation.md) |
| Fiber model, frontmatter, cross-project stores | [`docs/concepts/`](docs/concepts/) |
| CLI verbs, daemon HTTP API | [`docs/reference/cli.md`](docs/reference/cli.md), [`docs/reference/api.md`](docs/reference/api.md) |

## Critical invariants

- **Execution backends own conversations; shuttle owns task assignment and
  observation.** CLI workers live in tmux and remain attachable via
  `shuttle attach <fiber>`. Codex app conversations live in the local Codex
  App Server and remain addressable while idle. Neither an idle turn nor an
  unreachable App Server means a conversation has died. Preserve its identity
  across daemon restarts; never substitute a CLI launch for an app failure.
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
  one atomic write. The daemon writes a document itself only on worker exit or
  force-dispatch (`Shuttle.LifecycleStore`). At boot, `shuttle contract`
  checks the Go CLI against `daemon/lib/shuttle/contract.ex`; the daemon holds
  on a skew.
- **Live host-addressed content and control use `Shuttle.OriginRouter`.**
  The composite board carries each row's `origin` back to the daemon for
  requests such as `/api/v1/fibers/:id?body=true` and `/file`, so it can display
  that host's current content and artifacts without waiting for Git sync.
  Route requests for host-local assets and execution through the selected
  daemon. Ordinary synchronized notes, including roles and collaborators,
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
  by the `host` id it reports; it refreshes every minute and falls back to the
  file alone when Tailscale is absent or failing. The file adds hosts outside
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
  felt `status` is `active` and (2) the boot quarantine is released: every
  daemon restart parks every dispatchable candidate — fresh launches and
  dirty-death resumes alike — in `pending_launch` until
  `shuttle daemon release`; only work the daemon observed running and
  cron-due standing roles pass through. The one exception is opt-in per host
  (`~/.config/shuttle/host.json` has `"quarantine_auto_release": true`): a
  daemon killed hard and back within the heartbeat window, on the same
  machine, with every recorded worker re-adopted and no churn, releases
  itself only if its previous incarnation had been released
  (`Shuttle.DaemonHeartbeat`). An asked-for restart — every deploy and
  operator restart, `make stop`, or re-running `bin/shuttle-launch` — leaves
  a stop marker and always holds. An unreleased hold survives hard kills.
  There is no `enabled` flag; steady-state recovery of a worker that dies while
  the daemon is healthy and unquarantined is unaffected, and force-dispatch
  bypasses the quarantine. Tags are free-form qualitative noticings.

## The daily loop

```bash
make build                 # both Go CLIs + UI + daemon release
make build SKIP_UI=1       # ditto, leaving ui/dist to whatever put it there
make cli                   # build felt and shuttle
make cli-install           # install both Go CLIs → ~/.local/bin
make restart               # rebuild UI + release, then stop + start
make status / make logs    # daemon status / tail the daemon log
```

`npm ci` is stamped on `ui/package-lock.json` and runs only when the lockfile
moves; `npm run build` runs every time.

Editing `daemon/lib/*.ex` needs `make restart` (a restart without `make daemon` is a
no-op — the release runs compiled BEAMs). Editing either Go CLI needs `make cli`.
Editing `ui/` needs `cd ui && npm test`, then `make restart` from the root.
Changing anything the board draws also wants a look at it: `cd ui && npm run
harness:board` builds a self-contained bundle with a mocked daemon that opens
over `file://`, which is the only way to see the board where `:4000` is
unreachable — and the only way to stage states a live fleet will not hold
still for.
Source builds require Go, Elixir/OTP, and Node/npm on each host.
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

Deploying is **always safe** — tmux owns the worker process, shuttle only owns
the watcher, so restarting the daemon never kills running jobs. An autonomous
worker that has built and verified a change SHOULD deploy it.

```
push → on the host: pull → make build → felt setup <harness> for each
harness carrying felt's plugin → cycle the :4000 listener (the host's
supervisor brings it back) → poll /api/v1/version until git_short_sha matches,
booted_at advances, and ready is true → shuttle daemon release
```

`bin/shuttle-deploy` builds source checkouts in each host's login shell across the fleet in
`~/.config/shuttle/remotes.json`. A host marked `"build_ui": false` there is built
with `SKIP_UI=1` and has the deploy host's `ui/dist` rsynced in before the build
instead — for a cluster login node on a network filesystem, where `npm ci` alone
costs minutes. It brings each harness's felt plugin up to the new build
(Claude Code and Codex from the checkout itself, skipped when the receipt
already passes at `HEAD` from a clean build), and a host whose `felt setup
receipt` still fails afterwards fails, naming each unhealthy component and
its repair.
**Every deploy and operator restart arms the boot quarantine**
— the cycle touches the daemon's stop marker and sends SIGTERM — so no fresh
oneshot dispatch proceeds until `shuttle daemon release` (cron-due standing roles
still fire). Only on a host that opted in does a hard-killed, previously
released daemon back within seconds, workers intact and no churn, release
itself. A daemon
route change must ship with the matching UI; `make build` builds both.
Fetched-release users do not need this checkout deployment helper. Details:
[`docs/dev/build-and-deploy.md`](docs/dev/build-and-deploy.md).

## License

The repo is **MIT** (both Go CLIs + UI). The shuttle daemon (`daemon/lib/`) contains
code derived from OpenAI's Symphony under the **Apache License 2.0**, preserved
in `NOTICE` and `LICENSE-APACHE`.

## Contributing

See `CONTRIBUTING.md`.
