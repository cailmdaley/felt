# Building and deploying

The developer-side build and fleet-deploy loop. For *installing* a daemon
(fetched release, keep-alive, supervisor flags, TCC), see
[Installing the shuttle daemon](../shuttle/installation.md).

## Build targets

```
make build        # both Go CLIs + UI + daemon release
make build SKIP_UI=1   # same, but leave ui/dist alone (host gets its bundle elsewhere)
make cli          # build felt and shuttle
make cli-install  # install both Go CLIs → ~/.local/bin
make ui           # install UI dependencies and build ui/dist
make daemon       # daemon release only → bin/rel (MIX_ENV=prod)
make daemon SKIP_CLI=1 # same, trusting felt and shuttle on PATH
make test         # go test ./...  +  mix test  +  the board's vitest suite  +  the plugin hooks  +  the bootstrap shims
make go-test / mix-test / js-test / plugin-hooks-test / bootstrap-test   # one suite each
make lint-personal   # the hygiene test alone: no maintainer host or account names in tracked source
make restart      # rebuild UI and release, then stop + start
make all          # restart
make start        # nohup detached; logs → $(LOG) (macOS ~/Library/Logs/shuttle.log, Linux ~/.shuttle/shuttle.log)
make stop         # SIGTERM with 5s grace
make logs         # tail -f the log
make status       # daemon status and snapshot summary
make clean        # rm daemon/_build, stray Elixir.*.beam, built binaries
make install      # full from-source bootstrap (scripts/bootstrap.sh)
make install-agent / uninstall-agent   # durable keep-alive: launchd (macOS) / systemd user unit (Linux)
```

Source builds require Go, Elixir/OTP, Node 22+, and npm on every build host.
`make build` compiles both Go CLIs, the UI, and daemon release; `make daemon` builds only the daemon release.
The fleet helper builds in each host's login shell, where its toolchain is configured.
Fetched releases include the runtime and UI, so users need none of these build tools;
the target must match the release's OS and CPU architecture.

**`bin/rel` is a Mix release** — an ERTS-bundled directory with compiled
modules, assembled by `make daemon` and managed by `shuttle daemon` commands.
The release's BEAM launcher is `shuttled`. A running BEAM keeps using the
release it booted, so a restart without `make daemon` picks up no source edit:
use `make restart`, then verify both `booted_at` and `git_short_sha` on
`/api/v1/version` so the answer proves the new process is serving. If `mix
release` warns about a stale build shadowing a fresh one, run `make clean`
first — stray `.beam` files at the project root shadow the real ones.

Terminal workers live in tmux and app conversations live in the managed Codex
App Server. Both survive Shuttle restarts; the daemon re-adopts their ownership.

**A supervisor owns the daemon's restart policy.** After `make install-agent`,
launchd (`io.shuttle.daemon`) or the systemd user unit starts the daemon with an
absolute path. `make stop` identifies the release boot path under `bin/rel`
whether that path is absolute or relative, but a supervisor immediately
respawns a process that it owns, so `make stop` is not a durable stop while the
supervisor is enabled. Use the supervisor for an explicit cycle:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   # macOS
systemctl --user restart shuttle-daemon                 # Linux
```

`make restart` also works: it rebuilds, stops the matching release process and
`make start` waits for the supervisor's replacement to answer. A daemon started
by `make start` follows the same target without a supervisor. Where
`shuttle-launch --loop` runs in tmux session `shuttle-daemon`, kill the `:4000`
listener directly so the loop respawns it from the rebuilt release:

```bash
lsof -ti:4000 -sTCP:LISTEN | xargs kill
```

### The CLI/daemon contract

The daemon shells `felt` for fiber content and generic writes, and `shuttle`
for Shuttle-owned operations. The Shuttle CLI/daemon contract is versioned
together: `shuttle contract` prints its integer level, and a daemon whose
expected level differs holds at boot with a skew reported on `/api/v1/version`
and `/api/v1/state`. `make daemon` therefore builds both Go CLIs first
(`SKIP_CLI=1` trusts both on `PATH`). The Elixir suite shells both CLIs too, so
run `make cli-install` before `make mix-test` after changing either boundary.

### The release's runtime stays out of workers and builds

A daemon started from `bin/rel` runs with the release's ERTS first on `PATH`
and `ROOTDIR`, `BINDIR`, `PROGNAME` and `EMU` set. Nothing it launches should
inherit them: a worker's `mix`, `erl` or `elixir` resolved from that ERTS dies
with `cannot get bootfile …/bin/rel/bin/start.boot`, and `bash -l` does not
help, because a login profile prepends to the inherited `PATH`. Every shell the
daemon starts in tmux — a worker's run script, a History resume — therefore
drops each `PATH` entry at or under the release root (written into the script
at launch) and unsets those variables and the release's `RELEASE_*` ones before
anything else runs. A daemon running under Mix leaves `PATH` alone.

The Makefile's mix targets (`make daemon`, `make mix-test`) run `mix` with the
same variables unset and every `PATH` entry under this checkout's
`bin/rel*` removed, so they work from a shell that inherited the release
environment. A bare `mix` in such a shell still needs `PATH` fixed by hand, as
does a shell carrying another checkout's release.

## Deploying

**Remote hosts are configured in `~/.config/shuttle/remotes.json`** (`shuttle
remotes list|add|rm|path`). SSH entries name an alias and local forwarded port;
the daemon reaches their API over that tunnel.
HTTPS `url` entries use the configured dial transport. When
`defaults.tailscale_socket` is set, the private LocalAPI bridge is mandatory
and requests fail closed if it is unavailable (see
[Configuring remotes](../shuttle/installation.md#configuring-remotes)).
How an SSH entry authenticates is your ssh config's business — but an alias
needing a live credential (a short-lived certificate, a 2FA-backed
ControlMaster) fails *instantly* with `Permission denied` once that credential
lapses, and the symptom looks like a dead host: the kanban **Attach** button
opens a terminal that flashes and dies.
Refresh the credential before concluding shuttle is broken.

`bin/shuttle-deploy` is a developer convenience for source checkouts.
It reads `~/.config/shuttle/remotes.json`; entries with a `checkout` field are deploy targets.
Release users install packaged releases through the [installer](../shuttle/installation.md).

To deploy a release candidate across the configured fleet, pin its tag:

```sh
bin/shuttle-deploy --ref v2.0.0-rc.1 --no-push
```

The helper resolves the tag to one commit and builds it in a detached Git worktree under `<main-worktree>.deploy/<commit>`. The main worktree is derived from Git's common directory, so deploys launched from linked worktrees share one per-repository root. The regular checkout's branch and local edits stay in place, and every exact-ref build gets its own immutable tree.

Before building a new worktree, the helper copies `daemon/deps`, `daemon/_build`, and `ui/node_modules` from the most recently modified deploy worktree in that root. It uses APFS clones (`cp -c`) on macOS and reflink copies where supported on Linux, with recursive-copy fallback. These are Mix dependencies and environment-specific build products, plus npm dependencies and the `.npm-ci-stamp` that lets `make ui` skip `npm ci`; they are copies, never links or moves. A seeding error is reported and the build proceeds cold.

After the daemon reports the expected SHA, fresh boot, and ready state, the helper prunes clean deploy worktrees under the shared root, retaining the deployed tree, the newest other tree for rollback, and any tree referenced by a process, its working directory, or a launchd/systemd supervisor. Dirty trees are reported and left alone. Failed deployments do not prune. Worktrees in the old checkout-local `<checkout>.deploy/` location are never removed automatically; the helper prints shell-quoted removal commands for review. Version tags stamp both CLIs and the daemon with the release version.
If Pi loads a Felt package from another revision, the helper reports the mismatch without replacing that package choice.
Use Pi's native package commands to select the deployed source directory, then rerun the host's deployment check.
Use `--hosts local,hub-a` to deploy a subset.

Push the verified revision, then deploy it on each host:

1. Pull the checkout and run `make build` in the host's login shell.
2. Re-render an installed daemon supervisor that an older template wrote — a
   pre-split one (it bakes `FELT_STORES`), one that predates `TMUX_TMPDIR`
   (the word appears nowhere in it), or one without an open-file limit
   (no `NumberOfFiles` or `LimitNOFILE`) — through `shuttle daemon install`, keeping
   its label, stores, port, log, `PATH`, and `SSH_AUTH_SOCK` and capturing
   `TMUX_TMPDIR` from the login shell.
3. Run `felt setup <harness>` for each harness that carries felt's plugin, so
   its hooks and skills match the felt just built, and check that `felt setup
   receipt` passes (see [harness plugins](#harness-plugins)).
4. Cycle the daemon through its supervisor or respawn loop.
5. Poll `/api/v1/version` until `git_short_sha` matches, `booted_at` advances,
   and `ready` is `true` (up to 15 minutes by default; set
   `SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS` to override).
6. Check the changed behavior through the live API or board.
7. Run `shuttle daemon release` to release the boot quarantine.

The helper builds both CLIs, the daemon, and — on every host that is not marked
`"build_ui": false` — the UI, on that host.
An autonomous worker should deploy a built, tested, independently reviewed change.
Restarting briefly interrupts the API and board; existing tmux workers keep running.
Every deploy quarantines new launches and resumes until `shuttle daemon release`:
the cycle touches `$SHUTTLE_DATA_DIR/heartbeat.stopped` on the target host and
then stops the daemon with SIGTERM (whose shutdown touches the marker again), so
the rebuilt daemon sees a graceful stop and holds. Only on a host that opts in
(host.json `"quarantine_auto_release": true`) does a daemon killed hard, and back
within the heartbeat window with its workers alive, no churn and its previous
incarnation already released, release itself. Restarting the tmux respawn loop
with `bin/shuttle-launch` touches the same marker before it kills the old
session (see
[the boot quarantine](../shuttle/lifecycle.md#boot-quarantine)).

Confirm `git_short_sha` flipped and `/api/v1/version` reports `ready: true`; if
not, the old process may still be bound or the new daemon is still initializing.
The listener binds before store resolution, orphan adoption, event-stream
seeding, and Tailnet bridge reconciliation finish. While that synchronous boot
work runs, `/api/v1/version` answers with `ready: false`; state-dependent routes
return a fast 503. The respawn loop treats the bound listener as alive, polls
booting daemons every five seconds, and falls through to `start --force` if the
listener stops answering.

For a manual remote build:

```bash
ssh <host> "bash -lc 'cd <checkout> && git pull --ff-only && make build'"
```

### Harness plugins

`make build` installs a new `felt`, but each harness keeps running the plugin
generation it was last set up with, and `felt setup receipt` fails once the
two disagree. The helper therefore runs `felt setup` on every host, in its
login shell, after the build.

A harness counts as installed where felt's plugin is enabled in it: Claude Code
and Codex as the enabled bundles in `felt setup receipt --json`, and pi as a
felt package in `pi list`, either `git:github.com/cailmdaley/felt` or a local
directory whose committed `package.json` (its working copy, outside git) names
felt. A harness binary on `PATH` without
felt's plugin is left alone, so the deploy never installs a plugin the operator
did not install or has removed. A host with no such harness reports
`harness plugins: none carry felt`.

Each receipt bundle's `inspection` says how its enablement was established:
`confirmed` by the harness's own plugin list, `configured` by its config and
cache alone, or `unknown` when the list failed or the config could not be read.
The helper sets up confirmed and configured bundles. An unknown bundle fails the
host with the receipt's repair and no setup runs. So does a receipt that is
missing or incomplete (its bundles list unclosed, or no closing brace on the
top-level object), rather than reading a partial answer as "no harness".

Claude Code and Codex are set up with `--source <checkout>`, so the sealed
generation holds the tree the felt binary was built from, and setup needs no
network. They are skipped when the receipt already passes and its active
generation was sealed at the checkout's `HEAD` by a clean build. A dirty
checkout builds felt as `dev (<sha>-dirty)`, which does not identify a single
tree, so a dirty host is set up again on every deploy. pi has no `--source`
flag and no generation. For pi's GitHub package, a regular deploy runs
`felt setup pi` only when pi's clone is not at the checkout's `HEAD`. An exact-ref
deploy fetches and detaches a clean clone at the deployed commit when it differs;
tracked edits or a commit that cannot be fetched fail the host. A local felt
package is never re-pointed: it is current when
it is the deployed checkout or sits at its `HEAD`, and otherwise the host fails
with the package's path and commit. Any pi package other than the deployed
checkout must also have no tracked edits or deletions (`git status
--porcelain --untracked-files=no`); a package with them fails the host with the
edited paths, and so does one git cannot inspect. Untracked files are ignored, since pi's npm install leaves a
`package-lock.json` in its clone.

If setup fails, the host's line carries its output. If `felt setup receipt`
still fails afterwards, the line names each component that is not healthy
(`felt`, a harness plugin, `hooks`, `generation`) with that component's own
repair, for example a stale `felt` shadowing the new one on `PATH`, or `hooks
mismatch: open a Codex session and approve felt's hooks`. It falls back to the
receipt's top-level repair when no component reports one. The host counts as failed
only after its daemon cycle and quarantine release have run, so a harness
problem never leaves the daemon on the old build. A pi clone that cannot fetch
the deployed commit fails the host.

### The bundle on a host that does not build it

The board bundle is identical on every host, and building it is expensive
exactly where it is least worth doing: on a cluster login node whose home
directory is a network filesystem, `npm ci` takes minutes and `vite build`
several more. Such a host opts out with `"build_ui": false` in its
`~/.config/shuttle/remotes.json` entry:

```json
{"name": "hub-a", "port": 4001, "checkout": "/home/op/dev/felt", "build_ui": false}
```

`bin/shuttle-deploy --list` shows the choice per host (`build` or `shipped`).
For a `shipped` host the helper rsyncs the deploy host's own freshly-built
`ui/dist` into that checkout and then builds it with `make build SKIP_UI=1`. The
key is absent on every host that builds its own, and only `bin/shuttle-deploy`
reads it — the felt CLI and the daemon carry it through untouched.

**The rsync precedes the remote build, and the order is load-bearing.**
`make daemon` copies `ui/dist` into the release's `priv/ui/dist`, and
`ShuttleWeb.Assets` serves the release's copy in preference to the checkout's. A
bundle that landed after the build would sit in the checkout unserved.

**`RemoteRegistry`'s circuit breaker paces revival attempts; it never abandons
a remote.** Each configured remote is driven by a recovery state machine; after
`trip_threshold` (default 3) consecutive failed revive cascades it trips and
stops taking recovery action — the RemoteRegistry keeps passively polling the
remote's health at a decimated cadence (an unhealthy remote is polled far less
often than a healthy one). A tripped breaker has three exits, and needing a
human is only one of them:

- **The passive probe succeeds** — the remote came back on its own, and the
  breaker resets with no human step.
- **The trip cooldown elapses** — the breaker re-arms itself and runs one more
  full cascade, with the attempt counter reset so it gets the whole ladder
  again. `trip_cooldown_schedule_ms` (default 15min, 30min, then hourly)
  widens the gap with each successive trip.
- **`shuttle daemon reset <remote>`** or `POST /api/v1/remotes/:name/reset` —
  forces a cascade now instead of waiting out the cooldown. One reset buys
  exactly one cascade, and it 409s if the breaker isn't currently tripped.

**The daemon serves its own web UI at `http://127.0.0.1:4000/`** — the Desk
kanban with Stash/Capture, Chronicle, and Board on hotkeys 1–3. Board is a
document overview and reader; fiber controls sit inline on the fiber page and
the worker pill opens its conversation. The UI is served as the static `ui/dist`
bundle by the same process as the `:4000` API (`Plug.Static` + `SpaController`).
Phone meetings start from Capture on the board.
Capture reads meeting availability and supported modes from the daemon serving the board.
On a mobile viewport, it selects Meeting with phone audio and no mode selector; the live meeting card holds the microphone controls.
On desktop, the selector appears only when the recording host supports several modes.
The host picker chooses where the scribe runs; open the desired recording host's board to record there.
When recorder and scribe differ, Capture names both beside the Meeting toggle.
The `--chrome` flag appears only for a browser-capable agent on a macOS host with an active GUI session.
`/phone` redirects to `/`.
To pull it up locally: `make start`, then open the root URL in a browser. A fresh
checkout that hasn't built the bundle gets a 404 with the hint
`cd ui && npm run build`; the API stays usable regardless.

`make ui` installs the UI dependencies and builds `ui/dist` on the current host.
Both `make build` and `make restart` include this step, and both skip it under
`SKIP_UI=1`.
The compiled UI requires no Node runtime to serve.

`npm ci` is gated on a stamp under `ui/node_modules/` that depends on
`ui/package-lock.json`, so it runs on a fresh checkout and after a lockfile
change and not otherwise; `npm run build` runs every time, because vite is the
cheap half and its sources change with every commit. A host that should not run
either builds with `SKIP_UI=1` and takes its `ui/dist` from elsewhere — see
[the bundle on a host that does not build it](#the-bundle-on-a-host-that-does-not-build-it).

When changing API routes, update the matching UI and `docs/reference/api.md` in the same change.
Deploy with `make build` so the daemon and UI come from the same revision.

The `shuttle` Go CLI owns both orchestration commands and daemon lifecycle:
`shuttle daemon start|stop|status|release|reset|install|uninstall` controls the
Mix release and its keep-alive, while `shuttle snapshot` and `shuttle dispatch`
speak to the running daemon.

## Plugin maintenance and authentication

Felt invokes Claude plugin inspection, installation, updates, and rollback in
command-scoped bare mode (`CLAUDE_CODE_SIMPLE=1`). Claude's
[bare-mode contract](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)
excludes subscription OAuth credentials and the system keychain. Plugin commands
still manage the native marketplace and cache. Maintenance also disables
nonessential traffic and auto-updates in that child process. These environment
settings do not propagate to worker sessions or change the user's configuration.

Deploy skill-owned launch prompts only after the matching plugin generation is
installed and verified. Never copy live OAuth credentials into a test config or
modify a harness cache by hand to bypass native plugin installation.
