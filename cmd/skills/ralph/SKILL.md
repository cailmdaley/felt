---
name: ralph
description: >
  This skill should be used when the user mentions "ralph", "ralph loop",
  "iterate", or "autonomous loop", or asks to "launch ralph", "start a
  ralph loop", or "run ralph on <fiber>". Covers both launching an
  autonomous loop on a fiber via the bundled launcher script, and
  executing one iteration from inside an active loop (survey the
  constitution, work substantially, update state discoverably, exit).
---

# Ralph

Ralph is an autonomous loop iterator for long-running work against a fiber-defined constitution. The skill has two entry points, and only one applies at a time:

- **Launching a loop** — outside any active loop, invoke the bundled launcher script to start an iteration sequence on a fiber. See **Launching** below.
- **Inside a loop** — the constitution is in the system prompt above; follow the **Loop** protocol below. Ignore the Launching section; a loop is already running.

## Launching

The launcher is a shell script bundled with the sibling `felt` skill, not the `ralph` skill. Its runtime path is:

```
~/.claude/skills/felt/scripts/ralph
```

It is not placed on `PATH`. Invoke it by absolute path, or add a user-level shell alias.

### Usage

```
~/.claude/skills/felt/scripts/ralph <fiber-id> [--backend claude|codex] [-- extra-flags...]
```

- `<fiber-id>` must resolve via `felt show <fiber-id>` from the current working directory or from `~/loom`. Nested IDs (e.g. `vellum-reader/workspace`) are fine.
- The fiber's status must be `open` or `active`. The launcher refuses to start on closed fibers.
- The loop terminates automatically when the fiber's status flips off `open`/`active` — typically by an iteration calling `felt edit <fiber-id> -s closed -o "..."` after a clean survey.

### Backends

- `claude` (default) — each iteration runs `claude --dangerously-skip-permissions --append-system-prompt <constitution>` with the rendered fiber injected as the system prompt. Set via `--backend claude` or the default.
- `codex` — runs `codex --dangerously-bypass-approvals-and-sandbox --config developer_instructions=<constitution>`, wrapped in a Python SIGINT bridge so that `Ctrl+C` actually tears the process down (Codex's TUI intercepts SIGINT directly, so a plain bash foreground child deadlocks). Set via `--backend codex` or `RALPH_BACKEND=codex`.

### Extra flags

Anything after a literal `--` separator is forwarded to the backend unchanged. Common flags for the Claude backend:

- `--chrome` — enable the Claude-in-Chrome integration for iterations that need live browser access alongside the `/agent-browser` skill.
- `--model <id>` — override the backend model.

### Session

The launcher starts a detached tmux session named `ralph-<fiber-id>` and returns immediately. Attach and detach normally:

```
tmux attach -t ralph-<fiber-id>    # attach
<tmux prefix> d                    # detach
tmux ls                            # list
```

If a session with that name already exists, the launcher refuses to start a second one and prints the attach command instead.

### Examples

```bash
# Plain launch on a top-level fiber, claude backend, no browser
~/.claude/skills/felt/scripts/ralph vellum-simplify

# Nested fiber ID, Chrome integration enabled
~/.claude/skills/felt/scripts/ralph vellum-reader/workspace -- --chrome

# Codex backend
~/.claude/skills/felt/scripts/ralph some-fiber --backend codex

# Claude backend, Chrome integration, model override
~/.claude/skills/felt/scripts/ralph some-fiber -- --chrome --model claude-opus-4-6
```

## Loop

1. **Survey** — Fresh eyes. Read the constitution, check git log, explore the current state.
2. **Work** — Stay and work from the vantage point the survey built. Exit only after most of that context has been spent, not when one convenient task ends.
3. **Felt** — Before exiting: activate the felt skill.
4. **Exit** — `kill $PPID`

### Earn the vantage point

The survey is a fixed cost; exploit the warm world-model rather than rebuilding it next iteration. Exit when the next valuable move needs a different mental workspace — not when one task finishes. If changes so far have been small and runway is plentiful, expand the workspace rather than exit.

## Rules

**State, not checklist.** The constitution describes what "done" looks like. Survey reality, decide what's highest value, work on that.

**Discoverable updates.** Commits, fibers, test results — not notes or progress files. The next iteration finds what changed by inspecting the system.

**No fiber comments.** Never use `felt edit <id> --comment` within the loop. Update state through sub-fibers, git commits, documentation, code. Comments bloat the fiber and the system prompt.

**Pointers, not snapshots.** If you learn something, update the constitution's *context* or *desired state* — don't leave comments.

**You have authority.** Trust the constitution, don't ask permission. Make substantial contributions. Don't avoid ambitious solutions just because they span multiple iterations.

**File uncertain decisions** as open `-t question` fibers so the user can answer after the loop.

### Long-Running Jobs

Some iterations require waiting on computation (snakemake, cluster jobs). When jobs are running:

1. **Check state** — `snakemake-peek <session>`, tail logs, check SLURM output
2. **Sleep** — interval proportional to expected runtime (30s for minute-scale, 5m for hour-scale)
3. **Check again** — look for errors or completion
4. **Repeat** until jobs finish or fail

Stay and shepherd computation through. Don't exit and hope the next iteration picks it up.

## Exit

Closing the constitution fiber (`felt edit <fiber-id> -s closed`) stops the loop — no further iterations will run. So the closing decision is reserved for a cold survey that finds nothing left to do.

**If you made any changes this iteration, you may not close the constitution fiber.** Commit, file fibers, `kill $PPID` — let the next iteration survey with fresh eyes and decide whether to close. This is the only hard rule on exit.

Making changes does NOT mean you should exit early. Keep working while the context is warm — make as many changes as belong in this iteration. The rule only constrains *closing the fiber*, not the length of the iteration. See "Earn the vantage point" above for when to actually exit.

- **Made changes this iteration** → `kill $PPID` when the warm context is spent. Do not close the fiber.
- **Survey found zero remaining work AND you made zero changes** → close: `felt edit <fiber-id> -s closed -o "..."`.

---

Pattern adapted from [ralph-wiggum](https://ghuntley.com/ralph/).
