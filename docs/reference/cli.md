# CLI Reference

This page covers both Go CLIs. `felt` creates, searches, and edits fibers;
`shuttle` interprets the optional `shuttle:` block and owns orchestration.
Scan for a command, then read its `--help` text for examples and detail.

Their global flags are separate:

| CLI | Flag | Purpose |
|---|---|---|
| `felt` | `-C, --directory <dir>` | Run as if felt was started in `<dir>` |
| `felt` | `-j, --json` | Output in JSON format |
| `shuttle` | `-C, --store <dir>` | Select a felt store root |
| `shuttle` | `-j, --json` | Output in JSON format |
| both | `-h, --help` | Show help for the command |

`felt --version` prints its build version. `shuttle version` reports the
running daemon's version when reachable, otherwise the local Mix release version.

## Core fiber verbs

| Command | Purpose |
|---|---|
| `felt init` | Create or repair the local `.felt/` directory and support files |
| `felt add <slug> <name>` | Create a fiber (`-b` body, `-o` outcome, `-s` status, `-t` tag, `-D` due, `--top-level` to skip placing `<slug>` under an existing fiber of the same leading name) |
| `felt edit <id>` | Modify a fiber's native metadata (`--name`, `-o`, `-s`, `-t`/`--untag`, `-b` body, `-D`, `--set`/`--unset` for opaque scalars) |
| `felt show <id>` | Show a fiber at a given detail level (`-d name\|compact\|summary\|full`; compact and summary report the body's line count; `--body`, `--citations`, `--consumers`, `--field <name>`; `--citations` and `--consumers` search the whole store) |
| `felt rm <id>` | Delete a fiber's file; nested fibers stay where they are. Refuses a guessed id (one resolving only by its last segment or as a prefix completion) and names the fiber it would have reached |
| `felt sync [--push]` | Fetch and merge the actual store repository's upstream; optionally publish committed work to that tracking branch. Leaves conflicts for contextual resolution and never stages, stashes, or force-pushes; a diverged upstream makes a merge commit |

## Search and reading

| Command | Purpose |
|---|---|
| `felt ls [query]` | List and search fibers; `--any field:<name>` / `--any tag:<tag>` (repeatable) admits fibers matching at least one any-filter, ANDed with every other filter; a query, tag, field, any-filter, or id-file filter searches every status but closed. `--ids-from <file>` reads canonical ids without a walk and preserves input order. `--json-field` projects JSON output; `-v` expands matches folded under a matching ancestor |
| `felt find [query]` | Search the whole store, not just this view — local hits first under their local ids, then the rest of the enclosing store under a separator naming it, each by its full id there (those ids work as arguments to `show`, `edit`, `nest`, `rm`, `tree`). Takes `ls`'s matching and filters (`-t`, `-s`, `-r`, `-e`, `--body`, `--has-field`, `-v`, `--limit`, `-j`) |
| `felt session` | Print the SessionStart context as plain text |
| `felt tree [id]` | Show the containment tree, every status included (`-L`/`--depth` caps depth; elided branches show how much is below) |

## Structure

| Command | Purpose |
|---|---|
| `felt nest <child> <parent>` | Move a fiber subtree under a parent, rewriting every reference the move would break (wikilinks, markdown links, `inputs.from`), across the enclosing store too from a view; refuses a guessed id |
| `felt unnest <child>` | Move a nested fiber subtree to the top level, rewriting and refusing as `nest` does |

## Maintenance

| Command | Purpose |
|---|---|
| `felt check` | Report unparseable fibers, empty names, broken wikilinks, `inputs.from` and `depends_on` refs, stale link paths, legacy forms, slug collisions, stray fiber files; exits non-zero on errors |
| `felt migrate` | Normalize legacy storage into the current model, folding stray fiber files into their directories; exits non-zero when a stray cannot fold safely (`--dir`, `--dry-run`) |
| `felt backfill-ids` | Assign ULID ids to fibers missing one (`--dir`, `--dry-run`) |

## Setup / update

| Command | Purpose |
|---|---|
| `felt setup claude` | Install the felt plugin for Claude Code (`--source`, `--uninstall`) |
| `felt setup codex` | Install the felt plugin for Codex (`--source`, `--uninstall`) |
| `felt setup pi` | Install the felt package for pi (`--uninstall`) |
| `felt setup receipt` | Report the Felt executable and promoted/loaded harness generations, hooks, and pending plugin-promotion state (`--json` for the machine-readable receipt, where each bundle's `inspection` is `confirmed` by the harness's plugin list, `configured` from its config and cache alone, or `unknown`) |
| `felt setup skills` | Link felt skills into a target directory (`--source`, `--target`, default `~/.claude/skills`) |
| `felt setup validate --source <checkout>` | Non-mutating validation of a complete local plugin candidate, including both skills and registered hook files |
| `felt uninstall` | Remove the felt plugin from Claude Code and Codex and the felt package from pi (inverse of `setup claude`/`codex`/`pi`) |
| `felt update` | Update the `felt` and `shuttle` Go binaries together, then refresh the Claude Code plugin and any installed Codex or pi integration to the matching tag |

## `felt hook` (agent-harness adapters)

These commands wrap the primary verbs above for agent harnesses, not for
people.

| Command | Purpose |
|---|---|
| `felt hook session` | Emit the SessionStart `additionalContext` envelope |
| `felt hook pretool` | PreToolUse gate: deny non-felt tool calls until the felt skill activates |
| `felt hook posttool` | PostToolUse: stamp `updated-at` when an agent edits a fiber file directly |

## Shuttle hooks

These event and commit adapters are also installed by the felt plugin, but the
`shuttle` binary owns their ledgers and mailbox behavior.

| Command | Purpose |
|---|---|
| `shuttle hook event` | Append one harness event to the host-local activity stream (`~/.shuttle/events.jsonl`) and handle Shuttle mailbox registration/delivery |
| `shuttle hook commit` | Record a commit from a Bash call in the host-local commit ledger (`~/.shuttle/commits.jsonl`) |

## `shuttle` (dispatch layer)

The `shuttle:` block is opaque frontmatter to felt: `felt show -j` and `felt
ls -j` return it without a resolved facet, and felt never validates its schema.
`shuttle` owns that schema and the resolved view. Its local write verbs work
offline and validate before they touch disk. When a fiber's
`shuttle.host` names a remote in the resolved fleet (an enabled entry in
`~/.config/shuttle/remotes.json`, or a tailnet peer the local daemon
discovered),
`pause`, `resume`, `close`, `reopen`, `accept`, `set-agent`, `set-model`,
`set-outcome`, `reshape`, and `uninstall` route through the local daemon to the
owner; `dispatch` does the same. `snapshot`, `dispatch`, `status --all`/`--remote`,
`sessions`, `transcript`, `message`, and
`validate-identity` talk to the local daemon (127.0.0.1:4000 or a unix socket,
per `shuttle host`). `accept` and `resume` on a fiber this host owns go
through its daemon when it answers, which applies them with `--local` inside
its Poller, serialized with the Poller's state changes (a poll read in flight
sees the old document or the new one, written in one atomic step); a daemon
that cannot be reached means the document is written directly. A daemon that
takes the request but does not answer within 5 s is reported ("did not answer
in time … may still apply"), never bypassed with a local write, since the
transition may still land there. `--local` writes the document here and never
routes; on a fiber another host owns it is refused. If routing to an owner is
impossible, the CLI explains why and names the command to run there. For what
the daemon speaks directly, see the [HTTP API](api.md).

### Install / reshape the contract

| Command | Purpose |
|---|---|
| `shuttle install <fiber>` | Install as a one-shot dispatch role (`--project-dir` required unless `--disabled`, `-m` agent, `--surface`, `--host`, `--disabled`) |
| `shuttle repeat <fiber>` | Install as a standing (cron-scheduled) role (`-s/--schedule` and `--project-dir` required, `-z/--tz`, `-m`, `--surface`, `--host`) |
| `shuttle reshape <fiber> [kind]` | Change an existing block's `kind` and/or a standing constitution's schedule (`-s/--schedule`, `-z/--tz`) |
| `shuttle uninstall <fiber>` | Remove the `shuttle:` block; the fiber, its status, and its tags are untouched, and a live worker keeps running |

`install` and `repeat` are create-only: each refuses a fiber that
already carries a `shuttle:` block, pointing at `reshape` (kind/schedule),
`set-model`/`set-agent` (agent), or `uninstall` (start over). A fresh create
settles status (`install`/`repeat` arm to `active`, `install --disabled`
parks at `open`); an arming create refuses a closed fiber — arming
something already reviewed needs an explicit `reopen`. `reshape` touches only the block's shape — `kind`, and a standing
constitution's schedule — and leaves status and verdict fields exactly as found, so a
role in Awaiting review can be reshaped in place without being requeued; `kind`
is optional, so `reshape <fiber> --schedule "0 7 * * *"` is a schedule-only
edit. Lifecycle moves (`pause`/`resume`/`close`/`reopen`/`accept`) are
untouched by any of this.

### Lifecycle

| Command | Purpose |
|---|---|
| `shuttle claim <fiber>` | Associate the current conversation with an installed draft without launching or activating a worker (`--surface cli\|app`, `--session <native-id>`, `--tmux-session <name>`, `--json`) |
| `shuttle pause <fiber>` | Set status to `open`, kill any live worker (`--no-kill` to leave it running) |
| `shuttle resume <fiber>` | Set status to `active`; a standing constitution awaiting review is re-armed and its run concluded (`handed_off_at`), so it runs at the schedule's next tick; any other closed fiber is refused (use `reopen`). Arming requires a `project_dir`: `--project-dir <dir>` sets it on a block without one, and always writes locally. `--local` skips the daemon |
| `shuttle accept <fiber>` | Resolve the human verdict on an untempered standing constitution, closed or still active: it re-arms and its run concludes (`handed_off_at`). The outcome is kept. A oneshot is refused. `--local` skips the daemon |
| `shuttle rest <fiber>` | Put a constitution in Resting without review: `status: open` + `horizon: stashed`, verdict cleared, run concluded, an arrived `due:` cleared, a live worker stopped. Works in any state, including standing and tempered/discarded. `--until YYYY-MM-DD` sets a return day; `--until ''` rests undated. Routes through the owning daemon, which writes it inside its Poller and stops the worker through its backend (tmux or an app interrupt); `--local` writes here and stops nothing, and an unreachable daemon is bypassed with a local write and tmux kill |
| `shuttle reopen <fiber>` | Requeue a closed/reviewed fiber back to active (`--as-draft` for `open` instead). From another host, a default reopen starts a fresh worker on the owner; `--message <text>` or `--message-file <path>` adds its launch directive on that remote route. Arming requires a `project_dir`: `--project-dir <dir>` sets it on a block without one |
| `shuttle close <fiber>` | Set status to `closed`; set/clear `tempered` (`--tempered=true\|false`) |
| `shuttle set-agent <fiber> [agent]` | Save next-launch agent and axes (`--effort`, `--chrome`, `--surface`, `--project-dir`); leaves the current session running |
| `shuttle set-model <fiber> <agent>` | Change only the dispatch agent, preserving runtime keys; a `surface: app` block can only move to another Codex agent here (use `set-agent … --surface cli` to leave the app) |
| `shuttle seat <fiber> [role]` | Make the constitution a seat of a role (`shuttle.seat`), or `--clear` it. The role resolves like `assign --role` and must have a charter under `roles/`; the slug is stored. Lifecycle and roster are untouched; routes to the owning daemon like the other block writers |
| `shuttle assign <fiber>` | Add roster membership with repeatable `--role <name/path/UID>` and `--collaborator <name/path/UID>` flags; replace the whole roster with `--json-assignment <JSON>` or remove it with `--clear`. References resolve under `roles/` and are stored as readable role/collaborator slugs; preserves lifecycle and execution settings |
| `shuttle ask <fiber> "<one-line question>"` | Raise a non-blocking question for the human in `shuttle.ask: {text, at}`; the worker keeps working and its In flight card appears in **Question** above **Working**. `--clear` removes it. Resume, reopen, and messaging the fiber's worker clear it too. Works offline and accepts `-C <store>` |
| `shuttle set-outcome <fiber>` | Set the `outcome:` field (`--outcome`, or stdin for multi-line) |
| `shuttle handoff <fiber>` | Stamp the clean-exit signal; a worker's final action before its tmux session ends |

To adopt your current conversation, install the constitution with
`shuttle install <fiber> --disabled --project-dir <dir> -m <agent>`, then run
`shuttle claim <fiber>` and, only after it succeeds, `shuttle resume <fiber>`.
Terminal claims identify the current tmux pane; `--tmux-session` supplies an
explicit existing session. App claims use `CODEX_THREAD_ID` or `--session`
and require the daemon to verify the native conversation. The claimed host
and surface must match the installed task. If verification fails, leave the
constitution open; activating it could launch another worker.

### Read / inspect

| Command | Purpose |
|---|---|
| `shuttle ls [query]` | Felt-compatible fiber listing/search with Shuttle's resolved facet in JSON output |
| `shuttle show <id>` | Felt-compatible fiber read with Shuttle's resolved facet in JSON output |
| `shuttle check` | Validate every `shuttle:` block in the selected store and report host drift |
| `shuttle status [fiber]` | One line per shuttle-managed fiber, closed ones hidden from the table (`--closed` shows them; `--json` always includes them; `--all`, `--remote <name>` — mutually exclusive, `--include-orphans`); with a fiber, a detailed single-fiber report ending in a dispatch verdict: eligible on which host (status and host ownership, noting a missing `project_dir`), or the verb that makes it so |
| `shuttle ps` | Live tmux worker sessions only |
| `shuttle snapshot` | Print the local daemon's state snapshot |
| `shuttle dispatch <fiber>` | Ask the daemon to dispatch a fiber now (`--ad-hoc`); remote owners route through this host's daemon. `--message <text>` or `--message-file <path>` adds a launch directive |
| `shuttle sessions [fiber\|session-uuid]` | With no argument, list live native sessions across the fleet (`--host`, `--harness`, `--json`); JSON rows include `fiber` when the host's session ledger records a pairing. With a fiber or session, show the composite ledger by UID, including historical paths, lifecycle events, hosts, harnesses, staleness, transcript availability, and a canonical `address` when the row can be addressed. A session UUID or `--commit <sha>` reverse-resolves the owning fiber and its disposition; `--materialize [--dir <d>]` resolves every available transcript to an ordinary local file and writes a `manifest.json` |
| `shuttle message <target> [text\|-]` | Send to a full address, a unique native session ID, or a fiber path, slug, or UID, which resolves to its recorded worker session (`--attach`, `--file`, `--context-only`, `--from`, `--message-id`, `--json`). Session IDs resolve through live discovery and the session ledger; ambiguous IDs list their candidate addresses. `-` and `--file -` read multiline text; repeat `--attach <path>` to include binary files. Receipts print the resolved canonical address and message ID for a safe explicit retry |
| `shuttle transcript <session-id>` | Print the native transcript path when local, or verify and materialize an exact remote copy in the managed cache; inspect it with the harness's ordinary `jq`/`rg` recipes (`--json` for metadata and paths) |
| `shuttle agents [resolve <agent>]` | List the effective agent registry (`--source builtin\|user`), or resolve one agent with its axes (`--effort`, `--chrome`) |
| `shuttle agents init` | Seed `~/.config/shuttle/agents.json` from the built-ins (`--path`, `--force`) |
| `shuttle agents effort <agent> <level>` | Set an agent's default effort as an `overrides` entry in the user registry (`--reset` removes it) |
| `shuttle attach <fiber>` | Attach to a running worker's tmux session |
| `shuttle session-name <fiber>` | Print the canonical tmux session name for a fiber |

`attach`, `session-name`, and fiber message targets require one exact match across
configured stores; they refuse guessed paths and duplicate matches.

### Daemon and host operations

| Command | Purpose |
|---|---|
| `shuttle doctor` | Diagnose the shuttle binary, host identity/configuration, listener, daemon contract, and tmux integration |
| `shuttle daemon start [--force]` | Start the local Mix release in the foreground |
| `shuttle daemon stop` | Stop the local daemon and mark the shutdown as intentional |
| `shuttle daemon status` | Print daemon state; exits 2 when the daemon is down |
| `shuttle daemon release` | Release the boot quarantine |
| `shuttle daemon reset <remote>` | Reset a remote's circuit breaker |
| `shuttle daemon install [options]` | Install the per-user keep-alive supervisor; `--stores` pins its store list, `--codex-socket` persists an explicit Codex endpoint (`--codex-socket=` clears it) |
| `shuttle daemon uninstall [--label <name>]` | Remove the per-user keep-alive supervisor |
| `shuttle version` | Print the running daemon version or, when it is down, the local Mix release version |

`shuttle` reads ordinary fiber data through felt's Go library. The daemon
shells out to `felt` for fiber content and writes and to `shuttle` for resolved
views and Shuttle-owned operations.

### Codex desktop bridge

`shuttle codex-desktop-bridge` adapts the desktop application's JSONL
`CODEX_CLI_PATH` protocol to a native Codex App Server websocket. It execs the
bundled native executable in the original desktop-child process, preserving
the signed Desktop → Codex → app-tools ancestry. A separate relay child owns
the desktop JSONL pipes, the private Unix socket lock, and shutdown monitoring.
The relay stays in the native private process group, pinning its identity until
shutdown. Desktop stdin EOF or a relay signal stops the native process. Native
exit cancels the relay even when desktop stdout is blocked. After confirmed
native exit, the relay removes only the observed socket inode, then terminates
its entire private group, including itself and any surviving MCP descendants.

Native arguments and environment are preserved, including app-tools pipe
variables. `CODEX_CLI_PATH` points at the real executable for nested launches.
Non-server invocations exec the native binary directly, retaining its exit code.

```sh
shuttle codex-desktop-bridge --codex /absolute/path/to/codex -- \
  -c features.code_mode_host=true app-server \
  --analytics-default-enabled \
  -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true
```

The default endpoint is `$CODEX_HOME/shuttle-desktop/app-server.sock`; use
`--socket` (or the configured `SHUTTLE_CODEX_SOCKET`) when Shuttle's native
transport needs a different private path. A pre-existing endpoint, an
endpoint owned by another user, or a directory accessible by other users is
refused. A stale endpoint should only be removed after its owning process has
been verified stopped.

See [Desktop installation and rollback](../shuttle/codex-desktop.md) for
explicit endpoint configuration, durable launch setup, and acceptance checks.

### Session discovery and messaging

No-argument `sessions` may report a Claude, Codex, or Pi receiver with `state: "hook"`. This
means a supported hook registered the session for queued context; it does not
claim that a model turn is live. `last_seen` records the latest registration in
Unix milliseconds. A registration names the receiver's harness process and is
listed only while that process runs; a context-only message to a receiver
whose process has exited is rejected rather than queued. Peer JSON
rows include the fiber path when the session ledger records its pairing, and
provenance rows include a canonical `address` when the host and harness are known.
Messages wake idle receivers or steer ongoing work by default:

```bash
shuttle sessions --json
shuttle message <address> "Please review the results" --attach results.csv
shuttle message <address> "Background for your next task" --context-only
```

`shuttle message` accepts that address, a unique native session ID, or a
Shuttle fiber path, slug, or UID with a recorded worker. Fiber targets require
one exact match across configured stores; they refuse guesses and duplicate
matches, and a slug naming several fibers is refused with their full paths. A fiber resolves to the worker in its newest dispatch, resume, or
claim ledger row, which the owning host writes. When the fiber's
`shuttle.runtime.session_uuid` or another live session registered for the
fiber differs, the command notes it on stderr and still uses the ledger's
worker. A fiber with no ledger row, an unavailable ledger, or a stale or
failing ledger feed from the worker's host or the fiber's owning host is
refused, since a newer worker there could be missing.
A Codex App ledger row keeps its transcript id in `session` and its address id
in `thread_id`; a Codex row whose thread id cannot be established is refused. Ambiguous session IDs fail with
their candidate addresses. Addresses
use `claude`, `codex`, and `pi`; the ledger spelling `claude-code` normalizes
to `claude`.

`--context-only` queues or adds context without starting a turn or invoking native
steering. Hooks offer queued context when the receiver next prompts or uses a
tool; Pi offers it before the next agent turn. `--wake` remains an explicit alias
for the default; `--wake=false` is equivalent to `--context-only`.

Shuttle routes to the configured owner host and its live harness integration.
Claude uses its receiver-registered native inbox; Codex uses the owning App
Server; Pi uses the Felt extension's native endpoint. Existing Confer Pi workers
also remain addressable, but standalone Pi sessions do not require Confer.
Hooks alone cannot wake Claude or Codex: install and enable the receiver's hooks
for context delivery, and use a supported live native endpoint for wake.
A failed wake never silently becomes a context-only send. Pending native input
or approval is handled by the harness, not by injecting terminal keystrokes.

Receipts describe delivery evidence, not task completion. HTTP 200 carries a
processed delivery receipt, including `rejected` and `unknown`. HTTP 400 reports
`invalid_address`, `wrong_host`, `invalid_request`, `unsupported_harness`, or
`preflight_failed`; preflight refusals may include a rejection receipt. HTTP 409
reports `message_id_conflict` when an ID is reused for changed content. Other
rejected receipts—including `session_unavailable`, `session_not_found`,
`wake_required`, and `wake_refused`—return 200. HTTP 5xx means the Shuttle CLI did not
provide a valid receipt or the owner could not be reached; the daemon may
include a synthetic `unknown` receipt. `shuttle message` exits 0 for
`accepted`, `submitted`, `queued`, and `context_added`; it exits 1 for
`rejected`, `unknown`, or another command error. A target that does not
resolve, is ambiguous, or has no session-ledger worker fails before any
request is sent, with exit 1 and no receipt. Once resolved, it prints
`sending <id> to <resolved address>` to stderr before delivery; if interrupted,
retry with `--message-id <printed id>`.

Retry an uncertain delivery with the identical request and the same
`--message-id`, never a fresh ID. A concurrent attempt waits until the owner's
recorded observation deadline plus 1.5 seconds, capped by its own request
deadline. A later Claude-native retry of a completed `queued`, `submitted`, or
`unknown` receipt rechecks the transcript for up to two seconds from its saved
offset and upgrades the status when it finds later evidence; it never resends
the message. Records without an offset return their stored receipt unchanged.
Changed content requires a new message ID.

Claude preserves its native inbound hold/refuse policy. For a wake, `queued`
means Claude put the message behind its current turn; `submitted` means the
transcript shows native admission without a model reply; `accepted` requires a
correlated real assistant reply. If the observer sees no admission stage, the
receipt is `unknown`, even if Claude processes the message later. Context-only
messages use separately enabled Shuttle hooks. To disable those
hooks' message registration and delivery, set `SHUTTLE_MESSAGES=off` in the
receiver environment. Installing hook files does not establish that the harness
has enabled or trusted them; discovery reflects receiver registration.

| Receipt | Evidence |
|---|---|
| `queued` | Hook mailbox: context-only, no turn starts. Claude-native wake: queued behind the current turn; the detail says it runs when that turn ends |
| `submitted` | Claude transcript shows the native user row or `queued_command`; admission only, with no model reply observed yet |
| `context_added` | Codex acknowledged adding persistent context; no turn started |
| `accepted` | Claude has a correlated real assistant reply; other transports report their native runtime acknowledgement |
| `unknown` | Delivery may have succeeded without enough evidence; retry the same ID to re-check |
| `rejected` | The request or receiving transport refused delivery |

No receipt proves that a model read, acted on, or integrated the message.
Hook offers can repeat if the receiver crashes after writing context but before
recording the offer; message IDs remain stable. Repeating the identical send
with the same `--message-id` retrieves its recorded result without redelivery.
Sender labels are self-reported. Automatic `--from` detection supplies a native
session address; if the receiver uses another routing alias for that host,
resolve the reply address through its own `sessions` output.

Receipts and queued payloads stay under `$SHUTTLE_DATA_DIR` (default
`~/.shuttle`; trimmed, with a leading `~` expanded), outside the project. Payloads offered by hooks are retained there
for diagnosis. `SHUTTLE_CODEX_SOCKET` and `SHUTTLE_CONFER_STATE_DIR` override
native discovery locations when a harness uses a nondefault runtime directory.

Attach up to eight files totaling 20 MiB with the same command:

```sh
shuttle message <address> "Here are the notes and plot" --attach notes.txt --attach plot.png
shuttle message <address> --attach results.pdf
```

Attachments are stable copies, stored outside the project on the receiving
host. The receiver verifies each SHA-256 digest before delivering a common
message containing local paths; each harness receives the same file references.
The JSON receipt's `files` list gives the copied name, path, digest, and size.
This confirms stored bytes, not that the recipient opened or understood them.
An identical retry returns the original receipt; changed bytes under the same
message ID are refused. An older daemon that cannot receive attachments refuses
the whole file message instead of dropping its files.

`--file` supplies message text. `--attach` transfers file bytes to another
session. `shuttle send-file` publishes artifacts to the human's IDE using
the existing owner-served file surface.

### Fleet / operator plumbing

| Command | Purpose |
|---|---|
| `shuttle remotes list` | List the fleet: the file's entries (disabled ones included) and the local daemon's discovered tailnet peers, with a SOURCE column (`configured` or `discovered`) and a line on discovery's state; an unreachable daemon lists the file alone and says so. Validates paths, proxy/dial exclusivity, duplicate names, and port collisions. `--configured` lists and validates the file alone; `--json` adds `discovery` (or `discovery_error`) to the normalized document |
| `shuttle remotes add <name>` | Add or replace a remote in the file (`--port` or `--url`, `--ssh`, `--remote-port`, `--remote-socket`, `--display`, `--checkout`, `--multiplex`, `--tunnel-manager`) |
| `shuttle remotes rm <name>` | Remove a remote from the file; a discovered peer is suppressed with an `"enabled": false` entry instead |
| `shuttle remotes path` | Print the fleet file path (`~/.config/shuttle/remotes.json`) |
| `shuttle host` | Print this host's id, class and daemon listener (`--json` gives `{id, class, class_source, listen, listen_source, file, data_dir}`; the daemon reads its host id from it at boot, and the stop scripts put `heartbeat.stopped` in `data_dir`) |
| `shuttle host seed` | Write this host's id to `~/.shuttle/host` (or `$SHUTTLE_HOST_FILE`) unless it already holds one: `$SHUTTLE_HOST`, else the normalized hostname. `shuttle daemon install` runs it |
| `shuttle host class <class>` | Set this host's trust class in `~/.config/shuttle/host.json` (`single-user`, `shared-multi-user`, `exposed`) |
| `shuttle host check-owner` | Verify that a socket-class TCP listener belongs to this user, from `/proc/net/tcp{,6}` (a no-op for Unix listeners and off Linux) |
| `shuttle tunnels install [name ...]` | Write (and optionally bootstrap) autossh tunnels for the named remotes, or all enabled remotes if none are given (`--unit-dir`, `--log-dir`, `--autossh-path`, `--write-only`, `--dry-run`). launchd on macOS, systemd user units on Linux |
| `shuttle validate-identity` | Check federated fiber UID invariants across daemon feeds (`--daemon-url`, repeatable, to check other hosts) |
| `shuttle contract` | Print the daemon-facing CLI contract version (used at daemon boot to detect a stale CLI) |
| `shuttle mark-runtime <fiber>` | Stamp `shuttle.runtime` continuation fields (`--dispatched-at`, `--session`, `--run-id`, `--handed-off-at`, `--meeting`; at least one required); daemon-facing, not for manual use |

!!! note
    `shuttle remotes`, `tunnels`, `validate-identity`, `contract`, and
    `mark-runtime` serve daemon and fleet plumbing. An adopter running
    shuttle solo will not need them.

### `shuttle send-file <path> [path...]`

Publish readable regular files to the Shuttle Board and the session/fiber sent-files
trail. Claude, Codex and Pi sessions use this command. Paths are resolved to absolute
paths on the owning host; files must remain there for subsequent viewing.
The command validates the whole batch before recording one `file_sent` event.
It fails visibly if attribution or recording is unavailable.

Session identity comes from `--session`; else `PI_SESSION_ID` when
`AI_AGENT=pi` (Pi's own marker, so Pi nested under another harness is
attributed to Pi); else the first set of `CODEX_THREAD_ID`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID`, `PI_SESSION_ID`; else the
current tmux session's local ledger. `shuttle message` derives its
automatic `--from` the same way. A worker's tmux name identifies its
fiber. Outside a harness, pass `--session <native-session-id>`.
The event stream uses the same configuration as `shuttle hook event`; recording
works offline and confirms registration, not a completed client download.
The daemon also reads `SendUserFile` hook events as sends.

### `shuttle follow <transcript>`

Stream a live meeting transcript to an agent in batches, each followed by one
blank line. Run it under a harness monitor that reads stdout as it arrives.
The file may not exist yet; follow waits for it. Everything already in the file
at the first read is printed at once. After that, new complete lines are held
until a line addresses the agent (a whole word from `--names`, case-insensitive,
default `claude,cloud,clawed,klaud`, matched after any leading `HH:MM:SS`
timestamp or `HH:MM:SS-HH:MM:SS` range), the pending utterance text reaches `--words` (default 150), or
`--seconds` (default 15) pass since the first pending line arrived. A line
starting `# ended` flushes and ends the follow with exit 0. Lines starting `#`
ride along without counting words or addressing the agent. A partial trailing
line waits for its newline, a file that shrinks is read again from the start,
and the file is polled once per second.
