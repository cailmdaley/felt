# felt + Shuttle — Contributor & Operator Notes

One repo, one checkout, three artifacts:

- **felt CLI** (Go) — the **data layer**. A directory-based markdown fiber
  tracker / agent memory, and the home of the `felt shuttle <verb>`
  subcommands. Built here.
- **Shuttle daemon** (Elixir/OTP escript → `bin/shuttle`) — the **dispatcher**.
  Polls the felt tree, launches one tmux worker per eligible fiber, exposes a
  `:4000` snapshot/control API and owns a per-worker watcher.
- **the board UI** (TypeScript, `ui/`) — the **surface**. A kanban board over
  the felt tree, served by the daemon at `http://127.0.0.1:4000/`.

Felt owns the data model; Shuttle owns the network and the surface. The Elixir
daemon is the production dispatcher.

## felt CLI — the data layer

Markdown fiber tracker. Directory-based markdown fibers with YAML frontmatter,
plain markdown bodies, containment by path, wikilinks for narrative references,
and a rebuildable SQLite cache at `.felt/index.db`.

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

**Relationships and index.** Containment is the directory tree. `[[wikilinks]]`
are narrative references. If a project uses `inputs.from` as a data-flow
convention, felt indexes reverse consumers without claiming the rest of that
schema. The SQLite cache indexes links, tags, additional YAML field text, and
FTS5 body text; `felt show` uses it for citations/consumers and `felt ls --body`
uses it for fast body search. The cache is strictly a rebuildable index — plain
markdown is the source of truth.

**Editing.** `felt edit` owns native metadata only: name, status, tags, due,
body, outcome. For non-native frontmatter, read then edit the markdown file
directly.

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
felt index sync                   felt session
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
- The plugin bundles the `felt` skill, a SessionStart hook (lists active +
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

## Direction — the merge is done; OTP daemon deliberately kept

The merge that earlier notes framed as a goal is the achieved state:

- **One CLI surface.** Every caller speaks `felt shuttle <verb>`; the standalone
  `shuttle-ctl` Go shim is retired (Stage A).
- **One repo, one checkout.** felt and Shuttle live together at `~/dev/felt`,
  building three artifacts from one source tree (Stage B). Portolan is retired —
  Shuttle is self-contained, with its own browser UI and launch story, and
  assumes no Portolan process is running.
- **The `shuttle:` block is in felt's surface.** The contract that used to be
  validated on both sides (a Go `pkg/schema` *and* the Elixir daemon) now lives
  once, in felt's Go code. `pkg/schema` is gone. Continuation state
  (`session_uuid` / `dispatched_at` / `handed_off_at`) lives entirely in the
  `shuttle:` block.

**The Elixir/OTP daemon is deliberately retained.** Dispatch, the per-worker
watcher, and the `:4000` API are where OTP earns its keep, and the daemon is the
production dispatcher. A Go rewrite collapsing everything into a single binary is
a possible **Stage C** — a deferred, must-earn-itself idea, *not* planned now.
The standing design stance: felt owns the data model; Shuttle owns the network
and the surface; the two are one package, not two that shell to each other.

**felt history is gone.** The daemon detects clean worker exits via the
`shuttle.handed_off_at` frontmatter field — not a felt-history event. The
editorial chain felt-history used to carry now lives in the constitution body's
`## Status` block plus the git log of the fiber. (The synced-SQLite index slice —
treating the index purely as a throwaway cache — is deferred to a follow-on.)

### Portolan provenance

Portolan is retired; Shuttle does not depend on it. Remaining `grep -ri portolan`
hits are historical provenance comments — they explain *why* a shape exists
("ported from Portolan's …") and age out as the code they describe is rewritten.
A few conceptual carry-overs (the UI's city/pinning reconstruction in
`KanbanCityResolver.ts` / `projectModel.ts`; client-side `kind`/`priority`/
`isRoot` defaults in `KanbanFiber.ts`; gate/transition semantics in
`transition.ex` / `actions.ex`) are Portolan assumptions that unwind as the UI
simplifies — no runtime dependency.

## Build + lifecycle

### What builds what

```
make build        # BOTH: felt CLI (go build .) + daemon escript
make cli          # felt CLI only → ./felt
make cli-install  # felt CLI → ~/.local/bin (go install .)
make daemon       # daemon escript only → bin/shuttle (MIX_ENV=dev)
make test         # go test ./...  AND  mix test
make restart      # daemon (rebuild escript) + stop + start  [load-bearing dev loop]
make all          # restart
make start        # nohup detached; logs → ~/Library/Logs/shuttle.log (macOS)
make stop         # SIGTERM with 5s grace
make logs         # tail -f the log
make status       # felt shuttle ps + snapshot summary
make clean        # rm _build, stray Elixir.*.beam, built binaries
make install      # full from-source bootstrap (bootstrap.sh)
make install-agent / uninstall-agent   # durable launchd keep-alive (macOS)
```

`make build` needs `go` on PATH. **On the clusters (candide/cineca) use
`make all` / `make daemon`** — they build only the escript and need no Go
toolchain.

The escript loads its BEAMs at boot, so editing Elixir source has zero effect on
a running daemon until you restart. **`make restart` always** for daemon source
edits — a restart without `make daemon` is a no-op for picking up edits.

### Two install paths

- **(a) Public end-user CLI install** — downloads a release binary:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
  ```

  This is `install.sh`; installs to `~/.local/bin` (or `/usr/local/bin` if
  writable; override with `FELT_INSTALL_DIR`). Also Homebrew
  (`brew install cailmdaley/tap/felt`) or `go install github.com/cailmdaley/felt@latest`.

- **(b) Fleet / dev from-source bootstrap** — stands up the **entire** local
  surface:

  ```bash
  ./bootstrap.sh            # full bootstrap for this host
  ./bootstrap.sh --dry-run  # check prerequisites + print the plan, change nothing
  make install              # same, via the Makefile (flags: make install ARGS="--dry-run")
  ```

  Builds+installs the felt CLI, builds the daemon escript, places `ui/dist`,
  registers the loom event-stream hook, installs the keep-alive (launchd
  LaunchAgent on macOS / the `shuttle-daemon` tmux respawn loop on the clusters).
  `go` is a bootstrap prerequisite. Flags include `--skip-ui` / `--build-ui` (UI
  defaults to build on macOS, skip on clusters), `--skip-hook`, `--with-tunnels`
  (also installs the SSH tunnels on the macOS hub). bootstrap.sh branches by host
  type and is honest about missing prerequisites.

### Canonical checkout — `~/dev/felt` (outside Documents is load-bearing)

The canonical checkout is **`~/dev/felt`** (the old `~/dev/shuttle` is retired).
It must live **outside `~/Documents`** — see the launchd/TCC rationale below.

> **Remote-host caveat (B3 cutover pending):** candide and cineca still run from
> **`~/Documents/projects/shuttle`** until a later cutover (Stage B3). Keep the
> remote-deploy paths below as `~/Documents/projects/shuttle`; do not point them
> at `~/dev/felt` yet.

### Durable launch (macOS) — `make install-agent`

`make start` is a bare `nohup` with no supervisor: it won't restart on crash or
relaunch at login. Shuttle's own durable surface is a **launchd LaunchAgent**
(`share/io.shuttle.daemon.plist.template` → `~/Library/LaunchAgents/io.shuttle.daemon.plist`),
installed by `make install-agent`: `KeepAlive` restarts the daemon on crash,
`RunAtLoad` starts it at login. Independent of any other process.

**Run it from outside `~/Documents` — this is load-bearing.** macOS TCC blocks
launchd-spawned processes from `~/Documents`, `~/Desktop`, and `~/Downloads`, and
**Full Disk Access does not inherit** the way it does under Terminal (a terminal
app *takes responsibility* for its children, so everything you launch from a
shell shares the terminal's grant; launchd has no such umbrella, and FDA doesn't
even cross an `exec` to a differently-signed binary). So a launchd daemon whose
escript/`ui/dist`/felt stores sit under `~/Documents` either crash-loops
(`getcwd: Operation not permitted`, `escript: Failed to open file`) or silently
fails to walk stores — and the fix would be granting FDA to *each* binary in the
tree (`beam.smp`, `felt`, …), which is fragile (the erlang path is
version-pinned) and exactly the per-binary grind to avoid.

The clean setup, and the current production layout:

- **The repo lives outside Documents** — the canonical checkout is
  **`~/dev/felt`**. The escript and `ui/dist` are then readable by launchd with
  no grant.
- **`AGENT_LOOM_HOMES` scopes felt polling to `~/loom`** (the Makefile default,
  baked into the plist as `LOOM_HOMES`). `~/loom` is outside Documents and the
  felt aggregate — it re-discovers each project's substores by following the
  symlinks under `~/loom/.felt/` (`FeltStores.expand_with_symlinked_substores`),
  so configuring just `~/loom` is enough. **Caveat:** substores whose real root
  is itself under a protected folder (e.g. an iCloud `wedding`, a Documents
  `lightcone`) are discovered but can't be walked by the launchd daemon — those
  fibers won't enumerate until their project roots also move out of Documents.
- **`PATH` is captured from a login shell at install time** (`AGENT_PATH` in the
  Makefile, baked into the plist). launchd's own env is too bare to find
  `escript` (Homebrew) at boot or `felt` (`~/.local/bin`) at runtime — and a
  login shell *at runtime* (`bash -lc`) does NOT fix it, because under launchd's
  bare env the profile doesn't reconstruct PATH (exit 127, escript unfound). A
  PATH missing `felt` specifically yields `:enoent` → **500 on
  `/api/v1/fibers/composite`** (the kanban load), with the board fine otherwise.
  Capturing the real login PATH once, at install, is deterministic and needs no
  hand-maintained list.

Result: `make install-agent` from `~/dev/felt` → daemon binds `:4000`,
KeepAlive + RunAtLoad, **zero Full Disk Access grants**, survives erlang
upgrades. On the clusters the durable surface is still the `while true;
bin/shuttle start` tmux respawn loop in session `shuttle-daemon` (no launchd);
the LaunchAgent is macOS-only.

`make install-agent` warns if `$PWD` is under a protected folder. There *is* an
escape hatch — granting FDA to each I/O binary in the tree (`…/erlang/<v>/…/beam.smp`,
re-granted after every erlang upgrade, plus `~/.local/bin/felt`) — but it's
fragile and per-binary; relocating out of Documents is the supported fix.

### Owning the event stream — `~/loom/hooks/shuttle-hook.sh`

Shuttle derives per-session activity (`WaitingTracker`) and the sent-files trail
(`SentFiles`) from its OWN Claude Code hook-event stream. `~/loom/hooks/shuttle-hook.sh`
appends one JSON line per hook event to `$SHUTTLE_EVENTS_FILE` (default
`~/.shuttle/events.jsonl`, dir `$SHUTTLE_DATA_DIR`). The readers read ONLY this
path.

**The hook lives in loom, registered by `loom/setup.sh`.** It can't live in this
repo: `~/loom` is the same absolute path on every machine, but the checkout is
not (`~/dev/felt` here, `~/Documents/projects/shuttle` on the clusters), and
`~/.claude/settings.json` needs a stable absolute `command` path.
`loom/setup.sh`'s Python block registers `~/loom/hooks/shuttle-hook.sh` into
`~/.claude/settings.json` across the tracked events (UserPromptSubmit, PreToolUse,
Stop, Notification, SessionStart, SessionEnd). To install on a machine: sync loom
there, then run `~/loom/setup.sh`. The hook needs `jq` on PATH; without it it
exits silently (no events → no activity ranking, but the board still serves).
Each host's daemon tails its own host's `~/.shuttle/events.jsonl`.

**Connecting to candide and cineca (SSH auth — read this first).** The two
remotes authenticate differently, and getting it wrong looks like "the host is
down" when it isn't:

- **candide** (`candid03.iap.fr`, IAP) — plain pubkey auth with `~/.ssh/id_rsa`
  (the `Host *` identity), reached through an `nc` `ProxyCommand` hop. No cert
  dance: `ssh candide` just works whenever you're on a network that can reach
  IAP. Nothing expires.
- **cineca** (`login07-ext.leonardo.cineca.it`, user `cdaley00`, Leonardo) —
  auth is a **step-ca short-lived SSH certificate** held in the ssh-agent,
  valid **24h**. Refresh it once per day with:

  ```bash
  step ssh login 'cail.daley@cea.fr' --provisioner cineca-hpc
  ```

  When the cert is fresh, `ssh cineca` works non-interactively. When it has
  expired, **every** `ssh cineca` fails instantly with `Permission denied` —
  including the kanban **Attach** button, which runs `ssh -tt cineca tmux attach
  …` in a kitty tab, so the symptom is a terminal that **flashes open and dies**.
  That is the expired cert, not a Shuttle bug: re-run the `step ssh login` and
  attach works again. The `~/.ssh/cineca_key` / `cineca_key-cert.pub` paths in
  the ssh config are step's cert store — they may be absent on disk and ssh
  prints a harmless `no such identity` warning; the live credential is the cert
  in the agent. **Do not** pass `-o BatchMode=yes` when sanity-checking cineca
  (it suppresses the cert path and falsely reports a dead host), and ignore
  `~/.ssh/ssh_wrapper.sh` entirely — it's VS Code's remote helper, unrelated to
  Shuttle.

**Deploying is ALWAYS safe — local or remote — and is never a blocker.**
Rebuilding and restarting the daemon (`make all`, cycling `:4000`, reloading the
LaunchAgent, the respawn loop) does **not** kill running jobs: **tmux owns the
worker process, Shuttle only owns the watcher** (the load-bearing invariant
below). A restart cycles the watcher and rebinds the API; the `shuttle-<id>`
tmux sessions keep running untouched and the daemon re-adopts them on boot. So
deploy freely whenever there's a fix to ship — never hold back, gate it behind
"there are workers running," or frame a deploy as risky. The only cost is the
brief API/board blip during the ~1s (local) to ~2min (candide cold-walk)
restart; in-flight work is unaffected.

**An autonomous worker that has built and verified a change SHOULD deploy it —
that is the default, not a step to stop before.** Because the deploy itself is
mechanically safe (above), the only thing a branch-and-wait gate buys is a human
*code review* — and in practice that review rarely happens, so parking finished,
verified work on a branch is mostly latency and friction, not safety. The
verification that *does* matter happens in-session: build → run the tripwire
(`make test`, `cd ui && npm run build`) → get the skill's independent fresh-eyes
review (a subagent over the diff-against-constitution, an adversarial pass for
complex work) → **then deploy, in the same session.** Reserve "stop for the
human" for the genuinely different case — a change whose *design* he should weigh
in on before it ships (a capability removed, a contract redrawn, a load-bearing
model choice); even then, surface the alternatives in the fiber and keep moving
rather than treating the deploy *mechanics* as the gate.

**Deploying to remote hosts (candide, cineca):** push to GitHub first, then build
on the host — don't copy the macOS escript, as BEAM bytecode format varies across
OTP versions and the binary will crash on startup on a different host. (Remote
paths stay `~/Documents/projects/shuttle` until the B3 cutover.)

```bash
ssh candide "cd ~/Documents/projects/shuttle && git pull && make all"
ssh cineca  "cd ~/Documents/projects/shuttle && git pull && make all"
```

After a remote deploy, verify both `/api/v1/version` and one behavior-shaped
payload. A new `git_short_sha` only proves `BuildInfo` was rebuilt; if the live
payload still has old semantics, run `make clean && make daemon`, then let the
respawn loop restart the daemon from the clean escript.

**The respawn loop owns the remote daemon — `make stop`/`make all` may not
cycle it.** On candide/cineca a `while true; ./bin/shuttle start` loop in tmux
session `shuttle-daemon` owns the live daemon. `make stop`/`make all` target the
pidfile that `make start` writes, which is *not* the respawn-spawned daemon, so
they can build a fresh `bin/shuttle` yet leave the old binary serving `:4000`. To
actually cycle to the new binary, **kill the `:4000` listener directly**
(`lsof -ti:4000 -sTCP:LISTEN | xargs kill`) — the respawn loop restarts it from
the rebuilt escript. Confirm `git_short_sha` flipped; if not, the old process is
still bound. **candide startup is slow (~2 min)** — it scans large shapepipe felt
stores and adopts orphan sessions before binding `:4000`; wait it out, don't
assume a crash.

Candide: OTP 27.3.4.12 pinned in `~/.tool-versions`. Daemon log:
`~/.shuttle/shuttle.log`. cineca runs OTP 28.0.2 and **compiles fine** (the old
"OTP 28.0.x compilation crash" no longer reproduces on current `main`; only a
non-fatal "regexes re-compiled at runtime" perf warning remains — OTP 28.1+ or
27- silences it).

**The daemon serves its own web UI at `http://127.0.0.1:4000/`** — the kanban
board, Stash/Capture, and the fiber/file viewer, served as the static `ui/dist`
bundle by the same process as the `:4000` API (`Plug.Static` + `SpaController`).
To pull it up locally: `make start`, then open the root URL in a browser. A fresh
checkout that hasn't built the bundle gets a 404 with the hint
`cd ui && npm run build`; the API stays usable regardless.

**The UI bundle is shipped, not built on-host.** `make all` rebuilds only the
Elixir escript — it does *not* build `ui/dist`. And the UI **can't** be built on
the clusters from a source-only `lightcone-ui` clone: the aliased renderer source
imports its myst peers (`myst-to-react`, `@myst-theme/*`), which Node resolves
from `lightcone-ui`'s *own* `node_modules` — present only after a `pnpm install`
of that workspace. But the bundle is host-independent static output, so the lean
path is **build `ui/dist` locally (where the deps resolve) and `rsync` it**:

```bash
cd ui && npm run build              # locally; lightcone-ui present → paper entry included
rsync -az --delete ui/dist/ candide:~/Documents/projects/shuttle/ui/dist/
rsync -az --delete ui/dist/ cineca:~/Documents/projects/shuttle/ui/dist/
```

(The renderer is compiled *into* the bundle, so a remote serving the shipped
`dist` self-serves the paper render — it needs no `lightcone-ui` at runtime.)

**A daemon route change is a bundle-rebuild event.** `make all` rebuilds the
escript and rebinds `:4000` but never touches `ui/dist`, and nothing checks that
the shipped bundle and the daemon's route table still agree. So any change to the
`/api/v1/*` shape (add/remove/rename a route) MUST be paired with a `cd ui && npm
run build` + rsync to every host — the browser always runs the *local* bundle, and
a route mismatch fails silently as a 404 with no daemon-side error. This is exactly
how the shed-history merge broke *all* launches: it deleted `POST /api/v1/felt-history`,
but the stale `dist` still posted the directive there as the first step of New
Session, so the launch 404'd before it ever dispatched (provenance:
[[shuttle/findings/finding-uidist-stale-after-route-removal]]). If a fresh
`npm run build` exits 194 with *zero* output, that's not a type error — it's a
corrupted `node_modules` (circular `.bin` symlinks); `npm ci` fixes it.

**The ASTRA paper path needs node + a built MySTRA on each owning host.**
`GET /api/v1/astra` is owner-routed and shells out to `priv/mystra/bake.mjs`,
which imports MySTRA's built `dist`. Each host that *owns* astra.yamls you want
to render needs: `node` (any v22+) and a MySTRA checkout built once —
`git clone -b cail/migrate-to-astra-spec-sdk …/MySTRA && cd MySTRA && npm install
&& npm run build` at `~/Documents/projects/LightconeResearch/MySTRA` (the sibling
path `bake.mjs` resolves by default; its `dist/` is gitignored). The bake finds
node via a `bash -lc` login-shell fallback, so it works even though the respawn
loop sources asdf but not nvm. A host without node/MySTRA fails `/astra` cleanly;
the board + fibers are unaffected.

**The repo builds three things.** The **felt CLI** (Go: `main.go`, `cmd/`,
`internal/`) — including the `felt shuttle <verb>` subcommands, which ARE Go code
built here (`cmd/shuttle*.go` + `internal/shuttle/`); the **daemon escript**
(`bin/shuttle`, from `lib/`); and the **UI bundle** (`ui/dist`, from `ui/`).
Editing `lib/*.ex` needs `make restart`; editing the Go CLI needs `make cli` (or
`make cli-install`); editing the UI needs `cd ui && npm run build` + rsync.

**`bin/shuttle` is an escript** — it bundles BEAM bytecode at build time and
loads it at boot. A restart without `make daemon` is a no-op for picking up
source edits. `make restart` always.

If `mix escript.build` warns about "redefining module Shuttle.X" with the
"current version loaded from Elixir.Shuttle.X.beam" hint, run `make clean`
first — stray `.beam` files at the project root shadow the real ones. They
should never be committed.

## Quick start — operating without rebuilding

```bash
bin/shuttle snapshot                          # JSON snapshot of daemon state
bin/shuttle dispatch <fiber-id>               # one-shot dispatch

# felt shuttle — agent-facing CLI; offline; schema-validating
felt shuttle status                            # all fibers with shuttle: blocks
felt shuttle status --all                      # local + every configured remote
felt shuttle status --remote <name>            # single remote
felt shuttle ps                                # live tmux workers only
felt shuttle install <fiber> --project-dir "$PWD" [-m <agent-id>] [--disabled]
felt shuttle repeat <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"
felt shuttle pause <fiber>                       # disable + kill live worker; --no-kill preserves it
felt shuttle resume / accept <fiber>
felt shuttle set-model <fiber> <agent-id>
felt shuttle dispatch <fiber>
felt shuttle handoff <fiber>                     # worker's clean-exit ritual: stamp
                                                #   shuttle.handed_off_at (→ next dispatch
                                                #   is fresh) + end own tmux session. The
                                                #   single final action; folds in kill $PPID.
felt shuttle snapshot
felt shuttle abort / attach <fiber>
felt shuttle validate-identity                # UID migration/cross-city validation
```

## Critical invariants

- **tmux owns the worker process; Shuttle owns the watcher.** Workers stay
  attachable via `tmux attach -t shuttle-<fiber-id>`. Supervise watchers,
  not workers.
- **Felt is the data layer; the daemon shells out to the felt CLI.** Don't
  import felt internals into the daemon.
- **Remote content comes from the owning daemon over the tunnel — NEVER from
  git sync.** A fiber is owned by exactly one host; only that host's daemon can
  read its body, files, and assets off its own filesystem. Every cross-host
  READ (`/api/v1/fibers/:id?body=true`, `/file`, `/astra`) and every cross-host
  WRITE is **owner-routed via `Shuttle.OriginRouter`**: the composite board
  stamps each fiber's `origin`, the client carries it back, and the local daemon
  forwards to the owner's identical endpoint over the SSH LocalForward
  (candide→:4001, cineca→:4002). The `~/loom` git mirror replicating a remote
  fiber's files locally is **incidental and must never be relied on** — if any
  feature works only because a file happened to git-sync, that is a bug. The
  symptom when this invariant is violated: a remote card shows its outcome (it
  rides the composite feed) but the body reads empty / "not in the local
  mirror", because the read was attempted locally instead of being owner-routed.
  New endpoints that surface a fiber's host-local content MUST route through
  `OriginRouter`, not assume the bytes are reachable on this host.
- **Agent records live in one source of truth: felt's registry.** Felt owns
  the registry (`internal/shuttle/agents.json`, built into the CLI); the daemon
  reads the already-resolved record off felt's `shuttle.resolved.agent` JSON and
  shells `felt shuttle agents [resolve]` for the registry / no-fiber cases.
  There is no daemon-embedded `share/agents.json` and no `config/agents.exs`.
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
- **`shuttle.project_dir` is required for enabled installs.** `felt shuttle
  install` and `repeat` require `--project-dir`; workers start there instead
  of falling back to the felt store.
- **felt shuttle is the agent-facing CLI.** Local write verbs validate before
  write and work offline. `bin/shuttle` handles daemon lifecycle and dispatch.
- **No tag predicate for dispatch.** The `shuttle:` block's `enabled: true`
  field is the dispatch signal. Tags are free-form qualitative noticings.

## How dispatch works

- **Poller** (`lib/shuttle/poller.ex`) owns the tick. It walks each
  configured felt store, pulls candidate metadata via `felt ls --json` and
  per-fiber detail via `felt show -j`, and considers a fiber eligible iff
  `shuttle.enabled: true` AND `status in ["open", "active"]` AND not
  already running AND deps satisfied.
- **Configured stores** come from `LOOM_HOMES` (comma-separated env var) →
  persisted `~/.shuttle/felt_stores.json` → `LOOM_HOME` → `~/loom`.
  `POST /api/v1/felt-stores` rewrites the persisted file.
- **Dispatcher** (`lib/shuttle/dispatcher.ex`) resolves the agent, spawns
  the `shuttle-<fiber-id>` tmux session.
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
3. **`Felt store: <path>`** — the worker's absolute anchor. When
   `prompt_fiber_id`'s work_dir-local translation safe-fails, the id above
   is global and doesn't resolve from cwd; the store line makes the
   fallback mechanical (`felt -C <felt-store> show <id>`).
4. **`From User`** — the user's directive, when one rides this dispatch. It
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
~/Library/Logs/shuttle.log               # daemon stdout/stderr (macOS)
tmux ls | grep '^shuttle-'               # live workers
curl -s http://127.0.0.1:4000/api/v1/agents | jq
curl -s http://127.0.0.1:4000/api/v1/state | jq
curl -s http://127.0.0.1:4000/api/v1/state/composite | jq
felt shuttle validate-identity                # checks :4000/:4001/:4002 by default
```

Dispatch sanity ladder:

1. `felt shuttle status` shows `enabled: true, idle, oneshot`? → fiber is
   well-formed and the offline walker sees it.
2. `bin/shuttle snapshot` lists it under `eligible[]`? → daemon dispatched.
3. `felt shuttle` sees it but daemon doesn't → daemon binary is stale.
   `make restart`.
4. Daemon sees it but agent never appears → check the resolved agent's `cli`
   (`felt shuttle agents`) and that the wrapper is on `PATH`.

**Kanban stuck on "Loading…" / `/api/v1/state` returns
`{"error":"poller_unavailable", ..., "{:timeout, {GenServer, :call, [Shuttle.Poller, …, 1500]}}"}`
right after a fresh daemon start.** The poller serves its *last* snapshot, but on
a cold boot there is none yet, so the snapshot call starves behind the first full
walk until it completes — and the **first tick on a fresh machine is cold**: empty
OS file cache, dataless iCloud sidecars (`com~apple~CloudDocs` stores ship `.felt`
index files as `dataless` placeholders that block on a network download the first
time `felt` reads them), and every configured store walked back-to-back. Observed
once at **~106s** (`Sent 200 in 106275ms` in `shuttle.log`). It is a one-time tax:
once warm, all stores poll in well under a second and the board loads. So **wait
out the first walk** rather than trimming `~/.shuttle/felt_stores.json` — the
persisted list is fine, and most project stores are slices of `~/loom` (the
aggregate store; its ids are already prefixed `ai-futures/…`) so trimming gains
little. Two real follow-ups: (1) a store path with **no `.felt/` dir** ("not in a
felt repository") errors every tick — drop it from the list; (2) the remotes
timing out independently (`ssh_check_failed`, `:4001 econnrefused`) is separate
noise, not this.

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
├── internal/felt/           core felt logic (storage, parsing, graph, index)
├── internal/shuttle/        shuttle: block schema + agent registry (agents.json)
├── claude-plugin/           plugin payload for Claude Code + Codex
├── scripts/release.sh       bumps plugin manifests + commits + tags
│
│   # Shuttle daemon — Elixir/OTP (the dispatcher)
├── mix.exs  mix.lock
├── bin/shuttle              the daemon escript (built artifact)
├── lib/                     Elixir source
│   ├── shuttle/poller.ex      discover + eligibility + retry queue
│   ├── shuttle/dispatcher.ex  agent resolution, tmux launch
│   └── shuttle_web/           agent-API HTTP endpoints (/api/v1/...)
├── config/                  Elixir env config (dev/test/prod endpoint settings)
├── priv/                    daemon assets (e.g. mystra/bake.mjs)
├── share/                   shared data (plist template, launchd assets)
├── test/                    Mix test suite
│
│   # the board UI — TypeScript
└── ui/                      kanban board; `npm run build` → ui/dist (served by :4000)
```

`deps/` and `_build/` are Mix-managed and gitignored.

## Tests

```bash
make test                  # go test ./...  AND  mix test
go test ./...              # Go (felt CLI)
mix test                   # full Elixir suite
mix test --only focus      # tagged subset

# Opt-in real harness smoke. Opens real Claude/Codex/Pi CLIs in tmux,
# sends no prompt, captures the idle pane, then kills the smoke sessions.
SHUTTLE_REAL_HARNESS_SMOKE=1 mix test --only integration test/shuttle/real_harness_smoke_test.exs
```

The real harness smoke is deliberately outside ordinary `mix test`. It uses
tmux session names like `shuttle-harness-smoke-<harness>-<unique>`, records
captures under `_build/test/shuttle_harness_smoke/`, and skips harnesses that
are not available in `bash -l`.

## License

The repo is **MIT** (the felt CLI + UI — Cail's original work). The Shuttle
daemon (`lib/`) contains code derived from OpenAI's Symphony under the **Apache
License 2.0**, preserved in `NOTICE` and `LICENSE-APACHE`.

## Contributing

See `CONTRIBUTING.md`.
