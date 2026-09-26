# Installing the shuttle daemon

The daemon runs one of two ways, and the choice is about what you want on the
machine.

- **Fetch the release.** A prebuilt daemon for your platform, carrying its own
  Erlang runtime, the board bundle, and its keep-alive supervisor inside it. One
  command, no toolchain, no checkout.
- **Build from a checkout.** `scripts/bootstrap.sh` builds the felt CLI and the daemon
  from source, places the board bundle, and installs the same keep-alive. This
  is the fleet path — what the deploy script updates, and what you want if you
  are changing daemon code.

Either way the daemon needs `tmux` and the `felt` CLI at runtime: workers run in
tmux sessions, and the daemon shells out to `felt` for every store walk and
every write.

!!! note "Platform and operating modes"
    Linux and macOS support single-host use — the daemon, board, and workers on
    one machine, with a keep-alive supervisor that restarts the daemon if it
    crashes. Multi-host tunnel management (`felt shuttle tunnels`) installs
    launchd jobs on macOS and systemd user units on Linux. Multi-host operation
    needs SSH access and configured remote daemons. Windows is unsupported.

This page gets you from nothing to a worker running on the board. The
[Keep-alive](#keep-alive) internals, store/agent/remote configuration, and the
event stream come after — read them once the daemon is up and you want to
understand what it's doing.

## Prerequisites

At runtime, whichever path you take:

| Tool | Required | Purpose |
| --- | --- | --- |
| `felt` | yes | The daemon shells out to the CLI for every store walk and every write, so `felt` must be on the daemon's `PATH`. |
| `tmux` | yes | Every worker runs in a tmux session. On a Linux host without systemd, the daemon's own keep-alive is a tmux loop too. |
| `jq` | optional | `session.sh` uses it to pretty-print the SessionStart envelope. Without it the hook falls back to `felt hook session`. |

Building from a checkout adds a toolchain, none of which the fetched daemon
needs:

| Tool | Required | Purpose |
| --- | --- | --- |
| `go` 1.23+ | yes | Builds the `felt` CLI from the same checkout, so the CLI and the daemon never skew. |
| `elixir` 1.19+ / OTP 28 | yes | `daemon/mix.exs` declares `elixir: "~> 1.19"`. CI builds on OTP 28, and a fetched release carries the OTP runtime it was built with. |
| `node` 22+ / `npm` | yes | Source builds compile the board into `ui/dist` on each host. A fetched daemon ships the bundle already built. |

`scripts/bootstrap.sh` checks all of these and names what is missing.

## Fetch the release

`SHUTTLE=1` on the felt install script installs the CLI as usual, then unpacks
the daemon beside it:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | SHUTTLE=1 sh
```

!!! warning "Environment variables go after the pipe"
    `SHUTTLE=1` sets the environment of `sh`, which is what reads the script.
    Written the other way round — `SHUTTLE=1 curl … | sh` — it sets `curl`'s
    environment instead, the script never sees it, and you get a CLI install
    and no daemon, reported as success. The same holds for `FELT_VERSION` and
    `SHUTTLE_HOME`.

The CLI lands where it always does: `/usr/local/bin` if that is writable, else
`~/.local/bin`, overridable with `FELT_INSTALL_DIR`. The daemon lands in
`~/.local/share/shuttle` — override with `SHUTTLE_HOME` — and its front door is
`$SHUTTLE_HOME/bin/shuttle`:

```bash
FELT_STORES=~/dev/myproject ~/.local/share/shuttle/bin/shuttle start
```

That runs in the foreground and stops on `Ctrl-C`. To have the daemon start at
login and come back after a crash, hand it to the supervisor that ships in the
same tarball — `shuttle install-agent`, walked through step by step for macOS in
[Set up a supervised daemon on macOS](#set-up-a-supervised-daemon-on-macos) and
covered in full under [Keep-alive](#keep-alive).

What you downloaded is a Mix release: the daemon's compiled modules, the
bundled Erlang runtime and native components, and the board bundle, in one
directory tree. It reads nothing from the host's toolchain, which is why this
path asks for no Elixir and no Node. The bundled runtime makes each tarball
platform-specific — matching OS and CPU architecture — and the matrix covers
four: `shuttle_{Linux,Darwin}_{x86_64,arm64}.tar.gz`.

On Linux the one thing the host must supply is a C library at least as new as
the one the release was built against. The Linux tarballs declare a floor of
**glibc 2.28** (RHEL/Rocky/Alma 8, the `manylinux_2_28` baseline): they are
built inside an EL8 container, and CI reads the required `GLIBC_`/`GLIBCXX_`/
`GCC_` symbol versions back out of every binary and refuses to publish an
artifact above that floor. So a release that boots on an EL8 login node boots
on every newer distribution too; `ldd --version` tells you where a host stands.
The felt CLI has no such requirement — it is a static binary.

The installer checks this for you: before it replaces anything it starts the
bundled runtime (`bin/shuttled eval …`) and reads the version from inside the
VM. A tree whose runtime cannot start on the host is reported, with the
loader's error, and left uninstalled. Do the same yourself if you copy a
tarball around by hand — the launcher's `version` verb is a shell readout that
succeeds on a runtime that cannot run.

Upgrade by running the same command again. It deletes `$SHUTTLE_HOME` and
unpacks the new tarball in its place, so keep nothing of your own in there. The
daemon's state lives in `~/.shuttle` and survives.

The tarball carries what the daemon needs to run *and* to keep running. Under
its root sit `bin/`, `erts-*/`, `lib/`, `releases/` and `share/`. Two of those
matter here: `share/` holds both supervisor templates — the launchd plist and
the systemd unit — and `bin/` holds the `shuttle` shim that renders them,
alongside `shuttle-launch`, the tmux respawn loop for hosts with no supervisor
at all. So a fetched install supervises itself, from the same files a checkout
uses, through [`shuttle install-agent`](#keep-alive).

What the tarball leaves behind is the repo's *development* surface: the `make`
targets and `bin/shuttle-deploy`. A fetched host runs a daemon and keeps it
alive; it cannot build one, and it cannot deploy to a fleet.

### Set up a supervised daemon on macOS

This is the whole sequence on a Mac — from nothing to a daemon that starts at
login and restarts itself when it dies. No checkout, no toolchain. Run the steps
in order — step 3 refuses to install anything without the store you make in
step 2.

**1. Install the CLI and the daemon.**

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh \
  | SHUTTLE=1 sh
```

`SHUTTLE=1` goes *after* the pipe, for the reason in the warning above: in front
of `curl` it sets the wrong process's environment, and you get a felt CLI with
no daemon, reported as success.

A fresh Mac ships no `tmux`, and the installer says so when it finds none. Every
worker runs inside a tmux session, so a daemon without it serves a board and
dispatches nothing:

```bash
brew install tmux
```

**2. Create a felt store — and keep it out of `~/Documents`.**

The daemon polls felt stores, and it assumes none — it polls exactly the ones
you name in step 3, which is why the store comes first. Make one somewhere
launchd is allowed to read:

```bash
mkdir -p ~/notes && cd ~/notes && felt init
```

!!! warning "Not `~/Documents`, `~/Desktop`, or `~/Downloads`"
    macOS blocks launchd-started processes from those three folders, and
    granting Full Disk Access does not rescue you — the grant does not inherit
    down the launchd process tree the way it does under a terminal. A store in
    one of them is *discovered and unreadable*: the daemon starts, the board
    loads, the board shows nothing, and no error appears anywhere. Anywhere else
    in your home directory works — `~/notes`, `~/dev`, `~/loom`. The same rule
    covers the daemon itself. `install-agent` checks both — the release it is
    installing and every store you name — and warns on stderr about any path
    under one of the three, but it installs anyway, so read what it prints.

!!! warning "macOS: start your tmux server from a terminal, not the daemon"
    Every worker runs inside tmux, and macOS charges file access to a process
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
    from a terminal you started by hand — `felt setup receipt` reports when
    the current server is daemon-born, meaning it was forked by the daemon
    before this behaviour existed (or by an older daemon). Dispatch still
    works; every worker on that server is just charged to the daemon binary,
    so the remedy is to restart the server from a terminal once no workers are
    live.

!!! note "Already using felt on this machine?"
    Then step 3 is the step that decides what the board shows. The daemon polls
    exactly the stores you name and assumes nothing else — so a machine that
    already holds fibers, pointed at a fresh `~/notes`, gets a daemon running
    perfectly and a board that is perfectly empty. Nothing warns you, because
    nothing is wrong: you asked for this.

    Two ways to bring the existing stores in. Pass them all to
    Settings → Stores individually, or — better past the first couple —
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
~/.local/share/shuttle/bin/shuttle install-agent
```

That writes `~/Library/LaunchAgents/io.shuttle.daemon.plist` and loads it. The
daemon comes up immediately, comes back at every login, and restarts on crash.
Open the board and add `~/notes` in **Settings → Stores**. Register additional
stores there too; changes take effect without reinstalling the supervisor.

**4. Check it, and know how to undo it.**

```bash
launchctl list | grep shuttle                   # the job is loaded
curl -s http://127.0.0.1:4000/api/v1/version    # the daemon answers
tail -f ~/Library/Logs/shuttle.log              # what it is doing
```

Then open <http://127.0.0.1:4000/> for [the board](board.md).

To undo it:

```bash
~/.local/share/shuttle/bin/shuttle uninstall-agent
```

That unloads the job and deletes the plist, which stops the running daemon too.
Nothing else goes: the release, your store, and the daemon's state in
`~/.shuttle` all survive, and `install-agent` puts the job back.

<a id="release-candidates"></a>
### Pin a release

The installer and `felt update` select the latest stable GitHub release by
default. Set `FELT_VERSION` when you need an exact tag; it skips the
`releases/latest` lookup and fetches that tag for the CLI and daemon together:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh \
  | FELT_VERSION=1.1.0 SHUTTLE=1 sh
```

Replace `1.1.0` with the tag you want. Both variables sit after the pipe, for
the reason above: an install that silently drops `FELT_VERSION` fetches the
latest stable instead. The tag is accepted with or without its leading `v`. If
it has no daemon tarball for your platform, the install names the tag and the
missing asset rather than leaving a bare `curl` error.

Prerelease tags and release candidates are excluded from latest and Homebrew
selection. Pin one explicitly with `FELT_VERSION` when you want to test it.

A fetched daemon reports the tag it was built from, so you can check what you
are actually running:

```bash
curl -s http://127.0.0.1:4000/api/v1/version    # mix_vsn is the release tag
```

To return to the latest stable, run `felt update` without a pin. The daemon has
no self-update — run the install line again without `FELT_VERSION` and the
stable tarball replaces `$SHUTTLE_HOME`.

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
2. **`felt` CLI.** `GOBIN=~/.local/bin go install .` from *this* checkout — not
   the release binary. The daemon shells the CLI, so the two must never skew.
3. **Daemon release.** `make daemon` assembles the
   release into `bin/rel` and leaves `bin/shuttle` — a tracked shell shim — as
   the front door. The step records the checkout path in `~/.shuttle/repo`, so
   remote revival over SSH can find it without an environment.
4. **`ui/dist`.** Builds the served board bundle with Node and npm on this host.
5. **Event stream.** Runs `felt setup claude` and `felt setup codex` against
   this checkout, so the plugin hooks match the binary. Then it pipes a probe
   payload through `felt hook event` and checks the line it writes. Details in
   [The event stream and the ledgers](#the-event-stream-and-the-ledgers).
6. **Keep-alive.** Installs a supervisor — the OS service manager that starts
   the daemon at login and restarts it if it dies: a launchd LaunchAgent on
   macOS, a systemd user unit on Linux (or a tmux respawn loop where there is
   no systemd user session). Details in [Keep-alive](#keep-alive).

Useful flags: `--dry-run`, `--skip-hook`,
`--skip-cli`, `--with-tunnels`.

Editing daemon source means rebuilding: the release runs the compiled modules
under `bin/rel`, so a restart alone picks up nothing. `make restart` rebuilds
and bounces in one step.

## Verify

```bash
curl -s http://127.0.0.1:4000/api/v1/version   # daemon answers
felt shuttle ps                                # running workers
make logs                                      # tail the daemon log
make status                                    # ps + a snapshot summary
```

The two `make` targets belong to a checkout. From a fetched install, ask the
shim directly — `~/.local/share/shuttle/bin/shuttle status` — and tail the log
where the supervisor put it: `~/Library/Logs/shuttle.log` on macOS,
`~/.shuttle/shuttle.log` on Linux, or wherever `--log` pointed it. A daemon you
started in the foreground logs to your terminal instead.

Open <http://127.0.0.1:4000/> in your browser for [the board](board.md).

The daemon binds `127.0.0.1:4000` and nothing else. It stays loopback-only by
construction, but it carries no authentication layer. Treat it as a trusted
single-user admin surface: anyone who can reach it through an SSH forward,
Tailscale Serve, or another proxy can read and edit fibers, control workers,
and launch agents. Keep any forwarding limited to people and networks you
trust; do not publish the port to the open internet.

## From an empty board to a first dispatch

With the daemon up, here is the fastest path from nothing to a worker running.

Register the current directory as a felt store, if `FELT_STORES` does not
already cover it:

```bash
curl -s -X POST http://127.0.0.1:4000/api/v1/felt-stores \
  -H 'Content-Type: application/json' \
  -d '{"felt_stores": ["'"$PWD"'"]}'
```

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
felt shuttle install pipeline/first-pass --project-dir "$PWD" --model claude-sonnet
```

Open <http://127.0.0.1:4000/> — the fiber shows up as a card, armed. The
daemon polls every 30 seconds by default, so the card moves to in-flight on
its own; `felt shuttle dispatch pipeline/first-pass` skips the wait. `felt
shuttle ps` lists the live tmux session, and `felt shuttle attach
pipeline/first-pass` drops you into it.

When the worker hands off, the fiber's `outcome` and `## Status` rewrite in
place and the card lands in Awaiting review.

!!! note "First dispatch not starting?"
    Every restart arms a boot quarantine that holds new work until you run
    `bin/shuttle release` — see the first entry in [Sharp
    edges](#sharp-edges) if your card sits armed with nothing happening. From a
    fetched install the same shim sits at `$SHUTTLE_HOME/bin/shuttle`.

That's the whole path from install to a worker on the board. Everything below
is what the daemon is doing underneath, and the configuration knobs for a setup
beyond one machine.

## Keep-alive

A supervisor is what turns "the daemon is running" into "the daemon runs": it
starts the daemon at login and restarts it when it dies. `shuttle install-agent`
installs one, branching on `uname -s` — a launchd LaunchAgent on macOS, a
systemd `--user` unit on Linux — and points you at the tmux respawn loop on a
Linux host that has no user-level systemd.

The verb is the same wherever the daemon came from:

```bash
# fetched install
~/.local/share/shuttle/bin/shuttle install-agent

# checkout — builds the release first, then calls the same verb
make install-agent
```

Neither front door is on your `PATH`; the rest of this section writes `shuttle`
for whichever one you have.

Both arms render a template from `daemon/share/` in a checkout or `share/`
in a fetched installation. The templates ship in the tarball and are
tracked in the repo — the same two files, never forked. The templates' one
placeholder for a location, `__SHUTTLE_DIR__`, resolves to whatever directory
holds `bin/shuttle`: the checkout root in a checkout, the unpacked release root
in a tarball. So the two paths install byte-identical jobs, and `make
install-agent` is a checkout convenience rather than a separate mechanism.

The install fixes these values into the job:

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--felt-stores <list>` | `AGENT_FELT_STORES` | empty — use the editable store registry |
| — | `FELT_STORES_FILE` | `~/.config/felt/stores.json` |
| `--path <PATH>` | `AGENT_PATH` | the login shell's `PATH`, captured at install time |
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
shuttle install-agent --label io.shuttle.daemon-test --port 4394 \
  --felt-stores ~/test-store
```

`uninstall-agent` takes the same `--label`, and needs it — without one it looks
for the default job and removes nothing.

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

`--felt-stores` has no default on purpose. A daemon that polls nothing boots
clean, binds `:4000`, serves an empty board and dispatches nothing — a failure
that looks like success — so `install-agent` refuses rather than installing one.

To see the job before installing it:

```bash
shuttle install-agent --felt-stores ~/notes --print
shuttle install-agent --felt-stores ~/notes --print --os Linux
```

`--print` (or `--dry-run`) renders to stdout and changes nothing. `--os` renders
the other platform's file for inspection, and it is accepted *only* alongside
`--print`, so an install can never take a branch this host cannot run.

`shuttle uninstall-agent` reverses the install on either platform, and `make
uninstall-agent` calls the same verb.

### macOS (launchd)

`install-agent` renders `daemon/share/io.shuttle.daemon.plist.template`
(`share/` in a fetched installation) into
`~/Library/LaunchAgents/io.shuttle.daemon.plist` and loads it (bootstrap step 6
does this through `make install-agent`). The agent sets `RunAtLoad` and
`KeepAlive`, so the daemon starts at login and restarts on crash. A daemon you
had started by hand is stopped first — the job starts its own, and two would
fight over `:4000`.

Three environment variables go into the plist. Each one exists because the
obvious approach failed:

- **`PATH`** — captured from `bash -lc 'echo $PATH'` *at install time*.
  launchd's own environment is nearly empty, and the daemon cannot find `felt`
  in it. (The daemon itself needs nothing off `PATH` to boot — it carries its
  own Erlang runtime — but it shells `felt` for every store walk and every
  write.) Sourcing the login profile at runtime does not fix it, because the
  profile is not self-sufficient from a bare environment. So the plist freezes
  the real login `PATH`. A `PATH` without `felt` on it gives you a daemon that
  boots, serves the board, and returns 500 on `/api/v1/fibers/composite`.
- **`FELT_STORES`** — empty by default, so the daemon reads the editable
  `stores.json` registry. Empty also clears any override inherited from the
  supervisor manager. `--felt-stores` explicitly pins a comma-separated list
  instead and makes Stores read-only in Settings.
- **`FELT_STORES_FILE`** — the registry location, captured at install time.
  felt re-discovers a store's symlinked substores, so one
  [cross-project store](../concepts/cross-project.md) is usually enough.
- **`SSH_AUTH_SOCK`** — `~/.ssh/agent.sock`, the persistent login agent. launchd
  hands the daemon a bare per-session Keychain agent that holds only the default
  key, which breaks every SSH the daemon makes to a remote host. Point
  `--ssh-auth-sock` elsewhere if your socket lives elsewhere.
- **`SHUTTLE_LOG`** — the same file `StandardOutPath` redirects to, rendered
  from the same `--log`. launchd never tells a process where its stdout went,
  and the daemon needs to know in order to rotate it (see
  [Log rotation](#log-rotation)).

Logs go to `~/Library/Logs/shuttle.log` (`make logs` tails it from a checkout).
Remove the agent with `shuttle uninstall-agent`.

launchd cannot read `~/Documents`, `~/Desktop` or `~/Downloads`, and that limit
binds your *stores* as much as the daemon's own directory —
see [Sharp edges](#sharp-edges).

### Linux (systemd user unit)

`install-agent` renders `daemon/share/io.shuttle.daemon.service.template`
(`share/` in a fetched installation) into
`~/.config/systemd/user/shuttle-daemon.service`, then runs `systemctl --user
enable` and `restart`. `Restart=always` with `RestartSec=10` is the KeepAlive analog;
`WantedBy=default.target` starts the daemon at login. It bakes in the same
`PATH`, store configuration, and `SSH_AUTH_SOCK` as the plist, for the same reasons —
a systemd user manager inherits almost nothing either. An empty
`SSH_AUTH_SOCK` is dropped from the rendered unit rather than baked in as a
dead path, since Linux has no canonical agent socket.

It is a **user** unit: the daemon runs as you and wants no root.

```bash
loginctl enable-linger $(id -un)
```

Run that once. A systemd user manager normally stops at your last logout, which
would take the daemon down with your ssh session; lingering keeps it alive
across logout and starts it at boot. `install-agent` prints the command but does
not run it, because enabling linger needs privileges the install does not
assume.

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
it whichever path is running. Remove the unit with `shuttle uninstall-agent`.

`install-agent` kills the tmux respawn loop first; both would bind `:4000`.

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

### Linux without systemd (tmux respawn loop)

Plenty of Linux hosts have no systemd user session — an HPC login node typically
does not, and neither does a bare container. `install-agent` probes for one
*before* it stops anything, and when the probe fails it refuses and prints the
respawn loop's command line instead of writing a unit nothing will read.

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

Run the same command after an upgrade to pick up a new `shuttle-launch`: it
kills the tmux session and recreates it from the refreshed script.

Unlike `install-agent`, the loop bakes nothing in — it hands the daemon the
environment you start it in. Give it stores through `FELT_STORES`, or persist
them once in `~/.config/felt/stores.json` (see [Configuring
stores](#configuring-stores)).

The loop runs `./bin/shuttle start --force` and backs off exponentially. A
daemon that exits within 60 seconds doubles the sleep, from 2s up to a 300s cap.
One that survives 60 seconds resets it. This exists because a wedged login node
once drove a fixed 2-second loop to roughly 35,000 restarts.

To cycle onto a freshly built release, kill the listener and let the loop
respawn it:

```bash
lsof -ti:4000 -sTCP:LISTEN | xargs kill
```

!!! warning "Remote revival needs `~/.shuttle/repo` on a fetched host"
    A hub revives a dead remote by running `~/.local/bin/shuttle-launch` over
    SSH with no environment. The script then resolves the daemon's directory
    from `$SHUTTLE_DIR`, else the state file `~/.shuttle/repo`, else its own
    parent directory — and only `scripts/bootstrap.sh` writes that state file. After a
    fetched install, write it yourself or revival exits without starting
    anything:

    ```bash
    mkdir -p ~/.shuttle && echo ~/.local/share/shuttle > ~/.shuttle/repo
    ```

## Configuring stores

The daemon polls felt stores. It resolves them in this order:

1. `FELT_STORES` — a comma-separated list of store paths.
2. `~/.config/felt/stores.json` — the persisted registry (override the path with
   `FELT_STORES_FILE`).

**shuttle assumes no default store.** An unset variable and an absent registry
resolve to an empty list. The daemon then polls nothing: it boots, binds
`:4000`, serves an empty board, and dispatches nothing. `install-agent` uses
this editable registry by default and reports a missing registry at install
time; open **Settings → Stores** to register the first store.

### Switching an existing supervisor to the registry

Older installations pinned `FELT_STORES` in the supervisor job. To make Stores
editable, back up both the job and `stores.json`, then write the daemon's
**currently effective** store list into the registry. Do not activate a stale
registry list blindly: it may contain additional stores you did not intend to
poll. Reinstall with `shuttle install-agent` (or `make install-agent`) without
`--felt-stores` or `AGENT_FELT_STORES`. Keep any existing PATH, socket, label,
port, or log overrides when reinstalling. A custom `FELT_STORES_FILE` must be
present in the installation environment too.

Installation replaces and reloads the supervisor. Check Settings → Stores:
the source should be the registry, the effective stores should be unchanged,
and editing should be enabled. Verify the board still contains the expected
fibers, then release the restart quarantine with `shuttle release`.

The registry file takes this canonical shape. A bare JSON array also works.

```json
{
  "version": 1,
  "felt_stores": ["/home/you/dev/myproject"]
}
```

`POST /api/v1/felt-stores` rewrites the file, and the board's store picker uses
that endpoint. A store is a directory with a `.felt/` inside it; nothing
validates that when you register one, and nothing needs to — a directory
without one is a store with no fibers, which the poller reads as empty rather
than as an error.

Everything in this section and the two below it is also reachable from the
board's [settings sheet](board.md#settings--the-operator-files-on-any-host)
(`⌘,`), for any host in the fleet — which is how you configure a machine you
have no shell on.

## Configuring agents

`felt shuttle agents` prints the effective registry. It layers your own file
over the shipped default fleet (enumerated in
[Constitutions](constitutions.md#agent-selection)). Set `$FELT_AGENTS_FILE` to
choose the path; otherwise felt reads `~/.config/felt/agents.json`.

```bash
felt shuttle agents init      # seed the user file from the built-ins
felt shuttle agents           # the merged table, with a source footer
felt shuttle agents --source user
```

Each record names a CLI, a model, and its axis metadata (`effort_levels`,
`default_effort`, `chrome_capable`). `felt shuttle agents init` seeds the file
from the built-ins, working every field across several harnesses — edit that. A
missing file is silent. A malformed file fails loudly and names the path.

The file's `builtins` key controls the merge. `"merge"` (the default) folds your
records over the built-ins by id, last one wins — wholesale, never field by
field. `"restrict"` drops the built-in layer entirely, so the file becomes the
complete registry for that host.

To change one agent's default effort without copying its whole record, use the
`overrides` block. It applies after the merge, to built-in and user records
alike:

```json
{
  "version": 1,
  "builtins": "merge",
  "agents": [],
  "overrides": { "claude-opus": { "default_effort": "high" } }
}
```

```bash
felt shuttle agents effort claude-opus high     # write the override
felt shuttle agents effort claude-opus --reset  # remove it
```

An alias key lands on its base agent; the CLI keys the entry by that base id.
`default_effort` is the only field an override sets. An unknown field, an
unknown agent, or a level outside the agent's `effort_levels` fails the load
and names the file. `felt shuttle agents` marks an overridden default as
`default=<level>(override)`, and `--json` carries
`"default_effort_source": "override"`. The board's settings sheet sets the same
override from a select on each agent row.
There is no reserved `human` record.

## Host classes and trust boundaries

The daemon's control plane has no authentication: anything that reaches its
listener can read and write every registered fiber, read transcripts, and
launch or kill workers as the user running it. The design makes the
*listener* the boundary, so the boundary has to match the host it runs on.

Every host declares a class in `~/.config/felt/host.json`:

```json
{"class": "single-user"}
```

Set it with `felt shuttle host class <class>`; read it back with `felt
shuttle host --json` or the board's settings sheet. Three classes exist.
`single-user` is a laptop, a workstation, a single-user VM — loopback is
yours alone. `shared-multi-user` is an HPC login node: loopback is shared
with every logged-in user, `/proc/net/tcp` is world-readable, and any
`127.0.0.1` listener is theirs to connect to. `exposed` is reachable beyond
your tailnet; it uses the same listener protections as `shared-multi-user`.

The class changes where the daemon listens. `single-user` listens on
`tcp://127.0.0.1:4000` (override the port with `SHUTTLE_PORT`).
`shared-multi-user` and `exposed` listen on a Unix socket instead,
`~/.shuttle/sock/daemon.sock`, inside a `0700` directory the daemon creates
and verifies before it binds — it refuses to bind if the directory is missing
that mode. `host.json`'s `listen` key, or `SHUTTLE_LISTEN`, overrides either
default, and the CLI resolves the same address to reach it. A remote entry's
`remote_socket` key points an SSH tunnel's far end at the socket instead of a
port — verified end to end as `ssh -L 127.0.0.1:<port>:~/.shuttle/sock/daemon.sock
<host>` against an OpenSSH 8.0 login node — and the local `felt` CLI on that
host dials the same socket directly. A host whose only inbound is SSH
tunnels can run entirely off the socket, with no TCP listener at all.

An unprivileged userspace `tailscaled` cannot target a Unix socket with
`tailscale serve`; the command refuses with "must be root, or be an operator
and able to run sudo tailscale to serve a path or Unix socket." The macOS
system `tailscaled` cannot reach a filesystem socket and answers 502. A host
fronted by either arrangement therefore needs a TCP loopback listener — both
"The board on your phone" below and "Tailscale as fleet transport" target
`4000`, not the socket path.

On a `shared-multi-user` or `exposed` host, `PeerGatePlug` protects that TCP
listener before static assets or request-body parsing. It resolves the
client-side established connection row in `/proc/net/tcp` or `/proc/net/tcp6`
by matching the peer address and ephemeral port as the local endpoint and the
daemon's address and port as the remote endpoint. A peer is admitted only
when the row's uid is the daemon's effective uid. A foreign uid or an
unresolved row receives HTTP 403 with `error: "peer_refused"`; request headers
cannot bypass the gate. This admits a same-user userspace `tailscaled` and
refuses a co-tenant connecting directly. The `tailscale_login` header is
retained on TCP only after uid admission; the header itself is still an
assertion.

The gate identifies the last local process, not the original client. A relay
running as the daemon's owner can pass a co-tenant's traffic with that owner's
uid. Examples include a userspace Tailscale SOCKS/HTTP proxy, `ssh -D` or
`ssh -L`, socat, and code-server or Jupyter `/proxy/` routes. Operators must
not run relays as themselves. Root has no separate admission exception; it is
denied unless the daemon itself runs as uid 0, and root can already inspect or
control that daemon process.

The TCP uid gate does not cover port squatting on a shared host: the port is
a shared resource, and another user can bind it while the daemon is down.
Because that listener runs as the other user, its HTTP response could claim
`peer_gate: "uid"` and imitate the daemon. On Linux, `felt setup receipt` and
the CLI check the matching `/proc/net/tcp{,6}` LISTEN row's uid; a foreign
owner is a mismatch, and the CLI refuses to talk to it. They skip this check
where `/proc` is unavailable, including macOS. A Unix socket in the protected
`0700` directory has no equivalent TCP-port squatting window: a co-tenant
cannot claim the path or connect through it.

`namei -m ~/.shuttle/sock/daemon.sock` shows the Unix socket's permissions
along the whole path. A shared or exposed host refuses to boot a TCP listener
when `/proc/net/tcp` is unreadable, as on macOS. Use the class's Unix socket,
or declare `single-user` when loopback is private to the operator. `felt
setup receipt` reports `peer_gate: uid` when the daemon gates its
shared-class TCP listener and treats an ungated TCP listener as a mismatch.

The same class gates dial-out. The daemon refuses `defaults.https_proxy`
(configured below, under `defaults.https_proxy`) unless the host is
`single-user`, because `tailscaled --outbound-http-proxy-listen` is an
unauthenticated loopback gateway into the whole tailnet, and a co-tenant who
finds it arrives everywhere wearing your node's identity. A `shared-multi-user`
host dials out over ssh instead. To reach the tailnet from userspace mode
without the proxy, use `ssh -o ProxyCommand="tailscale nc %h %p" <node>`,
which rides `tailscaled`'s private LocalAPI socket rather than an
unauthenticated listener. Tunnel *local* ends are still plain TCP loopback
today and are flagged, not fixed, on a shared host.

`felt setup receipt` is where this is checked. It reports the declared
class, the resolved listen address, the set of distinct logged-in users, the
socket directory's mode and owner, and every listening TCP socket owned by a
fleet process (the daemon, tunnels, `tailscaled`), and it goes `mismatch`
with a repair line whenever the host contradicts its declared class. Four
checks worth watching turn the receipt red on purpose: declaring
`single-user` on a login node, `chmod 755`-ing the socket directory, setting
`SHUTTLE_LISTEN=tcp` on a shared host, and setting `defaults.https_proxy` on
a shared host.

## Configuring remotes

One daemon can aggregate other daemons over SSH tunnels. The fleet file lists
them, and both the Go CLI and the daemon read it at runtime.

```bash
felt shuttle remotes path                          # ~/.config/felt/remotes.json
felt shuttle remotes add hub-a --port 4001         # --ssh, --remote-port, --display, --checkout
felt shuttle remotes add hub-b --port 4004 --multiplex
felt shuttle remotes list                          # also the validator
felt shuttle remotes rm hub-a
```

`list` reports parse errors, duplicate names, and port collisions. `--multiplex`
rides an existing `ControlMaster` socket — SSH's connection-sharing feature,
which keeps one authenticated connection open for later commands to reuse —
which is what a 2FA host needs. A `launchd_label_prefix` key in the file names
the launchd labels `felt shuttle tunnels install` writes. Single-machine use
needs none of this: an absent file means no remotes.

`bin/shuttle-deploy` reads the same file, so the fleet is described once. Give
a remote a `checkout` (its repo path) to make it a deploy target — a remote
without one is skipped. Two more optional keys serve deploy only: `ssh_flags`,
a list of extra ssh arguments, and `auth`, which the deploy script reads as
`"pubkey"` (the default) or `"interactive"`. Mark a host `"interactive"` when
its ssh needs a live human credential — push-2FA or a short-lived certificate —
and `bin/shuttle-deploy --handshake` will bootstrap a `ControlMaster` for it
instead of failing.

## Tailscale as fleet transport

`felt shuttle remotes` reaches a remote daemon over an SSH tunnel by default —
see [Configuring remotes](#configuring-remotes). Tailscale is an alternative
transport for the same registry: a remote entry names a Tailscale URL instead
of an SSH port, and the composite board reaches it over the tailnet with no
tunnel process, no `autossh`, and no SSH key or MFA-cert juggling to keep
alive. It earns its place on two hosts a tunnel struggles with: a hub behind a
laptop that closes its lid (a tunnel dies with the SSH session; a tailnet
membership does not), and a cluster login node behind 2FA whose only
"always-on" SSH story today is `--multiplex`'s `ControlMaster` babysitting.
Tailscale replaces that whole apparatus with one join per host.

**Read the policy caveat below before you join a node.**

### The unprivileged recipe

Nothing here needs root or a TUN device — every host in this recipe runs
`tailscaled` in **userspace-networking** mode, which is what makes it viable
on a login node where you cannot install a kernel module or a system service:

1. Drop the static `tailscale` and `tailscaled` binaries into `~/.local/bin`
   (Tailscale ships them as a plain tarball; no package manager or root
   needed).
2. Keep `tailscaled` alive under tmux with `bin/tailscaled-launch`
   (`scripts/bootstrap.sh` installs it to `~/.local/bin` next to
   `shuttle-launch`, whether or not you use it): it starts `tailscaled
   --tun=userspace-networking` against a per-host state directory and
   respawns it if it dies, the same role `shuttle-launch` plays for the
   daemon.
3. Export `TS_SOCKET` so the `tailscale` CLI talks to *this* userspace
   instance rather than a system one:
   ```bash
   export TS_SOCKET=$HOME/.local/state/tailscale/tailscaled.sock
   tailscale up          # one-time device auth
   tailscale serve --bg 4000    # https://<node>.<tailnet>.ts.net → 127.0.0.1:4000
   ```
   `tailscale up` prints a login URL the first time; approve it from any
   already-authenticated device or browser. `serve --bg` is what actually
   exposes the daemon — the target is always the TCP loopback port, on every
   host class: an unprivileged userspace `tailscaled` refuses to serve a
   Unix socket ("must be root, or be an operator and able to run sudo
   tailscale to serve a path or Unix socket"), and the macOS system
   `tailscaled` cannot reach a filesystem socket at all. See [Host classes
   and trust boundaries](#host-classes-and-trust-boundaries) for what that
   means for a `shared-multi-user` host, and the policy caveat before you run
   it.

   `tailscale up` is not optional. A `tailscaled` running under
   `tailscaled-launch` with `up` never approved looks, from the hub's side,
   identical to a healthy node: the process is alive, the socket answers, and
   the daemon's recovery cascade still considers this host joined. But it has
   no tailnet identity and no address, so the hub sees only a remote that
   never comes back — a stale card, not an error. Check with
   `TS_SOCKET=$HOME/.local/state/tailscale/tailscaled.sock tailscale status`
   after joining: it lists this node and its peers when `up` succeeded, and
   refuses or reports "Logged out" when it has not.

### The remotes.json entry

A Tailscale-fronted remote skips SSH entirely — no `--ssh`, no port, no
`ControlMaster`:

```json
{"name": "hub-a", "url": "https://hub-a.example.ts.net", "tunnel": {"manager": "none"}}
```

`tunnel: {"manager": "none"}` is what tells the daemon there is no local
tunnel process to manage or revive for this remote; it dials `url` directly.

The general rule, not specific to Tailscale: a remote with no `port` has no
tunnel for the hub to supervise, full stop. `manager: none` is the default for
such an entry — you may omit it, as the entries above do implicitly, and
`felt shuttle remotes add --url` writes it for you. What is an error is naming
an actual supervisor (`launchd`, `systemd`, `autossh`) on a portless entry:
there is no local port for that supervisor to forward to, so `felt shuttle
tunnels install` rejects it rather than writing a job that starts and
immediately has nothing to do.

### `defaults.https_proxy`

A hub whose *own* `tailscaled` also runs in userspace-networking mode has no
kernel route into the tailnet at all — the only way out to another node's
`ts.net` address is through that `tailscaled`'s local HTTP proxy
(`--outbound-http-proxy-listen`). That listener is **off by default** — see
"The proxy is a gateway" below — so a hub turns it on explicitly:

```bash
printf 'localhost:1055\n' > ~/.local/state/tailscale/http-proxy-listen
tailscaled-launch --restart
```

Then point the fleet file at the same address with a document-level default,
which the daemon feeds to `:httpc` for every remote request:

```json
{
  "defaults": {"https_proxy": "http://localhost:1055"},
  "remotes": [
    {"name": "hub-a", "url": "https://hub-a.example.ts.net", "tunnel": {"manager": "none"}}
  ]
}
```

A hub with a real TUN-mode Tailscale install (a desktop or laptop running the
official app, with a kernel route into the tailnet) needs none of this — drop
`defaults.https_proxy` and the daemon dials `ts.net` addresses directly.
`$HTTPS_PROXY` is deliberately **not** read for this: a supervised daemon's
environment is invisible to the person operating it, and `felt shuttle
remotes list` validates `remotes.json`, not the daemon's environment, so the
fleet file has to be the single source of truth.

The two values are independent settings in independent files and nothing
checks that they agree. A mismatch looks like every remote going stale at once
with no other symptom, so check both when that happens.

TLS is verified normally, against the system CA store — `ts.net` certificates
are publicly trusted (Let's Encrypt, via Tailscale's HTTPS certificate
feature), so there is no `verify_none` or pinned-cert escape hatch anywhere in
this path.

### The proxy is a gateway

`--outbound-http-proxy-listen` is an **unauthenticated** route into the whole
tailnet, and `tailscaled` offers no authentication option for it. See [Host
classes and trust boundaries](#host-classes-and-trust-boundaries): the daemon
refuses `defaults.https_proxy` on any host declared `shared-multi-user` or
`exposed`, because the proxy binds to `127.0.0.1`, which is a real boundary on
a laptop and none at all on a shared login node — every user logged into that
node shares its loopback, so any of them can run

```bash
curl -x http://127.0.0.1:1055 https://<any-node>.<tailnet>.ts.net/api/v1/state
```

and reach every daemon in your tailnet, including the control API that
launches and kills workers. An HPC login node routinely has a dozen other
people on it.

Only a hub needs the proxy — a node that merely runs `tailscale serve` to
expose its own daemon needs no outbound route at all, so a proxy there is pure
exposure for no function. This is why `bin/tailscaled-launch` ships with both
its listeners off: turn the HTTP proxy on only for a `single-user` hub that
composites the fleet. (`socks5-listen` is the same switch for
`--socks5-server`; nothing in felt or shuttle uses it.)

A hub that is itself a shared host dials out over ssh instead of the proxy —
see [Host classes and trust boundaries](#host-classes-and-trust-boundaries)
for the `tailscale nc` ProxyCommand that reaches the tailnet through
`tailscaled`'s private LocalAPI socket.

### Policy caveat

Joining a tailnet from a shared or institutional host is not a decision to
make unilaterally. Some facilities' acceptable-use policies explicitly forbid
"alternative access mechanisms" for compute nodes, and some have named and
banned structurally similar overlay-networking tools outright. Check the
facility's AUP before running `tailscale up` on one of its nodes, and — even
where joining is allowed — never run `tailscale serve` on a node whose policy
forbids exposing services from it. Joining a tailnet and serving a port from
it are different acts; a policy can permit one and forbid the other.

None of this is an SSH-login or 2FA bypass. Getting a shell on the node still
goes through the facility's normal login path, 2FA included — Tailscale plays
no part in that. What it changes is what happens *after* you're on the node:
`tailscaled` makes one outbound WireGuard connection to Tailscale's
coordination service, and `tailscale serve` exposes exactly one port (the
shuttle daemon's `:4000`) to a tailnet you control, typically a single-user
one. It does not open an inbound port on the facility's network, and it does
not touch the login path at all.

## The event stream and the ledgers

Three append-only JSONL files sit in the daemon's state directory, all resolved
against `$SHUTTLE_DATA_DIR` (default `~/.shuttle`). They are what the board's
time views read; [Telemetry and the ledgers](telemetry.md) covers what each one
is for.

### `events.jsonl`

The daemon ranks in-flight workers by idle time and renders each card's
sent-files trail. Both read one host-local file, `~/.shuttle/events.jsonl`.

`felt hook event` writes it. The plugin registers that command on seven events —
SessionStart, UserPromptSubmit, PreToolUse, Stop, SubagentStop, Notification,
and SessionEnd — for Claude Code and Codex alike. `felt setup claude` and `felt
setup codex` install the wiring; bootstrap step 5 runs both.

The hook writes only when the stream's parent directory already exists, so a
felt-only install grows no stream. `SHUTTLE_EVENTS_FILE` overrides the path and
creates its parent. `SHUTTLE_EVENTS=off` disables recording. Probe the writer
by hand:

```bash
echo '{"hook_event_name":"SessionStart"}' | SHUTTLE_EVENTS_FILE=/tmp/e.jsonl felt hook event
```

The live file rotates once it passes `SHUTTLE_EVENTS_MAX_BYTES` (64 MiB): it is
renamed to `events.jsonl.1` and a fresh stream starts. A reader whose window
reaches back past the last rotation reads the sibling too, but only when the
sibling's mtime is at or after the window's start — rotation is a rename with no
writes after it, so that mtime is the newest line the file can hold, and an
earlier one proves the window cannot overlap it. Only `events.jsonl.1` is kept;
an older rotation is overwritten. A `toolInput` over 8 KiB is trimmed to its
file paths plus `truncated: true`, so a `Write` of a large file does not park
the whole body in the stream.

### `sessions.jsonl`

Which fiber each harness session belonged to. **The daemon writes it itself**,
at dispatch, claim and resume — there is nothing to install. Override the path
with `SHUTTLE_SESSIONS_FILE`.

### `commits.jsonl`

Which session made each commit. The plugin writes it from a `PostToolUse` hook
on `Bash`, at the one moment the pairing is certain: `felt hook commit` reads
the commit back whenever the command ran a `git commit`, and appends a line.
Installing the plugin (`felt setup claude`, `felt setup codex` — bootstrap
step 5) is all it takes. Like the event stream it writes only when `~/.shuttle`
already exists, so a felt user who does not run shuttle acquires nothing. There
is no git-log fallback, so commits made outside an agent session never appear.
Override the path with `SHUTTLE_COMMITS_FILE`; see [The commit
ledger](telemetry.md#the-commit-ledger) for the line format.

## The board on your phone (Tailscale)

The daemon binds `:4000` to `127.0.0.1` and never needs to change. To reach the
board from another device, front it with Tailscale Serve on the host running
the daemon:

```bash
brew install --cask tailscale        # macOS; log in from the menu-bar app
tailscale serve --bg 4000            # https://<host>.<tailnet>.ts.net → 127.0.0.1:4000
tailscale serve status
```

The first `serve` prints a one-time link to enable Serve on the tailnet;
approve it in the browser and the command completes. Any device signed into
the same tailnet (the Tailscale iOS app, say) opens the URL directly; the URL
is tailnet-only, TLS is Tailscale's. Tailnet membership therefore grants access
to the daemon's full trusted-user surface, not a read-only dashboard. The board
composites the whole fleet from that daemon's `remotes.json`, so which host
fronts it is a question of uptime, not reach — a laptop asleep is a board
offline.

For another reverse proxy, preserve the browser-facing host and scheme in
`X-Forwarded-Host` and `X-Forwarded-Proto`, replacing any client-supplied values.
The daemon accepts direct requests only under loopback hostnames and rejects
browser writes from unrelated origins. These checks protect the local browser
boundary; they do not authenticate clients or replace access controls on the proxy.

## Sharp edges

Roughly in the order a new installer hits them.

**Fiber files are trusted content.** `/file` serves arbitrary absolute paths so
reports and companion artifacts can render. HTML artifacts run inside the board
as same-origin iframes, and interactive reports may execute JavaScript. Do not
point a publicly reachable daemon at stores containing untrusted HTML or
reports; the daemon's trusted-user boundary applies to files as well as API
writes.

**Every restart arms a boot quarantine.** On every (re)start the daemon parks
each dispatchable candidate it has never observed running into `pending_launch`.
Nothing *fresh* launches until a human runs `bin/shuttle release`. (Work the
daemon did observe alive — adopted at boot, or dispatched since — keeps
redispatching, because that counts as continuation, and a standing role whose
cron is due fires on schedule. See
[Boot quarantine](lifecycle.md#boot-quarantine) for why.) The quarantine guards
your token budget. It also explains why your first worker never starts while
nothing appears to be wrong.

```bash
bin/shuttle release
```

**A worker needs `project_dir`, `host`, and `active`.** You set these three
gates by hand on the fiber's `shuttle:` block. All three fail quietly, by simply
not dispatching. `host` is strict: absent or empty leaves the fiber unowned and
ineligible on *every* daemon. shuttle offers no `"local"` default and no
wildcard. The host id comes from `SHUTTLE_HOST`, else the file
`~/.shuttle/host` (override the path with `SHUTTLE_HOST_FILE`), else the system
hostname. For the full ordered predicate list the daemon evaluates, see
[Dispatch eligibility](lifecycle.md#dispatch-eligibility).

**`~/.shuttle/host` is the machine's name, and it is a file for a reason.** The
system hostname is consulted exactly once: the first CLI command or daemon boot
that needs an identity and finds none normalizes it (lowercased, cut at the
first `.`) and writes it to `~/.shuttle/host`; everything afterwards reads the
file. That fixes a name that would otherwise drift — DHCP renames a laptop
mid-session, and the CLI and the daemon read the hostname through different
runtimes that disagree about the DNS suffix. A drifted name is silent: fibers
armed under one spelling are invisible to a daemon calling itself the other. To
give a host a friendlier name, edit that file and restart the daemon. The file
changes what *new* stamps say, not what old ones already say, so also set
`host:` on any already-armed fiber to the new name — editing the block by hand
is safe now that both the CLI and the daemon read their own identity from the
same file.

**Every built-in agent assumes its CLI is installed.** The shipped records cover
the configured Claude, Codex, and Pi fleet, with `claude-opus` as the
default. A record whose CLI is absent or unauthenticated fails at dispatch, not
at install. Use `builtins: "restrict"` when a host should expose only the
subset it can run — see [Configuring agents](#configuring-agents).

**Source builds compile all three components on each host.** `make build` builds
the CLI, the UI, and the daemon release; `make daemon` builds only the release.
Go, Elixir/OTP, and Node/npm must be available in the build shell.
The fleet deploy helper uses each host's login shell to load its toolchain.
Fetched releases need none of these build tools.

**The UI build needs nothing beyond the repo.** `npm run build` runs `tsc
--noEmit && vite build`. A fresh clone builds `ui/dist` fine:

```bash
cd ui && npm ci && npm run build
```

**macOS TCC: keep the daemon *and its stores* out of `~/Documents`.**
launchd-started processes cannot read `~/Documents`, `~/Desktop`, or
`~/Downloads`. Full Disk Access does not inherit across the launchd process tree
the way it does under a terminal, so granting it buys nothing. A daemon rooted
in a protected folder crash-loops on start. A *store* under one is the quieter
failure: the daemon starts fine, finds the store, reads nothing out of it, and
the board loads with no fibers and no error. `install-agent` warns on stderr
about either — the release root and each `--felt-stores` entry, under `--print`
as well as a real install — and then installs anyway, so the warning is the
whole protection. Put both somewhere else: `~/dev/felt` for a checkout,
`~/notes` or `~/loom` for a store, or anything outside the three folders.

That turns the symlink direction into a correctness constraint rather than a
matter of taste. A project on your Desktop can still be daemon-visible — but
only if its bytes are canonical *outside* the protected folder: the store lives
in, say, `~/loom`, and the Desktop holds a symlink pointing into it. The other
direction leaves the real files where launchd cannot read them, and the daemon
follows the symlink into the same silence.

**A store in iCloud Drive is readable — until it is evicted.** `~/Library/Mobile
Documents/…` is not one of the TCC-protected folders, so a store there works.
But *Optimize Mac Storage* evicts the contents of files iCloud decides you are
not using, leaving the names in place and the bytes on the server, and the
symptom is the TCC symptom exactly: the daemon discovers the store, reads little
or nothing out of it, and the board loads quiet and empty. Keep a store you
dispatch from pinned locally — *Keep Downloaded* on the folder, or the setting
off — or keep it out of iCloud.

**The first walk of a guarded store can stall every endpoint.** macOS asks for
consent the first time a process reaches into iCloud Drive, and the daemon's
first poll after you name such a store is what raises the dialog. Until someone
answers it, the walk blocks and every API request queues behind it — discovery
times out, the log reports carrying zero fibers, and responses arrive tens of
seconds late or not at all. That is the dialog waiting, usually behind another
window, not the daemon failing. Answer it and the board fills; warm, the same
walk is instant. So after pointing the daemon at a store in iCloud or any other
location macOS guards, go find the prompt before you judge an empty board.

**A supervisor respawns the daemon after `make stop`.** The Makefile's release
pattern matches `bin/rel` in both relative and absolute paths, so `make restart`
can rebuild and cycle a supervisor-owned checkout. Use the supervisor directly
when you want its service state to be explicit:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   # macOS
systemctl --user restart shuttle-daemon                 # Linux
```

`make restart` also works for a daemon started with `make start`; in either case,
the command waits for `/api/v1/version` after the replacement boots.

**`felt shuttle tunnels` needs a fleet file first.** It renders autossh jobs
from `~/.config/felt/remotes.json` — launchd plists on macOS, systemd user units
on Linux. With no remotes configured it has nothing to write, and `scripts/bootstrap.sh
--with-tunnels` does nothing useful. A Linux host with no systemd user session
cannot start a unit, so `install` says so and writes nothing; `--write-only`
renders the units for you to supervise yourself.

**The event stream stays empty until `~/.shuttle` exists.** `felt hook event`
refuses to create its own directory, so a felt-only install records nothing.
Degradation is graceful — the board still serves — but the activity ranking and
the sent-files trail stay empty. Both daemon installs create the directory:
`scripts/bootstrap.sh` for a checkout, and `install.sh` under `SHUTTLE=1` for a fetched
release (it writes `~/.shuttle/repo` there too). So a host with the daemon on it
is already enabled. The gap is a felt-only install — no `SHUTTLE=1`, no
checkout — where nothing has made the directory yet: run `mkdir -p ~/.shuttle`
yourself. See [The event stream and the
ledgers](#the-event-stream-and-the-ledgers).

## License

The felt CLI and the board UI carry the MIT license. The daemon (`daemon/lib/`)
contains code derived from OpenAI's Symphony under the Apache License
2.0, preserved in
[`NOTICE`](https://github.com/cailmdaley/felt/blob/main/NOTICE).
