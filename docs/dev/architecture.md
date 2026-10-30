# Architecture

One repo, one checkout, four artifacts: the **felt CLI** and **shuttle CLI**
(Go), the **shuttle daemon** (Elixir/OTP), and the **board UI** (TypeScript,
`ui/`). felt is a lean fiber library and notes CLI; shuttle is the orchestration
layer built on felt. The daemon is the production dispatcher.

## Architecture stance

- **Two Go CLIs, one-way dependency.** `felt` owns fiber storage and generic
  frontmatter. `shuttle` owns the network and orchestration, and reads and
  writes fibers through felt's Go library. felt has no dependency on shuttle or
  messaging packages; a test enforces that import boundary.
- **One repo, one checkout, four artifacts.** `cmd/felt` and `cmd/shuttle`
  build the two CLIs, while the same source tree builds the daemon release and
  board UI. Shuttle needs no separate browser application or dispatcher.
- **The `shuttle:` block is opaque to felt.** felt preserves it as ordinary
  frontmatter. shuttle owns the schema, validation, resolution, and lifecycle
  fields. The daemon reads and writes fiber content through felt and shells
  shuttle for Shuttle-owned behavior. Continuation state
  (`session_uuid` / `dispatched_at` / `handed_off_at`) lives in the block.
- **Resolved views belong to shuttle.** `shuttle ls` and `shuttle show` use
  felt's fiber readers and add Shuttle's resolved facet; felt's JSON output
  contains the plain frontmatter without a `resolved` sub-key.

**The Elixir/OTP daemon is the production dispatcher.** Dispatch, the
per-worker watcher, and the `:4000` API are where OTP earns its keep. A Go
rewrite collapsing everything into a single binary is a deferred, must-earn-
itself idea.

**Continuity across dispatches lives in frontmatter and git, not an event log.**
The daemon detects clean worker exits via the `shuttle.runtime.handed_off_at`
frontmatter field. The editorial chain lives in the constitution body's
`## Status` block plus the git log of the fiber.

## Thread results

A child constitution publishes lifecycle results to its nearest ancestor constitution that is not archived (tempered or discarded).
Only the child's owning daemon publishes them.
Results reach only that nearest orchestrator; each orchestrator decides what to pass on, with no automatic upward propagation.
Close wakes the orchestrator by default; `shuttle close --quiet` publishes context without waking, while ask always wakes.
A thread resting until a fiber (`shuttle.blocked_on`, set by `shuttle rest --until`) publishes `unblocked` as context when that fiber closes with any verdict; it never wakes and arms nothing.
The quiet marker names its exact close timestamp and an ordinary close clears it, so it cannot affect a later publication.
The outbox freezes the wake choice with the publication through retries and restarts.
Before the first poll, the daemon establishes a durable first-deployment timestamp in its host-local thread outbox.
Signals stamped at or before that baseline stay in fiber history and are never backfilled.
The baseline survives restarts; invalid or unreadable state refuses startup rather than replaying historical results.

The sender captures each new publication's immutable intended parent UID (felt's intrinsic frontmatter identity), text and message ID before attempting delivery.
Every retry resolves that UID from a fresh document read and uses its current host, including for formerly local parents.
Cross-host delivery carries the UID, never a slug.
Moving the child does not change a pending publication's recipient; a missing parent leaves it pending.
Snapshot migration keeps the original baseline and publications, extracting the parent's UID from saved snapshots.
A snapshot without a parent UID remains pending for operator repair rather than routing by an ambiguous slug.
Pending publications survive cleared lifecycle stamps and daemon restarts.
An acknowledgment means the parent daemon has durably enqueued the result in its fiber mailbox, not that a worker has consumed it.
The sender's host-local `thread-outbox/` separates `pending/` payload files from `acked/` records containing only publication IDs.
Capture checks only the IDs being captured; acknowledgment writes one ID and removes its pending payload, without decoding or rewriting accumulated history.
Acknowledgment IDs never expire because unchanged lifecycle stamps can be observed indefinitely.
An interrupted acknowledgment leaves a durable ID that suppresses replay; the next pending read removes any leftover payload.
Snapshot migration installs pending payloads and compact acknowledgment IDs idempotently, preserves the baseline, then removes the full snapshot.
Pending publications are retried independently of the baseline.
A corrupt or missing baseline in an established store refuses startup without touching pending work.
Recover by restoring the exact trusted cutoff from backup; never delete the outbox or reset the cutoff to the current time.

The parent Poller publishes one durable receiver identity and epoch synchronously with worker registration, recovery, removal and conversation rotation.
A CLI claim binds its supplied conversation UUID in worker metadata before registration publishes authority, never borrowing the predecessor's runtime UUID.
Recovery restores the durable receiver for the same live execution before consulting frontmatter: a known conversation and an explicitly unknown identity both survive failed runtime-mirror writes.
The execution retains its committed receiver harness in worker metadata and restores it from that record on adoption, independently of the current agent registry.
A missing registry entry remains visibly unresolved in the fiber and live-worker view; it neither blocks startup nor changes the receiver identity, address, or epoch.
A claim whose frontmatter write fails retains its committed receiver, exposes the mirror error, and retries the identity mirror during polling.
Mirror repair does not rotate the receiver epoch or append a duplicate session-resume event.
Boot recovery completes only after both the session scan and document listings are healthy; an uncertain boot defers authority reconciliation to a healthy poll.
Recovery adopts live workers before revoking untracked receivers.
An unchanged worker keeps its epoch across flushes and daemon restarts.
Publishing a worker transition revokes the predecessor before the Poller reports completion, even before a successor's delivery task runs.
Hooks check the current receiver under the mailbox emission lock; asynchronous delivery carries its epoch and cannot change authority.
A failed authority write aborts the transition instead of reporting success.

## Stores and views

Fiber documents synchronize through ordinary Git. Workers use `felt sync`
before substantive work, edit locally, and publish committed changes with
`felt sync --push`. A worker resolves relevant conflicts with the work's
context. Role charters under `roles/<role>/` have intrinsic IDs and no host
owner. A task's optional `shuttle.role` names one role charter; `shuttle.seat`
marks whether the constitution is a seat of that office.
Synchronizing a constitution does not change its `shuttle.host` dispatch gate.
Armed cross-host creation writes through the owner daemon; dispatch never depends on archive synchronization.
The daemon never runs Git or `felt sync`, and a missing document returns not-found naming its host and identifier.
Host-addressed board requests use the daemon's routing for that host's
current content, artifacts, and execution controls.

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
  `shuttle` verb acts on the fiber the id names, in the store that holds it.

## The `shuttle:` block

**The `shuttle:` block is opaque frontmatter to felt.** felt preserves it like
any other unknown field and does not validate or resolve it. The shuttle CLI
owns its typed facet and lifecycle writes; the Elixir daemon reads fiber content
with `felt`, then uses `shuttle ls`/`shuttle show` when it needs resolved
Shuttle data and `shuttle` for Shuttle-owned operations. `shuttle contract`
checks the CLI/daemon contract at boot, and a test keeps felt's import graph
free of shuttle and messaging packages.

## Execution surfaces

The agent registry determines the harness, model, and reasoning effort.
`shuttle.surface` chooses the presentation of a Codex conversation: `cli` opens a terminal TUI in the host's selected backend; `app` has no terminal viewer.
Both use the same local Codex App Server backend, durable conversation ownership, and native message transport.
An existing block without a surface selects terminal presentation.
New Codex selections in the board default to app presentation, with CLI available explicitly.
Other harnesses use their own CLI processes.

The App Server owns the conversation and its turns. Shuttle stores the
conversation identity and task assignment durably on the owning host. Capture
creates an unassigned conversation that can claim a fiber; an ordinary
dispatch assigns the conversation immediately. Both use the same execution
backend. A completed turn can wait for a reply without releasing its task or
starting another conversation.
An explicit stop releases the assignment through the backend's interrupt operation.
A handoff belonging to the current assignment, or a closed fiber, releases an idle assignment.
A confirmed unloaded or missing thread also releases its assignment without requiring a handoff, because it has no running turn.
Handoff validation uses the durable assignment start, not watcher-registration time.
Neither completion nor heartbeat observation interrupts or reloads the conversation.
Boot adoption applies the same rule as polling.
The durable conversation identity and endpoint survive assignment retirement, while the next dispatch selects the fiber's current agent.
An unavailable backend leaves the assignment supervised until its state can be established.

The durable record pins the backend's host and endpoint, independently of presentation.
Recovery, resume, stop, attachment, and native messaging check that owner before native operations; matching a thread ID in another server's rollout store is insufficient.
The daemon owns record writes. The Go native adapter reads only the ownership projection needed to refuse a different host or endpoint; shared fixtures enforce that contract.
Missing ownership fields in an existing record, or an unreadable record, don't authorize migration to the currently configured server.
An embedded CLI conversation with no AppWorkers record can be imported only with host-local execution evidence and a successful no-holder scan; see [the migration cases](operating.md#terminal-codex-workers).

App Server transport errors preserve uncertainty instead of becoming worker-death signals.
Resume targets the recorded conversation and reports failures; creating a fresh conversation is an explicit operation.
For Codex, closing a terminal viewer does not release the task, interrupt the turn, or authorize a replacement conversation.
`shuttle attach` prepares another viewer of the exact owned thread when needed, without starting a model turn.
Other harnesses use terminal-backend and process liveness.
API responses distinguish presentation from conversation identity: terminal Codex has a real `tmux_session` as well as `thread_id` and `session_uuid`.

Both Codex surfaces require the selected App Server's Unix control socket.
Shuttle creates the thread, saves its identity, and confirms its initial turn before opening `codex --remote unix://PATH resume THREAD_ID` in a terminal.
An empty thread has no resumable rollout before its first input.
The explicit endpoint is authoritative: a connection or resume failure never falls back to an embedded CLI runtime or a fresh conversation.
A desktop application's private stdio App Server is a separate runtime: sharing persisted rollouts does not share loaded-turn ownership.
Hook-only Codex sessions can receive `--context-only`, but waking them is rejected with attachment guidance.
Shuttle never pastes messages into their terminals.
Codex documents its managed daemon lifecycle in the [App Server daemon reference](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server-daemon/README.md).
On macOS, desktop attachment to the managed daemon also depends on the desktop
transport-selection gate; current failures caused by desktop-injected config
overrides are tracked upstream in
[openai/codex#41014](https://github.com/openai/codex/issues/41014).

Phone access uses the host's configured Codex remote access. App Server
creation and a direct link into the ChatGPT app are separate capabilities:
session identity does not imply a working phone URL. Shuttle must not invent
a cloud-task URL for a local conversation.

## Trust boundaries

The daemon's control plane has no authentication: anything that reaches its
listener can read and write every registered fiber, read transcripts, and
launch or kill workers as the user running it. The stance this follows from is
that the *listener* is the boundary, so the listener has to match the trust
of the host it runs on rather than the daemon carrying its own authentication
layer.

A host declares its trust class — `single-user`, `shared-multi-user`, or
`exposed` — in `~/.config/shuttle/host.json`, set with `shuttle host class`
and read with `shuttle host --json`, which also reports the host id. The
daemon reads `host.json` with the same rules, but takes its host id from
`shuttle` at boot. The class is a declared fact the operator asserts, not
something the daemon infers from the host; `shuttle doctor` checks that the
assertion still holds against reality (logged-in users, the socket directory's
mode, every fleet-owned listening socket).

The class determines where the daemon binds. `single-user` listens on
`tcp://127.0.0.1:4000` (`SHUTTLE_PORT`). `shared-multi-user` and `exposed`
listen on the Unix socket `$SHUTTLE_DATA_DIR/sock/daemon.sock` (default
`~/.shuttle/sock/daemon.sock`), inside a `0700`
directory the daemon creates and verifies before binding — a directory found
with looser permissions is a refusal to bind, not a downgrade. `host.json`'s
`listen` key or `SHUTTLE_LISTEN` overrides either default, and the CLI
resolves the same address to reach the daemon it is driving. A Unix socket
changes who can even open a connection: a caller has to traverse the
filesystem to the socket path, so only `sshd` running as the host's owner (an
SSH tunnel's far end) or the local CLI can reach it, which is a permission
check the kernel enforces rather than one the daemon has to implement. A host
whose only inbound is SSH tunnels can run entirely off the socket.
An unprivileged userspace `tailscaled` cannot target a Unix socket with
`tailscale serve`, and the macOS system `tailscaled` cannot reach a filesystem
socket at all. A shared host using either arrangement needs a loopback TCP
listener. An exposed host instead places a front proxy before the daemon; that
proxy dials the daemon's Unix socket.

On shared TCP listeners, `PeerGatePlug` runs before static assets or
request-body parsing and admits only a peer whose uid from `/proc/net/tcp` or
`/proc/net/tcp6` matches the daemon's effective uid. An unresolved or foreign
uid receives a 403 response. The plug also refuses exposed TCP requests that
reach it, while daemon boot refuses to create an exposed TCP listener.

The gate identifies the last local process, not the original client. A relay
running as the daemon's owner can pass co-tenant traffic with that owner's uid;
examples include userspace Tailscale SOCKS/HTTP proxies, `ssh -D`/`-L`, socat,
and code-server or Jupyter `/proxy/` routes. Operators must not run relays as
themselves. Root has no separate admission exception; it can already inspect
or control the daemon process.

The daemon refuses `defaults.https_proxy` on shared and exposed hosts because
the local Tailscale HTTP proxy is an unauthenticated loopback gateway to the
whole tailnet.

For `https://` remotes, `defaults.tailscale_socket` asks the daemon to open a
private, owner-only Unix socket per remote and dial the remote through
tailscaled's LocalAPI. On shared/exposed hosts using the default Unix listener,
bridge sockets sit beside `daemon.sock` under the same `0700` directory guard.
The bridge verifies the remote TLS certificate and hostname before it relays
traffic; it never exposes a loopback proxy to co-tenants.
When the private socket is configured, HTTPS requests fail closed if their
bridge is missing or unavailable; they never fall back to direct or proxy
routing. The two transport defaults are mutually exclusive. Tailnet discovery
uses the same socket: it reads the status from the LocalAPI and dials each probe
through it with the same certificate and hostname checks.

Every connection gets peer facts in `conn.assigns.peer`: transport (`unix` or
`tcp`), TCP uid when `/proc` resolves it, whether forwarding headers are
present, and a `tailscale_login` header. The uid gate consumes those facts on
shared and exposed TCP listeners; single-user TCP and Unix connections bypass
that gate. Unix reachability is bounded by the socket directory's filesystem
permissions. The `tailscale_login` value is retained on TCP only after the uid
gate admits the peer, but the header remains an assertion rather than an
independent credential. A shared TCP listener refuses to boot when
`/proc/net/tcp` is unreadable; an exposed TCP listener is refused regardless
of `/proc`. Use the class's Unix socket or declare the host `single-user` when
loopback is private to its operator.

## The fleet

Every daemon finds the others itself. `Shuttle.TailnetPeers` reads the tailnet
status, keeps the peers owned by this node's own Tailscale user, probes each
online one at `https://<magicdns-name>/api/v1/version`, and names every
Shuttle daemon that answers by the `host` id it reports there. Fibers route by
`shuttle.host`, so a peer is named by its host id, never by its MagicDNS label.
A node shared in from another tailnet is never probed or trusted; a peer that
reports this daemon's own id, reports no id, or shares an id with another peer
is dropped. Phones and other nodes without a daemon drop out because they do
not answer. The round runs shortly after boot, off the boot path, and every
minute after that. A peer that answered once survives ten minutes of failed
probes, so a daemon restarting for a deploy goes stale on the board instead of
vanishing from it.

`~/.config/shuttle/remotes.json` holds the exceptions: hosts outside the
tailnet (reached through an ssh tunnel port), non-default URLs, ssh names for
the recovery cascade, and deploy metadata. `Shuttle.Remotes.resolve/2` merges
the two sources. A configured entry wins over a discovered peer with the same
name or `https` authority, `"enabled": false` suppresses a discovered host, and
`defaults.discover: false` turns discovery off. The resolved fleet feeds the
registries, `Shuttle.OriginRouter`, messaging, and the dial bridges. A newly
discovered peer reaches them without a restart, because the discovery
generation is part of `Shuttle.Remotes.config_token/0`.

The Go CLI does not probe the tailnet. `shuttle remotes list` and every verb
that routes by host name read the local daemon's discovered peers from
`/api/v1/version` and merge them with the file through `resolveRemotes`, the Go
mirror of the Elixir resolver. `daemon/test/fixtures/tailnet_peers/` holds the
shared cases. When Tailscale is absent, stopped, or failing, the daemon uses
the file alone and records why, and `shuttle doctor` reports the reason.

## Meeting recorder routing

A meeting has two independent host addresses: the **recorder** runs hark, and the agent's **origin** owns the scribe or joined constitution.
Capture and Join preserve that origin when forwarding to a recorder, so transcript mirrors and agent delivery point to the correct owner even when the owner is the requesting hub.
A record-only start (`POST /meeting/start`) has an origin and no agent: the requesting daemon is the origin, receives the mirror, and answers its own path to the transcript.

A phone board asks its serving daemon for `GET /api/v1/meeting?prefer=phone`.
The daemon probes the configured fleet with short bounded local-capability reads and prefers a reachable recorder advertising hark availability and macOS device modes.
It falls back to local recording only before a start is attempted.
Plain `GET /meeting` reports local capabilities and cannot trigger another selection round.
An explicit recorder address terminates forwarding after one hop.

The selected recorder is visible in the UI and travels with the returned meeting row.
Active polling and Stop remain pinned to that recorder; Stop checks the launch identity under the meeting lock, so stale controls cannot stop another recording.
After an ambiguous forwarded start, the daemon reports uncertainty and does not retry or select a fallback.
The UI holds another start until the operator inspects the recorder.

Phone audio stays phone audio even when a remote Mac records it.
The phone connects only to the hub's `/meeting/audio` WebSocket, which relays to the selected recorder's `/meeting/audio` endpoint.
The recorder validates the launch id and feeds its local hark socket.
Relay connections have bounded connection and send deadlines, propagate status and closure, and never replay audio after a disconnect.

## Platform story

**Linux and macOS are both supported for single-host use.** One host runs the
shuttle CLI, daemon, board, and workers on either OS. The keep-alive differs —
a launchd LaunchAgent on macOS, a systemd user unit on Linux (`shuttle daemon
install` picks the branch from `uname -s`) — and so does the log path, but the
CLI, daemon, and bundle are built from this repo.

**Either platform can be the fleet's hub.** `shuttle tunnels install`
writes the hub's autossh jobs as launchd LaunchAgents on macOS and systemd
`--user` units on Linux, picking the branch the way `shuttle daemon install` does.
A Linux host with no systemd user session (an HPC login node usually has none)
gets a refusal naming `--write-only`, not units nothing would start. Either way
the tunnel is installed on the hub, not on the remote. One asymmetry remains:
the daemon's recovery cascade bounces a stalled tunnel with `launchctl
kickstart`, so on a Linux hub a quiet remote skips the bounce and advances to
the cascade's ssh check.

**Terminal backends and opening.** `Shuttle.Terminal` launches through the host's configured backend (`tmux` by default, `rex` when selected) and retains tmux as an observation and stop backend on Rex hosts when available.
The worker name is Shuttle's identity; Rex's daemon-written session/block binding is authoritative, while labels are display and recovery indices.
`Shuttle.Opener` selects Rex or Kitty for the local display: Rex opens local Rex sessions and provides viewers for local or remote tmux sessions.
Remote Rex opening is not supported.
The Codex App Server, Remote Control host and Hark meetings retain tmux for dead panes, options and respawn; daemon supervision loops also retain tmux.

Windows is unsupported.

### Managed Codex dependency and endpoint

Shuttle ensures that the selected Codex App Server is running, independently of dispatch and boot quarantine.
`Shuttle.CodexBackend` reconciles asynchronously with bounded observations and exponential launch backoff, from 2 seconds to 300 seconds.
It initializes a connection without creating a project, thread, or model turn.
`GET /api/v1/version` reports its independent `codex_backend` health; daemon `ready` does not imply backend readiness.
Dispatch and capture return a retryable wait before creating a conversation when the backend isn't ready.
The autonomous poll retries without the five-minute preflight cooldown.

`SHUTTLE_CODEX_SOCKET` is authoritative for daemon transport, native Go messaging, and remote terminal viewers.
An empty or absent override selects `/tmp/shuttle-codex-<euid>-<host-hash>/control.sock`.
`host-hash` is the first 16 lowercase hexadecimal characters of SHA-256 over the actual OS hostname, not Shuttle's logical host ID.
The literal `/tmp` base is independent of `HOME`, `CODEX_HOME`, `TMPDIR`, and `XDG_RUNTIME_DIR`, so separate login environments and network-mounted homes agree on a host-local endpoint.
Explicit overrides must be clean absolute Unix socket paths of at most 100 bytes.
The endpoint root must be a real directory owned by the effective uid with mode `0700`; insecure precreated roots and user-controlled symlink components are refused, not repaired.
The root-controlled macOS `/tmp` alias is accepted.
Codex 0.162.1's exact protected rendezvous alias is accepted after its target root, ownership, type, and permissions are verified; arbitrary leaf symlinks are refused.
The socket remains same-user IPC, with filesystem permissions and Codex's peer-UID checks, not cross-host authentication.

The manager starts `command codex app-server --listen unix://PATH` in an endpoint-specific tmux session, after the macOS `TmuxServer.ensure_available` guard.
It scrubs worker identity, fiber, run, and tmux variables before starting the backend; it doesn't depend on an interactive Codex wrapper.
The private endpoint root holds exclusively created launch scripts, while tmux owns the backend process across manager and Shuttle restarts.
A healthy existing server is adopted untouched.
A successful process scan with no server holder, no live owned pane (dead or gone), and a refused or missing socket authorize recovery through Codex's native per-endpoint startup lock and stale-socket checks.
Remote TUI clients don't count as server holders.
Unowned unresponsive sockets, missing sockets with live server holders, failed observations, and another manager still starting remain uncertain and never authorize replacement.
Shuttle never kills a live backend, unlinks its socket, or restarts it for a config change.
After reboot, reconciliation starts an absent dependency without releasing worker quarantine.

`CODEX_HOME` stays persistent, defaulting to `~/.codex`; authentication, configuration, and rollouts aren't moved to `/tmp` or copied into another home.
Codex's native `app-server daemon start` and `daemon version` manage and describe its own `CODEX_HOME` endpoint, not Shuttle's custom listener.
Plain App Server startup briefly takes Codex's `CODEX_HOME` startup lock, but persistent Shuttle process ownership, death evidence, and endpoint-specific lifecycle state remain host-local.
Backend tools use the server's environment, not the terminal viewer's environment.
Managed Codex refuses per-agent environment overrides and unsupported arbitrary CLI flags rather than silently ignoring them.

Durable conversation records pin their host and endpoint.
Changing the default or an override doesn't rewrite old records or authorize connecting an old thread to a different server.
Restore the recorded endpoint or deliberately reconcile ownership; shared rollout files aren't evidence of live conversation ownership.
