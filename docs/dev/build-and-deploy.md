# Building and deploying

The developer-side build and fleet-deploy loop. For *installing* a daemon
(fetched release, keep-alive, supervisor flags, TCC), see
[Installing the shuttle daemon](../shuttle/installation.md).

## What builds what

```
make build        # BOTH: felt CLI (go build .) + daemon release
make cli          # felt CLI only → ./felt
make cli-install  # felt CLI → ~/.local/bin (go install .)
make daemon       # daemon release only → bin/rel (MIX_ENV=prod)
make test         # go test ./...  +  mix test  +  the board's vitest suite  +  the plugin hooks
make restart      # daemon (rebuild release) + stop + start  [load-bearing dev loop]
make all          # restart
make start        # nohup detached; logs → $(LOG) (macOS ~/Library/Logs/shuttle.log, Linux ~/.shuttle/shuttle.log)
make stop         # SIGTERM with 5s grace
make logs         # tail -f the log
make status       # felt shuttle ps + snapshot summary
make clean        # rm _build, stray Elixir.*.beam, built binaries
make install      # full from-source bootstrap (bootstrap.sh)
make install-agent / uninstall-agent   # durable keep-alive: launchd (macOS) / systemd user unit (Linux)
```

`make build` needs `go` on PATH. `make all` / `make daemon` rebuild the felt CLI
first when Go is present, to keep the CLI and daemon in lockstep. **On a host
with no Go toolchain — typically a Linux server where you only run the
daemon — that rebuild is skipped automatically** and they build only the
release, against whatever `felt` is already installed. Pass `SKIP_CLI=1` to
force the same skip on a host that does have Go.

A release runs the compiled BEAMs under `bin/rel`, so editing Elixir source has
zero effect on a running daemon until you rebuild AND restart. **`make restart`
always** for daemon source edits — a restart without `make daemon` is a no-op
for picking up edits.

**Restarting the daemon does NOT end your session — common misconception, closed
out.** A worker (including the shuttle session reading this) runs in its own tmux
session; the daemon only *watches* it (tmux owns the worker process — see
"Deploying" below). Bouncing the daemon cycles the watcher and
rebinds `:4000`; every `<leaf>-<uid>-shuttle` tmux session keeps running untouched and is
re-adopted on boot. So an in-session worker can deploy its own fix and restart the
daemon freely — never hold a restart because "there's a live session."

**A supervisor owns the daemon's restart policy.** After `make install-agent`,
launchd (`io.shuttle.daemon`) or the systemd user unit starts the daemon with an
absolute path. `make stop` identifies the release boot path under `bin/rel`
whether that path is absolute or relative, but a supervisor immediately
respawns a process that it owns. Use the supervisor for an explicit cycle:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   # macOS
systemctl --user restart shuttle-daemon                 # Linux
```

After rebuilding with `make daemon`, `make restart` also works: it stops the
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

**The deploy ritual per host** is: push → on the host, pull → `make daemon` →
rsync `ui/dist` → cycle the daemon (kill the `:4000` listener, then let
whichever supervisor owns the host bring it back — launchd kickstart on
macOS, a systemd user unit's `Restart=always` on a systemd Linux host, or the
tmux respawn loop elsewhere) → poll
`/api/v1/version` until `git_short_sha` matches → release the boot quarantine.
`bin/shuttle-deploy` scripts exactly that. It reads the fleet from
`~/.config/felt/remotes.json` — a remote with a `checkout` field is a deploy
target; without one it is skipped.

**Deploying is ALWAYS safe — local or remote — and is never a blocker.**
Rebuilding and restarting the daemon (`make all`, cycling `:4000`, reloading the
LaunchAgent, the respawn loop) does **not** kill running jobs: **tmux owns the
worker process, shuttle only owns the watcher** (the load-bearing invariant in
[AGENTS.md](https://github.com/cailmdaley/felt/blob/main/AGENTS.md)). A restart cycles the watcher and rebinds the API; the `<leaf>-<uid>-shuttle`
tmux sessions keep running untouched and the daemon re-adopts them on boot. So
deploy freely whenever there's a fix to ship — never hold back, gate it behind
"there are workers running," or frame a deploy as risky. The costs are the
brief API/board blip during the restart — ~1s locally, up to a couple of minutes
on a remote host with a cold store walk — and one deliberate follow-up: **every restart arms the boot
quarantine** — the rule is BROAD: while quarantined, NO autonomous dispatch of
any kind proceeds, fresh launches and dirty-death resumes alike, all parked in
`pending_launch` until a human runs `bin/shuttle release` (POST
`/api/v1/quarantine/release`). In-flight workers (already running) are
unaffected; force-dispatch bypasses. So the deploy ritual is: restart, verify,
`bin/shuttle release`.

**An autonomous worker that has built and verified a change SHOULD deploy it —
that is the default, not a step to stop before.** Because the deploy itself is
mechanically safe (above), the only thing a branch-and-wait gate buys is a human
*code review* — and in practice that review rarely happens, so parking finished,
verified work on a branch is mostly latency and friction, not safety. The
verification that *does* matter happens in-session: build → run the tripwire
(`make test`, `cd ui && npm run build`) → get the skill's independent fresh-eyes
review (a subagent over the diff-against-constitution, an adversarial pass for
complex work) → **then deploy, in the same session** (and release the boot
quarantine the restart armed — `bin/shuttle release` — so fresh dispatch
resumes). Reserve "stop for the
human" for the genuinely different case — a change whose *design* a human should
weigh in on before it ships (a capability removed, a contract redrawn, a load-bearing
model choice); even then, surface the alternatives in the fiber and keep moving
rather than treating the deploy *mechanics* as the gate.

**Deploying to a remote host:** push to your git remote first, then build on the
host. The checkout deployment convention builds on-host via `make daemon`, which
keeps the source revision and native release environment aligned. A packaged
release carries its own ERTS, so the target's installed OTP version does not
need to match the build host; it is still platform-specific, and the target
must have a compatible OS, CPU architecture, libc, and runtime environment.
The respawn loop is driven by `~/.local/bin/shuttle-launch` — a
copy of the tracked `bin/shuttle-launch` that `bootstrap.sh` installs (repo
resolved via `SHUTTLE_DIR` or the script's own location; the loop backs off
exponentially on fast daemon exits, 2s→300s).

```bash
ssh <host> "cd <checkout> && git pull && make daemon"
```

After a remote deploy, verify both `/api/v1/version` and one behavior-shaped
payload. A new `git_short_sha` only proves `BuildInfo` was rebuilt; if the live
payload still has old semantics, run `make clean && make daemon`, then let the
respawn loop restart the daemon from the clean release.

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

The cooldown exists because the fleet's most common outage — an expired SSH
credential — is one neither end can fix and a passive probe can never see
through: the tunnel is down, so the remote daemon is unreachable, and the
cascade's `restart_remote` rung is the only thing that could revive it. A
breaker whose sole automatic exit was a successful passive probe would
therefore be a permanent give-up wearing a retry's clothes, and was: a hub once
sat on a tripped remote for twelve hours across that host's reboot, waiting for
a human who did not know to look.

**The daemon serves its own web UI at `http://127.0.0.1:4000/`** — the Desk
kanban with Stash/Capture and the fiber/file viewer, plus the Day, Week,
Chronicle and Board views on hotkeys 2-5, served as the static `ui/dist`
bundle by the same process as the `:4000` API (`Plug.Static` + `SpaController`).
To pull it up locally: `make start`, then open the root URL in a browser. A fresh
checkout that hasn't built the bundle gets a 404 with the hint
`cd ui && npm run build`; the API stays usable regardless.

**The UI bundle is shipped, not built on-host.** `make all` rebuilds only the
Elixir release — it does *not* build `ui/dist`. The bundle is host-independent
static output, so the lean path is **build `ui/dist` on a host that has the
Node toolchain and `rsync` it to the rest**:

```bash
cd ui && npm run build
rsync -az --delete ui/dist/ <host>:<checkout>/ui/dist/
```

An optional MyST renderer is compiled *into* the bundle when its source is
present at build time, so a remote serving the shipped `dist` needs no Node
toolchain at runtime.

**A daemon route change is a bundle-rebuild event.** `make all` rebuilds the
release and rebinds `:4000` but never touches `ui/dist`, and nothing checks that
the shipped bundle and the daemon's route table still agree. So any change to the
`/api/v1/*` shape (add/remove/rename a route) MUST be paired with a `cd ui && npm
run build` + rsync to every host — the browser always runs the *local* bundle, and
a route mismatch fails silently as a 404 with no daemon-side error. This is exactly
how the shed-history merge broke *all* launches: it deleted `POST /api/v1/felt-history`,
but the stale `dist` still posted the directive there as the first step of New
Session, so the launch 404'd before it ever dispatched. If a fresh
`npm run build` exits 194 with *zero* output, that's not a type error — it's a
corrupted `node_modules` (circular `.bin` symlinks); `npm ci` fixes it. A route
change is also a docs event: `docs/reference/api.md` tabulates the surface and
nothing in CI checks it against the router, so update it in the same commit.

**`GET /api/v1/astra` is a maintainer-only integration.** It is owner-routed and
shells out to `priv/mystra/bake.mjs`, which needs `node` plus a built MySTRA
checkout beside the repo on the host that owns the astra.yaml. A host without
them fails `/astra` cleanly; the board and fibers are unaffected.

**The repo builds three things.** The **felt CLI** (Go: `main.go`, `cmd/`,
`internal/`) — including the `felt shuttle <verb>` subcommands, which ARE Go code
built here (`cmd/shuttle*.go` + `internal/shuttle/`); the **daemon release**
(`bin/rel`, from `lib/`, launched through the tracked `bin/shuttle` shim); and
the **UI bundle** (`ui/dist`, from `ui/`).
Editing `lib/*.ex` needs `make restart`; editing the Go CLI needs `make cli` (or
`make cli-install`); editing the UI needs `cd ui && npm test` (the two pinned
time zones also run in CI) plus `npm run build` + rsync.

**`bin/rel` is a Mix release** — an ERTS-bundled directory built by
`MIX_ENV=prod mix release shuttled --overwrite --path bin/rel`, launched via
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
