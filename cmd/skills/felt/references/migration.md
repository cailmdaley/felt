# Migration

Migrating a project from flat fibers (`slug-hex.md`) to directory fibers (`slug/slug.md`).

---

## Steps

### 1. Run migration

```bash
felt migrate --dry-run    # preview — check for collisions, slug renames
felt migrate              # big bang — no backwards compatibility
```

The tool strips hex suffixes, creates `slug/slug.md` directories, rewrites `depends-on` references in migrated files, and inserts `(<slug>)=` MyST anchors.

### 2. Validate

```bash
felt tree --check         # DAG integrity — broken deps surface here
felt ls -s all | wc -l    # sanity check: fiber count should match pre-migration
```

### 3. Fix stale references

**Pre-existing directory fibers are not rewritten.** If any fibers were created with the v2 binary before migration, their `depends-on` may still reference old hex IDs. `felt tree --check` will flag these. Fix manually:

```bash
# tree --check reports: ERROR: fiber-a depends on non-existent some-fiber-8a08fc28
felt show fiber-a -d compact   # confirm it exists
# Edit .felt/fiber-a/fiber-a.md — change depends-on from some-fiber-8a08fc28 to some-fiber
```

### 4. Update CLAUDE.md

All fiber references in CLAUDE.md need updating:

- **Inline IDs:** strip hex suffixes. `gotcha-ssh-double-quote-810f6df9` becomes `gotcha-ssh-double-quote`.
- **File paths:** `.felt/slug-hex.md` becomes just the fiber ID `slug`. Deep dive tables should reference fiber IDs, not file paths — fibers are accessed via `felt show`, not by navigating to files.
- **Renamed projects:** if the project was renamed (e.g., hexarchy to portolan), old fibers keep their original slug. The CLAUDE.md reference needs the actual slug, not the wished-for name.
- **Deleted fibers:** some fibers may have been removed before migration. Drop references to fibers that no longer exist.
- **Command changes:** old export subcommands become `felt export --format tapestry`.

### 5. Update consumers

Any code that reads `.felt/` directly needs updating for the directory layout:

- **FiberReader (portolan):** scan for directories, read `slug/slug.md` within each. The fiber ID is the directory name.
- **Test fixtures:** `writeFiber()` helpers must create `slug/slug.md` inside a directory, not flat `slug.md` files.
- **Hook scripts:** if any shell scripts glob `.felt/*.md`, update to `.felt/*/`.

### 6. Confirm

```bash
ls .felt/*.md 2>/dev/null    # should return nothing (only directories remain)
felt hook session | head -20  # verify session context works
```

---

## Pitfalls

**Pre-v2 directory fibers have stale deps.** The migration tool only rewrites `depends-on` in files it migrates (flat files). Directory fibers that already existed are untouched. Always run `felt tree --check` after migration.

**Project renames create slug mismatches.** If the project was once called "hexarchy" and fibers were filed under that name, the slugs stay `hexarchy-*` after migration. CLAUDE.md references that assumed the current project name won't match. Use `felt ls -s all <keyword>` to find actual slugs.

**`myst.yml` stays in `.felt/` root.** It's not a fiber — the migration doesn't touch it, and the reader should skip it (it's a file, not a directory).

**Global felt (`~/loom/.felt/`) is separate.** Migrate each project independently. Global felt has its own namespace and may have different collision patterns.

**Consumers see all directories.** After migration, `.felt/` contains only directories (plus `myst.yml`). Code that filtered for `*.md` files now needs to filter for directories containing `slug/slug.md`. Empty directories or directories without matching `.md` files should be silently skipped.

---

## Checklist

- [ ] `felt migrate --dry-run` — no unexpected collisions
- [ ] `felt migrate` — completes without error
- [ ] `felt tree --check` — graph OK
- [ ] Pre-existing directory fibers' `depends-on` fixed
- [ ] CLAUDE.md hex suffixes stripped
- [ ] CLAUDE.md file paths updated to fiber IDs
- [ ] CLAUDE.md stale/deleted references removed
- [ ] Code consumers updated (FiberReader, test fixtures)
- [ ] `ls .felt/*.md` returns nothing
- [ ] `felt hook session` produces clean output
