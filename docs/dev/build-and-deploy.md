# Building and deploying

The developer-side build and fleet-deploy loop. For *installing* a daemon
(fetched release, keep-alive, supervisor flags, TCC), see
[Installing the shuttle daemon](../shuttle/installation.md).

## Build targets

```
make build        # felt CLI + UI + daemon release
make cli          # felt CLI only → ./felt
make cli-install  # felt CLI → ~/.local/bin (go install .)
make ui           # install UI dependencies and build ui/dist
make daemon       # daemon release only → bin/rel (MIX_ENV=prod)
make test         # go test ./...  +  mix test  +  the board's vitest suite  +  the plugin hooks
make restart      # rebuild UI and release, then stop + start
make all          # restart
make start        # nohup detached; logs → $(LOG) (macOS ~/Library/Logs/shuttle.log, Linux ~/.shuttle/shuttle.log)
make stop         # SIGTERM with 5s grace
make logs         # tail -f the log
make status       # felt shuttle ps + snapshot summary
make clean        # rm daemon/_build, stray Elixir.*.beam, built binaries
make install      # full from-source bootstrap (scripts/bootstrap.sh)
make install-agent / uninstall-agent   # durable keep-alive: launchd (macOS) / systemd user unit (Linux)
```

Source builds require Go, Elixir/OTP, Node 22+, and npm on every build host.
`make build` compiles all three components; `make daemon` builds only the daemon release.
The fleet helper builds in each host's login shell, where its toolchain is configured.
Fetched releases include the runtime and UI, so users need none of these build tools.

The daemon runs compiled modules under `bin/rel`.
Use `make restart` after source edits to build the UI and release, then restart the daemon.
Workers live in tmux and continue running through daemon restarts; the new daemon re-adopts them.

**A supervisor owns the daemon's restart policy.** After `make install-agent`,
launchd (`io.shuttle.daemon`) or the systemd user unit starts the daemon with an
absolute path. `make stop` identifies the release boot path under `bin/rel`
whether that path is absolute or relative, but a supervisor immediately
respawns a process that it owns. Use the supervisor for an explicit cycle:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   # macOS
systemctl --user restart shuttle-daemon                 # Linux
```

`make restart` also works: it rebuilds, stops the
matching release process and `make start` waits for the supervisor's replacement
to answer. A daemon started by `make start` follows the same target without a
supervisor.

## Deploying

**Remote hosts are configured in `~/.config/felt/remotes.json`** (`felt shuttle
remotes list|add|rm|path`). Each entry names an ssh alias and a local forwarded
port; the daemon reaches a remote's API over that tunnel. How a given host
authenticates is your ssh config's business — but note that an ssh alias needing
a live credential (a short-lived certificate, a 2FA-backed ControlMaster) fails
*instantly* with `Permission denied` once that credential lapses, and the
symptom looks like a dead host: the kanban **Attach** button opens a terminal
that flashes and dies. Refresh the credential before concluding shuttle is
broken.

`bin/shuttle-deploy` is a developer convenience for source checkouts.
It reads `~/.config/felt/remotes.json`; entries with a `checkout` field are deploy targets.
Release users install packaged releases through the [installer](../shuttle/installation.md).

Push the verified revision, then deploy it on each host:

1. Pull the checkout and run `make build` in the host's login shell.
2. Cycle the daemon through its supervisor or respawn loop.
3. Poll `/api/v1/version` until `git_short_sha` matches and `booted_at` advances.
4. Check the changed behavior through the live API or board.
5. Run `bin/shuttle release` to release the boot quarantine.

The helper builds the CLI, UI, and daemon on each host.
It does not copy a UI bundle from the machine invoking it.
An autonomous worker should deploy a built, tested, independently reviewed change.
Restarting briefly interrupts the API and board; existing tmux workers keep running.
Every restart quarantines new launches and resumes until `bin/shuttle release`.

For a manual remote build:

```bash
ssh <host> "bash -lc 'cd <checkout> && git pull --ff-only && make build'"
```

Packaged releases carry their own Erlang runtime and native components.
The target must match the release's OS and CPU architecture and provide a compatible runtime environment.

**A supervisor owns the live daemon.** Under systemd, use
`systemctl --user restart shuttle-daemon`; under launchd, use the `launchctl`
command above. `make stop` can find a release started by either a relative or an
absolute path, but it is not a durable stop while the supervisor is enabled.
Where `shuttle-launch --loop` runs in tmux session `shuttle-daemon`, kill the
`:4000` listener directly so the loop respawns it from the rebuilt release:

```bash
lsof -ti:4000 -sTCP:LISTEN | xargs kill
```

Confirm `git_short_sha` flipped; if not, the old process is still bound. **A
host with large felt stores can take minutes to start** — it walks every store
and adopts orphan sessions before binding `:4000`; wait it out, don't assume a
crash.

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
- **`bin/shuttle reset <remote>`** or `POST /api/v1/remotes/:name/reset` —
  forces a cascade now instead of waiting out the cooldown. One reset buys
  exactly one cascade, and it 409s if the breaker isn't currently tripped.

**The daemon serves its own web UI at `http://127.0.0.1:4000/`** — the Desk
kanban with Stash/Capture and the fiber/file viewer, plus the Day, Week,
Chronicle and Board views on hotkeys 2-5, served as the static `ui/dist`
bundle by the same process as the `:4000` API (`Plug.Static` + `SpaController`).
To pull it up locally: `make start`, then open the root URL in a browser. A fresh
checkout that hasn't built the bundle gets a 404 with the hint
`cd ui && npm run build`; the API stays usable regardless.

`make ui` installs the UI dependencies and builds `ui/dist` on the current host.
Both `make build` and `make restart` include this step.
An optional MyST renderer is compiled into the bundle when its source is available at build time.
The compiled UI requires no Node runtime to serve.

When changing API routes, update the matching UI and `docs/reference/api.md` in the same change.
Deploy with `make build` so the daemon and UI come from the same revision.

**`GET /api/v1/astra` is a maintainer-only integration.** It is owner-routed and
shells out to `daemon/priv/mystra/bake.mjs`, which needs `node` plus a built MySTRA
checkout beside the repo on the host that owns the astra.yaml. A host without
them fails `/astra` cleanly; the board and fibers are unaffected.

**The repo builds three things.** The **felt CLI** (Go: `main.go`, `cmd/`,
`internal/`) — including the `felt shuttle <verb>` subcommands, which ARE Go code
built here (`cmd/shuttle*.go` + `internal/shuttle/`); the **daemon release**
(`bin/rel`, from `daemon/lib/`, launched through the tracked `bin/shuttle` shim); and
the **UI bundle** (`ui/dist`, from `ui/`).
Editing `daemon/lib/*.ex` needs `make restart`; editing the Go CLI needs `make cli` (or
`make cli-install`); editing the UI needs `cd ui && npm test` (the two pinned
time zones also run in CI), then `make restart` from the root.

**`bin/rel` is a Mix release** — an ERTS-bundled directory built by
`(cd daemon && MIX_ENV=prod mix release shuttled --overwrite --path ../bin/rel)`, launched via
`bin/rel/bin/shuttled`. A restart without `make daemon` is a no-op for picking
up source edits. `make restart` always.

**A running release does not switch to a newly built release.** `bin/rel` is a
Mix release — an ERTS-bundled directory with compiled modules — and a running
BEAM process keeps using the release it booted. Rebuild and restart together;
then verify both `booted_at` and `git_short_sha` so the response proves that the
new process is serving. `bin/shuttle` itself is a tracked POSIX shell shim, not a
build artifact — it execs the release launcher for `start` and speaks HTTP to
the running daemon for the read verbs (snapshot, status, dispatch, release,
reset, version).

If `mix release` warns about a stale build shadowing a fresh one, run
`make clean` first — stray `.beam` files at the project root shadow the real
ones. They should never be committed.
