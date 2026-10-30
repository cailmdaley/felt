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

`make ui` and `make daemon` take the checkout's build lock (`scripts/build-lock.sh`,
a `bin/.build.lock` directory holding the builder's pid), so two builds started in
one checkout at once — two agents deploying together — run one after the other
instead of overwriting each other's `ui/dist` and `bin/rel.next`. A lock whose
holder has exited is broken automatically.

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

The helper prints one warning if the target commit's latest completed main CI run failed.
Its advisory GitHub query has a ten-second process timeout and never updates the latest-main cache.
This repo's SessionStart hook reads `felt-ci-status.json` from Git's common directory, prints one line when that cached result is red, and starts a detached refresh for the next session.
Worktrees share the cache; successful refreshes replace it atomically, while offline or malformed responses preserve the last known result.
A red result checked more than a day ago shows its age; cached green, missing, or malformed results stay silent.
The hook does no network work synchronously and requires Node; its outer harness deadline is two seconds.
CI does not gate deployment or require waiting after a push; run targeted local tests before pushing and the full suite for broad changes.

Deploy the current commit or pin an explicit revision:

```sh
bin/shuttle-deploy --hosts local,hub-a
bin/shuttle-deploy --ref v2.0.0-rc.1 --no-push
```

The helper resolves one commit, pushes it unless `--no-push` is set, and runs the same ritual on each selected host:

1. Fetch the commit into a clean, detached worktree at `<main-worktree>.deploy/<commit>`.
2. Run `make build` in the host's login shell.
3. Run `felt setup refresh --source <worktree>` for harnesses already carrying felt.
4. Restart once through the existing owner.
   A live tmux respawn loop is replaced through `shuttle-launch --tmux`.
   An installed service is retargeted through `shuttle daemon install --preserve`, whose controlled refresh is the restart.
5. Poll `/api/v1/version` until the full commit matches, `booted_at` advances beyond the observed pre-deploy boot, and `ready` is true.
   Version tags must also match `mix_vsn`.
6. Run `shuttle daemon release` and prune old deploy worktrees.

A worktree protects a running BEAM's release files on network filesystems and leaves the source checkout's branch and edits alone.
New worktrees copy disposable Mix and npm caches from the previous revision when available; failed copies fall back to a cold build.
Pruning retains the current and previous revisions, the two newest worktrees, and worktrees named by `pi list`.
Other deploy worktrees, including their generated files, are removed.
A failed Pi listing prevents pruning.

The host must already have a working daemon and an installed service or live respawn loop.
Deployment does not migrate configuration, copy agent registries, or choose a new supervisor.
`shuttle daemon install --preserve` reads the installed service's settings and keeps its stores, registry, endpoint, log, PATH, SSH agent, tmux directory and Codex settings while changing the release.
Explicit install flags override saved settings.
A missing or unreadable service definition fails instead of inventing a replacement.
Use the [installer](../shuttle/installation.md) for initial setup and configuration changes.

Every failure names its host and step and contributes to a nonzero final exit status; other selected hosts still run.
A harness-refresh failure is reported after the daemon has been deployed and released, so it does not leave a host serving the old build.
Release success uses the CLI's HTTP status handling and exit code.
The ready timeout defaults to 15 minutes; set `SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS` and `SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS` to override it.
Python 3 is required on the deploy host to parse API responses; remote probes use the host's Shuttle endpoint resolution, including Unix sockets.

Configured SSH flags apply to probes, builds and file transfers.
Interactive-auth hosts can opt into `--handshake` when a human is present to approve the authentication prompt.
A red CI result remains advisory.
An autonomous worker should deploy a built, tested, independently reviewed change.
Restarting briefly interrupts the API and board; existing workers retain their conversations.
The restart writes the stop marker and holds fresh launches until the verified deployment releases quarantine.

### Harness plugins

`felt setup refresh --source <checkout>` owns discovery and refresh of installed integrations.
It refreshes enabled Claude Code and Codex plugins from that checkout, and leaves harnesses without felt alone.
An unknown plugin inspection fails with its repair instruction.
A healthy generation sealed at the clean checkout's commit can be reused.
After a refresh, the runtime receipt must pass.

Pi keeps its installed package source.
A clean GitHub package is pinned to the checkout's commit; a different local package must already match it and have no tracked edits.
The deployed checkout itself can be used as Pi's local package.
A package that cannot be inspected fails with its path and repair rather than being replaced.

### The bundle on a host that does not build it

The board bundle is identical on every host, and building it is expensive
exactly where it is least worth doing: on a cluster login node whose home
directory is a network filesystem, `npm ci` takes minutes and `vite build`
several more. Such a host opts out with `"build_ui": false` in its
`~/.config/shuttle/remotes.json` entry:

```json
{"name": "hub-a", "port": 4001, "checkout": "/home/op/dev/felt", "build_ui": false}
```

A remote can also set `"build_wrap": "srun -p serial --cpus-per-task=8 --mem=16G --time=00:45:00"`
to run its build through a scheduler. The optional string is a trusted shell
command prefix: deployment runs `<build_wrap> bash -lc '<build>'` inside the
SSH login shell. Only the build (including its checkout directory and version
environment) is wrapped, for every deployment. Fetch,
worktree preparation, harness refresh, and daemon cycling stay outside the
wrapper. This composes with `build_ui: false` and `SKIP_UI=1`.

`bin/shuttle-deploy --list` shows configured deploy targets.
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
  restarts recovery immediately for a tripped, degraded or unreachable remote.
  One reset buys one attempt, and it 409s when no recovery action is waiting.

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
