# Migration

Migrating a store from flat fibers (`.felt/slug-hex.md`) to directory fibers (`.felt/slug/slug.md`).

## Run it

```bash
felt ls -s all | wc -l    # count before
felt migrate --dry-run    # preview flat-file moves, title renames, anchor stripping
felt migrate
felt ls -s all | wc -l    # count should match
felt check
```

`felt migrate` strips hex suffixes into `slug/slug.md` directories, rewrites `inputs.from` references that point at migrated hex ids, renames frontmatter `title:` to `name:`, drops inert `depends-on:` keys, and strips leading MyST anchor lines like `(slug)=`. A single bare `.md` at `.felt/` root is the entry-point fiber and stays; multiple bare files are migrated. Each store migrates independently — run it in every per-project and cross-project store.

## Clean up after

- **Stale hex ids.** `rg -n '<slug>-[0-9a-f]{8}' .felt` catches references the migration couldn't map, in bodies or `inputs.from`.
- **CLAUDE.md references.** Strip hex suffixes from inline ids (`gotcha-ssh-double-quote-810f6df9` → `gotcha-ssh-double-quote`), and replace file paths with fiber ids — fibers are reached through `felt show`, not by path. Fibers filed under a project's old name keep that slug; find the real one with `felt ls -s all <keyword>`. Drop references to fibers that no longer exist.
- **Code that reads `.felt/` directly** — readers, test fixtures, hook scripts globbing `.felt/*.md` — must walk directories and read `<slug>/<slug>.md`, skipping directories without one.
- **A stray `myst.yml` at `.felt/` root** is inert; delete it.

Done when `ls .felt/*.md` shows at most the entry-point fiber, `felt check` passes, and `felt session` produces clean output.
