# felt + Shuttle — Contributor & Operator Notes

One repo, one checkout, three artifacts:

- **felt CLI** (Go) — the **data layer**. A directory-based markdown fiber
  tracker / agent memory, and the home of the `felt shuttle <verb>`
  subcommands. Built here.
- **Shuttle daemon** (Elixir/OTP Mix release, launched through the tracked
  `bin/shuttle` shim) — the **dispatcher**.
  Polls the felt tree, launches one tmux worker per eligible fiber, exposes a
  `:4000` snapshot/control API and owns a per-worker watcher.
- **the board UI** (TypeScript, `ui/`) — the **surface**. Five full-page views
  over the felt tree and the fleet's session/commit ledgers (Desk kanban, Day,
  Week, Chronicle, and the Board canvas of sent work), served by the daemon at
  `http://127.0.0.1:4000/`.

Felt owns the data model; Shuttle owns the network and the surface. The Elixir
daemon is the production dispatcher.

## felt CLI — the data layer

Markdown fiber tracker. Directory-based markdown fibers with YAML frontmatter,
plain markdown bodies, containment by path, and wikilinks for narrative
references. The markdown tree is the whole store — no derived state on disk.

### Data model

Fibers are minimal by default. All fields except `name` are optional.

| Field | Notes |
|-------|-------|
| id | Intrinsic ULID minted once at `felt add`. Preserved in frontmatter; surfaced as `uid` in JSON because JSON `id` remains the slug address. |
| name | Required. The fiber. |
| body | Markdown content. |
| outcome | The conclusion — decisions, answers, results. `-o` flag. |
| status | Opt-in tracking: open/active/closed. Most fibers don't have one. |
| tags | Freeform. Use for categorization (decision, spec, question, etc). |
| extra frontmatter | Any other top-level YAML keys. felt preserves them opaquely and surfaces them in JSON. |

**Identity.** The CLI addresses fibers by slug path (`felt show project/fiber`).
New fibers also carry a frontmatter ULID (`id:`) minted once at creation for
federation tools. JSON keeps slug at `id` for compatibility and exposes the
intrinsic value as `uid`.

**Status is opt-in.** `felt add <slug> "name"` creates a statusless fiber.
`felt add <slug> "name" -s open` enters tracking; `felt edit <id> -s active`
enters tracking. `felt ls` only shows tracked fibers.

**Relationships.** Containment is the directory tree. `[[wikilinks]]`
are narrative references. If a project uses `inputs.from` as a data-flow
convention, felt computes reverse consumers without claiming the rest of that
schema. Citations/consumers (for `felt show`) and body search (`felt ls --body`,
plain substring; `--body -r` for regex) are all computed from the markdown tree
on demand. The markdown *is* the store — there is no derived state on disk.

**Editing.** `felt edit` owns native metadata with dedicated flags: name,
status, tags, due, body, outcome. Non-native top-level scalars go through
`--set key=value` (YAML-typed, repeatable) and `--unset key`; felt refuses
native keys there and refuses to scalar-clobber an existing structured value.
*Writing* structured frontmatter (lists, nested maps) is still a direct file
edit — `--unset` will remove one.

**The `shuttle:` block is non-native frontmatter felt owns the *shape* of.**
Felt validates and stamps the `shuttle:` block (the `felt shuttle <verb>` Go
subcommands in `cmd/` + `internal/shuttle/`); the Elixir daemon reads it. This
is the merge end-state — the contract lives in one place (felt) rather than
being validated on both sides.

### felt command surface

```bash
# Core
felt init                         felt add <slug> <name> [flags]
felt edit <id> [flags]            felt show <id> [-d level]
felt ls [query]                   felt check
felt tree                         felt nest|unnest <id>
felt migrate [--dry-run]          felt rm <id>
felt session
felt backfill-ids [--dry-run]     # owner-only intrinsic id migration
felt setup claude|codex|skills    felt update
```

Progressive disclosure: `felt show <id> -d compact` shows metadata + outcome +
additional YAML field keys (levels: name, compact, summary, full). Targeted
views: `--body`, `--citations`, `--consumers`, `--field <key>`. Global `-j`/
`--json` on most commands.

### Agent integration + releasing

felt ships a single plugin (`claude-plugin/`) that serves both **Claude Code**
and **Codex**. The same hook scripts and skills directory work for either agent;
only the manifest at the plugin root differs (`.claude-plugin/` and
`.codex-plugin/` siblings, same content). A single marketplace manifest at
`.claude-plugin/marketplace.json` registers the plugin for both.

- `felt setup claude` registers the `cailmdaley/felt` marketplace and installs
  the plugin; `felt setup codex` symlinks skills and configures Codex hooks.
- The plugin bundles the `felt` and `shuttle` skills, a SessionStart hook (lists active +
  recently touched fibers), and a PreToolUse deny gate (`cmd/hook.go`).
  **Updating the binary updates hook behavior** — the plugin only needs
  refreshing when skill content changes.
- **Binary and plugin update in lockstep.** `felt update` swaps the binary then
  refreshes each integration; the Homebrew formula's `post_install` does the
  same on `brew upgrade felt`.

Release: `scripts/release.sh <version>` bumps `claude-plugin/.claude-plugin/
plugin.json` and `.codex-plugin/plugin.json` in sync with the binary tag, then
`git push origin main v<version>` triggers the goreleaser workflow (darwin/linux
× amd64/arm64; auto-pushes the Homebrew formula). A `before`-hook guard refuses
to build a release whose manifests don't match the tag, so a forgotten bump
can't ship.

Release candidates: `scripts/release.sh 1.1.0-rc.1` — any `X.Y.Z-<suffix>`
version cuts a prerelease. Three things then keep it away from everyone who
didn't ask for it, and all three key off the `-` in the tag: goreleaser marks
the GitHub release `prerelease: auto`; `install.sh` and `felt update` resolve
through the `releases/latest` API, which skips prereleases; and the Homebrew
tap's `skip_upload` is true for any prerelease, so `brew upgrade felt` never
sees it. The only way in is pinning `FELT_VERSION` (below). The daemon tarballs
attach to the RC release the same way, stamped with the RC version.

## Architecture stance

- **One CLI surface.** Every caller speaks `felt shuttle <verb>`.
- **One repo, one checkout, three artifacts.** felt and Shuttle live in one
  source tree, building the felt CLI, the daemon release, and the board UI from
  it. Shuttle is self-contained, with its own browser UI and launch story,
  assuming no external dispatcher process.
- **The `shuttle:` block is in felt's surface.** The contract lives once, in
  felt's Go code, and the Elixir daemon reads it. Continuation state
  (`session_uuid` / `dispatched_at` / `handed_off_at`) lives entirely in the
  `shuttle:` block.
- **felt owns the data model; Shuttle owns the network and the surface** — the
  two are one package, not two that shell to each other.

**The Elixir/OTP daemon is the production dispatcher.** Dispatch, the
per-worker watcher, and the `:4000` API are where OTP earns its keep. A Go
rewrite collapsing everything into a single binary is a deferred, must-earn-
itself idea, not planned now.

**Continuity across dispatches lives in frontmatter and git, not an event log.**
The daemon detects clean worker exits via the `shuttle.runtime.handed_off_at`
frontmatter field. The editorial chain lives in the constitution body's
`## Status` block plus the git log of the fiber.

## Build + lifecycle

### Platform story

**Linux and macOS are both supported for single-host use.** One host runs the
daemon, the board, and its workers on either OS. The keep-alive differs — a
launchd LaunchAgent on macOS, a systemd user unit on Linux (`make
install-agent` picks the branch from `uname -s`) — and so does the log path,
but the daemon, the CLI, and the bundle are the same artifacts.

**Either platform can be the fleet's hub.** `felt shuttle tunnels install`
writes the hub's autossh jobs as launchd LaunchAgents on macOS and systemd
`--user` units on Linux, picking the branch the way `make install-agent` does.
A Linux host with no systemd user session (an HPC login node usually has none)
gets a refusal naming `--write-only`, not units nothing would start. Either way
the tunnel is installed on the hub, not on the remote. One asymmetry remains:
the daemon's recovery cascade bounces a stalled tunnel with `launchctl
kickstart`, so on a Linux hub a quiet remote skips the bounce and advances to
the cascade's ssh check.

**`kitty` attach is terminal lock-in, not platform lock-in.** Attach opens the
worker's tmux session in kitty via kitty's remote-control CLI, and kitty runs on
Linux. What is mac-specific is only the `osascript` call that raises the kitty
window, and that is already a no-op off macOS (`activate/1` in
`lib/shuttle/kitty.ex`). A non-kitty user gets nothing on either OS; `felt
shuttle attach <fiber>` always works.

Windows is unsupported.

### What builds what

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
out.** A worker (including the Shuttle session reading this) runs in its own tmux
session; the daemon only *watches* it (tmux owns the worker process — see
"Deploying is ALWAYS safe" below). Bouncing the daemon cycles the watcher and
rebinds `:4000`; every `<leaf>-<uid>-shuttle` tmux session keeps running untouched and is
re-adopted on boot. So an in-session worker can deploy its own fix and restart the
daemon freely — never hold a restart because "there's a live session."

**Restarting a launchd-managed daemon needs `launchctl`, not `make restart`.**
After `make install-agent`, the daemon runs under launchd (`io.shuttle.daemon`)
with an *absolute* `bin/shuttle` path. `make stop`'s `PIDPATTERN` only matches a
relative-path shell launch, so against the launchd daemon `make restart` rebuilds
the release but its stop/start no-ops (start then hits "already running"). Bounce
it with **`launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon`** — KeepAlive
respawns the rebuilt release. (`make restart` is right only when the daemon was
shell-started via `make start`.)

### Two install paths

- **(a) Public end-user CLI (and, opt-in, daemon) install** — downloads release
  artifacts, no Elixir/Erlang/Node toolchain required:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | SHUTTLE=1 sh
  ```

  `FELT_VERSION` pins an exact tag (with or without the leading `v`) and skips
  the `releases/latest` lookup — the only supported way to install a release
  candidate, for both the CLI and the `SHUTTLE=1` daemon:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | FELT_VERSION=1.1.0-rc.1 SHUTTLE=1 sh
  ```

  Note where the variables sit: **after** the pipe, on `sh`. `VAR=1 curl … | sh`
  puts them in `curl`'s environment, not the script's, so they are silently
  ignored — and a pinned install that silently ignores `FELT_VERSION` hands the
  tester the latest stable instead of the RC.

  This is `install.sh`; installs the felt CLI to `/usr/local/bin` if writable,
  else `~/.local/bin`; override with `FELT_INSTALL_DIR`. Also Homebrew
  (`brew install cailmdaley/tap/felt`) or `go install github.com/cailmdaley/felt@latest`.
  `SHUTTLE=1` additionally fetches the ERTS-bundled daemon release tarball
  (`shuttle_<Os>_<arch>.tar.gz`, same GitHub release) to `$SHUTTLE_HOME`
  (default `~/.local/share/shuttle`); its front door is
  `$SHUTTLE_HOME/bin/shuttle`. Runtime prerequisites for this path: tmux and
  felt — no Erlang, Elixir, or Node.

- **(b) Dev / multi-host from-source bootstrap** — stands up the **entire** local
  surface:

  ```bash
  ./bootstrap.sh            # full bootstrap for this host
  ./bootstrap.sh --dry-run  # check prerequisites + print the plan, change nothing
  make install              # same, via the Makefile (flags: make install ARGS="--dry-run")
  ```

  Builds+installs the felt CLI, builds the daemon release, places `ui/dist`,
  registers the plugin event hook (`felt hook event`) and probes it, installs
  the keep-alive (launchd LaunchAgent on macOS / a systemd user unit on Linux,
  falling back to the `shuttle-daemon` tmux respawn loop where there is no
  systemd user session).
  `go` is a bootstrap prerequisite. Flags include `--skip-ui` / `--build-ui` (UI
  defaults to build on macOS, skip on Linux), `--skip-hook`, `--with-tunnels`
  (also installs the hub's SSH tunnels). bootstrap.sh branches by host
  type and is honest about missing prerequisites.

### Where the checkout lives — outside `~/Documents` on macOS

Put the checkout anywhere you like, with one macOS constraint: it must live
**outside `~/Documents`** (and `~/Desktop` / `~/Downloads`) — see the
launchd/TCC rationale below. Linux hosts are unconstrained. Using the same path
on every host you run a daemon on keeps the deploy commands uniform.

### Durable launch — `make install-agent`

`make start` is a bare `nohup` with no supervisor: it won't restart on crash or
relaunch at login. `make install-agent` installs the real supervisor, branching
on `uname -s`: launchd on macOS, a systemd user unit on Linux. Both templates
live in `share/` and bake in the same three environment values (`PATH`,
`FELT_STORES`, `SSH_AUTH_SOCK`) for the same reason — neither supervisor gives
the daemon your login environment.

#### macOS — the LaunchAgent

Shuttle's macOS durable surface is a **launchd LaunchAgent**
(`share/io.shuttle.daemon.plist.template` → `~/Library/LaunchAgents/io.shuttle.daemon.plist`),
installed by `make install-agent`: `KeepAlive` restarts the daemon on crash,
`RunAtLoad` starts it at login. Independent of any other process.

**Run it from outside `~/Documents` — this is load-bearing.** macOS TCC blocks
launchd-spawned processes from `~/Documents`, `~/Desktop`, and `~/Downloads`, and
**Full Disk Access does not inherit** the way it does under Terminal (a terminal
app *takes responsibility* for its children, so everything you launch from a
shell shares the terminal's grant; launchd has no such umbrella, and FDA doesn't
even cross an `exec` to a differently-signed binary). So a launchd daemon whose
release/`ui/dist`/felt stores sit under `~/Documents` either crash-loops
(`getcwd: Operation not permitted`, the release's boot script failing to open a
file) or silently fails to walk stores — and the fix would be granting FDA to
*each* binary in the tree (`beam.smp`, `felt`, …), which is fragile (the erlang
path is version-pinned) and exactly the per-binary grind to avoid.

The clean setup:

- **The repo lives outside Documents.** The release and `ui/dist` are then
  readable by launchd with no grant.
- **`AGENT_FELT_STORES` scopes felt polling** (a Makefile variable, baked into
  the plist as `FELT_STORES`). Point it at an aggregate store outside the
  protected folders: felt re-discovers each project's substores by following
  symlinks under `<store>/.felt/`
  (`FeltStores.expand_with_symlinked_substores`), so configuring the aggregate
  alone is enough when those symlinks point to readable project roots.
  **Caveat:** a substore whose real root sits under a protected folder is
  discovered but may be unreadable to the launchd daemon until that project root
  also moves out of Documents.
- **`PATH` is captured from a login shell at install time** (`AGENT_PATH` in the
  Makefile, baked into the plist). launchd's own env is too bare to find `felt`
  (`~/.local/bin`) at runtime — the release itself needs nothing off PATH to
  boot (it bundles its own ERTS), but the daemon shells `felt` for its writes
  — and a login shell *at runtime* (`bash -lc`) does NOT fix it, because under
  launchd's bare env the profile doesn't reconstruct PATH (exit 127, `felt`
  unfound). That specifically yields `:enoent` → **500 on
  `/api/v1/fibers/composite`** (the kanban load), with the board fine otherwise.
  Capturing the real login PATH once, at install, is deterministic and needs no
  hand-maintained list.

Result: `make install-agent` from a checkout outside Documents → daemon binds
`:4000`, KeepAlive + RunAtLoad, **zero Full Disk Access grants**, survives erlang
upgrades.

#### Linux — the systemd user unit

`share/io.shuttle.daemon.service.template` →
`~/.config/systemd/user/shuttle-daemon.service`, rendered and enabled by the
same `make install-agent`. `Restart=always` + `RestartSec=10` are the KeepAlive
/ ThrottleInterval analogs; `WantedBy=default.target` starts it at login. It is
a *user* unit — the daemon runs as you, reads your stores, wants no root. **Run
`loginctl enable-linger <user>` so the user manager (and the daemon) survives
logout and starts at boot** — the install prints this; it is the one manual
step, because lingering needs privileges the install doesn't assume. There is
no TCC on Linux, so the checkout may live anywhere.

`make install-agent` retires the tmux respawn loop first, since both would bind
`:4000`.

**Where there is no systemd user session** — a typical HPC login node, a
container — `make install-agent` says so and refuses, and the durable surface
stays `bin/shuttle-launch`: a tracked respawn script that `bootstrap.sh`
installs to `~/.local/bin` and runs in tmux session `shuttle-daemon`, backing
off exponentially on fast daemon exits (2s→300s). `bootstrap.sh` picks between
the two automatically, and installs `shuttle-launch` either way because remote
revival (`remote_registry.ex` over SSH) invokes it.

`make install-agent` warns if `$PWD` is under a protected folder. There *is* an
escape hatch — granting FDA to each I/O binary in the tree (`…/erlang/<v>/…/beam.smp`,
re-granted after every erlang upgrade, plus `~/.local/bin/felt`) — but it's
fragile and per-binary; relocating out of Documents is the supported fix.

### Owning the event stream — `felt hook event`

Shuttle derives per-session activity (`WaitingTracker`) and the sent-files trail
(`SentFiles`) from its OWN agent hook-event stream. `felt hook event`
(`cmd/hook_event.go`) appends one JSON line per hook event to
`$SHUTTLE_EVENTS_FILE` (default `~/.shuttle/events.jsonl`, dir
`$SHUTTLE_DATA_DIR`). The readers read ONLY this path, and
`cmd/shuttle_events.go` mirrors `WaitingTracker.default_events_file/0` so the
writer and the readers cannot drift.

**The writer is the binary; the plugin registers it.**
`claude-plugin/hooks/event.sh` is a one-line shim (`exec felt hook event`), wired
in `claude-plugin/hooks/hooks.json` on SessionStart, UserPromptSubmit,
PreToolUse, Stop, SubagentStop, Notification, and SessionEnd. `.codex-plugin`
points at the same file, so Codex sessions feed the stream too. Install with
`felt setup claude` / `felt setup codex`; `bootstrap.sh` step 5 does both and
then probes the writer. No `jq`, `perl`, or `hostname` — the whole line is built
in Go, which is what makes it work on a bare remote login node.

**Writing is gated on `~/.shuttle` already existing** — the daemon's state
directory is the opt-in, and the hook never creates it, so a felt-only install
grows no stream. `SHUTTLE_EVENTS_FILE` overrides the gate (and creates its
parent); `SHUTTLE_EVENTS=off` disables recording. The live file rotates to
`.jsonl.1` past `SHUTTLE_EVENTS_MAX_BYTES` (64 MiB), and a `toolInput` over
8 KiB is trimmed to its file paths plus `truncated: true` — otherwise every
`Write` parks a whole file body in the stream.

`cmd/testdata/events_golden.jsonl` is the cross-language contract: written
byte-for-byte by `cmd/hook_event_test.go`, parsed by both Elixir readers in
`test/shuttle/events_parity_test.exs`. Each host's daemon tails its own host's
`~/.shuttle/events.jsonl`.

### The two ledgers — `sessions.jsonl` and `commits.jsonl`

Beside the event stream sit two append-only ledgers, both read by the temporal
views as **join rung 0** — the structural pairing that replaces an inference.

- `~/.shuttle/sessions.jsonl` (`lib/shuttle/session_ledger.ex`) pairs a fiber
  with the harness session dispatched against it. **The daemon writes it**, at
  dispatch / claim / resume.
- `~/.shuttle/commits.jsonl` (`lib/shuttle/commit_ledger.ex`) pairs a commit
  with the session that made it: one line per commit carrying `sha`, `subject`,
  `repo`, the `--shortstat` counts, and `session` / `tmux` / `cwd`. It replaces
  parsing a fiber name out of a commit subject. **The hook writes it** —
  `~/loom/hooks/shuttle-hook.sh` on `PostToolUse` for a Bash call that ran a
  `git commit` — because the pairing is only knowable inside the session's own
  process tree. The daemon is a reader only. Coverage is therefore partial:
  commits made before the hook, outside a session, or on a host whose events
  come from the `felt hook event` writer instead are absent — and there is **no
  fallback**. Only recorded, joined commits are ever drawn, so a day before the
  hook has no prose rather than a guessed one. Note too that the writer ships
  outside this repo, so a public adopter's commit ledger stays empty until they
  write their own.

Both are served host-scoped (`/api/v1/sessions`, `/api/v1/commits`) with a
cross-host `/composite` sibling fed by `Shuttle.RemoteTemporalRegistry`.

**Remote hosts are configured in `~/.config/felt/remotes.json`** (`felt shuttle
remotes list|add|rm|path`). Each entry names an ssh alias and a local forwarded
port; the daemon reaches a remote's API over that tunnel. How a given host
authenticates is your ssh config's business — but note that an ssh alias needing
a live credential (a short-lived certificate, a 2FA-backed ControlMaster) fails
*instantly* with `Permission denied` once that credential lapses, and the
symptom looks like a dead host: the kanban **Attach** button opens a terminal
that flashes and dies. Refresh the credential before concluding Shuttle is
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
worker process, Shuttle only owns the watcher** (the load-bearing invariant
below). A restart cycles the watcher and rebinds the API; the `<leaf>-<uid>-shuttle`
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
host. A release bundles its own ERTS, so a tarball built for the same OS/arch
*would* run elsewhere — but a checkout host still builds on-host via
`make daemon`, both because that's the fleet's normal deploy path and because
BEAM bytecode format varies across OTP versions, so a release built under a
different OTP than the one on the target host will crash on startup. The
respawn loop is driven by `~/.local/bin/shuttle-launch` — a
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

**A supervised daemon is not yours to cycle with `make stop`/`make all`.** Under
systemd, use `systemctl --user restart shuttle-daemon`. Where `shuttle-launch
--loop` runs in tmux session `shuttle-daemon` instead,
that loop owns the live daemon. `make stop`/`make all` target the
pidfile that `make start` writes, which is *not* the respawn-spawned daemon, so
they can build a fresh release yet leave the old one serving `:4000`. To
actually cycle to the new release, **kill the `:4000` listener directly**
(`lsof -ti:4000 -sTCP:LISTEN | xargs kill`) — the respawn loop restarts it from
the rebuilt release. Confirm `git_short_sha` flipped; if not, the old process is
still bound. **A host with large felt stores can take minutes to start** — it
walks every store and adopts orphan sessions before binding `:4000`; wait it
out, don't assume a crash.

**`RemoteRegistry`'s circuit breaker — a remote gets 3 failed revive cascades,
then a human.** Each configured remote is driven by a recovery state machine;
after `trip_threshold` (default 3) consecutive failed revive cascades it trips
and stops taking recovery action — the RemoteRegistry keeps passively polling
the remote's health at a decimated cadence (an unhealthy remote is polled far
less often than a healthy one) but will not itself re-attempt revival. The
breaker auto-heals on a successful probe (no human step needed when the remote
just comes back). To force one more cascade before that: `bin/shuttle reset
<remote>` or `POST /api/v1/remotes/:name/reset` — one reset buys exactly one
cascade, and it 409s if the breaker isn't currently tripped.

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
`make cli-install`); editing the UI needs `cd ui && npm test` (CI never runs it)
plus `npm run build` + rsync.

**`bin/rel` is a Mix release** — an ERTS-bundled directory built by
`MIX_ENV=prod mix release shuttled --overwrite --path bin/rel`, launched via
`bin/rel/bin/shuttled`. A restart without `make daemon` is a no-op for picking
up source edits. `make restart` always.

**The release loads modules lazily, and that keeps one escript-era hazard
alive.** Mix releases run in `:interactive` code-loading mode (verified:
`bin/rel/bin/shuttled eval 'IO.inspect(:code.get_mode())'` → `:interactive`;
nothing in `vm.args` sets `-mode embedded`). So modules load from
`bin/rel/lib/*/ebin` on first reference, exactly as the escript loaded them
from its own file — and rebuilding under a running daemon can still let a
not-yet-referenced module (`Shuttle.BuildInfo`) load from the NEW build while
the long-booted Poller keeps running the OLD code. That is why deploy
verification checks `booted_at` as well as `git_short_sha`: a sha alone can be
told by a stale daemon, a boot time cannot. `bin/shuttle` itself is a tracked POSIX shell shim, not a build
artifact — it execs the release launcher for `start` and speaks HTTP to the
running daemon for the read verbs (snapshot, status, dispatch, release, reset,
version).

If `mix release` warns about a stale build shadowing a fresh one, run
`make clean` first — stray `.beam` files at the project root shadow the real
ones. They should never be committed.

## Quick start — operating without rebuilding

```bash
bin/shuttle snapshot                          # JSON snapshot of daemon state
bin/shuttle dispatch <fiber-id>               # one-shot dispatch
bin/shuttle release                           # release the boot quarantine (parked launches dispatch next tick)
bin/shuttle reset <remote>                    # reset a tripped remote circuit breaker (revive cascade resumes)

# felt shuttle — agent-facing CLI; offline; schema-validating
felt shuttle status                            # all fibers with shuttle: blocks
felt shuttle status --all                      # local + every configured remote
felt shuttle status --remote <name>            # single remote
felt shuttle ps                                # live tmux workers only
felt shuttle install <fiber> --project-dir "$PWD" [-m <agent-id>] [--disabled]
felt shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"
felt shuttle pin <fiber> --project-dir "$PWD"    # pinned, schedule-less perennial role
felt shuttle reshape <fiber> [kind] [-s <schedule>] [-z <tz>]  # change an existing block's kind/schedule in place
felt shuttle pause <fiber>                       # park in drafts + kill live worker; --no-kill preserves it
felt shuttle resume / accept / reopen <fiber>
felt shuttle set-agent <fiber> <agent-id> [--effort E] [--chrome]
felt shuttle dispatch <fiber>
felt shuttle handoff <fiber>                     # worker's clean-exit ritual: stamp
                                                #   shuttle.runtime.handed_off_at (→ next
                                                #   is fresh) + end own tmux session. The
                                                #   single final action; folds in kill $PPID.
felt shuttle snapshot
felt shuttle abort / attach <fiber>
felt shuttle validate-identity                # UID migration/cross-city validation
```

## Critical invariants

- **tmux owns the worker process; Shuttle owns the watcher.** Workers stay
  attachable via `felt shuttle attach <fiber>`. Supervise watchers,
  not workers.
- **Felt is the data layer; the daemon shells out to the felt CLI.** Don't
  import felt internals into the daemon.
- **Remote content comes from the owning daemon over the tunnel — NEVER from
  git sync.** A fiber is owned by exactly one host; only that host's daemon can
  read its body, files, and assets off its own filesystem. Every cross-host
  READ (`/api/v1/fibers/:id?body=true`, `/file`, `/astra`) and every cross-host
  WRITE is **owner-routed via `Shuttle.OriginRouter`**: the composite board
  stamps each fiber's `origin`, the client carries it back, and the local daemon
  forwards to the owner's identical endpoint over the SSH LocalForward each
  remote declares in `~/.config/felt/remotes.json` (`:4000` is local; remotes
  take `:4001`, `:4002`, …). A git mirror that happens to replicate a remote
  fiber's files locally is **incidental and must never be relied on** — if any
  feature works only because a file happened to git-sync, that is a bug. The
  symptom when this invariant is violated: a remote card shows its outcome (it
  rides the composite feed) but the body reads empty / "not in the local
  mirror", because the read was attempted locally instead of being owner-routed.
  New endpoints that surface a fiber's host-local content MUST route through
  `OriginRouter`, not assume the bytes are reachable on this host.
- **Agent records live in one source of truth: felt's registry.** Felt resolves
  the registry as two layers — `internal/shuttle/agents.builtin.json` (embedded)
  with the user file (`$FELT_AGENTS_FILE`, else `~/.config/felt/agents.json`)
  merged over it by default. The user file can set `builtins: "restrict"` to
  replace the shipped layer for one host. `felt shuttle agents init` seeds that
  file from the built-ins — a worked example of every field, ready to edit for
  local additions or overrides. There
  is no reserved `human` agent; a
  malformed user file fails loud with its path, a missing one is silent. The
  daemon reads the already-resolved record off felt's
  `shuttle.resolved.agent` JSON and shells `felt shuttle agents [resolve]` for
  the registry / no-fiber cases. There is no daemon-embedded `share/agents.json`
  and no `config/agents.exs`.
- **Remote daemons live in `~/.config/felt/remotes.json`.** The Go CLI
  (`cmd/shuttle_remotes.go`) and the daemon (`lib/shuttle/remotes.ex`) read the
  same file at runtime, so nothing about your hosts is baked at build time.
  `felt shuttle remotes list|add|rm|path` manages it, and `list` doubles as the
  validator. `test/fixtures/remotes/` enforces Go/Elixir parity, and
  `cmd/hygiene_test.go` fails the build on a personal hostname in `config/`,
  `lib/`, `cmd/`, or `share/`.
- **`shuttle.agent` field drives agent selection.** The `shuttle:` block's
  `agent:` field resolves against the registry. Default agent is
  `claude-sonnet`.
- **`shuttle.host` field drives daemon affinity — strictly.** A daemon
  dispatches a block iff `block.host == own_host_id` (its `SHUTTLE_HOST` or
  `:inet.gethostname()`). There is no `"local"` default and no `nil`
  wildcard: an absent or empty `host:` is unowned and ineligible on *every*
  daemon. `felt shuttle install`/`repeat` stamp `host` by default so blocks
  are born owned. The same predicate gates the orphan-resurrection path, so
  a remote restart can't re-grab another host's fiber.
- **`shuttle.project_dir` is required for armed installs.** `felt shuttle
  install` and `repeat` require `--project-dir`; workers start there instead
  of falling back to the felt store.
- **felt shuttle is the agent-facing CLI.** Local write verbs validate before
  write and work offline. `bin/shuttle` handles daemon lifecycle and dispatch.
- **No tag predicate for dispatch — two gates, both explicit.** A fiber is
  shuttle-managed iff it carries a `shuttle:` block. It dispatches iff (1) its
  felt `status` is `active` AND (2) the boot quarantine is released: every
  daemon (re)start parks EVERY dispatchable candidate — fresh launches and
  dirty-death resumes alike — in `pending_launch` until `bin/shuttle release`.
  There is no `enabled` flag; steady-state resume of a worker that dies while
  the daemon is healthy and unquarantined is unaffected, and force-dispatch
  bypasses the quarantine. Tags are free-form qualitative noticings.

## How dispatch works

- **Poller** (`lib/shuttle/poller.ex`) owns the tick. It walks each
  configured felt store, pulls candidate metadata via `felt ls --json` and
  per-fiber detail via `felt show -j`, and considers a fiber eligible iff
  it carries a `shuttle:` block owned by this host (`shuttle.host` matches),
  its `project_dir` exists here, felt `status` is `active`, and it isn't
  already running/claimed (see `eligible?/2` in poller.ex).
- **Configured stores** come from `FELT_STORES` (comma-separated env var) →
  persisted `~/.config/felt/stores.json`. There is no implicit default store
  and no legacy Shuttle-named registry authority. `POST
  /api/v1/felt-stores` rewrites the persisted file.
- **Dispatcher** (`lib/shuttle/dispatcher.ex`) resolves the agent, spawns
  the `<leaf>-<uid>-shuttle` tmux session.
- **Standing roles** — `shuttle.kind: standing` with a cron `schedule:`.
  Scheduled runs dispatch only when `next_due_at` is due AND `review.state`
  is `scheduled` or `accepted`. Manual dispatch is ad-hoc (`adhoc-...`
  run id) and preserves `next_due_at`; worker exit flips state to
  `awaiting`, and `felt shuttle accept` advances `next_due_at` only for
  scheduled runs.

## Dispatch prompt structure

All prompt variants share this shape (`compose_prompt/3` in dispatcher.ex):

1. **Orientation paragraph** — what Shuttle is, what the worker is here to
   do, how the practice loads. Per-prompt, not boilerplate. Goes first
   because in causal attention every downstream token sees the prefix.
2. **`Fiber: <id>`** (and `Run: <run-id>` for standing) — identity lines.
   Fresh dispatches also carry **`Previous session: <uuid> (<harness>)`**
   when the fiber has one — the predecessor's transcript pointer, read from
   the session ledger (`SessionLedger.latest_for_uid/2`, fallback: the
   runtime marker) *before* this dispatch stamps its own. Resume prompts
   never carry it (the resumed worker IS the previous session); the shuttle
   skill's `references/transcripts.md` carries the read recipes.
3. **`Felt store: <path>`** — the worker's absolute anchor. When
   `prompt_fiber_id`'s work_dir-local translation safe-fails, the id above
   is global and doesn't resolve from cwd; the store line makes the
   fallback mechanical (`felt -C <felt-store> show <id>`).
4. **`Exit Contract`** block — always present; one uniform contract for
   oneshot + standing (rewrite `## Status`, then `felt shuttle handoff`),
   three-case for pinned roles (stay alive while the human drives; handoff
   relaunches a fresh worker for autonomous arcs; close → awaiting review).
   A `Headless` block follows for print-mode agents (no human can attach).
5. **`From User`** — the user's directive, when one rides this dispatch. It
   is the `user_message` dispatch *parameter* (inlined into the prompt at
   launch and discarded), not a persisted felt event. The directive arrives
   *with* the dispatch.

The fiber's outcome and handoff prose are not inlined — they're already in
scope after `felt show <id>`, which renders the body's `## Status` block (the
worker's last-writer-wins handoff) along with the rest of the constitution. The
shuttle skill prescribes the worker reads it on arrival.

## Inspecting state

```bash
felt shuttle status                      # offline walker view (independent of daemon)
bin/shuttle snapshot                     # raw JSON snapshot
make status                              # daemon-side view (ps + snapshot)
make logs                                # daemon stdout/stderr — ~/Library/Logs/shuttle.log
                                         # (macOS) / ~/.shuttle/shuttle.log (Linux)
tmux ls | grep '^shuttle-'               # live workers
curl -s http://127.0.0.1:4000/api/v1/agents | jq
curl -s http://127.0.0.1:4000/api/v1/state | jq
curl -s http://127.0.0.1:4000/api/v1/state/composite | jq
felt shuttle validate-identity                # checks :4000/:4001/:4002/:4003 by default
```

Dispatch sanity ladder:

1. `felt shuttle status` shows the fiber with `KIND oneshot` and an
   active/idle state? → fiber is well-formed and the offline walker sees it.
2. `bin/shuttle snapshot` lists it under `eligible[]`? → daemon dispatched.
3. Fiber is `active` but sitting in `pending_launch`? → the daemon restarted
   and the boot quarantine is armed. `bin/shuttle release`. Check this before
   reaching for `make restart` — a restart *re-arms* the quarantine.
4. `felt shuttle` sees it but daemon doesn't → daemon binary is stale.
   `make restart` (then `bin/shuttle release`).
5. Daemon sees it but agent never appears → check the resolved agent's `cli`
   (`felt shuttle agents`) and that the wrapper is on `PATH`.

**"The terminal opens and closes instantly", or the card never moves and no
session exists.** The daemon preflights the resolved agent's wrapper before it
spawns anything: it probes `bash -lc 'type -t <wrapper>'`, because the run
script itself executes under `bash -l`. A wrapper that resolves to nothing
there — never installed, or a shell function your *zsh/fish* config defines and
your bash login profile does not — aborts the dispatch instead of spawning a
session that dies in under a second. The refusal names the wrapper and the fix
in the daemon log, in the snapshot's `blocked` row (so the board shows it), and
in the dispatch API's 422. A wrapper that exists only as a shell **alias** is
refused too — a non-interactive login bash does not expand aliases, so define it
as a function or an executable on `PATH`. (Which message you get for an alias
depends on your bash: 5.x reports `alias` and you get the alias-specific text;
3.2, still the system bash on macOS, exits non-zero instead and you get the
generic "did not resolve" text. Both refuse the dispatch.)

The same preflight refuses a fiber whose `project_dir` is not a directory on
this host — a checkout that lives on another machine. The autonomous path
already skipped those; this catches the force-dispatch path (Requeue,
drag-to-launch), which bypasses eligibility. After either refusal the daemon
parks that fiber for 5 minutes rather than re-probing a login shell every tick;
a force-dispatch skips the wait.

**Kanban stuck on "Loading…" / `/api/v1/state` returns
`{"error":"poller_unavailable", ..., "{:timeout, {GenServer, :call, [Shuttle.Poller, …, 1500]}}"}`
right after a fresh daemon start.** The poller serves its *last* snapshot, but on
a cold boot there is none yet, so the snapshot call starves behind the first full
walk until it completes — and the **first tick on a fresh machine is cold**: empty
OS file cache and every configured store walked back-to-back. Observed once at
**~106s** (`Sent 200 in 106275ms` in `shuttle.log`). It is a one-time tax: once
warm, all stores poll in well under a second and the board loads. If this
becomes recurring, inspect the canonical registry at
`~/.config/felt/stores.json`: a store path with **no `.felt/` dir** ("not in a
felt repository") errors every tick and should be dropped. Remote timeouts
(`ssh_check_failed`, `:4001 econnrefused`) are separate noise.

## Codebase layout

```
felt/
├── AGENTS.md                canonical contributor & operator guide (this file)
├── CLAUDE.md                compatibility pointer to AGENTS.md
├── CONTRIBUTING.md          contribution guide
├── README.md               public front door (CLI-first)
├── LICENSE / LICENSE-APACHE / NOTICE   MIT + daemon's Apache-derived split
├── Makefile                 build (cli/daemon/build) + daemon lifecycle
├── bootstrap.sh             full from-source bootstrap (make install)
├── install.sh               public release-binary installer (curl | sh)
│
│   # felt CLI — Go (the data layer)
├── main.go  go.mod  go.sum
├── cmd/                     cobra commands; `felt shuttle <verb>` = cmd/shuttle*.go
├── internal/felt/           core felt logic (storage, parsing, graph, search)
├── internal/shuttle/        shuttle: block schema + agent registry (agents.builtin.json + user layer)
├── claude-plugin/           plugin payload for Claude Code + Codex
├── scripts/release.sh       bumps plugin manifests + commits + tags
│
│   # Shuttle daemon — Elixir/OTP (the dispatcher)
├── mix.exs  mix.lock
├── bin/shuttle              tracked shell shim, the daemon's front door
├── bin/rel/                 the built daemon release (bin/rel/bin/shuttled), gitignored
├── lib/                     Elixir source
│   ├── shuttle/poller.ex      discover + eligibility + retry queue
│   ├── shuttle/dispatcher.ex  agent resolution, tmux launch
│   └── shuttle_web/           agent-API HTTP endpoints (/api/v1/...)
├── config/                  Elixir env config (dev/test/prod endpoint settings)
├── priv/                    daemon assets (e.g. mystra/bake.mjs)
├── share/                   keep-alive templates (launchd plist, systemd unit)
├── test/                    Mix test suite
│
│   # the board UI — TypeScript
└── ui/                      the board UI; `npm run build` → ui/dist (served by :4000)
    ├── src/board/views/     the four registered views (day · week · chronicle · shelf) + ViewRegistry contract
    └── harness/             offline visual-verification harness — `npm run harness`
                             (detail panel) / `npm run harness:board` (board chrome +
                             temporal views) build self-contained bundles into
                             ui/harness-dist/ and ui/harness-board-dist/, openable
                             over `file://`. They mount the REAL components against a
                             mocked daemon, which is the only way to look at the board
                             from a sandbox: the live :4000 is unreachable there.
```

`deps/` and `_build/` are Mix-managed and gitignored.

## Tests

```bash
make test                  # go test ./... + mix test + the board suite + the plugin hooks
go test ./...              # Go (felt CLI)
mix test                   # full Elixir suite
mix test --only focus      # tagged subset
cd ui && npm test          # the board suite; runs vitest TWICE, under two
                           # pinned TZs (America/Los_Angeles, Europe/Paris)
bash scripts/test-plugin-hooks.sh  # the shell hook shims, HOME and PATH sandboxed

# Opt-in real harness smoke. Opens real Claude/Codex/Pi CLIs in tmux,
# sends no prompt, captures the idle pane, then kills the smoke sessions.
SHUTTLE_REAL_HARNESS_SMOKE=1 mix test --only integration test/shuttle/real_harness_smoke_test.exs
```

**The board suite runs twice on purpose, and CI does not run it at all.** The
second pinned offset is where the civil-day logic breaks, so a hand-run `npx
vitest run` can go green on a change `make test` would fail. CI type-checks and
builds the bundle (`npm run build`) but never invokes vitest — `cd ui && npm
test` is a local-only gate, which makes it the easiest one to skip and the one
worth not skipping.

The real harness smoke is deliberately outside ordinary `mix test`. It uses
tmux session names like `shuttle-harness-smoke-<harness>-<unique>`, records
captures under `_build/test/shuttle_harness_smoke/`, and skips harnesses that
are not available in `bash -l`.

## License

The repo is **MIT** (the felt CLI + UI). The Shuttle
daemon (`lib/`) contains code derived from OpenAI's Symphony under the **Apache
License 2.0**, preserved in `NOTICE` and `LICENSE-APACHE`.

## Contributing

See `CONTRIBUTING.md`.
