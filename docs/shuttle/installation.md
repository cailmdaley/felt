# Installation reference

For a guided first installation, start with [Set up Shuttle](setup.md).
[Connect your machines](remotes.md) covers the multi-host path, and [Opening conversations](conversations.md) covers terminals and Remote Control.
This page covers installing, upgrading and supervising the daemon;
[Configuration](configuration.md) covers stores, agents, host trust and remotes, and
[Sharp edges](troubleshooting.md) collects what tends to go wrong.

The two Go CLIs are installed together: `felt` manages fiber data, and `shuttle`
owns Shuttle configuration and orchestration. The Elixir daemon and board are
optional; choose how to add them.

- **Fetch the release.** The install script puts both Go CLIs on `PATH`. With
  `SHUTTLE_DAEMON=1`, it also fetches the platform's daemon release, carrying
  its Erlang runtime and board bundle. No toolchain or checkout is needed.
- **Build from a checkout.** `scripts/bootstrap.sh` builds both CLIs and the
  daemon from source, places the board bundle, and installs the keep-alive.
  This is what the source deploy script updates; use it when changing daemon code.
  Prebuilt releases also support multi-host fleets.

The daemon needs `tmux` and both Go CLIs at runtime. Terminal workers use the host's selected backend, tmux by default or Rex on a configured host.
The daemon shells out to `felt` for fiber content and generic writes,
and to `shuttle` for resolved reads and Shuttle-owned operations.

!!! note "Platform and operating modes"
    Linux and macOS support single-host use — the daemon, board, and workers on
    one machine, with a keep-alive supervisor that restarts the daemon if it
    crashes. Multi-host tunnel management (`shuttle tunnels`) installs
    launchd jobs on macOS and systemd user units on Linux. Multi-host operation uses Tailscale discovery or configured SSH tunnels. Windows is unsupported.

## Upgrade from 1.x

Version 2 separates the `felt` and `shuttle` commands.
Replace `felt shuttle …` with `shuttle …` in your scripts, and use `shuttle daemon …` for service management.
The 1.x `felt update` installs only one binary, so use the [release installer](#fetch-the-release) with `SHUTTLE_DAEMON=1` to install both CLIs and the matching daemon.
Keep your original `FELT_INSTALL_DIR` and `SHUTTLE_HOME` overrides if you customized the installation paths.

Before restarting, copy your Shuttle settings to their current directory without overwriting settings already there:

```sh
mkdir -p ~/.config/shuttle
for name in host.json remotes.json agents.json stores.json projects.json; do
  if [ -f "$HOME/.config/felt/$name" ] && \
     [ ! -e "$HOME/.config/shuttle/$name" ] && \
     [ ! -L "$HOME/.config/shuttle/$name" ]; then
    cp -p "$HOME/.config/felt/$name" "$HOME/.config/shuttle/$name"
  fi
done
```

Your fiber stores stay where they are.
Review the existing supervisor's environment and any custom service options before replacing it.
Preview the replacement with `shuttle daemon install --print`; supply your existing store list, PATH, SSH socket, tmux directory, log path, label, and port overrides when needed.
Use `shuttle daemon install --help` for those flags.
If your supervisor uses `FELT_STORES_FILE` for a custom store registry, carry that path forward as `SHUTTLE_STORES_FILE` in its environment.
Then run `shuttle daemon install` with the reviewed options to reload the service, followed by `shuttle doctor`.
Review eligible tasks before running `shuttle daemon release` to end the startup hold.

For source checkouts, `bin/shuttle-deploy` copies these configuration files and refreshes pre-split supervisors as part of deployment.

## Prerequisites

At runtime, whichever path you take:

| Tool | Required | Purpose |
| --- | --- | --- |
| `felt` | yes | The daemon shells out to felt for fiber content and generic writes. |
| `shuttle` | yes | The daemon shells out to shuttle for resolved reads, Shuttle operations, and its CLI contract. |
| `tmux` | yes | The default worker backend and auxiliary services use tmux. On a Linux host without systemd, the daemon's own keep-alive is a tmux loop too. |
| `jq` | optional | `session.sh` uses it to pretty-print the SessionStart envelope. Without it the hook falls back to `felt hook session`. |

Building from a checkout adds a toolchain, none of which the fetched daemon
needs:

| Tool | Required | Purpose |
| --- | --- | --- |
| `go` 1.26+ | yes | Builds both Go CLIs from the same checkout as the daemon. |
| `elixir` 1.19+ / OTP 28 | yes | `daemon/mix.exs` declares `elixir: "~> 1.19"`. CI builds on OTP 28, and a fetched release carries the OTP runtime it was built with. |
| `node` 22+ / `npm` | yes | Source builds compile the board into `ui/dist` on each host. A fetched daemon ships the bundle already built. |

`scripts/bootstrap.sh` checks all of these and names what is missing.

## Fetch the release

These commands select **2.0.0-rc.2** for prerelease testing.
Stable updates and Homebrew do not select release candidates automatically.

The install script always installs both Go CLIs. Set `SHUTTLE_DAEMON=1` to
also unpack the daemon release:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | FELT_VERSION=2.0.0-rc.2 SHUTTLE_DAEMON=1 sh
```

!!! warning "Environment variables go after the pipe"
    `SHUTTLE_DAEMON=1` sets the environment of `sh`, which is what reads the script.
    Written the other way round — `SHUTTLE_DAEMON=1 curl … | sh` — it sets `curl`'s
    environment instead, the script never sees it, and you get both Go CLIs
    but no daemon, reported as success. The same holds for `FELT_VERSION` and
    `SHUTTLE_HOME`.

Both Go CLIs land together: `/usr/local/bin` if that is writable, else
`~/.local/bin`, overridable with `FELT_INSTALL_DIR`. The Mix release lands in
`~/.local/share/shuttle` — override with `SHUTTLE_HOME` — and is managed through
the `shuttle` CLI:

```bash
SHUTTLE_STORES=~/dev/myproject shuttle daemon start
```

That runs in the foreground and stops on `Ctrl-C`. To have the daemon start at
login and come back after a crash, hand it to the supervisor that ships in the
same tarball — `shuttle daemon install`, walked through step by step for macOS in
[Set up a supervised daemon on macOS](#set-up-a-supervised-daemon-on-macos) and
covered in full under [Keep-alive](#keep-alive).

What you downloaded is a Mix release: the daemon's compiled modules, the
bundled Erlang runtime and native components, and the board bundle, in one
directory tree. It reads nothing from the host's toolchain, which is why this
path asks for no Elixir and no Node. The bundled runtime makes each tarball
platform-specific — matching OS and CPU architecture — and the matrix covers
four: `shuttled_{Linux,Darwin}_{x86_64,arm64}.tar.gz`. The separate
`felt_{os}_{arch}.tar.gz` Go CLI archive contains both `felt` and `shuttle`.

On Linux the one thing the host must supply is a C library at least as new as
the one the release was built against. The Linux tarballs declare a floor of
**glibc 2.28** (RHEL/Rocky/Alma 8, the `manylinux_2_28` baseline): they are
built inside an EL8 container, and CI reads the required `GLIBC_`/`GLIBCXX_`/
`GCC_` symbol versions back out of every binary and refuses to publish an
artifact above that floor. So a release that boots on an EL8 login node boots
on every newer distribution too; `ldd --version` tells you where a host stands.
The Go CLIs have no such requirement — they are static binaries.

The installer checks this for you: before it replaces anything it starts the
bundled runtime (`bin/shuttled eval …`) and reads the version from inside the
VM. A tree whose runtime cannot start on the host is reported, with the
loader's error, and left uninstalled. Do the same yourself if you copy a
tarball around by hand — the launcher's `version` verb is a shell readout that
succeeds on a runtime that cannot run.

Upgrade by running the same command again. It deletes `$SHUTTLE_HOME` and
unpacks the new tarball in its place, so keep nothing of your own in there. The
daemon's state lives in `~/.shuttle` and survives.

The daemon tarball carries what the release needs to run *and* to keep
running. Under its root sit `bin/`, `erts-*/`, `lib/`, `releases/` and
`share/`. `bin/` contains `shuttled`, the BEAM launcher; `share/` holds the
launchd plist and systemd unit templates. The supervisor invokes the installed
Go `shuttle` CLI, which reads the release selected in `~/.shuttle/repo` at launch, and `shuttle daemon install` renders
the same templates in a checkout or fetched install. Both templates raise the
daemon's open-file limit to 8192 (the soft `NumberOfFiles` for launchd, leaving
the hard limit at its default; `LimitNOFILE` for systemd). launchd's default soft limit of 256 is fewer descriptors than a
busy board's sockets and `felt` pipes can need.

What the tarball leaves behind is the repo's *development* surface: the `make`
targets and `bin/shuttle-deploy`. A fetched host runs a daemon and keeps it
alive; it cannot build one, and it cannot deploy to a fleet.

### Set up a supervised daemon on macOS

This is the whole sequence on a Mac — from nothing to a daemon that starts at
login and restarts itself when it dies. No checkout, no toolchain. Run the steps in order, or start the service first and register your store through Settings.

**1. Install the CLI and the daemon.**

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh \
  | FELT_VERSION=2.0.0-rc.2 SHUTTLE_DAEMON=1 sh
```

`SHUTTLE_DAEMON=1` goes *after* the pipe, for the reason in the warning above: in front
of `curl` it sets the wrong process's environment, and you get both Go CLIs
but no daemon, reported as success.

A fresh Mac ships no `tmux`, and the installer says so when it finds none. The default worker backend and auxiliary services need tmux:

```bash
brew install tmux
```

**2. Create a felt store — and keep it out of `~/Documents`.**

The daemon polls exactly the felt stores you register and assumes none. Make one somewhere
launchd is allowed to read:

```bash
mkdir -p ~/notes && cd ~/notes && felt init
```

For a fresh installation, you can seed the stores registry before installing the supervisor.
If it already exists, add to its list rather than replacing it; alternatively use Settings → Notes & tasks after startup:

```bash
mkdir -p ~/.config/shuttle
printf '{"version":1,"felt_stores":["%s"]}\n' "$HOME/notes" \
  > ~/.config/shuttle/stores.json
```

!!! warning "Not `~/Documents`, `~/Desktop`, or `~/Downloads`"
    macOS blocks launchd-started processes from those three folders, and
    granting Full Disk Access does not rescue you — the grant does not inherit
    down the launchd process tree the way it does under a terminal. A store in
    one of them is *discovered and unreadable*: the daemon starts, the board
    loads, the board shows nothing, and no error appears anywhere. Anywhere else
    in your home directory works — `~/notes`, `~/dev`, `~/loom`. The same rule
    covers the daemon itself. `shuttle daemon install` checks both — the
    release it is installing and every store you name — and warns on stderr
    about any path under one of the three, but it installs anyway, so read what
    it prints.

!!! warning "macOS tmux backend: start your tmux server from a terminal, not the daemon"
    On a tmux host, terminal workers run inside tmux, and macOS charges file access to a process
    tree's *responsible process* — for anything launchd spawns, that's the
    daemon's own executable, not the worker or its shells. If no tmux server
    is running when the daemon tries to dispatch, forking one itself would
    make the daemon the responsible process for every worker underneath it,
    so every file a worker or its tools touch (`~/Documents`, an app's saved
    data, anything outside the sandbox) raises a TCC prompt the daemon can
    never hold the grant to answer. The daemon refuses instead: it asks your
    running terminal (kitty, remote-controlled) to start the server, and if
    none is reachable it declines the dispatch and reports why on the board
    rather than silently rooting a server itself. Keep a tmux server alive
    from a terminal you started by hand — `shuttle doctor` reports when the
    current server is daemon-born. Workers on that server are charged to the
    daemon binary, so restart the server from a terminal once no workers are
    live.

!!! note "Already using felt on this machine?"
    Then step 3 is the step that decides what the board shows. The daemon polls
    exactly the stores you name and assumes nothing else — so a machine that
    already holds fibers, pointed at a fresh `~/notes`, gets a daemon running
    perfectly and a board that is perfectly empty. Nothing warns you, because
    nothing is wrong: you asked for this.

    Once the daemon is running, bring existing stores in through
    Settings → Notes & tasks individually, or — better past the first couple —
    join them by symlink into a single **cross-project store** and
    name only that. felt re-discovers a store's symlinked substores, so the
    aggregate is the one entry the daemon needs, and adding a project later
    means adding a symlink rather than editing the daemon's configuration.

    Which end holds the real bytes is a real decision, not a formality. A
    project with its own git remote, or one inside iCloud Drive or Dropbox,
    keeps its bytes where they are and gets a symlink *into* the aggregate;
    an ordinary repo you control the sync for can go the other way.
    [Cross-project stores](../concepts/cross-project.md) walks both
    directions, and the merge-before-you-link procedure that keeps the fibers
    on the losing side from vanishing.

**3. Hand the daemon to launchd.**

```bash
shuttle daemon install
```

That writes `~/Library/LaunchAgents/io.shuttle.daemon.plist` and loads it. The
daemon comes up immediately, comes back at every login, and restarts on crash.
The board reads `~/notes` from the registry; add any additional stores in
**Settings → Notes & tasks**. Changes take effect without reinstalling the supervisor.

**4. Check it, and know how to undo it.**

```bash
launchctl list | grep shuttle                   # the job is loaded
curl -s http://127.0.0.1:4000/api/v1/version    # the daemon answers
tail -f ~/Library/Logs/shuttle.log              # what it is doing
```

Then open <http://127.0.0.1:4000/> for [the board](board.md).

To undo it:

```bash
shuttle daemon uninstall
```

That unloads the job and deletes the plist, which stops the running daemon too.
Nothing else goes: the release, your store, and the daemon's state in
`~/.shuttle` all survive, and `shuttle daemon install` puts the job back.

<a id="release-candidates"></a>
### Pin a release

The installer selects the latest stable GitHub release by default; `felt update` always selects stable.
Set `FELT_VERSION` for the installer when you need an exact tag; it skips the
`releases/latest` lookup and fetches the matching `felt` and `shuttle` CLIs,
and the daemon release when requested:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh \
  | FELT_VERSION=2.0.0-rc.2 SHUTTLE_DAEMON=1 sh
```

Replace `2.0.0-rc.2` with the tag you want. Both variables sit after the pipe, for
the reason above: an install that silently drops `FELT_VERSION` fetches the
latest stable instead. The tag is accepted with or without its leading `v`. If
it has no `shuttled_<os>_<arch>.tar.gz` asset for your platform, the install
names the tag and missing asset rather than leaving a bare `curl` error.

The 1.x releases packaged a single CLI and require the installer from their own Git tag.
The current installer requires both `felt` and `shuttle` in the CLI archive.

Prerelease tags and release candidates are excluded from latest and Homebrew
selection. Pin one explicitly with `FELT_VERSION` when you want to test it.

A fetched daemon reports the tag it was built from, so you can check what you
are actually running:

```bash
curl -s http://127.0.0.1:4000/api/v1/version    # mix_vsn is the release tag
```

Keep the version pin while testing this candidate.
The stable channel is still 1.x and uses different commands, configuration paths, and packaging.
Returning to it requires that tag's installer and service configuration; an unpinned update is not a rollback procedure for 2.0.

## Build from a checkout

Clone the repo, then run the bootstrap. `make install` runs the same thing.

```bash
git clone https://github.com/cailmdaley/felt ~/dev/felt
cd ~/dev/felt
./scripts/bootstrap.sh --dry-run     # check prerequisites, print the plan, change nothing
./scripts/bootstrap.sh               # or: make install
```

Six steps run in order.

1. **Prerequisites.** Named, with install hints. A missing required tool aborts
   the run before anything is built.
2. **Go CLIs.** `make cli-install` builds and installs `felt` and `shuttle`
   from *this* checkout, so the daemon and its CLIs share one source revision.
3. **Daemon release.** `make daemon` assembles an immutable `bin/rel.generation-*` Mix release and atomically publishes `bin/rel-built` pointing to it.
   Building does not select a release or touch the host daemon; keep-alive installation selects it.
4. **`ui/dist`.** Builds the served board bundle with Node and npm on this host.
5. **Event stream.** Runs `felt setup claude` and `felt setup codex` against
   this checkout, so the plugin hooks match both CLIs. Then it pipes a probe
   payload through `shuttle hook event` and checks the line it writes. Details in
   [The event stream and the ledgers](telemetry.md#recording-and-rotation).
6. **Keep-alive.** Installs a supervisor — the OS service manager that starts
   the daemon at login and restarts it if it dies: a launchd LaunchAgent on
   macOS, a systemd user unit on Linux (or a tmux respawn loop where there is
   no systemd user session). Details in [Keep-alive](#keep-alive).

Useful flags: `--dry-run`, `--skip-hook`,
`--skip-cli`, `--with-tunnels`.

Editing daemon source means rebuilding: the release runs the compiled modules
in its selected generation, so a restart alone picks up nothing. `make restart` rebuilds
and bounces in one step from the main checkout. In a linked worktree it only builds;
use `bin/shuttle-deploy --hosts local --ref <commit>` to activate that revision.

## Verify

```bash
curl -s http://127.0.0.1:4000/api/v1/version   # daemon answers
shuttle ps                                # running workers
make logs                                      # tail the daemon log
make status                                    # ps + a snapshot summary
```

The two `make` targets belong to a checkout. From a fetched install, run
`shuttle daemon status` and tail the log
where the supervisor put it: `~/Library/Logs/shuttle.log` on macOS,
`~/.shuttle/shuttle.log` on Linux, or wherever `--log` pointed it. A daemon you
started in the foreground logs to your terminal instead.

Open <http://127.0.0.1:4000/> in your browser for [the board](board.md).

A single-user host defaults to `127.0.0.1:4000`; shared and exposed hosts default to a protected Unix socket.
See [Host classes and trust boundaries](configuration.md#host-classes-and-trust-boundaries).
The API carries no authentication layer. Treat it as a trusted
single-user admin surface: anyone who can reach it through an SSH forward,
Tailscale Serve, or another proxy can read and edit fibers, control workers,
and launch agents. Keep any forwarding limited to people and networks you
trust; do not publish the port to the open internet.

## From an empty board to a first dispatch

With the daemon up, here is the fastest path from nothing to a worker running.

Register the directory containing `.felt/` in **Settings → Notes & tasks**, preserving existing entries.
If `SHUTTLE_STORES` pins the list, follow [Configuring stores](configuration.md#configuring-stores) to change it.

Add a fiber and give it a `constitution` tag — tags gate nothing, but they
make the fiber findable as one:

```bash
felt add pipeline/first-pass "Rewrite the covariance loader" -t constitution
```

Open `.felt/pipeline/first-pass/first-pass.md` and write the spec: a
heading-less lede, then a `## Desired State` section stating what "done" looks
like in checkable terms. See [Writing a
constitution](constitutions.md#2-write-the-spec) for the shape.

Install the `shuttle:` block. This is what turns the fiber into something the
daemon will pick up:

```bash
shuttle install pipeline/first-pass --project-dir "$PWD" --model claude-opus
shuttle daemon release
```

Inspect other eligible tasks before releasing: the release applies to the entire host.
Open <http://127.0.0.1:4000/> — the fiber shows up as a card, armed. The
daemon polls every 30 seconds by default, so the card moves to in-flight on
its own; `shuttle dispatch pipeline/first-pass` skips the wait. `shuttle ps`
lists the live worker, and `shuttle attach pipeline/first-pass` opens its terminal.

When the worker closes, the fiber's `outcome` and `## Status` describe the result, and the card lands in Awaiting review.
A handoff leaves the task active for another worker to continue.

!!! note "First dispatch not starting?"
    Every restart arms a boot quarantine that holds new work until you run
    `shuttle daemon release` — see the first entry in [Sharp
    edges](troubleshooting.md) if your card sits armed with nothing happening. The
    `shuttle` CLI is on `PATH` in a fetched install too.

That's the whole path from install to a worker on the board. Everything below
is what the daemon is doing underneath, and the configuration knobs for a setup
beyond one machine.

## Keep-alive

A supervisor is what turns "the daemon is running" into "the daemon runs": it
starts the daemon at login and restarts it when it dies. `shuttle daemon install`
installs one, branching on `uname -s` — a launchd LaunchAgent on macOS, a
systemd `--user` unit on Linux — and points you at the tmux respawn loop on a
Linux host that has no user-level systemd.

The verb is the same wherever the daemon came from:

```bash
# fetched install
shuttle daemon install

# checkout — builds the release first, then calls the same verb
make install-agent
```

The `shuttle` Go CLI is installed on `PATH` with `felt`; the Makefile target
builds the same CLI from a checkout. Both paths render the templates from
`daemon/share/` in a checkout or `share/` in a fetched installation. The
service records the absolute installed `shuttle` executable and starts it with `shuttle daemon start`.
The CLI reads `~/.shuttle/repo` on each launch; the service's working directory is the user's home.
`shuttle daemon install`, main-checkout `make restart`, and deployments select the release in that one pointer. `make start` follows the existing selection without changing it. Builds never select or cycle the daemon.
Main-checkout activation and deployments share an automatic pin-only migration: remove `SHUTTLE_RELEASE` and replace a checkout-dependent working directory with home, preserving every other environment entry and service setting verbatim.
Activation selects immediately before cycling and restores the previous selection and migrated definitions on failure.
Selection, activation and pruning share a lock; deployment verifies the booted `release_path` as well as the revision and readiness.
A missing selected release fails with its path and repair commands; the tmux loop backs off rather than spinning.
The same templates serve both installation paths.
`/api/v1/version` and `shuttle daemon status` report `release_path`, the absolute release root the running VM booted from (`"unknown"` under Mix).
The pointer selects the next boot; changing it does not change a running VM's receipt.

The install fixes these values into the job:

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--stores <list>` | `AGENT_STORES` | empty — use the editable store registry |
| — | `SHUTTLE_STORES_FILE` | `~/.config/shuttle/stores.json` |
| `--path <PATH>` | `AGENT_PATH` | the login shell's `PATH`, captured at install time |
| `--tmux-tmpdir <dir>` | `AGENT_TMUX_TMPDIR` | the login shell's `TMUX_TMPDIR`, captured at install time; omitted when empty |
| no flag | `CODEX_HOME` | the installed supervisor's value, else Codex's default home |
| `--log <file>` | `AGENT_LOG` | `~/Library/Logs/shuttle.log` (macOS), `~/.shuttle/shuttle.log` (Linux) |
| `--ssh-auth-sock <path>` | `AGENT_SSH_AUTH_SOCK` | `~/.ssh/agent.sock` (macOS), empty (Linux) |
| `--label <name>` | `AGENT_LABEL` | `io.shuttle.daemon` |
| `--port <n>` | `AGENT_PORT` | unset — the daemon binds 4000 |

`--label` and `--port` exist for one purpose: supervising a **second** instance
beside the one you already run. The label names both the launchd job and the
systemd unit, so leaving it at the default on a machine that already has a
supervised daemon replaces that daemon rather than adding one. Give the second
instance both a label and a port, or the two fight over 4000:

```bash
shuttle daemon install --label io.shuttle.daemon-test --port 4394 \
  --stores ~/test-store
```

`shuttle daemon uninstall` takes the same `--label`, and needs it — without
one it looks for the default job and removes nothing.

Two more flags render without installing: `--print` (also `--dry-run`) writes
the job to stdout and changes nothing, and `--os Darwin|Linux` renders the other
platform's file for inspection. `--os` is rejected outside `--print`, so an
install can never take a branch this host cannot run. Warnings go to stderr, so
`--print > somewhere.plist` still gives you a clean file.

Most become environment variables in the rendered job, because neither
supervisor hands the daemon your login environment; `--log` says where the
daemon's output goes, and `--label` names the job itself. A flag beats its environment variable, and `make
install-agent` passes the `AGENT_*` variables straight through, which is why the
checkout form spells them that way.

`--stores` has no default on purpose. A daemon that polls nothing boots
clean, binds `:4000`, serves an empty board and dispatches nothing — a failure
that looks like success — so `shuttle daemon install` refuses rather than
installing one.

To see the job before installing it:

```bash
shuttle daemon install --stores ~/notes --print
shuttle daemon install --stores ~/notes --print --os Linux
```

`--print` (or `--dry-run`) renders to stdout and changes nothing. `--os` renders
the other platform's file for inspection, and it is accepted *only* alongside
`--print`, so an install can never take a branch this host cannot run.

`shuttle daemon uninstall` reverses the install on either platform, and
`make uninstall-agent` calls the same command.

### Cluster login recovery and Rex

For an existing deployment, run `bin/shuttle-login-install` from a checkout on
the node that serves the daemon, after deploying the matching CLI and daemon.
It installs the helpers and profile hook from the selected release without
restarting services, and refuses to stamp ownership unless the daemon answers
locally and the owner pin agrees with this node.
Run this step on each Linux host after `bin/shuttle-deploy` when adding login recovery.

On Linux, `scripts/bootstrap.sh` installs `shuttle-ensure` and adds it to the
Bash or Zsh login profile. It records the short hostname that ran bootstrap in
`~/.shuttle/owner-node`; set `SHUTTLE_OWNER_NODE` during bootstrap to choose a
different owner node. Each login prints the node that owns the daemon to stderr,
keeping stdout available for machine-readable SSH replies. The
ensure returns immediately after starting a detached check, and only the owner
node may start the userspace `tailscaled` loop or the daemon's configured
supervisor. The daemon and tailscaled launchers enforce the same owner pin,
including when the hub asks a host to recover over SSH. This prevents a shared
cluster home from starting the same host on a second login node. Move ownership
only after stopping the daemon and tailscaled supervisors on the old node; then
edit `~/.shuttle/owner-node` to the new node's short hostname and log in there.
Changing the pin does not stop already-running processes. The login ensure and
SSH recovery launchers honor the pin. A directly managed systemd unit starts
the Go CLI without this shell guard, so install that unit only on the owner
node when homes are shared.

The systemd unit or tmux respawn loop restarts a failed daemon. On a cluster,
the login ensure recreates a missing loop after an SSH login; hub SSH recovery
can do the same if the hub is reachable and its credentials are valid. The
login ensure and SSH recovery launchers honor the owner-node pin.

Remote state and fiber registries follow discovery even when no peers are known at boot.
They poll at each remote's configured interval for 45 seconds after a board or composite API read, and at least 60 seconds apart otherwise.
Background thread reconciliation reads the cache without requesting fast polling; remote thread results still arrive through the background feed, with up to one minute of polling latency.
Cached data's staleness window follows that cadence, while recovery actions retain their own deadlines.
Explicit feed refreshes fetch immediately.

On a Rex host, the dispatcher checks for the Rex server on its poll tick and
starts it when absent, even when no worker is waiting to launch. Rex keeps
sessions outside the daemon, so ordinary daemon restarts leave them running.
Stopping the Rex server ends all its sessions; the live daemon detects the
missing workers and restores them from Shuttle's durable worker and turn
evidence. This does not restart the daemon or release its boot quarantine.

`bin/rex-install` replaces the Linux Rex executable without touching the
running server. To activate an upgrade, run `rex server stop` as a planned
restart. That ends all sessions; on its next poll tick, the daemon starts the
new Rex binary and restores assigned workers. If the tailnet listener failed
when Rex started, Shuttle falls back to a local-only server. The live server
keeps that configuration, so bringing tailscaled back does not add the
listener; stop Rex in a planned restart to have Shuttle try again.

### macOS (launchd)

`shuttle daemon install` renders `daemon/share/io.shuttle.daemon.plist.template`
(`share/` in a fetched installation) into
`~/Library/LaunchAgents/io.shuttle.daemon.plist` and loads it (bootstrap step 6
does this through `make install-agent`). The agent sets `RunAtLoad` and
`KeepAlive`, so the daemon starts at login and restarts on crash. A daemon you
had started by hand is stopped first — the job starts its own, and two would
fight over `:4000`.

Six environment variables go into the plist. Each one exists because the
obvious approach failed:

- **`PATH`** — captured *at install time* from one login shell run in a
  scrubbed environment (your `$SHELL` as `-lic`, then `-lc`, then
  `/bin/bash -lc`), so the installing session's own values cannot leak in.
  launchd's own environment is nearly empty, and the daemon cannot find `felt`
  or `shuttle` in it. (The daemon itself needs nothing off `PATH` to boot — it
  carries its own Erlang runtime — but shells `felt` for fiber content and
  `shuttle` for resolved views and orchestration.) Sourcing the login profile
  at runtime does not fix it, because the profile is not self-sufficient from
  a bare environment. So the plist freezes the real login `PATH`. A `PATH`
  without `felt` can leave the daemon up but break fiber-content endpoints.
  Without `shuttle`, the boot contract check holds the daemon and Shuttle-owned
  reads and operations fail.
- **`SHUTTLE_STORES`** — empty by default, so the daemon reads the editable
  `stores.json` registry. Empty also clears any override inherited from the
  supervisor manager. `--stores` explicitly pins a comma-separated list
  instead and makes Stores read-only in Settings.
- **`SHUTTLE_STORES_FILE`** — the registry location, captured at install time.
  felt re-discovers a store's symlinked substores, so one
  [cross-project store](../concepts/cross-project.md) is usually enough.
- **`SSH_AUTH_SOCK`** — `~/.ssh/agent.sock`, the persistent login agent. launchd
  hands the daemon a bare per-session Keychain agent that holds only the default
  key, which breaks every SSH the daemon makes to a remote host. Point
  `--ssh-auth-sock` elsewhere if your socket lives elsewhere.
- **`TMUX_TMPDIR`** — captured from the same login shell as `PATH`. tmux
  places its server socket under this directory, so the daemon's workers and
  your own `tmux attach` meet on one server only if both see the same value.
  An rc file that moves it off `/tmp` (common on cluster hosts with a small or
  shared `/tmp`) must reach the daemon too; otherwise the board's Attach finds
  no workers and the daemon cannot reach sessions started from your shell.
  Dropped when empty, so tmux's default applies. `--tmux-tmpdir` overrides the
  capture, and `--tmux-tmpdir=` omits it.
- **`SHUTTLE_LOG`** — the same file `StandardOutPath` redirects to, rendered
  from the same `--log`. launchd never tells a process where its stdout went,
  and the daemon needs to know in order to rotate it (see
  [Log rotation](#log-rotation)).

Logs go to `~/Library/Logs/shuttle.log` (`make logs` tails it from a checkout).
Remove the agent with `shuttle daemon uninstall`.

launchd cannot read `~/Documents`, `~/Desktop` or `~/Downloads`, and that limit
binds your *stores* as much as the daemon's own directory —
see [Sharp edges](troubleshooting.md).

### Linux (systemd user unit)

`shuttle daemon install` renders `daemon/share/io.shuttle.daemon.service.template`
(`share/` in a fetched installation) into
`~/.config/systemd/user/shuttle-daemon.service`, then runs `systemctl --user
enable` and `restart`. `Restart=always` with `RestartSec=10` is the KeepAlive analog;
`WantedBy=default.target` starts the daemon at login. It bakes in the same
`PATH`, `TMUX_TMPDIR`, store configuration, and `SSH_AUTH_SOCK` as the plist, for
the same reasons — a systemd user manager inherits almost nothing either. An
empty `SSH_AUTH_SOCK` or `TMUX_TMPDIR` is dropped from the rendered unit rather
than baked in as a dead value, since Linux has no canonical agent socket and an
empty `TMUX_TMPDIR` means tmux's default. `KillMode=process` makes a stop or
restart signal only the daemon: a tmux server the daemon started lives in the
unit's cgroup, and systemd's default would kill it, and every worker on it,
along with the daemon.

It is a **user** unit: the daemon runs as you and wants no root.

```bash
loginctl enable-linger $(id -un)
```

Run that once. A systemd user manager normally stops at your last logout, which
would take the daemon down with your ssh session; lingering keeps it alive
across logout and starts it at boot. `shuttle daemon install` prints the
command but does not run it, because enabling linger needs privileges the
installer does not assume.

Day-to-day:

```bash
systemctl --user status shuttle-daemon     # is it up
systemctl --user restart shuttle-daemon    # cycle onto a freshly built release
journalctl --user -u shuttle-daemon        # unit-level events
tail -f ~/.shuttle/shuttle.log             # the daemon's own log (make logs, in a checkout)
```

The unit also exports `SHUTTLE_LOG`, the same file it appends stdout to, so the
daemon knows where its own log is and can rotate it (see
[Log rotation](#log-rotation)).

Logs go to `~/.shuttle/shuttle.log` on Linux — beside the daemon's other state,
and the same file `make start` and the respawn loop write, so `make logs` finds
it whichever path is running. Remove the unit with `shuttle daemon uninstall`.

`shuttle daemon install` kills the tmux respawn loop first; both would bind
`:4000`.

### Log rotation

The daemon rotates its own log, and every autossh tunnel log under
`~/.local/state/shuttle/`, on an hourly timer: a file past **64MB** is copied to
`<file>.1` (replacing the previous generation) and truncated back to zero. One
pass also runs at daemon startup, so a restart onto an already-huge log caps it
immediately. Unrotated, these grow without bound — one hub's `shuttle.log`
reached 343MB.

It **copies and truncates** rather than renaming, because the supervisor holds
the log open on an append-mode fd for the daemon's whole lifetime. A rename
follows the inode, so the renamed file would keep receiving every write while
the new one stayed empty forever. Truncating in place keeps the inode, and the
holder's next append lands at the new EOF. `bin/shuttle-launch` and the systemd
unit's `ExecStartPre` still `mv` at 50MB — that is safe for them, and only for
them, because they run between daemon processes, while nothing holds the file.

This is why the rendered job carries `SHUTTLE_LOG`: neither launchd nor systemd
tells a process where its stdout was redirected. Without it the daemon falls
back to the platform default (`~/Library/Logs/shuttle.log`,
`~/.shuttle/shuttle.log`), which is right for a default install and wrong for
any `--log` override. The tmux respawn loop rides that fallback by design.

### Log level

The daemon logs at `info`. Set `SHUTTLE_LOG_LEVEL` in its environment to
change that at boot — `debug` adds a line per request and per poll, which is
what you want while chasing load and not otherwise, since it grows the log by
hundreds of megabytes a day. Request lines at `debug` include the request
parameters, POST bodies among them — message text sent through the daemon
lands in the log. Any Elixir `Logger` level is accepted (`debug`,
`info`, `notice`, `warning`, `error`, …, plus `all` and `none`); an unknown
value is ignored with a warning in the log.

### Linux without systemd (tmux respawn loop)

Plenty of Linux hosts have no systemd user session — an HPC login node typically
does not, and neither does a bare container. `shuttle daemon install` probes
for one *before* it stops anything, and when the probe fails it refuses and
prints the respawn loop's command line instead of writing a unit nothing will
read.

That loop is `bin/shuttle-launch`, and it ships in the tarball as well as the
repo. Both installers also place a copy at `~/.local/bin/shuttle-launch`:
`scripts/bootstrap.sh` on a checkout, `install.sh` on a fetched install. That exact path
is what a hub runs over SSH to revive a dead remote daemon, so it exists on
every Linux host whether or not you drive it yourself. On a host with no systemd
user session, bootstrap goes one step further and starts a tmux session named
`shuttle-daemon` running the loop.

Start it yourself by pointing it at the daemon's directory:

```bash
SHUTTLE_DIR=~/.local/share/shuttle ~/.local/bin/shuttle-launch   # fetched
SHUTTLE_DIR=~/dev/felt ~/.local/bin/shuttle-launch               # checkout
```

On a host using the tmux loop, run `shuttle-launch --tmux` after upgrading to
replace that loop with the refreshed script. The default launcher preserves a
verified live tmux loop.
Without one, if a reachable service manager owns an enabled or active service, the launcher restarts through that service instead.
`shuttle-launch --tmux` explicitly selects tmux, disabling the competing systemd unit or unloading the loaded launchd agent before creating the loop.
Deployment uses that mode when it has verified a live tmux loop, so owner selection cannot silently change during the restart.
The loop marker is set when tmux creates the launcher process, making it visible to Linux process inspection.
Detection checks the exact known launcher path and `--loop` arguments; it also recognizes installed launchers whose marker is only exported inside their shell.

Unlike the supervisor install, the loop bakes nothing in — it hands the daemon the
environment you start it in. Give it stores through `SHUTTLE_STORES`, or persist
them once in `~/.config/shuttle/stores.json` (see [Configuring
stores](configuration.md#configuring-stores)).

The loop runs `shuttle daemon start` and backs off exponentially.
The start command probes the live daemon endpoint and refuses a live daemon; the loop's status probe stands down while the daemon answers.
Start and install also share an atomic endpoint claim, so a second cooperating start or installer is refused before the first daemon has bound its listener.
The claim survives the CLI's `exec` into the foreground release and becomes reclaimable when that process dies.
Direct release launches bypass this guard, and creating external supervisor definitions is not serialized; see [deployment ownership](../dev/build-and-deploy.md).
A daemon that exits within 60 seconds doubles the sleep, from 2s up to a 300s cap.
One that survives 60 seconds resets it. This exists because a wedged login node
once drove a fixed 2-second loop to roughly 35,000 restarts.

To restart the currently selected release, kill the listener and let the loop
respawn it:

```bash
lsof -ti:4000 -sTCP:LISTEN | xargs kill
```

`~/.shuttle/repo` selects the release for both supervisors and the respawn loop.
The loop rereads it between daemon starts, so deployment can select a different checkout without replacing the loop.
The pointer requires an assembled release path, not a checkout root.
Selecting `bin/rel-built` records its canonical generation.
If you move the release manually, select its new absolute path with `shuttle daemon select-release <path>`.

## Rex terminal backend

On macOS or Linux, add `"terminal": "rex"` to `~/.config/shuttle/host.json`, preserving its other keys.
The default is `"tmux"`; invalid values prevent daemon startup, and a change takes effect on restart.

### Linux

Run `bin/rex-install` from the checkout to install the latest Linux snapshot into `~/.local/bin/rex`, without root or jq.
It supports amd64 and arm64, verifies the release API's SHA-256 checksum, and replaces only the executable.
Keep `~/.local/bin` on the daemon's PATH, or set `SHUTTLE_REX_BIN` to the executable's absolute path.
The installer never starts, stops or upgrades a running server.

On Linux, each dispatcher poll checks whether the Rex server is present and starts a detached server when it is absent, whether or not a worker is waiting. It listens on `unix://<data dir>/rex/server.sock` with state in `<data dir>/rex/state`.
The data directory is `$SHUTTLE_DATA_DIR`, defaulting to `~/.shuttle`; its `rex` directory has mode 0700.
This socket does not depend on `$XDG_RUNTIME_DIR` surviving logout.
Shuttle requests `--extra-listen tailnet://:7297` and passes the private tailscaled socket resolved from the remotes configuration, or uses the system tailscaled.
The listener admits Tailscale-identified callers; an ordinary loopback caller is refused, including another user on a shared host.
If that start fails, Shuttle logs the failure and tries once without the tailnet listener so local workers don't depend on Tailscale.
A running server retains its configuration; Shuttle never restarts it to add a listener.

Run `shuttle doctor` to inspect server reachability, the running server's version, and the port 7297 listener.
The listener check recognizes Rex's loopback refusal; it doesn't verify reachability from another tailnet host.
A missing listener doesn't prevent local work.
Linux diagnostics don't check Apple privacy grants or require an app client.
To open a remote Rex worker from the board, first choose **Add Remote Host…** in the Rex app and enter `http://<owner>.<tailnet>:7297`, using the host from the hub's configured remote URL.
The owner selects the worker in the attached app client, and the macOS hub activates Rex unless the open was quiet.
The Rex server must have a reachable tailnet listener; a local-only fallback cannot accept that connection.

### macOS

Keep the Rex app installed, grant **Rex Server** Full Disk Access in macOS Privacy & Security, and enable Remote Control in the Rex app settings so Shuttle can select sessions.
The app and launchd own the server; Shuttle opens the app when its server is absent.
Run `shuttle doctor` to inspect Rex reachability, its app client and privacy status; Full Disk Access is a warning, not a dispatch gate.

### Endpoints and session lifetime

`SHUTTLE_REX_SERVER` overrides server selection in both the daemon and CLI.
Without it, Linux uses the Shuttle-owned socket and macOS uses Rex's discovery.
Workers inherit the selected endpoint, and ordinary Rex requests always disable autostart.

Rex holds worker sessions independently of the daemon, so daemon restarts and CLI installation leave them running.
A Shuttle-owned server runs with `--restore=false`: Shuttle resumes its workers itself, and a block Rex restored would be a bare shell carrying the worker's label.
Shuttle only starts missing servers; it never stops a Rex server.
`rex server stop` ends **every session** on that server, and a running server keeps its version until it stops.
Shuttle observes existing tmux workers on a Rex host when tmux is available, but launches new terminal workers in Rex.
Claude Remote Control and Listen's Hark recorder use Rex blocks on Rex hosts.
Shuttle records launch metadata, exit status and output under its data directory. A Rex server restart makes an interrupted capture fail while preserving its transcript; Remote Control retries automatically.
On macOS tmux-primary hosts, Kitty launches the tmux anchor; a Rex host needs none.
See [Opening conversations](conversations.md) for attach and remote limitations.

## Terminal program status

Inside tmux, Claude and Pi hooks can report working and blocked status to an outer terminal that supports OSC 7501.
Set `SHUTTLE_PROGRAM_STATUS=off` (or `0`) in the agent's environment to disable these reports; direct terminals use the harness's native reporter.
Shuttle enables tmux passthrough for worker panes on tmux 3.3 or later.
For interactive and claimed panes, opt in with `tmux set -g allow-passthrough on`; this allows programs in those panes to send wrapped escape sequences to the outer terminal.
Only visible panes forward reports, and attaching does not replay status.
See [Terminal program status](../dev/event-stream.md#terminal-program-status) for event mapping and lifetime details.

## Claude Remote Control host

The daemon can keep one `claude remote-control` host running so claude.ai and the mobile app can open sessions in a folder on this machine.
Add `remote_control` to the existing `~/.config/shuttle/host.json`, preserving its other keys:

```json
{"remote_control": {"dir": "/path/to/projects", "args": ["--permission-mode", "auto"]}}
```

`dir` is required and absolute (`~/projects` also expands against the daemon's home).
`args` is an optional list of literal strings, passed after `remote-control`; it defaults to `[]`.
The Claude binary must be installed and authenticated for this user and available in a login bash's PATH.
The script uses `command claude`, bypassing shell functions that add flags intended for ordinary Claude sessions.
Remote Control child sessions don't receive Shuttle's worker prompt or task assignment.

The daemon reads this setting every 30 seconds without a restart.
It owns the `shuttle-remote-control` terminal launch, adopts it across daemon restarts, replaces it when the directory or arguments change, and stops it when the key is absent or invalid.
Invalid settings also log a warning.
The host starts independently of the boot quarantine because it waits for a human to open a session.
On Rex hosts it runs in a Rex block; tmux-primary hosts use the same terminal-rooted tmux server policy as workers.

Inspect it with `shuttle remote-control` or `shuttle remote-control --json`.
The status reports the pane PID, start time, starts during this daemon lifetime (`restarts`), last exit status and up to 20 nonempty screen lines, and the next retry time.
Short-lived hosts retry after 2 seconds, doubling to a 300-second cap; an actual lifetime of at least 60 seconds resets the wait to 2 seconds.
The daemon retains exit evidence in a dead tmux pane or a Rex launch receipt, and holds rather than spawning when terminal or process liveness is uncertain.
A lost session without a death timestamp counts conservatively as a short failure.

A manually started host in the same folder can refuse the managed host with an “already served” message.
The status preserves that message while retries back off; stop the manual host or remove `remote_control` to choose which one runs.
A killed host's child sessions lose their running turn, though Claude retains their conversation history server-side.
Changing this setting can stop those children too.

## License

Both Go CLIs and the board UI carry the MIT license. The daemon (`daemon/lib/`)
contains code derived from OpenAI's Symphony under the Apache License
2.0, preserved in
[`NOTICE`](https://github.com/cailmdaley/felt/blob/main/NOTICE).
