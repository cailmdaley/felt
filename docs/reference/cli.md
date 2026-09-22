# CLI Reference

This page lists every `felt` verb, grouped by area. Scan it to find a command.
Then read that command's `--help` text, which adds examples and the full
story.

Every command accepts these global flags:

| Flag | Purpose |
|---|---|
| `-C, --directory <dir>` | Run as if felt was started in `<dir>` |
| `-j, --json` | Output in JSON format |
| `-h, --help` | Show help for the command |

`felt -v` / `felt --version` prints the version. `felt shuttle` also accepts
`--felt-store <dir>` as an alias for `-C`.

## Core fiber verbs

| Command | Purpose |
|---|---|
| `felt init` | Create or repair the local `.felt/` directory and support files |
| `felt add <slug> <name>` | Create a new fiber (`-b` body, `-o` outcome, `-s` status, `-t` tag, `-D` due, `--top-level`) |
| `felt edit <id>` | Modify a fiber's native metadata (`--name`, `-o`, `-s`, `-t`/`--untag`, `-b` body, `-D`, `--set`/`--unset` for opaque scalars) |
| `felt show <id>` | Show a fiber at a given detail level (`-d name\|compact\|summary\|full`; compact and summary report the body's line count; `--body`, `--citations`, `--consumers`, `--field <name>`) |
| `felt rm <id>` | Permanently delete a fiber |

## Search and reading

| Command | Purpose |
|---|---|
| `felt ls [query]` | List and search fibers (`-t` tag, `-s` status, `-n` recent N, `-r` regex, `-e` exact, `--body`, `--has-field`, `--json-field`; a query or tag filter searches every status but closed, counting closed matches in a trailing hint; matches under a matching ancestor collapse into it, `-v` expands) |
| `felt find [query]` | Search the whole store, not just this view — local hits first under their local ids, then the rest of the enclosing store under a separator naming it, each by its full id there (those ids work as arguments to `show`, `edit`, `rm`, `shuttle`). Takes `ls`'s matching and filters (`-t`, `-s`, `-r`, `-e`, `--body`, `-v`, `--limit`, `-j`) |
| `felt session` | Print the SessionStart context as plain text |
| `felt tree [id]` | Show the containment tree (`-L`/`--depth` caps depth; elided branches show how much is below) |

## Structure

| Command | Purpose |
|---|---|
| `felt nest <child> <parent>` | Move a fiber subtree under a parent, rewriting ids and dependencies |
| `felt unnest <child>` | Promote a nested fiber subtree to the top level |

## Maintenance

| Command | Purpose |
|---|---|
| `felt check` | Lint fibers: broken wikilinks, broken `inputs.from` refs, legacy keys, slug collisions |
| `felt migrate` | Normalize legacy storage into the current model (`--dir`, `--dry-run`) |
| `felt backfill-ids` | Assign ULID ids to fibers missing one (`--dir`, `--dry-run`) |

## Setup / update

| Command | Purpose |
|---|---|
| `felt setup claude` | Install the felt plugin for Claude Code (`--source`, `--uninstall`) |
| `felt setup codex` | Install the felt plugin for Codex (`--source`, `--uninstall`) |
| `felt setup receipt` | Report the executable, promoted and actually loaded harness generations, hooks, pending promotion state, and live daemon contract (`--json` for the machine-readable receipt) |
| `felt setup skills` | Link felt skills into a target directory (`--source`, `--target`, default `~/.claude/skills`) |
| `felt setup validate --source <checkout>` | Non-mutating validation of a complete local plugin candidate (`--executable` overrides the felt binary probed for contract compatibility) |
| `felt uninstall` | Remove the felt plugin from Claude Code and Codex (inverse of `setup claude`/`setup codex`) |
| `felt update` | Update felt to the latest version, refreshing plugin wiring too |

## `felt hook` (agent-harness adapters)

These commands wrap the primary verbs above for agent harnesses, not for
people.

| Command | Purpose |
|---|---|
| `felt hook session` | Emit the SessionStart `additionalContext` envelope |
| `felt hook pretool` | PreToolUse gate: deny non-felt tool calls until the felt skill activates |
| `felt hook posttool` | PostToolUse: stamp `updated-at` when an agent edits a fiber file directly |
| `felt hook event` | Append one harness hook event to the host-local shuttle activity stream (`~/.shuttle/events.jsonl`) |

## `felt shuttle` (dispatch layer)

These optional verbs apply once a fiber carries a `shuttle:` block. Write verbs
work offline, and validate before they touch disk. A few read verbs talk to the
local daemon at `:4000`; for what that daemon speaks directly, see the [HTTP
API](api.md).

### Install / reshape the contract

| Command | Purpose |
|---|---|
| `felt shuttle install <fiber>` | Install as a one-shot dispatch role (`--project-dir` required unless `--disabled`, `-m` agent, `--host`, `--disabled`) |
| `felt shuttle pin <fiber>` | Install as a pinned, schedule-less perennial role (`--project-dir` required, `-m`, `--host`) |
| `felt shuttle repeat <fiber>` | Install as a standing (cron-scheduled) role (`-s/--schedule` and `--project-dir` required, `-z/--tz`, `-m`, `--host`) |
| `felt shuttle reshape <fiber> [kind]` | Change an existing block's `kind` and/or a standing role's schedule (`-s/--schedule`, `-z/--tz`) |
| `felt shuttle uninstall <fiber>` | Remove the `shuttle:` block; fiber and felt status untouched |

`install`, `pin`, and `repeat` are create-only: each refuses a fiber that
already carries a `shuttle:` block, pointing at `reshape` (kind/schedule),
`set-model`/`set-agent` (agent), or `uninstall` (start over). A fresh create
settles status (`install`/`repeat` arm to `active`, `pin` parks at `open`) and
refuses a closed fiber — arming something already reviewed needs an explicit
`reopen`. `reshape` touches only the block's shape — `kind`, and a standing
role's schedule — and leaves status and verdict fields exactly as found, so a
role in Awaiting review can be reshaped in place without being requeued; `kind`
is optional, so `reshape <fiber> --schedule "0 7 * * *"` is a schedule-only
edit. Lifecycle moves (`pause`/`resume`/`close`/`reopen`/`accept`) are
untouched by any of this.

### Lifecycle

| Command | Purpose |
|---|---|
| `felt shuttle pause <fiber>` | Set status to `open`, kill any live worker (`--no-kill` to leave it running) |
| `felt shuttle resume <fiber>` | Set status to `active`; the sole dispatch gate |
| `felt shuttle accept <fiber>` | Resolve a human verdict on a role awaiting review (kind-aware re-arm/re-park; `--keep-outcome`) |
| `felt shuttle reopen <fiber>` | Requeue a closed/reviewed fiber back to active (`--as-draft` for `open` instead) |
| `felt shuttle close <fiber>` | Set status to `closed`; set/clear `tempered` (`--tempered=true\|false`) |
| `felt shuttle set-agent <fiber> [agent]` | Save next-launch agent and axes (`--effort`, `--chrome`, `--surface`); leaves the current session running |
| `felt shuttle set-model <fiber> <agent>` | Change only the dispatch agent, preserving runtime keys |
| `felt shuttle assign <fiber>` | Set optional collaborator/role references (`--collaborator <UID> --collaborator-origin <host>`, `--role <UID> --role-origin <host>`), replace with `--json-assignment <JSON>`, or remove with `--clear`, `--clear-collaborator`, `--clear-role`. Preserves lifecycle and execution settings; also works on fibers without a shuttle block |
| `felt shuttle set-outcome <fiber>` | Set the `outcome:` field (`--outcome`, or stdin for multi-line) |
| `felt shuttle handoff <fiber>` | Stamp the clean-exit signal; a worker's final action before its tmux session ends |

### Read / inspect

| Command | Purpose |
|---|---|
| `felt shuttle status [fiber]` | One line per shuttle-managed fiber, closed ones hidden from the table (`--closed` shows them; `--json` always includes them; `--all`, `--remote <name>` — mutually exclusive, `--include-orphans`); with a fiber, a detailed single-fiber report including the daemon's dispatch assessment |
| `felt shuttle ps` | Live tmux worker sessions only |
| `felt shuttle snapshot` | Print the local daemon's state snapshot |
| `felt shuttle dispatch <fiber>` | Ask the local daemon to dispatch a fiber now (`--ad-hoc`) |
| `felt shuttle sessions [fiber\|session-uuid]` | With no argument, list live native harness sessions addressable across the fleet (`--host`, `--harness`, `--json`). With a fiber or session, preserve the provenance view: discover the composite session ledger by UID, including historical paths, lifecycle events, hosts, harnesses, staleness, and transcript availability. A session UUID or `--commit <sha>` reverse-resolves the owning fiber and its disposition through the ledgers; `--materialize [--dir <d>]` resolves every available transcript to an ordinary local file and writes a `manifest.json` |
| `felt shuttle message <address> [text\|-]` | Send text and files to the exact session address returned by `sessions` (`--attach`, `--file`, `--wake`, `--from`, `--message-id`, `--json`). `-` and `--file -` read multiline message text; repeat `--attach <path>` to include binary files. Receipts report the transport result and the message ID needed for a safe explicit retry |
| `felt shuttle transcript <session-id>` | Print the native transcript path when local, or verify and materialize an exact remote copy in the managed cache; inspect it with the harness's ordinary `jq`/`rg` recipes (`--json` for metadata and paths) |
| `felt shuttle agents [resolve <agent>]` | List (or resolve) the effective agent registry (`--source builtin\|user`) |
| `felt shuttle agents init` | Seed `~/.config/felt/agents.json` from the built-ins (`--path`, `--force`) |
| `felt shuttle attach <fiber>` | Attach to a running worker's tmux session |
| `felt shuttle session-name <fiber>` | Print the canonical tmux session name for a fiber |

No-argument `sessions` may report a Claude or Codex receiver with `state: "hook"`. This
means a supported hook registered the session for queued context; it does not
claim that a model turn is live. `last_seen` records the latest registration in
Unix milliseconds. An abnormal exit can leave a registration behind.
Hook delivery never wakes a session: queued context is offered by the next
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, or `PostToolUse` hook.
The existing `felt hook event` integration registers these receivers;
`SHUTTLE_MESSAGES=off` disables registration and offers for that hook process.

Messaging uses the configured fleet transport to reach the owning daemon.
Each owner discovers its own harnesses; network reachability alone does not
provide a messaging transport. Codex app-server sessions use the runtime's
Unix control socket. Claude receiver hooks register its native inbox socket and
transcript; explicit wake uses that live process, without launching a second
session. CLI context-only delivery uses supported hooks. Pi sessions use
Confer's existing Unix RPC socket and require `--wake` because its message
operation can start a turn. Terminal keystrokes are not a messaging transport.

Task handoffs that should begin without a human prompt use
`felt shuttle message <address> "task" --wake`. For an idle managed Codex session,
this calls the owning runtime's turn-start operation. For a running session it
steers the current turn; it does not schedule an additional turn after completion.
Codex sessions waiting on approval or user input reject wake until that native
input is resolved. Pi acknowledges either an active steer or a follow-up prompt.
The hook mailbox adapters reject wake when no native wake endpoint is registered
and remain usable for context-only sends.
Discovery capabilities describe the available adapter, not every feature a
harness vendor offers.

A wake request cannot succeed with a `queued`, `context_added`, or `submitted`
receipt. If a peer returns one after dispatch, Shuttle reports an unverified
outcome and does not retry automatically. A missing acknowledgement after sending
is `unknown`, even when the underlying worker reports a generic failure. Retrying
the same message ID retrieves the recorded outcome; it cannot force redelivery.

Claude native wake checks the registered socket and process identity, then waits
for a real assistant response descended from the exact message in the receiver's
transcript. A socket write or synthetic API-error response is insufficient.
Native inbox hold remains `unknown` with an explicit held detail; native refusal
is `rejected`. Shuttle preserves the receiver's inbound policy and does not use
its child authentication token. Missing model evidence before the bounded wait
expires remains `unknown`, even if processing later succeeds. Auth-required
native endpoints need supported peer authentication before they can be used.
Claude's native inbound setting governs this wake transport. Context-only sends
use the separately installed Shuttle mailbox hooks; native inbox refusal does
not disable that channel. `SHUTTLE_MESSAGES=off` disables hook registration and
mailbox offers in that receiver.
Pi wake acceptance requires the worker's correlated native acknowledgement;
workers without that evidence return `unknown` and need an updated Confer worker.

| Receipt | Evidence |
|---|---|
| `queued` | Stored in the receiver's host-local hook mailbox; no turn started |
| `context_added` | Codex acknowledged adding persistent context; no turn started |
| `accepted` | The native runtime acknowledged a steer, turn start, or Pi message |
| `unknown` | A delivery attempt may have succeeded; do not resend under a new ID |
| `rejected` | Validation or the receiving transport refused this request |

No receipt proves that a model read, acted on, or integrated the message.
Hook offers can repeat if the receiver crashes after writing context but before
recording the offer; message IDs remain stable. Repeating the identical send
with the same `--message-id` retrieves its recorded result without redelivery.
Sender labels are self-reported. Automatic `--from` detection supplies a native
session address; if the receiver uses another routing alias for that host,
resolve the reply address through its own `sessions` output.

Receipts and queued payloads stay under `$SHUTTLE_DATA_DIR` (default
`~/.shuttle`), outside the project. Payloads offered by hooks are retained there
for diagnosis. `SHUTTLE_CODEX_SOCKET` and `SHUTTLE_CONFER_STATE_DIR` override
native discovery locations when a harness uses a nondefault runtime directory.

Attach up to eight files totaling 20 MiB with the same command:

```sh
felt shuttle message <address> "Here are the notes and plot" --attach notes.txt --attach plot.png
felt shuttle message <address> --attach results.pdf
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
session. `felt shuttle send-file` publishes artifacts to the human's IDE using
the existing owner-served file surface.

### Fleet / operator plumbing

| Command | Purpose |
|---|---|
| `felt shuttle remotes list` | List the configured remote daemons; also the validator (parse errors, duplicate names, port collisions) |
| `felt shuttle remotes add <name>` | Add or replace a remote (`--port`, `--ssh`, `--remote-port`, `--display`, `--checkout`, `--multiplex`) |
| `felt shuttle remotes rm <name>` | Remove a remote |
| `felt shuttle remotes path` | Print the fleet file path (`~/.config/felt/remotes.json`) |
| `felt shuttle tunnels install [name ...]` | Write (and optionally bootstrap) autossh tunnels for the named remotes, or all enabled remotes if none are given (`--unit-dir`, `--log-dir`, `--autossh-path`, `--write-only`). launchd on macOS, systemd user units on Linux |
| `felt shuttle validate-identity` | Check federated fiber UID invariants across daemon feeds (`--daemon-url`, repeatable, to check other hosts) |
| `felt shuttle contract` | Print the daemon-facing CLI contract version (used at daemon boot to detect a stale CLI) |
| `felt shuttle mark-runtime <fiber>` | Stamp `shuttle.runtime` continuation fields (`--dispatched-at`, `--session`, `--run-id`, `--handed-off-at`; at least one required); daemon-facing, not for manual use |
| `felt shuttle migrate-runtime` | Lift flat legacy runtime keys into the nested `shuttle.runtime` block (`--dir`, `--host`, `--dry-run`) |

!!! note
    `felt shuttle remotes`, `tunnels`, `validate-identity`, `mark-runtime`, and
    `migrate-runtime` serve daemon and fleet plumbing. An adopter running
    shuttle solo will not need them.

### `felt shuttle send-file <path> [path...]`

Publish readable regular files to the Shuttle Board and the session/fiber sent-files
trail. Both Claude and Codex use this command. Paths are resolved to absolute
paths on the owning host; files must remain there for subsequent viewing.
The command validates the whole batch before recording one `file_sent` event.
It fails visibly if attribution or recording is unavailable.

Session identity comes from `--session`, `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID`,
or the current tmux session's local ledger. A worker's tmux name identifies its
fiber. Outside a harness, pass `--session <native-session-id>`.
The event stream uses the same configuration as `felt hook event`; recording
works offline and confirms registration, not a completed client download.
Legacy `SendUserFile` hook events remain supported.
