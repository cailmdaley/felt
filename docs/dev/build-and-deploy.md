# Building and deploying

The developer-side build and fleet-deploy loop. For *installing* a daemon
(fetched release, keep-alive, supervisor flags, TCC), see
[Installing the shuttle daemon](../shuttle/installation.md).

In the maintainer fleet, one seat runs the deploy; lanes send it a land request
(*Landing changes* in `AGENTS.md`).

## Build targets

```
make build        # both Go CLIs + UI + daemon release
make build SKIP_UI=1   # same, but leave ui/dist alone (host gets its bundle elsewhere)
make cli          # build felt and shuttle
make cli-install  # install both Go CLIs → ~/.local/bin
make ui           # install UI dependencies and build ui/dist
make daemon       # daemon release only → bin/rel-built (MIX_ENV=prod)
make daemon SKIP_CLI=1 # same, trusting felt and shuttle on PATH
make test         # go test ./...  +  mix test  +  the board's vitest suite  +  the plugin hooks  +  the bootstrap shims
make go-test / mix-test / js-test / plugin-hooks-test / bootstrap-test   # one suite each
make lint-personal   # the hygiene test alone: no maintainer host or account names in tracked source
make restart      # rebuild; main checkout selects and cycles, linked worktrees only build
make all          # restart
make start        # main checkout starts the existing selection; logs → $(LOG)
make stop         # SIGTERM with 5s grace; linked worktrees refuse a foreign release
make logs         # tail -f the log
make status       # daemon status and snapshot summary
make clean        # rm daemon/_build, stray Elixir.*.beam, built binaries
make install      # full from-source bootstrap (scripts/bootstrap.sh)
make install-agent / uninstall-agent   # durable keep-alive: launchd (macOS) / systemd user unit (Linux)
```

`make ui` and `make daemon` take the checkout's build lock (`scripts/build-lock.sh`,
a `bin/.build.lock` directory holding the builder's pid), so two builds started in
one checkout at once — two agents deploying together — run one after the other
instead of overwriting each other's `ui/dist` or interleaving release assembly.
A lock whose holder has exited is broken automatically.

Source builds require Go, Elixir/OTP, Node 22+, npm, and Python 3 on every build host.
Python 3 publishes the release symlink atomically.
`make build` compiles both Go CLIs, the UI, and daemon release; `make daemon` builds only the daemon release.
The fleet helper builds in each host's login shell, where its toolchain is configured.
Fetched releases include the runtime and UI, so users need none of these build tools;
the target must match the release's OS and CPU architecture.

**`bin/rel-built` points to the latest completed Mix release** — an ERTS-bundled directory with compiled modules, managed by `shuttle daemon` commands.
`make daemon` assembles a unique immutable `bin/rel.generation-*` directory and atomically publishes that symlink.
Selection resolves the symlink to its canonical generation, so another build cannot overwrite a selected or running assembly.
The release's BEAM launcher is `shuttled`. A running BEAM keeps using the
release it booted, so a restart without `make daemon` picks up no source edit:
use `make restart`, then verify both `booted_at` and `git_short_sha` on
`/api/v1/version` so the answer proves the new process is serving. If `mix
release` warns about a stale build shadowing a fresh one, run `make clean`
first — stray `.beam` files at the project root shadow the real ones.

Terminal workers live in tmux and app conversations live in the managed Codex
terminal worker sessions. They survive Shuttle restarts; the daemon re-adopts their ownership.

**A supervisor owns the daemon's restart policy.**
Launchd (`io.shuttle.daemon`), the systemd user unit, and the tmux loop read one launch pointer, `~/.shuttle/repo`.
**Builds never select, migrate, install CLIs, or restart the host daemon.**
`make restart` selects only from the main checkout, identified by Git's common directory.
`make start` is also main-checkout-only and follows the existing selection without changing it.
In a linked worktree, restart builds and prints deployment guidance without touching the host lifecycle; stop refuses a daemon whose reported release lies outside that worktree.
Use `bin/shuttle-deploy --hosts local --ref <commit>` to activate a linked worktree's committed revision.
Main-checkout activation and fleet deployment use the checkout-built CLI, not an older installed CLI.
They install the matching CLI pair, then share one activation path that removes only supervisor release pins and checkout-dependent working directories, preserving all other definition bytes and environment entries.
The target release is validated under a host-local lock, selected atomically immediately before cycling, and the previous selection and migrated definitions are restored if migration or cycling fails.
The same lock excludes pruning and competing selections throughout the cycle.
Supervisor definitions invoke the installed Go CLI and use the user's home as their working directory; neither value depends on the selected checkout.
`/api/v1/version` reports `release_path`, the absolute release root of the running VM, independently of the pointer's current value.
`shuttle daemon status` includes the same field.
An explicit `SHUTTLE_RELEASE` still selects a release for a direct CLI invocation.
A missing selected release fails with its path and instructions to deploy locally or restart from the main checkout; the tmux loop retries with exponential backoff.
`make stop` identifies the process through endpoint ownership.
A linked worktree also requires a release receipt within that worktree (`--within`).
A supervisor immediately respawns a process that it owns, so `make stop` is not a durable stop while the supervisor is enabled. Use the supervisor for an explicit cycle:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   # macOS
systemctl --user restart shuttle-daemon                 # Linux
```

`make restart` in the main checkout also works: it rebuilds, selects, stops the running release process and
`make start` waits for the supervisor's replacement to answer. A daemon started
by `make start` follows the same target without a supervisor. Where
`shuttle-launch --loop` runs in tmux session `shuttle-daemon`, kill the `:4000`
listener directly so the loop respawns it from the selected release:

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
Contract level 35 includes the CLI-owned locked writers `standing-transition` and `patch-document`, and `claude-mail-recover` for automatic message delivery.
The former checks the current owner, UID, run and human lifecycle state under the fiber lock; a changed run refuses force rearm.
The latter compares the source document's SHA-256 under that lock and refuses a stale snapshot rather than overwriting a concurrent edit.

`shuttle scan-changes` reads the previous metadata index as JSON on stdin.
Its output has a small JSON header (`ids` and `indexed_paths`), a newline,
and the next JSON index.
The daemon decodes the header and retains the index as opaque bytes for the next scan;
the Go CLI owns its paths and nanosecond timestamps.

### The release's runtime stays out of workers and builds

A daemon started from an assembled release runs with the release's ERTS first on `PATH`
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

To deploy a release candidate across the configured fleet, pin its tag:

```sh
bin/shuttle-deploy --ref v2.0.0-rc.1 --no-push
```

Every invocation resolves `--ref` (or `HEAD` when omitted) to one full commit before contacting any host.
An explicit commit object has no ref to push; branches and tags are pushed unless `--no-push` is set.
The caller executes an in-memory copy of its entrypoint, so refreshing or editing its checkout cannot replace script bytes Bash has yet to read.
When a remote is targeted, preflight fetches origin and verifies that the target is reachable from an advertised origin ref before building or cycling any host.
An implicit target must also descend from the checkout's fetched upstream; `--ref` explicitly authorizes a rollback or divergent revision.
Automated rollback targets must support incarnation-bound quarantine release (`e8fc948a` or a descendant); otherwise release stays held.
Directory-layout `bin/rel` assemblies are supported when they meet that protocol requirement.
A local-only deployment can use an unpublished commit.
Each host uses exactly that object in a detached Git worktree under `<main-worktree>.deploy/<commit>`; no host pulls a moving branch.
Git's common directory selects the main worktree, so linked checkouts share one deploy root.
After successful quarantine release, the regular checkout fast-forwards to the target when it is on a branch, has no tracked edits, and can fast-forward without overwriting untracked files.
Otherwise it stays untouched with an advisory; checkout freshness does not itself fail the host.
Harness inspection runs after this refresh, so Pi can keep loading its package from the regular checkout at the deployed revision.
This also applies when the invoking checkout is linked.
A deploy root must have the target `HEAD`, valid Git metadata, and no tracked edits.
Invalid, incomplete, or missing-but-registered roots are unlocked, removed and recreated under the lease before retrying the build.
A ready daemon already serving that exact root and revision coalesces without another build or daemon cycle; harness verification, quarantine release and pruning still run.
A newer descendant is not substituted for the requested revision.

A host-local kernel lock at `~/.shuttle/deploy.lock` serializes the entire transaction, from worktree preparation through build, activation, readiness, quarantine release and pruning.
A waiting run prints the holder's target, initiating host and PID, executing node's hostname, helper PID/process group and acquisition time.
Lock waits are bounded by `SHUTTLE_DEPLOY_LOCK_TIMEOUT_SECONDS` (3600 seconds by default); timeout fails that host and names the holder instead of stalling the remaining fleet indefinitely.
The helper compiles `scripts/deploy-lock/main.go` with `GOMAXPROCS=2 GOFLAGS=-p=2` under `~/.shuttle/deploy/tools`, then runs the resulting binary.
An attached outer shell waits for that binary to exit before removing its temporary directory on success or failure. If the helper is killed, that shell kills its remaining process group before cleanup.
Removing an executing binary on NFS leaves a `.nfs` file that prevents directory removal, so cleanup belongs outside the helper's process lifetime.
There is no Go compiler parent during the transaction and no dependency on `/tmp` permitting executable files.
Locking does not depend on the installed CLI version.
The helper, transaction shell and local build subprocesses inherit the lock descriptors. The locks drop only when the last holder closes them or exits, including cancelled build descendants, not when cancellation starts or the helper alone dies.
Preparation, harness and activation command shells close descriptors 3 and 4; background launchers and newly started tmux servers cannot retain a finished deploy's locks. The activation control descriptor is closed in those commands and builds too.
An `srun` job on another node inherits no local descriptor and relies on its submitting client's lifetime and cancellation. Kernel lock release does not delete lock files.
Different hosts can deploy concurrently.
Do not delete lock files to recover a deploy; their existence is not evidence that they are held.

### Transaction ownership and diagnostics

**A transaction dies with its observer.** SSH is attached and streams output directly; its exit status and the bootstrap's completion sentinel determine success. There is no detached runner or result polling.
The same helper supervises the local transport and the target transaction. Only the deployer holds its caller lifeline's write end: even a killed deployer closes the transport's stdin. On the target, observer EOF, TERM, INT or HUP cancels lock acquisition or sends TERM to the owned transaction group, then KILL after three seconds. The observer sends a newline every 15 seconds; the target treats 60 seconds without one as EOF, including a stopped observer or silent network partition. A forgotten waiter cannot acquire a lock and deploy later.
The activation socket's original endpoints are close-on-exec. Only its transaction endpoint is passed as fd 5; preparation, activation commands and harnesses close fd 5 before starting children, so owner death gives the transaction EOF.

SSH requests a 15-second connect timeout and 15-second keepalives with three missed replies, including preflights and rsync transports. An existing mux master uses its own settings: a master with a 30-second interval and three missed replies detects a dead link in roughly 90 seconds. The 60-second application heartbeat lease is independent of that transport bound. Failed preflights retain native SSH stderr. Transaction SSH uses `BatchMode=yes`: unattended work cannot prompt in its background process group. Interactive-auth hosts establish their credentials or persistent mux in preflight; `--handshake` is the explicit human approval path before the batch-only transaction.

The caller and target share one absolute `SHUTTLE_DEPLOY_DEADLINE`, defaulting to two hours after transaction start. It bounds login/bootstrap, lock waits, builds and finishing work. It bounds a hung transport or scheduler without waiting indefinitely for a result file.
Pointer selection through readiness verification, quarantine release and rollback-receipt persistence is the protected unit. Before acknowledging its start, the helper requires more deadline time than the readiness timeout plus a one-minute margin; otherwise the pointer stays unchanged. The helper defers observer/signal cancellation across that unit, then cancels before checkout refresh, harness setup and pruning. The hard transaction deadline still forces termination if activation itself stalls. Build, queue and lock waits are not protected.

The caller sends a length-framed bootstrap on stdin. The target reads it completely before starting a login shell, whose stdin is `/dev/null`; a separate descriptor carries observer lifetime. Captured query values have explicit begin/end frames, so profile stdout cannot become a path or JSON value. A profile that exits zero without executing the bootstrap cannot report deployment success.

After acquiring its locks, each target atomically publishes one private `~/.shuttle/deploy/last-run.log`, retaining ordered stdout/stderr and failure diagnostics even when SSH disappears. A waiter keeps private temporary output and cannot overwrite the holder's log. Logging ends at the completion token rather than waiting for background FIFO writers; the launched child closes fd 8. There are no persistent run directories. File privacy does not change the login umask inherited by builds or launched services.

```sh
tail -n 50 ~/.shuttle/deploy/last-run.log
```

After cancellation and group exit, a new deploy can acquire the lock. A completed matching deployment coalesces without another restart.

### Release verification and retention

Before retargeting the launcher, the helper reads the live daemon's commit from `/api/v1/version`.
After a fresh ready boot, quarantine release, advisory checkout refresh and successful harness setup, the helper removes obsolete worktrees with `git worktree remove --force`, then runs `git worktree prune`.
It keeps the new tree, the previous live tree, any tree referenced by `pi list`, the current pointer target, and the running daemon's reported `release_path`.
The previous release is recorded at `~/.shuttle/deploy/previous` after release; a coalesced run reuses that record instead of treating its own target as the rollback root.
Pruning also collects completed `bin/rel.generation-*` assemblies in the regular checkout.
It retains generations referenced by `bin/rel-built`, the selected pointer, the running release or explicit keep paths, and skips assemblies carrying `.assembling`.
Pruning observes and removes under the same release lock as activation and selection, so it cannot delete a selected or running release.
Each transaction also holds a kernel lease at `~/.shuttle/deploy/leases/<commit>.lock` before creating or using its tree.
Lease metadata stays outside deploy roots so rollback targets with older pruning code do not try to remove it as a worktree.
Pruning tries that lease without waiting and skips an in-flight tree; released leases do not retain obsolete trees.
Only registered Git worktrees are removed, so stale ordinary directories do not fail pruning.
An unavailable or unreported running release refuses pruning.
Generated files and local edits do not prevent removal of other trees.

A new worktree seeds `daemon/deps`, `daemon/_build`, and `ui/node_modules` from the previous live tree.
If that tree is unavailable or is the target being created, it seeds from the regular checkout instead.
These are Mix dependencies and compiled artifacts, plus npm dependencies and the `.npm-ci-stamp` that lets `make ui` skip `npm ci`.
Symlinked cache roots disable seeding.
Otherwise the helper stages no-dereference copies (APFS clones with `cp -c` on macOS, reflinks where supported on Linux) and publishes them only after successful copying; any seeding failure is reported and the build proceeds cold.
Version tags stamp both CLIs and the daemon with the release version.
If Pi loads a Felt package from another revision, the helper reports the mismatch without replacing that package choice.
Use Pi's native package commands to select the deployed source directory, then rerun the host's deployment check.
Use `--hosts local,hub-a` to deploy a subset.

Push the verified revision, then deploy it on each host:

1. Under the host lock and tree lease, prepare the pinned detached checkout, run `make build`, then explicitly run `make cli-install` in the host's login environment.
2. Prepare the pin-only supervisor migration with the checkout-built CLI.
   Every environment entry except `SHUTTLE_RELEASE` stays verbatim, including
   host identity, proxies, and an absent `TMUX_TMPDIR`.
   Other service settings and unrelated definitions stay untouched.
3. Atomically select the built release immediately before cycling through its supervisor or respawn loop.
   A verified live tmux loop takes precedence over service files.
   It stays running, disables competing service managers, and respawns its listener after a graceful SIGTERM.
   If disabling a competing manager already stopped the original listener, the replacement from the loop is left alone.
   A service-owned daemon is cycled once through that manager, without a separate listener kill.
   A loaded supervisor's pin migration counts as that cycle; the activation callback does not restart it again.
   An unsupervised listener is stopped before installing the respawn launcher.
4. Poll `/api/v1/version` until `git_short_sha` matches, `booted_at` advances, `release_path` equals the selected canonical release, and `ready` is `true`.
   Require `contract.ok: true`, an explicit `reconciliation_hold: null`, and a nonempty `incarnation`.
   `SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS` defaults to 900 and `SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS` to 5; both overrides are forwarded explicitly to remote transactions.
5. Post to `/api/v1/quarantine/release` with `expected: {incarnation, release_path}` from that verified response, then record the previous release.
   HTTP 409 means the daemon incarnation changed; verify the replacement before releasing it.
6. Fast-forward the clean regular checkout when possible, then run `felt setup <harness>` for each harness carrying felt's plugin and check `felt setup receipt` (see [harness plugins](#harness-plugins)).
7. Prune obsolete deploy roots after the harness checks succeed.
8. Check the changed behavior through the live API or board.

Refreshing an answering daemon is allowed only when the target service manager reports the PID that holds its listener.
The check needs `lsof`; an unreachable manager, missing inspection tool, stale unit file, or different owner refuses the refresh without stopping the listener.
Installation resolves the service's endpoint from the manager's environment, the host configuration, and the rendered port, not a caller-only `SHUTTLE_LISTEN` override.
Systemd drop-ins are refused because they can change that environment; move their settings into supported install options or `host.json` before refreshing.
A live tmux loop must be stopped before installing a service instead.
Refresh writes the stop marker in the service's resolved data directory and cycles only the target manager's service, never every process using the same release.

`shuttle daemon start` and `install` share an atomic endpoint claim that covers the pre-listen window.
The claim follows the foreground process across `exec` until it dies; installation hands its claim only to the target manager's verified new main process.
The installer waits up to 30 seconds for that handoff, even if the manager's restart command returns first.
On timeout it stops the pending service before releasing its reservation; an unconfirmed stop is reported as unresolved ownership.
This prevents concurrent cooperating starts and start/install races from launching competing daemon processes.
It does not serialize creation of external supervisor definitions or protect direct execution of the release launcher.
Two supervisors created concurrently can still exist, but their CLI starts cannot own the same endpoint concurrently; remove the unwanted supervisor rather than leaving it to retry.

The helper builds both CLIs, the daemon, and — on every host that is not marked
`"build_ui": false` — the UI, on that host.
An autonomous worker should deploy a built, tested, independently reviewed change.
Restarting briefly interrupts the API and board; existing tmux workers keep running.
Every daemon cycle quarantines fresh launches until `shuttle daemon release`:
previously-running workers restore without that gate.
the cycle touches `$SHUTTLE_DATA_DIR/heartbeat.stopped` on the target host and
then stops the daemon with SIGTERM (whose shutdown touches the marker again), so
the rebuilt daemon sees a graceful stop and holds. Only on a host that opts in
(host.json `"quarantine_auto_release": true`) does a daemon killed hard, and back
within the heartbeat window, with no churn and its previous
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

`make build` installs a new `felt`; harness setup reconciles its plugin payload
and records the source/build identity outside all plugin roots. The helper
runs harness setup in the host's login environment after activation, quarantine
release and the advisory checkout refresh, when the receipt does not already
identify that clean revision. A changed source/build identity does not by
itself require reinstalling a native plugin cache.

A harness counts as installed where felt's plugin is enabled in it: Claude Code
and Codex as the enabled bundles in `felt setup receipt --json`, and pi as a
felt package in `pi list`, either `git:github.com/cailmdaley/felt` or a local
directory whose committed `package.json` (its working copy, outside git) names
felt. A harness binary on `PATH` without
felt's plugin is left alone, so the deploy never installs a plugin the operator
did not install or has removed. A host with no such harness reports
`harness plugins: none carry felt`.

The schema-2 JSON receipt separates per-bundle diagnostics from deployment
selection: `bundles[].active` reports each bundle's activation, while the
unique `harnesses[]` rows carry `harness`, `enabled`, `inspection`, and `repair`.
Deployment consumers select enabled harness rows once, not one setup per
bundle; the split Codex integration still requires only one `felt setup codex`.

Each receipt bundle's `inspection` says how its activation was established:
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
flag and no generation. Setup compares actual native cache bytes against
external provenance at `~/.felt/plugin-runtime/current/.felt-generation.json`.
Claude's combined plugin and Codex's `felt` hook bundle and `felt-skills`
bundle each skip native install/update/remove/add when their payload matches.
Codex manifests use an adapter-format version, not the release version: a
Go-only revision changes zero hashed plugin bytes, and a skills-only revision
leaves the installed hook root untouched.

A genuine Codex hook change installs normally and warns that live processes
will refuse hooks until restarted. Exit each affected session, then run
`codex --no-daemon resume <session-id>`; wait for an old writer to unload if
necessary. A new terminal can reuse the stale App Server, so it is not enough.
The first combined-to-split setup requires this same cutover even with unchanged
hook commands. The process and conversation survive, but hooks fail until the
runtime is refreshed; a healthy receipt verifies installed state, not live
runtime approval. Setup neither restarts workers nor retains per-worker
plugin generations. Keep CLI hook interfaces compatible with installed
wrappers, which resolve the separately upgraded Felt and Shuttle binaries.
See [plugin integration](releasing.md#plugin-promotion) for the trust boundary.

For pi's GitHub package, deployment fetches and detaches a clean clone at the pinned commit when it differs from the checkout's `HEAD`.
Tracked edits or a commit that cannot be fetched fail the host. A local felt
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
receipt's top-level repair when no component reports one. A harness problem fails the host after its daemon activation and quarantine release, so it does not leave the daemon on the wrong build.
A failed build, activation, readiness check, quarantine release or prune also makes the invocation exit nonzero, with the host and failed step in its output. A pi clone that cannot fetch
the deployed commit fails the host.

### The Rex title helper

On a Mac with Rex, `make cli-install` builds `scripts/shuttle-rex-title.c` into `~/.local/bin/shuttle-rex-title` if nothing is there, then asks macOS for Accessibility once. An ad-hoc-signed grant is bound to the binary's code hash, so deploys never rebuild it. To change the helper, delete the file, remove its entry from the Accessibility list, and grant the new one. It disclaims responsibility on exec, so macOS checks its grant whichever process runs it, and the daemon spawns it each second while listening. `shuttle doctor` reports the state as `Rex session following`.

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
to run its build through a scheduler.
The optional string is a trusted shell command prefix: deployment runs `<build_wrap> bash -lc '<build>'` inside the SSH login shell.
Only the build (including its checkout directory, CLI installation and version environment) is wrapped.
Fetching the pinned object, worktree preparation, harness refresh, and daemon cycling stay outside the wrapper.
The lock bootstrap also runs outside the wrapper, with its own bounded Go parallelism.
An `srun` prefix gets `--immediate=900` unless it supplies an immediate limit, bounding its queue wait. Cancellation signals the submitting client in the transaction group so it cancels its step.
This composes with `build_ui: false` and `SKIP_UI=1`.

`bin/shuttle-deploy --list` shows the choice per host (`build` or `shipped`).
For a `shipped` host the helper snapshots the pinned revision's local `ui/dist` while holding the local tree's lease.
It rsyncs that snapshot to a unique temporary directory on the remote, then publishes it into the remote deploy tree under that host's lock and lease before running `make build SKIP_UI=1`.
Neither a competing deploy nor pruning can remove the rsync source mid-transfer.
The key is absent on every host that builds its own, and only `bin/shuttle-deploy` reads it — the felt CLI and the daemon carry it through untouched.

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
