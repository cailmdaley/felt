# Architecture

One repo, one checkout, three artifacts: the **felt CLI** (Go) is the data
layer, the **shuttle daemon** (Elixir/OTP) is the dispatcher, and the **board
UI** (TypeScript, `ui/`) is the surface. felt owns the data model; shuttle owns
the network and the surface.

## Architecture stance

- **One CLI surface.** Every caller speaks `felt shuttle <verb>`.
- **One repo, one checkout, three artifacts.** felt and shuttle live in one
  source tree, building the felt CLI, the daemon release, and the board UI from
  it. shuttle is self-contained, with its own browser UI and launch story,
  assuming no external dispatcher process.
- **The `shuttle:` block is in felt's surface.** The contract lives once, in
  felt's Go code, and the Elixir daemon reads it. Continuation state
  (`session_uuid` / `dispatched_at` / `handed_off_at`) lives entirely in the
  `shuttle:` block.
- **felt owns the data model; shuttle owns the network and the surface** — the
  two are one package, not two that shell to each other.

**The Elixir/OTP daemon is the production dispatcher.** Dispatch, the
per-worker watcher, and the `:4000` API are where OTP earns its keep. A Go
rewrite collapsing everything into a single binary is a deferred, must-earn-
itself idea, not planned now.

**Continuity across dispatches lives in frontmatter and git, not an event log.**
The daemon detects clean worker exits via the `shuttle.runtime.handed_off_at`
frontmatter field. The editorial chain lives in the constitution body's
`## Status` block plus the git log of the fiber.

## Stores and views

Fiber documents synchronize through ordinary Git. Workers use `felt sync`
before substantive work, edit locally, and publish committed changes with
`felt sync --push`. A worker resolves relevant conflicts with the work's
context. Roles and collaborators under `roles/` have stable IDs and no host
owner. Synchronizing a constitution does not change its `shuttle.host`
dispatch gate. Host-addressed board requests still use the daemon's routing
for that host's current content, artifacts, and execution controls.

A **store** is a `.felt/` directory and everything under it — one namespace,
one git repo. A **view** (or substore) is a project whose `.felt` is a *symlink*
into a subdirectory of a larger store: this repo's `.felt` points into
`~/loom/.felt/ai-futures/felt`. The loom is the store; the project is a lens on
it. A lens narrows what is *listed*, never what can be *found* or *reached*.

An **id** is resolved against the local store first, then — on a miss — against
the enclosing store, which resolves it by its own scope and suffix rules from
this view's position out there. A hit is reported as external and the command
runs where the fiber lives, appending `(in <root>)` so a cross-store write is
never silent. The one thing that never crosses is the **basename rescue** (the
"your path went stale but the slug is unique" guess): the external probe sits
above it, so felt never guesses at a fiber and then deletes or moves it.

The verb contract, in one line each:

- **`felt ls` lists the view.** Every flag filters this store's own listing.
  Fast, local, always — in a substore a filtered ls closes with a line naming
  `felt find` and the store it would search.
- **`felt find` searches the store.** Local hits first, the rest of the
  enclosing store under a separator naming it, each by its full id there,
  capped with an exact remainder count (`--limit`). `-j` merges both halves
  into one array, each entry naming its `store`.
- **An id reaches anywhere.** `show`, `edit`, `rm`, `nest`, `tree`, and every
  `felt shuttle` verb act on the fiber the id names, in the store that holds it.

## The `shuttle:` block

**The `shuttle:` block is non-native frontmatter felt owns the *shape* of.**
felt validates and stamps the `shuttle:` block (the `felt shuttle <verb>` Go
subcommands in `cmd/` + `internal/shuttle/`); the Elixir daemon reads it. This
is the merge end-state — the contract lives in one place (felt) rather than
being validated on both sides.

## Execution surfaces

The agent registry determines the harness, model, and reasoning effort.
`shuttle.surface` chooses how a Codex conversation runs: `cli` uses a tmux
worker; `app` uses the local Codex App Server. An existing block without a
surface retains CLI execution. New Codex selections in the board default to
app execution, with CLI available explicitly. Other harnesses use CLI.

The App Server owns the conversation and its turns. Shuttle stores the
conversation identity and task assignment durably on the owning host. Capture
creates an unassigned conversation that can claim a fiber; an ordinary
dispatch assigns the conversation immediately. Both use the same execution
backend. A completed turn can wait for a reply without releasing its task or
starting another conversation. An explicit stop or completed handoff releases
ownership.

App transport errors preserve uncertainty instead of becoming worker-death
signals. Resume targets the recorded conversation and reports failures;
creating a fresh conversation is an explicit operation. CLI process liveness
continues to come from tmux. API responses distinguish these surfaces instead
of presenting an app conversation as a terminal session.

The app surface requires the managed App Server's Unix control socket. A
desktop application's private stdio App Server is a separate runtime: it may
share persisted rollouts through the same Codex home, but it does not share
loaded-turn ownership and is not a safe fallback. Shuttle refuses app dispatch
when the managed socket is absent; choose a host with a reachable managed App
Server or use the CLI surface. Codex documents the managed daemon lifecycle in
its [App Server daemon reference](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md).
On macOS, desktop attachment to the managed daemon also depends on the desktop
transport-selection gate; current failures caused by desktop-injected config
overrides are tracked upstream in
[openai/codex#41014](https://github.com/openai/codex/issues/41014).

Phone access uses the host's configured Codex remote access. App Server
creation and a direct link into the ChatGPT app are separate capabilities:
session identity does not imply a working phone URL. Shuttle must not invent
a cloud-task URL for a local conversation.

## Platform story

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
`daemon/lib/shuttle/kitty.ex`). A non-kitty user gets nothing on either OS; `felt
shuttle attach <fiber>` always works.

Windows is unsupported.

### Explicit Codex endpoint

`SHUTTLE_CODEX_SOCKET` selects the same Unix WebSocket endpoint for app dispatch
and native session messaging. Set it in the Shuttle daemon's environment when
using an explicitly shared Desktop backend. Without it, both clients use
`$CODEX_HOME/app-server-control/app-server-control.sock`, with `CODEX_HOME`
defaulting to `~/.codex`. An empty override uses that default. An unavailable
explicit endpoint is an error; clients do not switch to another conversation
owner or start a replacement backend.
