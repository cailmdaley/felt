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

1. **Survey** — Fresh eyes. Read the constitution, check git log, explore the current state.
2. **Work** — Stay and work from the vantage point the survey built. Exit when it degrades, not before.
3. **Felt** — Before exiting: `/felt`.
4. **Exit** — `kill $PPID`

### Earn the vantage point

The survey builds understanding; the work exploits it. These are not equal phases. The survey is a fixed cost every iteration pays — reading the constitution, checking state, building a mental model. That cost only justifies itself through the work that follows.

The failure mode is leaving while you still have a clear view. You've read the codebase, you understand how the pieces connect, you can see what needs to change. That understanding is perishable — it exists in this session and nowhere else. The next iteration starts cold and rebuilds it from scratch. A short iteration that surveys, lands one small change, and exits usually wastes the investment that made the change easy.

Default to staying. After the first meaningful piece of work, do not ask "is this enough for one iteration?" Ask "what else is now cheaper because I already understand this part of the system?" Keep exploiting that advantage while the next valuable moves live in the same world-model.

Exit when the next worthwhile move would require building substantially different context: a different subsystem with different invariants, a separate debugging thread with little overlap, a different artifact or workflow, or a fresh verification pass better done by new eyes. Do not exit merely because one coherent task is complete. If adjacent moves are still cheap from the context already in memory, do them now. The point is to exhaust a world-model, not to sample it.

Do not run until the session is confused or sloppy. But do not leave early out of caution either. The danger is not only overextending; it is also under-harvesting the context you already paid to build. Short orthogonal tasks are not automatic exit triggers. If they fit cleanly into the current context, do them. Exit when continuing would mean switching to a different mental workspace, not when there are simply multiple things left to do.

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

**NEVER close the constitution in an iteration where you made changes.** If you committed code, edited files, migrated data, or wrote anything — you MUST `kill $PPID` and let the next iteration verify with fresh eyes. This is non-negotiable. The whole point of the loop is that no iteration grades its own work.

- **Made changes this iteration** → `kill $PPID`. Period.
- **Survey found zero remaining work AND you made zero changes** → close: `felt edit <fiber-id> -s closed -o "..."`.

The temptation is to survey, do all the work, re-check, and declare victory. Resist it. You don't get to verify your own output.

---

Pattern adapted from [ralph-wiggum](https://ghuntley.com/ralph/).
