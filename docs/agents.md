# Working with Agents

felt ships as a plugin for [Claude Code](https://claude.com/claude-code) and
[Codex](https://developers.openai.com/codex). The plugin gives an agent
fiber-awareness: it sees active fibers at session start, is nudged to use
felt instead of raw file edits, and keeps fiber timestamps honest when it
edits a fiber file directly.

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
```

Both wrap the official plugin-marketplace flow:

```bash
# Claude Code
claude plugin marketplace add cailmdaley/felt[#v<tag>]
claude plugin install felt@cailmdaley-felt

# Codex
codex plugin marketplace add cailmdaley/felt[@v<tag>]
# then config.toml: features.plugin_hooks = true, plugins."felt@cailmdaley-felt".enabled = true
```

Neither needs a local checkout — the CLI clones the marketplace straight from
GitHub. A tagged `felt` binary pins the plugin to the matching tag; a `dev`
build tracks the default branch, so the plugin content always matches the
binary that installed it.

Both commands are idempotent — re-running is safe — and both take
`--uninstall` to remove what they installed. `felt uninstall` removes from
both harnesses at once and is the general inverse.

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

## What the plugin bundles

One plugin directory serves both harnesses. It bundles two skills and three
hooks.

### Skills

- **felt** — the substrate practice: filing fibers, updating outcomes and
  bodies, additional YAML fields, session mining, maintenance passes.
- **shuttle** — the dispatch practice: authoring constitutions, worker
  dispatch, operating the board. Only relevant once you're using the
  optional [Shuttle](shuttle/index.md) layer.

Skills activate the way any Claude Code / Codex skill does — by the harness
matching the user's request against the skill's description. `felt setup
skills` (above) links these into your skills directory independent of the
plugin.

### Hooks

| Hook | Event | What it does |
|---|---|---|
| `session.sh` | `SessionStart` | Wraps `felt session`'s plain-text context (active + recently-touched fibers) in the harness's `additionalContext` envelope |
| `remind.sh` | `PreToolUse` | Gates the first non-skill tool call in a felt-enabled project until the felt skill has activated this session; a pass-through everywhere else |
| `touch.sh` | `PostToolUse` (Edit/Write/MultiEdit) | Stamps a fiber's `updated-at` when the agent edits its markdown file directly, so hand-edits count toward recency the same as `felt edit` does |

The logic lives in the binary, not the script. `remind.sh` and `touch.sh` are
one-line shims over `felt hook pretool` and `felt hook posttool`. `session.sh`
wraps `felt session` with a `jq -Rs` pipeline, and falls back to `felt hook
session` when `jq` is absent.

!!! note
    **Updating the binary updates hook behavior.** `felt update` (and
    Homebrew's post-install) refresh the binary and the plugin wiring
    together, so hooks always run against a matching binary. You only need
    to re-run `felt setup claude`/`codex` when the *skill content* changes,
    not when hook logic changes.

## Full CLI surface

See the [CLI reference](reference/cli.md) for every `felt` and `felt shuttle`
verb.
