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
| `felt setup skills` | Link felt skills into a target directory (`--source`, `--target`, default `~/.claude/skills`) |
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
| `felt hook event` | Append one harness hook event to the host-local Shuttle activity stream (`~/.shuttle/events.jsonl`) |

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
| `felt shuttle set-agent <fiber> [agent]` | Set dispatch agent and/or axes (`--effort`, `--chrome`) |
| `felt shuttle set-model <fiber> <agent>` | Change only the dispatch agent, preserving runtime keys |
| `felt shuttle set-outcome <fiber>` | Set the `outcome:` field (`--outcome`, or stdin for multi-line) |
| `felt shuttle handoff <fiber>` | Stamp the clean-exit signal; a worker's final action before its tmux session ends |

### Read / inspect

| Command | Purpose |
|---|---|
| `felt shuttle status [fiber]` | One line per shuttle-managed fiber (`--all`, `--remote <name>` — mutually exclusive, `--include-orphans`); with a fiber, a detailed single-fiber report including the daemon's dispatch assessment |
| `felt shuttle ps` | Live tmux worker sessions only |
| `felt shuttle snapshot` | Print the local daemon's state snapshot |
| `felt shuttle dispatch <fiber>` | Ask the local daemon to dispatch a fiber now (`--ad-hoc`) |
| `felt shuttle agents [resolve <agent>]` | List (or resolve) the effective agent registry (`--source builtin\|user`) |
| `felt shuttle agents init` | Seed `~/.config/felt/agents.json` from the built-ins (`--path`, `--force`) |
| `felt shuttle attach <fiber>` | Attach to a running worker's tmux session |
| `felt shuttle session-name <fiber>` | Print the canonical tmux session name for a fiber |

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
    Shuttle solo will not need them — see
    [Honest scoping](../shuttle/index.md#honest-scoping).
