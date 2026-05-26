# Migration

Migrating a project from flat fibers (`slug-hex.md`) to directory fibers (`slug/slug.md`).

---

## Steps

### 1. Run migration

```bash
felt migrate --dry-run    # preview — check flat-file moves, title renames, anchor stripping
felt migrate              # big bang — no backwards compatibility
```

The tool strips hex suffixes, creates `slug/slug.md` directories, rewrites `inputs.from` references that still point at migrated hex IDs, renames frontmatter `title:` to `name:`, and strips leading MyST anchor lines like `(slug)=` from fiber bodies.

### 2. Validate

```bash
felt ls -s all | wc -l    # sanity check: fiber count should match pre-migration
felt check                # lint the migrated tree
```

### 3. Fix stale references

**Pre-existing directory fibers are rewritten too.** If any fibers still carry old hex IDs in `inputs.from`, audit them after migration:

```bash
felt show fiber-a --field inputs   # confirm current data-flow refs
rg -n "some-fiber-8a08fc28" .felt
# Edit .felt/fiber-a/fiber-a.md — change inputs.from from some-fiber-8a08fc28.output to some-fiber.output
```

### 4. Update CLAUDE.md

All fiber references in CLAUDE.md need updating:

- **Inline IDs:** strip hex suffixes. `gotcha-ssh-double-quote-810f6df9` becomes `gotcha-ssh-double-quote`.
- **File paths:** `.felt/slug-hex.md` becomes just the fiber ID `slug`. Deep dive tables should reference fiber IDs, not file paths — fibers are accessed via `felt show`, not by navigating to files.
- **Renamed projects:** if the project was renamed (e.g., hexarchy to portolan), old fibers keep their original slug. The CLAUDE.md reference needs the actual slug, not the wished-for name.
- **Deleted fibers:** some fibers may have been removed before migration. Drop references to fibers that no longer exist.

### 5. Update consumers

Any code that reads `.felt/` directly needs updating for the directory layout:

- **FiberReader (portolan):** scan for directories, read `slug/slug.md` within each. The fiber ID is the directory name.
- **Test fixtures:** `writeFiber()` helpers must create `slug/slug.md` inside a directory, not flat `slug.md` files.
- **Hook scripts:** if any shell scripts glob `.felt/*.md`, update to `.felt/*/`.

### 6. Confirm

```bash
ls .felt/*.md 2>/dev/null    # should return nothing (only directories remain)
felt session | head -20       # verify session context works
```

---

## Pitfalls

**Audit old hex refs after migration.** The migration rewrites flat fibers and existing directory fibers it can map cleanly, but `rg` is still the fastest final check for stale hex IDs in bodies or external tooling.

**Project renames create slug mismatches.** If the project was once called "hexarchy" and fibers were filed under that name, the slugs stay `hexarchy-*` after migration. CLAUDE.md references that assumed the current project name won't match. Use `felt ls -s all <keyword>` to find actual slugs.

**`myst.yml` stays in `.felt/` root.** It's not a fiber — the migration doesn't touch it, and the reader should skip it (it's a file, not a directory).

**Each felt store migrates independently.** If you have multiple stores (e.g., one per project plus a cross-project store), run `felt migrate` in each. Stores have separate namespaces and may have different collision patterns.

**Consumers see all directories.** After migration, `.felt/` contains only directories (plus `myst.yml`). Code that filtered for `*.md` files now needs to filter for directories containing `slug/slug.md`. Empty directories or directories without matching `.md` files should be silently skipped.

---

## Checklist

- [ ] `felt migrate --dry-run` — no unexpected collisions
- [ ] `felt migrate` — completes without error
- [ ] `felt check` passes
- [ ] Old hex IDs removed from `inputs.from`
- [ ] CLAUDE.md hex suffixes stripped
- [ ] CLAUDE.md file paths updated to fiber IDs
- [ ] CLAUDE.md stale/deleted references removed
- [ ] Code consumers updated (FiberReader, test fixtures)
- [ ] `ls .felt/*.md` returns nothing
- [ ] `felt session` produces clean output
