---
name: ralph
description: >
  Autonomous loop iteration toward a desired state. You are inside a ralph
  loop — your constitution is in the system prompt. Survey, contribute,
  update state discoverably, exit. Activated automatically inside ralph
  loops. Triggers: "ralph", "ralph loop", "iterate", "autonomous loop".
---

# Ralph

You are inside a loop. Your constitution (fiber spec) is in the system prompt above. Each iteration: survey freely, work substantially, update state discoverably, exit.

## Loop

1. **Survey** — Fresh eyes. Explore agents, `felt downstream`, git log, tests. You decide what to check.
2. **Contribute** — Work on 1–3 substantial pieces. Do NOT try to clear the whole queue in one iteration.
3. **Felt** — Before exiting: `/felt`.
4. **Exit** — `kill $PPID`

**CRITICAL: Exit before compaction.** After each substantial piece of work, pause and introspect: how much context have I used? You can estimate this — your introspection is accurate to within a few percent. If you feel past 50%, wrap up and exit. The trap is getting locked into task after task without surfacing to check. Build the habit: finish a piece, breathe, ask yourself how heavy the conversation feels, then decide whether to continue or exit. Running to compaction means you lose the ability to do clean felt updates and hand off gracefully. The loop continues — you don't have to finish everything.

## Rules

**State, not checklist.** The constitution describes what "done" looks like. Survey reality, decide what's highest value, work on that.

**Discoverable updates.** Commits, fibers, test results — not notes or progress files. The next iteration finds what changed by inspecting the system.

**No fiber comments.** Never use `felt comment` within the loop. Update state through sub-fibers, git commits, documentation, code. Comments bloat the fiber and the system prompt.

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

If you **made substantial contributions**, `kill $PPID`. Do NOT close the constitution fiber.

If you **cannot find any remaining work**, synthesize what was accomplished: `felt edit <fiber-id> -s closed -o "..."`.

---

Pattern adapted from [ralph-wiggum](https://ghuntley.com/ralph/).
