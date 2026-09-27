# Session Mining

Retroactive extraction at session end: what wasn't captured in the moment. **Autonomous** — no review needed; you were there.

## What to look for

- **Decisions** — choices, trade-offs, rejections, "decided NOT to", with the reasoning.
- **Questions answered** — mechanisms, causes, how things work.
- **Patterns** — architectural insights, conventions, workflows.
- **Findings** — what was built, measured, produced.
- **Doc candidates** — a pattern that has recurred and wants a reference fiber, or a procedure that will be reused.

## Steps

1. **File each one.** A mined fiber is a record, not a todo: leave it statusless (`-s closed` only for a tracked thread that resolved). Give it a body with `-b` when the name and outcome aren't enough.

   ```bash
   felt add chose-x-over-y "Chose X over Y for Z" -o "X was better because…; Y failed due to…"
   ```

2. **Connect it.** Nest it under the parent it belongs to, cite related fibers with `[[wikilinks]]` in the prose, and add `inputs.from` only when the relation is computational. `felt find "<concept>"` surfaces neighbours. Isolated fibers are hard to find.

3. **Update what was left stale.** Outcomes and statuses on the fibers the session touched; the project's CLAUDE.md for new commands, paths, and pointers to doc fibers (keep it lean — depth goes in fibers).

4. **Commit**, if the store is a git repo.
