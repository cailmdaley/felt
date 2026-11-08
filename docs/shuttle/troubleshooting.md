# Sharp edges

Roughly in the order a new installer hits them.

**Fiber files are trusted content.** `/file` serves arbitrary absolute paths so
reports and companion artifacts can render.
HTML reader pages execute JavaScript in an opaque-origin sandbox, without access to the board's DOM or origin storage.
Their preferences live only in their retained document, and their history state cannot change the board's address.
Sibling images, CSS and classic scripts use the owner-routed `/file-assets` route; it grants no CORS access for report fetch/XHR requests.
Raw HTML, XHTML and SVG file responses carry a CSP sandbox too, so a report's popup or an “Open in new tab” action cannot regain the board's origin.
Do not expose a daemon containing untrusted reports publicly; the daemon's trusted-user boundary applies to files as well as API writes.

**Every restart arms a boot quarantine.** On every (re)start the daemon parks
each dispatchable candidate it has never observed running into `pending_launch`.
Nothing *fresh* launches until a human runs `shuttle daemon release`. (Work the
daemon did observe alive — adopted at boot, or dispatched since — keeps
redispatching, because that counts as continuation, and a standing constitution whose
cron is due fires on schedule. See
[Boot quarantine](lifecycle.md#boot-quarantine) for why.) The quarantine guards
your token budget. It also explains why your first worker never starts while
nothing appears to be wrong. On a host that opts in (a CPU-capped login node
whose daemon gets reaped), a released daemon killed hard — never a stop or
restart — lifts it by itself when it is back within seconds with its workers
still alive and no crash loop behind it — see
[the one automatic exit](lifecycle.md#the-one-automatic-exit-a-proven-fast-bounce).

```bash
shuttle daemon release
```

**A worker needs `project_dir`, `host`, and `active`.** You set these three
gates by hand on the fiber's `shuttle:` block. All three fail quietly, by simply
not dispatching. `host` is strict: absent or empty leaves the fiber unowned and
ineligible on *every* daemon. shuttle offers no `"local"` default and no
wildcard. The host id is what `shuttle host` reports: `SHUTTLE_HOST`,
else the file `~/.shuttle/host` (override the path with `SHUTTLE_HOST_FILE`),
else the system hostname. For the full ordered predicate list the daemon
evaluates, see [Dispatch eligibility](lifecycle.md#dispatch-eligibility).

**`~/.shuttle/host` is the machine's name, and it is a file for a reason.**
Only shuttle resolves the host id. The system hostname is consulted once:
`shuttle host seed` — which `shuttle daemon install` runs — or the first CLI
command that needs an identity and finds none normalizes it (lowercased, cut
at the first `.`) and writes it to `~/.shuttle/host`; everything afterwards
reads the file. The daemon takes `SHUTTLE_HOST` or asks `shuttle host --json`
once at boot, and refuses to boot if shuttle cannot answer. That fixes a
name that would otherwise drift when DHCP renames a laptop mid-session. A
drifted name is silent: fibers armed under one spelling are invisible to a
daemon calling itself the other. To give a host a friendlier name, edit that
file and restart the daemon. The file changes what *new* stamps say, not what
old ones already say, so also set `host:` on any already-armed fiber to the new
name.

**Every built-in agent assumes its CLI is installed.** The shipped records cover
the configured Claude, Codex, and Pi fleet, with `claude-opus` as the
default. A record whose CLI is absent or unauthenticated fails at dispatch, not
at install. Use `builtins: "restrict"` when a host should expose only the
subset it can run — see [Configuring agents](configuration.md#configuring-agents).

**Source builds compile all four artifacts on each host.** `make build` builds
both CLIs, the UI, and the daemon release; `make daemon` builds only the release.
Go, Elixir/OTP, Node/npm, and Python 3 must be available in the build shell.
Python 3 publishes the release symlink atomically.
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
the board loads with no fibers and no error. `shuttle daemon install` warns on stderr about either — the release root and
each `--stores` entry, under `--print` as well as a real install — and then
installs anyway, so the warning is the whole protection. Put both somewhere else: `~/dev/felt` for a checkout,
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

**A supervisor respawns the daemon after `make stop`.** Endpoint ownership identifies the process to stop; a linked worktree also checks its reported release path with `--within`.
`make restart` in the main checkout rebuilds, selects the canonical generation and cycles a supervisor-owned daemon. Use the supervisor directly
when you want its service state to be explicit:

```bash
launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon   # macOS
systemctl --user restart shuttle-daemon                 # Linux
```

`make restart` also works for a daemon started with `make start`; in either case,
the command waits for `/api/v1/version` after the replacement boots.

**`shuttle tunnels` needs a fleet file first.** It renders autossh jobs
from `~/.config/shuttle/remotes.json` — launchd plists on macOS, systemd user units
on Linux. With no remotes configured it has nothing to write, and `scripts/bootstrap.sh
--with-tunnels` does nothing useful. A Linux host with no systemd user session
cannot start a unit, so `install` says so and writes nothing; `--write-only`
renders the units for you to supervise yourself.

**The event stream stays empty until `~/.shuttle` exists.** `shuttle hook event`
refuses to create its own directory, so an install without daemon state records
nothing.
Degradation is graceful — the board still serves — but the activity ranking and
the sent-files trail stay empty. Both daemon installs create the directory:
`scripts/bootstrap.sh` for a checkout, and `install.sh` under `SHUTTLE_DAEMON=1` for a fetched
release (it writes `~/.shuttle/repo` there too). So a host with the daemon on it
is already enabled. The gap is a CLI-only install — no `SHUTTLE_DAEMON=1`, no checkout — where
nothing has made the directory yet: run `mkdir -p ~/.shuttle`
yourself. See [The event stream and the
ledgers](telemetry.md#recording-and-rotation).
