# Working with Agents

felt ships as a plugin for [Claude Code](https://claude.com/claude-code) and
[Codex](https://developers.openai.com/codex). The plugin makes an agent
fiber-aware. It shows the agent the active fibers at session start. It nudges
the agent toward felt instead of raw file edits. It keeps fiber timestamps
honest when the agent edits a fiber file directly.

## Requirement: `felt` on `PATH`

Every hook shells out to the `felt` binary. If the agent's process doesn't
have `felt` on `PATH`, the hooks fail quietly.

- In a terminal-launched session this is usually fine — your shell's `PATH`
  carries over.
- A GUI-launched agent (no shell profile sourced) can miss `~/.local/bin` or
  wherever `felt` landed. If SessionStart context never shows up, check
  `PATH` first.
- The daemon has the same requirement server-side: a `PATH` missing `felt`
  turns into 500s on the board's fiber endpoints, so the board loads but the
  kanban stays empty.

## Installing the plugin

```bash
felt setup claude    # Claude Code
felt setup codex     # Codex
felt setup pi        # pi (@earendil-works/pi-coding-agent)
```

The first two wrap the official plugin-marketplace flow:

```bash
# Claude Code
claude plugin marketplace add cailmdaley/felt[#v<tag>]
claude plugin install felt@cailmdaley-felt

# Codex
codex plugin marketplace add cailmdaley/felt[@v<tag>]
codex plugin add felt@cailmdaley-felt
```

`felt setup pi` wraps pi's package manager:

```bash
pi install git:github.com/cailmdaley/felt[@v<tag>]
```

None of them need a local checkout. Felt acquires GitHub sources into a
disposable checkout, validates the complete plugin payload, promotes one local
generation, and then asks the harness CLI to install it. A tagged `felt` binary
pins acquisition to the matching tag; a `dev` build tracks the default branch,
and every promoted payload records its resolved commit and content digest. An
interrupted native activation is reconciled from the last known-good promoted
generation before setup continues; `felt setup receipt --json` rejects pending
or mismatched source/cache generations.

All three commands are idempotent, so re-running is safe. All take `--uninstall` to
remove what they installed. `felt uninstall` clears the harnesses at once, and
serves as the general inverse.

!!! note "Codex asks you to trust the hooks"

    Codex reviews a plugin's hooks before it will run them. Your next
    interactive Codex session shows a review screen for felt's; accept it once
    and the setting persists. Until you do, the skills load but the hooks stay
    dormant — no `SessionStart` fiber context, and nothing recorded for
    shuttle's activity stream. A headless `codex exec` session can't show the
    prompt, so trust felt's hooks from an interactive session first.

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

One plugin directory serves Claude Code and Codex; one package manifest serves
pi (the repo-root `package.json`, whose `pi` key points at the same skill tree
and at `extensions/pi/`). Both bundle the same two skills; hooks on Claude/Codex
correspond to extension events on pi.

### Skills

- **felt** — the substrate practice: filing fibers, updating outcomes and
  bodies, additional YAML fields, session mining, maintenance passes.
- **shuttle** — the dispatch practice: authoring constitutions, worker
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
| `event.sh` | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, `SubagentStop`, `Notification`, `SessionEnd` | Appends one JSON line per event to the shuttle event stream (`~/.shuttle/events.jsonl`), which the daemon reads for activity ranking and the sent-files trail; writes nothing unless `~/.shuttle` exists |

The logic lives in the binary, not the script. `remind.sh`, `touch.sh`, and
`event.sh` each shim a single line over `felt hook pretool`, `felt hook
posttool`, and `felt hook event`.
`session.sh` wraps `felt session` with a `jq -Rs` pipeline, and falls back to
`felt hook session` when `jq` is absent.

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
| `tool_result` (bash) | Commit ledger via `felt hook commit`; post-tool-use event |
| `agent_end`, `session_shutdown` | Stop / session-end events for the activity stream |

No pi equivalent exists for SubagentStop and Notification events; the activity
stream simply carries fewer line types from pi sessions.

!!! note
    **Updating the binary updates hook behavior.** `felt update` (and
    Homebrew's post-install) refresh the binary and the plugin wiring
    together, so hooks always run against a matching binary. You only need
    to re-run `felt setup claude`/`codex` when the *skill content* changes,
    not when hook logic changes.

## Full CLI surface

See the [CLI reference](reference/cli.md) for every `felt` and `felt shuttle`
verb.
