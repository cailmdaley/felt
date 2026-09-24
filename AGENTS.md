# felt + shuttle — Contributor & Operator Notes

One repo, one checkout, three artifacts:

- **felt CLI** (Go) — the **data layer**. A directory-based markdown fiber
  tracker / agent memory, and the home of the `felt shuttle <verb>`
  subcommands. Built here.
- **shuttle daemon** (`daemon/`, an Elixir/OTP Mix release) — launched
  through the tracked `bin/shuttle` shim, the **dispatcher**.
  Polls the felt tree, launches one terminal or app worker per eligible fiber, exposes a
  `:4000` snapshot/control API and owns a per-worker watcher.
- **the board UI** (TypeScript, `ui/`) — the **surface**. Five full-page views
  over the felt tree and the fleet's session/commit ledgers (Desk kanban, Day,
  Week, Chronicle, and the Board canvas of sent work), plus a settings sheet on
  `⌘,` over every host's operator files, served by the daemon at
  `http://127.0.0.1:4000/`.

felt owns the data model; shuttle owns the network and the surface. The Elixir
daemon is the production dispatcher.

**Fibers are ordinary Git-synchronized documents; execution is host-owned.**
Run `felt sync` before substantive work, read and edit the local store, then
commit intentional changes and publish with `felt sync --push`. Resolve Git
conflicts with the work's context. Roles and collaborators live under `roles/`
and have no host owner. A constitution's `shuttle.host` selects the daemon
allowed to execute it; synchronizing its file does not transfer execution.
The live board still uses owner-routed APIs for host-local content and control.

## Where everything else lives

This file is the spine: orientation, invariants, and the daily loop. Depth
lives in the docs site (`docs/`, published to
<https://cailmdaley.github.io/felt/>).

| Looking for | Read |
|---|---|
| Architecture stance, stores/views, the `shuttle:` block, platform story | [`docs/dev/architecture.md`](docs/dev/architecture.md) |
| Make targets, restart discipline, the deploy ritual, remote deploy, UI bundle | [`docs/dev/build-and-deploy.md`](docs/dev/build-and-deploy.md) |
| Poller eligibility, stores vs picker projects, prompt structure | [`docs/dev/dispatch.md`](docs/dev/dispatch.md) |
| `bin/shuttle` / `felt shuttle` surface, sanity ladder, symptom debugging | [`docs/dev/operating.md`](docs/dev/operating.md) |
| Event stream + ledger writer/reader contract | [`docs/dev/event-stream.md`](docs/dev/event-stream.md) |
| Plugin integration, `scripts/release.sh`, release candidates | [`docs/dev/releasing.md`](docs/dev/releasing.md) |
| Codebase layout, test suites | [`docs/dev/layout.md`](docs/dev/layout.md) |
| Installing a daemon, keep-alive, macOS TCC, sharp edges | [`docs/shuttle/installation.md`](docs/shuttle/installation.md) |
| Fiber model, frontmatter, cross-project stores | [`docs/concepts/`](docs/concepts/) |
| CLI verbs, daemon HTTP API | [`docs/reference/cli.md`](docs/reference/cli.md), [`docs/reference/api.md`](docs/reference/api.md) |

## Critical invariants

- **Execution backends own conversations; shuttle owns task assignment and
  observation.** CLI workers live in tmux and remain attachable via
  `felt shuttle attach <fiber>`. Codex app conversations live in the local
  Codex App Server and remain addressable while idle. Neither an idle turn
  nor an unreachable App Server means a conversation has died. Preserve its
  identity across daemon restarts; never substitute a CLI launch for an app
  failure.
- **felt is the data layer; the daemon shells out to the felt CLI.** Don't
  import felt internals into the daemon.
- **Live host-addressed content and control use `Shuttle.OriginRouter`.**
  The composite board carries each row's `origin` back to the daemon for
  requests such as `/api/v1/fibers/:id?body=true` and `/file`, so it can display
  that host's current content and artifacts without waiting for Git sync.
  Route requests for host-local assets and execution through the selected
  daemon. Ordinary synchronized notes, including roles and collaborators,
  are read and edited locally; they do not need an origin registry.
- **Agent records live in one source of truth: felt's registry.** felt resolves
  the registry as two layers — `internal/shuttle/agents.builtin.json` (embedded)
  with the user file (`$FELT_AGENTS_FILE`, else `~/.config/felt/agents.json`)
  merged over it by default. The user file can set `builtins: "restrict"` to
  replace the shipped layer for one host. Records merge wholesale by id; the
  file's `overrides` block (`{"claude-opus": {"default_effort": "high"}}`)
  patches `default_effort` on any resolved agent, and `felt shuttle agents
  effort <id> <level>|--reset` is its one structured writer (the daemon's
  `POST /api/v1/agents/effort` shells it). `felt shuttle agents init` seeds that
  file from the built-ins — a worked example of every field, ready to edit for
  local additions or overrides. There
  is no reserved `human` agent; a
  malformed user file fails loud with its path, a missing one is silent. The
  daemon reads the already-resolved record off felt's
  `shuttle.resolved.agent` JSON and shells `felt shuttle agents [resolve]` for
  the registry / no-fiber cases. There is no daemon-embedded agent registry.
- **Remote daemons live in `~/.config/felt/remotes.json`.** The Go CLI
  (`cmd/shuttle_remotes.go`) and the daemon (`daemon/lib/shuttle/remotes.ex`) read the
  same file at runtime, so nothing about your hosts is baked at build time.
  `felt shuttle remotes list|add|rm|path` manages it, and `list` doubles as the
  validator — including for the board's settings sheet, which shells that verb
  rather than encoding the file itself, so the grammar the two readers must
  agree on is never implemented a third time.
  `daemon/test/fixtures/remotes/` enforces Go/Elixir parity, and
  `cmd/hygiene_test.go` fails the build on a personal hostname or path anywhere
  in the published surface: `daemon/config/`, `daemon/lib/`, `cmd/`, `daemon/share/`, `ui/`, `bin/`,
  **every `.md` in the repo** (docs and skills ship as content), plus `Makefile`
  and `scripts/bootstrap.sh`. Prose counts — naming one of your own hosts in a doc
  fails the build, so write incidents generically and keep the host's name in
  the fiber instead.
- **`shuttle.agent` field drives agent selection.** The `shuttle:` block's
  `agent:` field resolves against the registry. Default agent is
  `claude-opus` (from `internal/shuttle/agents.builtin.json`).
- **`shuttle.host` field drives daemon affinity — strictly.** A daemon
  dispatches a block iff `block.host == own_host_id` (`SHUTTLE_HOST`, else
  `~/.shuttle/host`, else the normalized OS hostname, seeded into that file so
  the CLI and the daemon cannot drift apart). There is no `"local"` default and
  no `nil` wildcard: an absent or empty `host:` is unowned and ineligible on
  *every* daemon. `felt shuttle install`/`repeat` stamp `host` by default so blocks
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
  dirty-death resumes alike — in `pending_launch` until `bin/shuttle release`;
  only work the daemon observed running and cron-due standing roles pass
  through. There is no `enabled` flag; steady-state resume of a worker that dies while
  the daemon is healthy and unquarantined is unaffected, and force-dispatch
  bypasses the quarantine. Tags are free-form qualitative noticings.

## The daily loop

```bash
make build                 # felt CLI + UI + daemon release
make cli-install           # felt CLI only → ~/.local/bin
make restart               # rebuild UI + release, then stop + start
make status / make logs    # ps + snapshot / tail the daemon log
```

Editing `daemon/lib/*.ex` needs `make restart` (a restart without `make daemon` is a
no-op — the release runs compiled BEAMs). Editing the Go CLI needs `make cli`.
Editing `ui/` needs `cd ui && npm test`, then `make restart` from the root.
Changing anything the board draws also wants a look at it: `cd ui && npm run
harness:board` builds a self-contained bundle with a mocked daemon that opens
over `file://`, which is the only way to see the board where `:4000` is
unreachable — and the only way to stage states a live fleet will not hold
still for.
Source builds require Go, Elixir/OTP, and Node/npm on each host.
To cycle a supervised daemon directly, use
`launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon` or
`systemctl --user restart shuttle-daemon`.

### Tests

```bash
make test                  # go test ./... + mix test + the board suite + the plugin hooks
go test ./...              # Go (felt CLI)
make mix-test              # full Elixir suite
cd ui && npm test          # vitest, run TWICE under two pinned TZs
                           # (America/Los_Angeles, Europe/Paris)
```

**The board suite runs twice on purpose, in both local tests and CI.** The
second pinned offset is where the civil-day logic breaks, so a hand-run `npx
vitest run` can go green on a change `make test` would fail. CI runs `npm test`
under America/Los_Angeles and Europe/Paris, then type-checks and builds the
bundle with `npm run build`.

### Deploying

Deploying is **always safe** — tmux owns the worker process, shuttle only owns
the watcher, so restarting the daemon never kills running jobs. An autonomous
worker that has built and verified a change SHOULD deploy it.

```
push → on the host: pull → make build → cycle the :4000
listener (the host's supervisor brings it back) → poll /api/v1/version until
git_short_sha and booted_at both move → bin/shuttle release
```

`bin/shuttle-deploy` builds source checkouts in each host's login shell across the fleet in
`~/.config/felt/remotes.json`. **Every restart arms the boot quarantine** — no
fresh oneshot dispatch proceeds until `bin/shuttle release` (cron-due standing
roles still fire). A daemon
route change must ship with the matching UI; `make build` builds both.
Fetched-release users do not need this checkout deployment helper. Details:
[`docs/dev/build-and-deploy.md`](docs/dev/build-and-deploy.md).

## License

The repo is **MIT** (the felt CLI + UI). The shuttle daemon (`daemon/lib/`) contains
code derived from OpenAI's Symphony under the **Apache License 2.0**, preserved
in `NOTICE` and `LICENSE-APACHE`.

## Contributing

See `CONTRIBUTING.md`.
