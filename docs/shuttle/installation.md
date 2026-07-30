# Installing the Shuttle daemon

The `felt` CLI installs cleanly from a release binary. The Shuttle daemon does
not. There is no release artifact, no package, no container — you build it from
a checkout and you keep the checkout.

!!! warning "This path is currently fleet-oriented"
    Shuttle was built to run on one person's machines: a macOS hub and a few HPC
    login nodes, and several defaults still point at private things — see
    [Honest scoping](index.md#honest-scoping). [Sharp edges](#sharp-edges) below
    names each one you will actually trip over. macOS is the well-trodden path.
    Linux works and is thinner. Windows is not supported.

## Prerequisites

| Tool | Required | Why |
| --- | --- | --- |
| `go` 1.23+ | yes | Builds the `felt` CLI. The daemon shells out to `felt` for every store walk. |
| `elixir` 1.19+ / OTP 27 | yes | `mix.exs` declares `elixir: "~> 1.19"`. CI builds on OTP 27. |
| `escript` | yes | The daemon *is* an escript. It ships with Erlang/OTP. |
| `tmux` | yes | Every worker runs in a tmux session. On Linux the daemon's own keep-alive is a tmux loop. |
| `node` 22+ / `npm` | only for the board | Builds the kanban bundle into `ui/dist`. |
| `jq` | optional | The Claude Code event hook uses it. Without it, activity ranking and the sent-files trail stay empty; the board still serves. |

`bootstrap.sh` checks all of these and tells you what is missing. Its Elixir
hint text still says "OTP 26+ and Elixir 1.16+" — that is stale. `mix deps.get`
will fail on 1.16.

## Bootstrap

Clone the repo, then run the bootstrap. `make install` is the same thing.

```bash
git clone https://github.com/cailmdaley/felt ~/dev/felt
cd ~/dev/felt
./bootstrap.sh --dry-run     # check prerequisites, print the plan, change nothing
./bootstrap.sh               # or: make install
```

Six steps run in order.

1. **Prerequisites.** Named, with install hints. Missing required tools abort
   the run before anything is built.
2. **`felt` CLI.** `GOBIN=~/.local/bin go install .` from *this* checkout — not
   the release binary. The daemon shells the CLI, so the two must never skew.
3. **Daemon escript.** `mix deps.get`, then `make daemon` → `bin/shuttle`. The
   checkout path is recorded in `~/.shuttle/repo` so remote revival over SSH can
   find it without an environment.
4. **`ui/dist`.** The served board bundle. Built by default on macOS, skipped by
   default on Linux — see [Sharp edges](#sharp-edges), because this step fails
   on a fresh clone.
5. **Event hook.** Checks whether `shuttle-hook.sh` is registered in
   `~/.claude/settings.json`. The hook lives in `~/loom`, the maintainer's
   private [cross-project store](../concepts/cross-project.md); if you do not
   have one, this step warns and continues.
6. **Keep-alive.** macOS: a launchd LaunchAgent. Linux: a tmux respawn loop.

Useful flags: `--dry-run`, `--skip-ui`, `--build-ui`, `--skip-hook`,
`--skip-cli`, `--with-tunnels`.

## Keep-alive on macOS (launchd)

Step 6 calls `make install-agent`, which renders
`share/io.shuttle.daemon.plist.template` into
`~/Library/LaunchAgents/io.shuttle.daemon.plist` and loads it. The agent has
`RunAtLoad` and `KeepAlive`, so the daemon starts at login and restarts on
crash.

Three environment variables are baked into the plist at install time, and each
one exists because the obvious approach failed:

- **`PATH`** — captured from `bash -lc 'echo $PATH'` *at install time*. launchd's
  own environment is nearly empty: the `#!/usr/bin/env escript` shebang cannot
  find `escript`, and the daemon cannot find `felt`. Sourcing the login profile
  at runtime does not fix it, because the profile is not self-sufficient from a
  bare environment. So the real login `PATH` is frozen into the plist. A `PATH`
  without `felt` on it gives you a daemon that boots, serves the board, and
  returns 500 on `/api/v1/fibers/composite`.
- **`FELT_STORES`** — the stores the daemon polls. The Makefile default is
  `$HOME/loom`, the maintainer's private
  [cross-project store](../concepts/cross-project.md). Override it:
  `make install-agent AGENT_FELT_STORES=~/myproject`. This launchd default is
  the *only* place a store path is assumed; the daemon itself has none.
- **`SSH_AUTH_SOCK`** — `~/.ssh/agent.sock`, the persistent login agent. launchd
  hands the daemon a bare per-session Keychain agent that only holds the default
  key, which breaks every SSH the daemon makes to a remote host. Override with
  `AGENT_SSH_AUTH_SOCK` if your socket lives elsewhere.

Logs go to `~/Library/Logs/shuttle.log` (`make logs` tails it). Remove the agent
with `make uninstall-agent`.

## Keep-alive on Linux (tmux)

There is no systemd unit in this repo. On Linux, bootstrap copies
`bin/shuttle-launch` to `~/.local/bin` and starts a tmux session named
`shuttle-daemon` running a respawn loop.

The loop runs `./bin/shuttle start --force` and backs off exponentially: a
daemon that exits within 60 seconds doubles the sleep (2s up to a 300s cap); one
that survives 60 seconds resets it. This exists because a wedged login node once
drove a fixed 2-second loop to roughly 35,000 restarts.

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

**There is no implicit default.** An unset variable and an absent registry
resolve to an empty list, and the daemon then polls nothing at all: it boots
fine, binds `:4000`, serves an empty board, and dispatches nothing. The launchd
plist above sets `FELT_STORES=$HOME/loom`, so a fresh install on a machine
without that directory lands exactly here.

The registry file is canonical in this shape (a bare JSON array is also
accepted):

```json
{
  "version": 1,
  "felt_stores": ["/Users/you/dev/myproject"]
}
```

`POST /api/v1/felt-stores` rewrites the file, and the board's store picker uses
that endpoint. A store path with no `.felt/` directory is not a store.

## Verify

```bash
curl -s http://127.0.0.1:4000/api/v1/version   # daemon answers
open http://127.0.0.1:4000/                    # the kanban board
felt shuttle ps                                # running workers
make logs                                      # tail the daemon log
make status                                    # ps + a snapshot summary
```

The daemon binds `127.0.0.1:4000` and only that. It is loopback-only by
construction; there is no auth layer, because there is nothing listening off the
machine.

## Sharp edges

Roughly in the order a new installer hits them.

**`make daemon` needs Go, despite what the docs say.** `daemon: cli-install`,
and `cli-install` runs `go install .`. The dependency is deliberate — a daemon
built against a stale installed CLI breaks mid-dispatch. But the Makefile header
and `AGENTS.md` both still claim `make daemon` needs no Go toolchain. They are
wrong. `bootstrap.sh --skip-cli` also does not skip the Go build, because step 3
calls `make daemon` anyway.

**The UI build fails on a fresh clone. Use `npx vite build`.** `npm run build`
is `tsc --noEmit && vite build`, and the typecheck covers a `src/paper` entry
that imports `@lightcone/renderer` — a private package you cannot resolve. The
Vite build itself drops that entry when it is absent, so the bundle builds fine;
only the typecheck fails. CI works around this and so should you:

```bash
cd ui && npm ci && npx vite build
```

`bootstrap.sh` still calls `npm run build`, catches the failure, warns, and
continues. `ui/dist` is gitignored, so the result is a live daemon with no
board.

**macOS TCC: keep the checkout out of `~/Documents`.** launchd-spawned processes
are blocked from `~/Documents`, `~/Desktop`, and `~/Downloads`, and Full Disk
Access does not inherit across the launchd process tree the way it does under a
terminal. A daemon rooted in a protected folder crash-loops or silently fails
its store walks. `make install-agent` warns and installs anyway. Use `~/dev/felt`
or anything else outside those folders. The same trap catches a *store* whose
real path is under `~/Documents` even when the checkout is clean.

**`make restart` silently no-ops under launchd.** `make stop` matches the daemon
by a relative-path pattern; the plist launches it by absolute path. So after
`make install-agent`, `make restart` rebuilds the escript, stops nothing, and
reports "already running." Bounce it properly:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon
```

`make restart` is correct only when you started the daemon with `make start`.

**Every restart arms a boot quarantine.** On every (re)start the daemon parks
each dispatchable candidate it has never observed running into `pending_launch`.
Nothing *fresh* launches until a human runs `bin/shuttle release`. (Work the
daemon did observe alive — adopted at boot, or dispatched since — keeps
redispatching, because that is continuation. See
[Boot quarantine](lifecycle.md#boot-quarantine) for why.) This is a safety
feature, and it is also why your first worker never starts and nothing appears
to be wrong.

```bash
bin/shuttle release
```

**A worker needs `project_dir`, `host`, and `active`.** These are the three
gates you set by hand on the fiber's `shuttle:` block, and all three fail
quietly by simply not dispatching. `host` is strict: absent or empty means
unowned and ineligible on *every* daemon — there is no `"local"` default and no
wildcard. The host id comes from `SHUTTLE_HOST`, else the file `~/.shuttle/host`
(override the path with `SHUTTLE_HOST_FILE`), else the system hostname. For the
full ordered predicate list the daemon evaluates, see
[Dispatch eligibility](lifecycle.md#dispatch-eligibility).

**The agent registry is compiled in.** `internal/shuttle/agents.json` is baked
into the `felt` binary and lists the CLIs and models on the maintainer's
machines (`claude-sonnet` is the default). Each entry assumes that CLI is
installed and authenticated. There is currently no supported way to register
your own agent without editing that file and rebuilding.

**Tunnels hardcode four hosts.** `felt shuttle tunnels`
(`cmd/shuttle_tunnels.go`) maps a fixed set of hostnames to ports 4001–4004, and
the daemon's matching remote registry sits in `config/dev.exs`.
`bootstrap.sh --with-tunnels` and `bin/shuttle-deploy` are private-fleet tooling
in general-purpose clothing. Ignore them unless you are on that fleet.

**The event stream needs `~/loom`, which is private.** Step 5 looks for
`~/loom/hooks/shuttle-hook.sh` registered in `~/.claude/settings.json`. That
store is not public and there is no documented substitute. Degradation is
graceful — no activity ranking, no sent-files trail, board still serves — but
that column of the board will stay empty.

## License

The felt CLI and the board UI are MIT licensed. The daemon you just built
(`lib/`) contains code derived from OpenAI's Symphony under the Apache License
2.0, preserved in
[`NOTICE`](https://github.com/cailmdaley/felt/blob/main/NOTICE).
