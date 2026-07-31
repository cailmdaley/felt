# Installing the Shuttle daemon

The `felt` CLI installs cleanly from a release binary. The Shuttle daemon ships
no release artifact, no package, and no container. You build it from a checkout
and you keep the checkout.

!!! warning "This path is currently fleet-oriented"
    Shuttle runs on one person's machines: a macOS hub and a few HPC login
    nodes. Several defaults still point at private things — see
    [Honest scoping](index.md#honest-scoping). [Sharp edges](#sharp-edges) below
    names each one you will actually trip over. macOS gets the most use. Linux
    works, on a thinner path. Windows is unsupported.

## Prerequisites

| Tool | Required | Purpose |
| --- | --- | --- |
| `go` 1.23+ | yes | Builds the `felt` CLI. The daemon shells out to `felt` for every store walk. |
| `elixir` 1.19+ / OTP 27 | yes | `mix.exs` declares `elixir: "~> 1.19"`. CI builds on OTP 27. |
| `escript` | yes | The daemon runs *as* an escript. It ships with Erlang/OTP. |
| `tmux` | yes | Every worker runs in a tmux session. On Linux the daemon's own keep-alive runs as a tmux loop. |
| `node` 22+ / `npm` | only for the board | Builds the kanban bundle into `ui/dist`. |
| `jq` | optional | `session.sh` uses it to pretty-print the SessionStart envelope. Without it the hook falls back to `felt hook session`. |

`bootstrap.sh` checks all of these and names what is missing. Its Elixir hint
text says "OTP 26+ and Elixir 1.16+". Ignore that hint — `mix deps.get` fails on
1.16.

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
4. **`ui/dist`.** The served board bundle. Built by default on macOS, skipped by
   default on Linux, because this step fails on a fresh clone — see
   [Sharp edges](#sharp-edges).
5. **Event stream.** Runs `felt setup claude` and `felt setup codex` against
   this checkout, so the plugin hooks match the binary. Then it pipes a probe
   payload through `felt hook event` and checks the line it writes. See
   [The event stream](#the-event-stream).
6. **Keep-alive.** macOS: a launchd LaunchAgent. Linux: a tmux respawn loop.

Useful flags: `--dry-run`, `--skip-ui`, `--build-ui`, `--skip-hook`,
`--skip-cli`, `--with-tunnels`.

## Keep-alive on macOS (launchd)

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
- **`FELT_STORES`** — the stores the daemon polls. The Makefile default is
  `$HOME/loom`, the maintainer's private
  [cross-project store](../concepts/cross-project.md). Override it:
  `make install-agent AGENT_FELT_STORES=~/myproject`. This launchd default
  supplies the *only* assumed store path; the daemon itself assumes none.
- **`SSH_AUTH_SOCK`** — `~/.ssh/agent.sock`, the persistent login agent. launchd
  hands the daemon a bare per-session Keychain agent that holds only the default
  key, which breaks every SSH the daemon makes to a remote host. Override with
  `AGENT_SSH_AUTH_SOCK` if your socket lives elsewhere.

Logs go to `~/Library/Logs/shuttle.log` (`make logs` tails it). Remove the agent
with `make uninstall-agent`.

## Keep-alive on Linux (tmux)

This repo ships no systemd unit. On Linux, bootstrap copies
`bin/shuttle-launch` to `~/.local/bin` and starts a tmux session named
`shuttle-daemon` running a respawn loop.

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
`:4000`, serves an empty board, and dispatches nothing. The launchd plist above
sets `FELT_STORES=$HOME/loom`, so a fresh install on a machine without that
directory lands exactly here.

The registry file takes this canonical shape. A bare JSON array also works.

```json
{
  "version": 1,
  "felt_stores": ["/Users/you/dev/myproject"]
}
```

`POST /api/v1/felt-stores` rewrites the file, and the board's store picker uses
that endpoint. A store path must contain a `.felt/` directory.

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
open http://127.0.0.1:4000/                    # the kanban board
felt shuttle ps                                # running workers
make logs                                      # tail the daemon log
make status                                    # ps + a snapshot summary
```

The daemon binds `127.0.0.1:4000` and nothing else. It stays loopback-only by
construction. It carries no auth layer, because nothing off the machine can
reach it.

## Sharp edges

Roughly in the order a new installer hits them.

**`make daemon` needs Go, despite what the docs say.** `daemon: cli-install`,
and `cli-install` runs `go install .`. The dependency is deliberate — a daemon
built against a stale installed CLI breaks mid-dispatch. But the Makefile header
and `AGENTS.md` both still claim `make daemon` needs no Go toolchain. They are
wrong. `bootstrap.sh --skip-cli` also does not skip the Go build, because step 3
calls `make daemon` anyway.

**The UI build fails on a fresh clone. Use `npx vite build`.** `npm run build`
runs `tsc --noEmit && vite build`. The typecheck covers a `src/paper` entry that
imports `@lightcone/renderer`, a private package you cannot resolve. The Vite
build itself drops that entry when it is absent, so the bundle builds fine; only
the typecheck fails. CI works around this and so should you:

```bash
cd ui && npm ci && npx vite build
```

`bootstrap.sh` still calls `npm run build`, catches the failure, warns, and
continues. `ui/dist` is gitignored, so you end with a live daemon and no board.

**macOS TCC: keep the checkout out of `~/Documents`.** launchd-spawned processes
cannot read `~/Documents`, `~/Desktop`, or `~/Downloads`. Full Disk Access does
not inherit across the launchd process tree the way it does under a terminal. A
daemon rooted in a protected folder crash-loops or silently fails its store
walks. `make install-agent` warns and installs anyway. Use `~/dev/felt`, or
anything else outside those folders. The same trap catches a *store* whose real
path sits under `~/Documents`, even when the checkout is clean.

**`make restart` silently no-ops under launchd.** `make stop` matches the daemon
by a relative-path pattern; the plist launches it by absolute path. So after
`make install-agent`, `make restart` rebuilds the escript, stops nothing, and
reports "already running." Bounce it properly:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon
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

**`felt shuttle tunnels` needs a fleet file first.** It renders launchd autossh
plists from `~/.config/felt/remotes.json`. With no remotes configured it has
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
