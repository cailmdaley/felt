# Working with Agents

felt ships as a plugin for [Claude Code](https://claude.com/claude-code) and
[Codex](https://developers.openai.com/codex). The plugin makes an agent
fiber-aware. It shows the agent the active fibers at session start. It nudges
the agent toward felt instead of raw file edits. It keeps fiber timestamps
honest when the agent edits a fiber file directly.

## Requirement: both Go CLIs on `PATH`

The plugin uses two binaries. Felt-owned hooks call `felt`; activity and commit
hooks call `shuttle`. Each adapter fails quietly when its binary is absent.

- In a terminal-launched session this is usually fine — your shell's `PATH`
  carries over.
- A GUI-launched agent (no shell profile sourced) can miss `~/.local/bin` or
  wherever the binaries landed. If session context or activity records are
  missing, check `PATH` first.
- The daemon also needs both binaries server-side: it shells `felt` for fiber
  content and writes, and `shuttle` for resolved reads and orchestration. A
  missing executable degrades the corresponding board operations.

## Installing the plugin

```bash
felt setup claude    # Claude Code
felt setup codex     # Codex
felt setup pi        # pi (@earendil-works/pi-coding-agent)
```

Claude setup wraps the official plugin-marketplace flow:

```bash
# Claude Code
claude plugin marketplace add cailmdaley/felt[#v<tag>]
claude plugin install felt@cailmdaley-felt

```

Codex setup acquires and validates the source, generates a marketplace at
`~/.felt/plugin-runtime/current`, and uses Codex's native commands to install
both `felt@cailmdaley-felt` (hooks) and `felt-skills@cailmdaley-felt` (skills).
Use `felt setup codex` rather than installing the combined source directly.
Both caches are verified independently, and unchanged payloads are not
reinstalled. A Go-only release changes no hashed plugin bytes; a skills update
leaves the hook cache untouched.

`felt setup pi` wraps pi's package manager:

```bash
pi install git:github.com/cailmdaley/felt[@v<tag>]
```

None of them need a local checkout. Felt acquires GitHub sources into a
disposable checkout, validates the complete plugin payload, promotes one local
generation, and then asks the harness CLI to install it. A tagged `felt` binary
pins acquisition to the matching tag; a `dev` build tracks the default branch,
and external provenance at `~/.felt/plugin-runtime/current/.felt-generation.json`
records its resolved commit, Felt build, and per-bundle content digests without
copying release-specific metadata into any plugin root. An
interrupted native activation is reconciled from the last known-good promoted
generation before setup continues; `felt setup receipt --json` rejects pending
or mismatched source/cache generations.

All three commands are idempotent, so re-running is safe. All take `--uninstall` to
remove what they installed. `felt uninstall` clears the harnesses at once, and
serves as the general inverse.

!!! note "Felt records trust for its own Codex hooks"

    `felt setup codex` records trust for exactly `felt@cailmdaley-felt`'s plugin hooks after installing or refreshing them.
    It uses Codex's own hook hashes and App Server config API, which need Codex 0.166.0 or newer, and leaves other plugins, user hooks, and project hooks untouched.
    Trust is recorded only for verified bytes: felt checks each native plugin cache directly against its digest in external provenance, and checks that every felt hook Codex lists loads from the verified hook cache.
    Setup uses a temporary private Codex App Server config API to write and verify trust; this transient operation does not connect to Shuttle worker conversations.
    Codex hashes the entire hook plugin, so genuine hook-bundle changes need fresh trust. Skills live in a separate approval boundary and have no command hooks to approve.
    Setup leaves an unchanged installed hook bundle alone.

    A failed trust step prints a warning and `felt setup receipt` reports the hooks as unhealthy with the repair:
    `felt setup codex --trust-hooks` when trust is missing or stale, `felt setup codex` when the cached plugin is not the promoted generation.
    An older Codex without the trust API is a note on a healthy receipt; Codex then asks to review felt's hooks interactively.

### Live Codex sessions during a hook change

A genuine hook-bundle change installs normally and prints a one-line cutover
warning. Already-running Codex processes retain their old approvals and refuse
hooks with `plugin contents changed; hook approval required`; persisted trust
and a healthy receipt do not refresh those processes. Exit the affected session,
then run `codex --no-daemon resume <session-id>`. Wait for the previous writer
to unload if Codex reports it is still active. New threads on the same stale
App Server can fail too; opening a new terminal alone is not sufficient.

The first migration from the combined plugin to separate hooks and skills is
such a change, even with identical hook commands. The conversation stays alive,
but refused hooks stop context injection, mailbox delivery, event recording,
and automatic handoff nudges until the runtime is refreshed. Fresh runtimes
load the newly approved bundles. Codex exposes the skills as `felt-skills:felt`
and `felt-skills:shuttle`. Migration removes the old combined cache's skill
files: an agent holding an old `felt:felt` or `felt:shuttle` path can get
“file not found” when trying to read it. On Codex 0.166.0, `skills/list` in the
already-live server discovers the new names and paths even without a forced
reload, while its hook approval remains stale. Text already read into a
conversation is not rewritten by setup; use the new inventory paths.
Go-only and skills-only updates do not change
the hook bundle and require no hook cutover. No worker pinning or old-generation
retention is involved.

When manually rolling back to a release with the combined plugin, remove the
split skills plugin before running that release's setup, so Codex does not
load duplicate copies:

```sh
codex plugin remove felt-skills@cailmdaley-felt
```

`install.sh` (the curl installer) runs both commands automatically for whichever
CLI it finds on `PATH`, with no opt-out flag — see
[Getting started](getting-started.md#install).

### Skills only

```bash
felt setup skills [--target <dir>]
```

Symlinks felt's skills into a directory without touching the plugin
marketplace — `~/.claude/skills` by default. Useful if you want the skill
content without the hooks.

## Plugin contents

`claude-plugin/` supplies the combined Claude plugin and the independently
projected Codex hook and skills plugins. Pi's repo-root `package.json` points
at the same skill tree and `extensions/pi/`. All three harnesses receive the
same two skills; hooks on Claude/Codex correspond to extension events on pi.

### Skills

- **felt** (`felt-skills:felt` in Codex) — the substrate practice: filing fibers, updating outcomes and
  bodies, additional YAML fields, end-of-session sweeps, maintenance passes.
- **shuttle** (`felt-skills:shuttle` in Codex) — the dispatch practice: authoring constitutions, worker
  dispatch, operating the board. Only relevant once you're using the
  optional [shuttle](shuttle/index.md) layer.

Skills activate the way any Claude Code / Codex / pi skill does — by the harness
matching the user's request against the skill's description. `felt setup
skills` (above) links these into your skills directory independent of the
plugin.

### Hooks (Claude Code, Codex)

| Hook | Event | Effect |
|---|---|---|
| `session.sh` | `SessionStart` | Wraps `felt session`'s plain-text context (active + recently-touched fibers) in the harness's `additionalContext` envelope |
| `remind.sh` | `PreToolUse` | Gates the first non-skill tool call in a felt-enabled project until the felt skill has activated this session; a pass-through everywhere else |
| `touch.sh` | `PostToolUse` (Edit/Write/MultiEdit) | Stamps a fiber's `updated-at` when the agent edits its markdown file directly, so hand-edits count toward recency the same as `felt edit` does |
| `event.sh` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `SubagentStop`, `Notification`, `SessionEnd` | Calls `shuttle hook event` to append one JSON line to `~/.shuttle/events.jsonl` and handle Shuttle mailbox registration/delivery; writes nothing unless `~/.shuttle` exists |

The logic lives in the owning binary, not the script. `remind.sh` and
`touch.sh` call `felt hook pretool` and `felt hook posttool`; `event.sh` calls `shuttle hook event`.
The Claude/Codex plugin records no commits; the Pi extension calls `shuttle hook commit`.
`session.sh` wraps `felt session` with a `jq -Rs` pipeline, and falls back to
`felt hook session` when `jq` is absent.
`handoff.sh` calls `shuttle hook handoff` without starting Node.
`remind.sh` delegates unchanged stdin to `felt hook pretool`; payload decoding
and the transcript-bound activation marker belong to Go. Reused session IDs,
empty markers, and duplicate or escaped JSON keys use that same decoder.
Codex's hook projection includes only `hooks.json` and the shell adapters;
Pi's JavaScript handoff implementation is outside its approval boundary.

`event.sh` runs asynchronously only on `SubagentStop`, which never touches mailbox or native receiver registrations.
`SessionEnd` stays synchronous so its receiver withdrawal finishes before a resumed `SessionStart` registers a new receiver.
Claude offers queued mail only on `PostToolUse` and `UserPromptSubmit`, which stay synchronous.
`PreToolUse` context can be discarded when a tool is interrupted, so that hook records activity but offers no mail.
`Stop` and `StopFailure` record a turn end but never drain mail or continue a turn.
Automatic busy-Claude mail waits up to 30 seconds for a main-thread hook offer, or falls back sooner when the worker isn't working.
The daemon runs one recovery pass at a time: queued receipts trigger it, pending mail gets one-second follow-ups, and boot plus a one-minute sweep recover missed receipts.
The durable fallback-directory rename and the hook's output share a short mailbox lock, so only one transport offers a message.
Claude subagent lifecycle/tool hooks neither touch parent registrations nor write parent activity events; sent-file records and other harnesses' child events retain their own event trails.
Context-only messages stay queued for a safe prompt or tool hook and never continue a turn.
`Stop` and `Notification` also stay synchronous: the daemon folds state transitions in file order, so a late stop or notification can close a newer working turn.
A late post can likewise reopen a stopped turn.
Making those recorders asynchronous requires an ordering-aware daemon change, not just a hook flag.
`touch.sh` stays synchronous because its frontmatter write must finish before the agent's next edit.

### Extension events (pi)

On pi the same behavior comes from `extensions/pi/index.ts`, loaded via the
package manifest. The division of labor is identical — the binary owns the
logic, the adapter owns the plumbing:

| pi event | Effect |
|---|---|
| `session_start` | Emits the session-start event for shuttle's activity stream |
| `before_agent_start` | Injects `felt session`'s context once per session (pi has no SessionStart context envelope); emits the prompt-submit event |
| `tool_call` | The activation gate: in a felt-enabled project, blocks tools until the model reads the felt SKILL.md or runs `/skill:felt` — pi activates skills by reading, not by a Skill tool, so the gate lives in the extension rather than the binary |
| `tool_result` (edit/write) | Recency stamping via `felt hook posttool` |
| `tool_result` (bash) | Commit ledger via `shuttle hook commit`; post-tool-use event via `shuttle hook event` |
| `agent_end`, `session_shutdown` | Stop / session-end events for the activity stream |

No pi equivalent exists for SubagentStop and Notification events; the activity
stream simply carries fewer line types from pi sessions.

!!! note
    **Updating the CLIs updates hook behavior.** `felt update` (and
    Homebrew's post-install) refresh both Go binaries and the plugin wiring
    together, skipping native cache changes when payloads match. The wrappers
    resolve independently upgraded binaries, so CLI hook interfaces must stay
    backward compatible. This trusts the updater; it does not pin all code
    transitively invoked by a hook. Re-run setup when skills or wrapper bytes
    change; a binary-only hook behavior change needs no plugin cache refresh.

## Full CLI surface

See the [CLI reference](reference/cli.md) for every `felt` and `shuttle`
verb.
