# Installing the Shuttle daemon

The `felt` CLI installs cleanly from a release binary. The Shuttle daemon ships
no release artifact, no package, and no container. You build it from a checkout
and you keep the checkout.

!!! warning "This path is currently fleet-oriented"
    Shuttle runs on one person's machines: a macOS hub and a few HPC login
    nodes. Several defaults still point at private things — see
    [Honest scoping](index.md#honest-scoping). [Sharp edges](#sharp-edges) below
    names each one you will actually trip over.

    **Platform:** Linux and macOS both support single-host use — the daemon,
    the board, and workers on one machine, with a real keep-alive on either.
    Multi-host tunnel management (`felt shuttle tunnels`) is macOS-only, since
    it manages launchd autossh jobs. macOS gets the most use. Windows is
    unsupported.

## Prerequisites

| Tool | Required | Purpose |
| --- | --- | --- |
| `go` 1.23+ | yes | Builds the `felt` CLI. The daemon shells out to `felt` for every store walk. |
| `elixir` 1.19+ / OTP 27 | yes | `mix.exs` declares `elixir: "~> 1.19"`. CI builds on OTP 27. |
| `escript` | yes | The daemon runs *as* an escript. It ships with Erlang/OTP. |
| `tmux` | yes | Every worker runs in a tmux session. On a Linux host without systemd, the daemon's own keep-alive is a tmux loop too. |
| `node` 22+ / `npm` | only for the board | Builds the kanban bundle into `ui/dist`. |
| `jq` | optional | `session.sh` uses it to pretty-print the SessionStart envelope. Without it the hook falls back to `felt hook session`. |

`bootstrap.sh` checks all of these and names what is missing.

## Bootstrap

Clone the repo, then run the bootstrap. `make install` runs the same thing.

```bash
git clone https://github.com/cailmdaley/felt ~/dev/felt
cd ~/dev/felt
./bootstrap.sh --dry-run     # check prerequisites, print the plan, change nothing
./bootstrap.sh               # or: make install
```

Six steps run in order.

1. **Prerequisites.** Named, with install hints. A missing required tool aborts
   the run before anything is built.
2. **`felt` CLI.** `GOBIN=~/.local/bin go install .` from *this* checkout — not
   the release binary. The daemon shells the CLI, so the two must never skew.
3. **Daemon escript.** `mix deps.get`, then `make daemon` → `bin/shuttle`. The
   step records the checkout path in `~/.shuttle/repo`, so remote revival over
   SSH can find it without an environment.
4. **`ui/dist`.** The served board bundle. Built by default when Node is on
   PATH, skipped otherwise — rsync it from a host that has Node instead.
5. **Event stream.** Runs `felt setup claude` and `felt setup codex` against
   this checkout, so the plugin hooks match the binary. Then it pipes a probe
   payload through `felt hook event` and checks the line it writes. See
   [The event stream](#the-event-stream).
6. **Keep-alive.** macOS: a launchd LaunchAgent. Linux: a systemd user unit,
   falling back to a tmux respawn loop where there is no systemd user session.

Useful flags: `--dry-run`, `--skip-ui`, `--build-ui`, `--skip-hook`,
`--skip-cli`, `--with-tunnels`.

## Keep-alive

`make install-agent` installs the supervisor, branching on `uname -s`. Both
arms render a template from `share/` and bake in the same three environment
values, for the same reason: neither supervisor hands the daemon your login
environment.

### macOS (launchd)

Step 6 calls `make install-agent`, which renders
`share/io.shuttle.daemon.plist.template` into
`~/Library/LaunchAgents/io.shuttle.daemon.plist` and loads it. The agent sets
`RunAtLoad` and `KeepAlive`, so the daemon starts at login and restarts on
crash.

`make install-agent` bakes three environment variables into the plist. Each one
exists because the obvious approach failed:

- **`PATH`** — captured from `bash -lc 'echo $PATH'` *at install time*.
  launchd's own environment is nearly empty: the `#!/usr/bin/env escript`
  shebang cannot find `escript`, and the daemon cannot find `felt`. Sourcing the
  login profile at runtime does not fix it, because the profile is not
  self-sufficient from a bare environment. So the plist freezes the real login
  `PATH`. A `PATH` without `felt` on it gives you a daemon that boots, serves
  the board, and returns 500 on `/api/v1/fibers/composite`.
- **`FELT_STORES`** — the stores the daemon polls, comma-separated. There is no
  default: `make install-agent AGENT_FELT_STORES=~/myproject` is required, and
  the target refuses without it. felt re-discovers a store's symlinked
  substores, so one [cross-project store](../concepts/cross-project.md) is
  usually the only entry you need.
- **`SSH_AUTH_SOCK`** — `~/.ssh/agent.sock` on macOS, the persistent login agent. launchd
  hands the daemon a bare per-session Keychain agent that holds only the default
  key, which breaks every SSH the daemon makes to a remote host. Override with
  `AGENT_SSH_AUTH_SOCK` if your socket lives elsewhere.

Logs go to `~/Library/Logs/shuttle.log` (`make logs` tails it). Remove the agent
with `make uninstall-agent`.

### Linux (systemd user unit)

`make install-agent` renders `share/io.shuttle.daemon.service.template` into
`~/.config/systemd/user/shuttle-daemon.service`, then runs `systemctl --user
enable --now`. `Restart=always` with `RestartSec=10` is the KeepAlive analog;
`WantedBy=default.target` starts the daemon at login. It bakes in the same
`PATH`, `FELT_STORES`, and `SSH_AUTH_SOCK` as the plist, for the same reasons —
a systemd user manager inherits almost nothing either. An empty
`SSH_AUTH_SOCK` is dropped from the rendered unit rather than baked in as a
dead path, since Linux has no canonical agent socket.

It is a **user** unit: the daemon runs as you and wants no root.

```bash
loginctl enable-linger $(id -un)
```

Run that once. A systemd user manager normally stops at your last logout, which
would take the daemon down with your ssh session; lingering keeps it alive
across logout and starts it at boot. `make install-agent` prints the command
but does not run it, because enabling linger needs privileges the install does
not assume.

Day-to-day:

```bash
systemctl --user status shuttle-daemon     # is it up
systemctl --user restart shuttle-daemon    # cycle onto a freshly built escript
journalctl --user -u shuttle-daemon        # unit-level events
make logs                                  # the daemon's own log
```

Logs go to `~/.shuttle/shuttle.log` on Linux — beside the daemon's other state,
and the same file `make start` and the respawn loop write, so `make logs` finds
it whichever path is running. Remove the unit with `make uninstall-agent`.

`make install-agent` kills the tmux respawn loop first; both would bind `:4000`.

### Linux without systemd (tmux respawn loop)

Plenty of Linux hosts have no systemd user session — an HPC login node
typically does not, and neither does a bare container. `make install-agent`
says so and refuses there. Bootstrap detects the same thing and falls back:
it copies `bin/shuttle-launch` to `~/.local/bin` and starts a tmux session named
`shuttle-daemon` running a respawn loop. (It installs `shuttle-launch` on every
Linux host either way, because remote revival invokes it over SSH.)

The loop runs `./bin/shuttle start --force` and backs off exponentially. A
daemon that exits within 60 seconds doubles the sleep, from 2s up to a 300s cap.
One that survives 60 seconds resets it. This exists because a wedged login node
once drove a fixed 2-second loop to roughly 35,000 restarts.

To cycle onto a freshly built escript, kill the listener and let the loop
respawn it:

```bash
lsof -ti:4000 -sTCP:LISTEN | xargs kill
```

To pick up a new `shuttle-launch` itself:

```bash
SHUTTLE_DIR=~/dev/felt ~/.local/bin/shuttle-launch
```

## Configuring stores

The daemon polls felt stores. It resolves them in this order:

1. `FELT_STORES` — a comma-separated list of store paths.
2. `~/.config/felt/stores.json` — the persisted registry (override the path with
   `FELT_STORES_FILE`).

**Shuttle assumes no default store.** An unset variable and an absent registry
resolve to an empty list. The daemon then polls nothing: it boots, binds
`:4000`, serves an empty board, and dispatches nothing. `make install-agent`
requires `AGENT_FELT_STORES` precisely so a supervised daemon never boots into
that state by accident.

The registry file takes this canonical shape. A bare JSON array also works.

```json
{
  "version": 1,
  "felt_stores": ["/home/you/dev/myproject"]
}
```

`POST /api/v1/felt-stores` rewrites the file, and the board's store picker uses
that endpoint. A store path must contain a `.felt/` directory.

## From an empty board to a first dispatch

With the daemon up and a store registered, here is the fastest path from
nothing to a worker running.

Add the store, if `FELT_STORES` does not already cover it:

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

## Configuring agents

`felt shuttle agents` prints the effective registry. It layers your own file
over a built-in set of eight records. Set `$FELT_AGENTS_FILE` to choose the
path; otherwise felt reads `~/.config/felt/agents.json`.

```bash
felt shuttle agents init      # seed the user file from the built-ins
felt shuttle agents           # the merged table, with a source footer
felt shuttle agents --source user
```

Each record names a CLI, a model, and its axis metadata (`effort_levels`,
`default_effort`, `chrome_capable`). `share/agents.example.json` in the repo
works every field across several harnesses — copy from it. A missing file is
silent. A malformed file fails loudly and names the path.

The file's `builtins` key controls the merge. `"merge"` (the default) folds your
records over the built-ins by id, last one wins. `"replace"` drops the built-in
layer entirely; `human` stays reserved either way.

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
rides an existing `ControlMaster` socket, which is what a 2FA host needs. A
`launchd_label_prefix` key in the file names the launchd labels
`felt shuttle tunnels install` writes. Single-machine use needs none of this: an
absent file means no remotes.

`bin/shuttle-deploy` reads the same file, so the fleet is described once. Give
a remote a `checkout` (its repo path) to make it a deploy target — a remote
without one is skipped. Two more optional keys serve deploy only: `ssh_flags`,
a list of extra ssh arguments, and `auth`, which the deploy script reads as
`"pubkey"` (the default) or `"interactive"`. Mark a host `"interactive"` when
its ssh needs a live human credential — push-2FA or a short-lived certificate —
and `bin/shuttle-deploy --handshake` will bootstrap a `ControlMaster` for it
instead of failing.

## The event stream

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

## Verify

```bash
curl -s http://127.0.0.1:4000/api/v1/version   # daemon answers
felt shuttle ps                                # running workers
make logs                                      # tail the daemon log
make status                                    # ps + a snapshot summary
```

Open <http://127.0.0.1:4000/> in your browser for the kanban board.

The daemon binds `127.0.0.1:4000` and nothing else. It stays loopback-only by
construction. It carries no auth layer, because nothing off the machine can
reach it.

## Sharp edges

Roughly in the order a new installer hits them.

**`make daemon` refreshes the felt CLI when Go is available.** The daemon
shells the felt CLI for its writes, so a stale installed CLI can break
daemon-shelled commands mid-dispatch — `make daemon` rebuilds it first whenever
Go is on PATH. On a host with no Go toolchain, `make daemon` builds only the
escript, against whatever `felt` is already installed there. `bootstrap.sh
--skip-cli` passes `SKIP_CLI=1` through to `make daemon`, so it skips the CLI
rebuild too, even on a host that has Go.

**The UI build needs no private checkout.** `npm run build` runs `tsc --noEmit
&& vite build`. The `src/paper` entry imports `@lightcone/renderer`, a private
package — but `ui/src/paper/lightcone.d.ts` ships ambient type declarations
that satisfy the typecheck without it, and the Vite build drops the paper entry
when the real package isn't resolvable. A fresh clone builds `ui/dist` fine:

```bash
cd ui && npm ci && npm run build
```

**macOS TCC: keep the checkout out of `~/Documents`.** launchd-spawned processes
cannot read `~/Documents`, `~/Desktop`, or `~/Downloads`. Full Disk Access does
not inherit across the launchd process tree the way it does under a terminal. A
daemon rooted in a protected folder crash-loops or silently fails its store
walks. `make install-agent` warns and installs anyway. Use `~/dev/felt`, or
anything else outside those folders. The same trap catches a *store* whose real
path sits under `~/Documents`, even when the checkout is clean.

**`make restart` silently no-ops under a supervisor.** `make stop` matches the
daemon by a relative-path pattern; launchd and systemd both launch it by
absolute path. So after `make install-agent`, `make restart` rebuilds the
escript, stops nothing, and reports "already running." Bounce it properly:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   # macOS
systemctl --user restart shuttle-daemon                 # Linux
```

`make restart` works only when you started the daemon with `make start`.

**Every restart arms a boot quarantine.** On every (re)start the daemon parks
each dispatchable candidate it has never observed running into `pending_launch`.
Nothing *fresh* launches until a human runs `bin/shuttle release`. (Work the
daemon did observe alive — adopted at boot, or dispatched since — keeps
redispatching, because that counts as continuation. See
[Boot quarantine](lifecycle.md#boot-quarantine) for why.) The quarantine guards
your token budget. It also explains why your first worker never starts while
nothing appears to be wrong.

```bash
bin/shuttle release
```

**A worker needs `project_dir`, `host`, and `active`.** You set these three
gates by hand on the fiber's `shuttle:` block. All three fail quietly, by simply
not dispatching. `host` is strict: absent or empty leaves the fiber unowned and
ineligible on *every* daemon. Shuttle offers no `"local"` default and no
wildcard. The host id comes from `SHUTTLE_HOST`, else the file
`~/.shuttle/host` (override the path with `SHUTTLE_HOST_FILE`), else the system
hostname. For the full ordered predicate list the daemon evaluates, see
[Dispatch eligibility](lifecycle.md#dispatch-eligibility).

**Every built-in agent assumes its CLI is installed.** The eight built-in
records name `claude`, `codex`, and the `human` pseudo-agent, with
`claude-sonnet` as the default. A record whose CLI is absent or unauthenticated
fails at dispatch, not at install. Run `felt shuttle agents init` and cut the
list down to what you actually have — see [Configuring
agents](#configuring-agents).

**`felt shuttle tunnels` is macOS-only, and needs a fleet file first.** It
renders launchd autossh plists from `~/.config/felt/remotes.json`, so `install`
refuses outright on Linux — multi-host aggregation runs from a Mac hub, though
the remotes it aggregates can be any platform. With no remotes configured it has
nothing to write, and `bootstrap.sh --with-tunnels` does nothing useful.
`bin/shuttle-deploy` still targets the maintainer's host layout despite its
general name.

**The event stream stays empty until `~/.shuttle` exists.** `felt hook event`
refuses to create its own directory, so a felt-only install records nothing.
Degradation is graceful — the board still serves — but the activity ranking and
the sent-files trail stay empty. Bootstrap step 3 creates the directory, so a
bootstrapped host is already enabled. See [The event
stream](#the-event-stream).

## License

The felt CLI and the board UI carry the MIT license. The daemon you just built
(`lib/`) contains code derived from OpenAI's Symphony under the Apache License
2.0, preserved in
[`NOTICE`](https://github.com/cailmdaley/felt/blob/main/NOTICE).
