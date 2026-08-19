# felt + shuttle — Contributor & Operator Notes

One repo, one checkout, three artifacts:

- **felt CLI** (Go) — the **data layer**. A directory-based markdown fiber
  tracker / agent memory, and the home of the `felt shuttle <verb>`
  subcommands. Built here.
- **shuttle daemon** (Elixir/OTP Mix release, launched through the tracked
  `bin/shuttle` shim) — the **dispatcher**.
  Polls the felt tree, launches one tmux worker per eligible fiber, exposes a
  `:4000` snapshot/control API and owns a per-worker watcher.
- **the board UI** (TypeScript, `ui/`) — the **surface**. Five full-page views
  over the felt tree and the fleet's session/commit ledgers (Desk kanban, Day,
  Week, Chronicle, and the Board canvas of sent work), served by the daemon at
  `http://127.0.0.1:4000/`.

felt owns the data model; shuttle owns the network and the surface. The Elixir
daemon is the production dispatcher.

**The one invariant to hold before anything else — it binds you, the agent
operating on the store, not just the code: a fiber's owning host is its only
read and write path, and git sync is never the answer.** Every fiber is owned
by exactly one host; cross-host reads and writes are owner-routed over the
daemon socket (`Shuttle.OriginRouter`). To hand-edit a fiber another host
owns, POST the local daemon's `/api/v1/felt-edit` (it routes by owner) —
never `felt edit` against the local checkout, never a loom `git pull`/`push`
to "sync state". A git mirror that happens to hold a remote fiber's files is
incidental; any fix, feature, or diagnosis that leans on it is wrong by
construction. When a cross-host behavior seems to need git, the model is
being misread — see "Critical invariants" below before acting.

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

- **tmux owns the worker process; shuttle owns the watcher.** Workers stay
  attachable via `felt shuttle attach <fiber>`. Supervise watchers,
  not workers.
- **felt is the data layer; the daemon shells out to the felt CLI.** Don't
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
- **Agent records live in one source of truth: felt's registry.** felt resolves
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
  dirty-death resumes alike — in `pending_launch` until `bin/shuttle release`.
  There is no `enabled` flag; steady-state resume of a worker that dies while
  the daemon is healthy and unquarantined is unaffected, and force-dispatch
  bypasses the quarantine. Tags are free-form qualitative noticings.

## The daily loop

```bash
make build                 # felt CLI (go build .) + daemon release
make cli-install           # felt CLI only → ~/.local/bin
make restart               # rebuild release + stop + start  [daemon dev loop]
make status / make logs    # ps + snapshot / tail the daemon log
```

Editing `lib/*.ex` needs `make restart` (a restart without `make daemon` is a
no-op — the release runs compiled BEAMs). Editing the Go CLI needs `make cli`.
Editing `ui/` needs `cd ui && npm test` + `npm run build` + rsync of `ui/dist`.
Under launchd/systemd, `make restart` silently no-ops — bounce with
`launchctl kickstart -k gui/$(id -u)/io.shuttle.daemon` or
`systemctl --user restart shuttle-daemon`.

### Tests

```bash
make test                  # go test ./... + mix test + the board suite + the plugin hooks
go test ./...              # Go (felt CLI)
mix test                   # full Elixir suite
cd ui && npm test          # vitest, run TWICE under two pinned TZs
                           # (America/Los_Angeles, Europe/Paris)
```

**The board suite runs twice on purpose, and CI does not run it at all.** The
second pinned offset is where the civil-day logic breaks, so a hand-run `npx
vitest run` can go green on a change `make test` would fail. CI type-checks and
builds the bundle but never invokes vitest — `cd ui && npm test` is a local-only
gate, which makes it the easiest one to skip and the one worth not skipping.

### Deploying

Deploying is **always safe** — tmux owns the worker process, shuttle only owns
the watcher, so restarting the daemon never kills running jobs. An autonomous
worker that has built and verified a change SHOULD deploy it.

```
push → on the host: pull → make daemon → rsync ui/dist → cycle the :4000
listener (the host's supervisor brings it back) → poll /api/v1/version until
git_short_sha and booted_at both move → bin/shuttle release
```

`bin/shuttle-deploy` scripts exactly that across the fleet in
`~/.config/felt/remotes.json`. **Every restart arms the boot quarantine** — no
autonomous dispatch of any kind proceeds until `bin/shuttle release`. A daemon
route change is a bundle-rebuild event: rebuild and rsync `ui/dist`, or the
stale bundle 404s silently. Details:
[`docs/dev/build-and-deploy.md`](docs/dev/build-and-deploy.md).

## License

The repo is **MIT** (the felt CLI + UI). The shuttle daemon (`lib/`) contains
code derived from OpenAI's Symphony under the **Apache License 2.0**, preserved
in `NOTICE` and `LICENSE-APACHE`.

## Contributing

See `CONTRIBUTING.md`.
