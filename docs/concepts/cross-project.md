# Cross-project stores

A felt store is just a `.felt/` directory. Nothing stops you having more than
one, and the useful pattern pairs a **per-project store** with a
**cross-project store** that aggregates several projects into one searchable
tree.

The two are joined by a filesystem symlink. Same bytes, two paths.

## Why bother

**Search across everything.** One store that contains every project answers
"have I solved this before?" and "where did that decision land?" without
guessing which repo it was in.

```bash
felt -C ~/loom ls "jackknife covariance"
felt ls "jackknife covariance"          # scoped to the current project
```

**Threads that belong to no project.** Recurring conversations, admin, notes
about the tools themselves. They need a home that does not pollute any single
project's tree.

**Cross-pollination.** Reading across occasionally surfaces a pattern from
project A that resolves a question in project B. A per-project view cannot show
you that.

The cost is one filesystem indirection.

!!! note "`~/loom` is a name, not a feature"
    Throughout felt's own docs and skills, `~/loom` is the maintainer's
    cross-project store. It is a private directory on their machines, not
    something felt ships or expects. Yours can live anywhere and be called
    anything — the mechanism is entirely the symlink plus the `-C` flag.

## The `-C` flag

`-C, --directory <dir>` runs felt as if it had been started in `dir`. It is
global, so it works with every verb:

```bash
felt -C ~/loom ls "query"
felt -C ~/loom tree
felt -C ~/loom show some-project/a-fiber
```

This is the whole cross-store mechanism on the read side. There is no "remote
store" concept — just a different working directory.

## Which end holds the real bytes

The link is a plain symlink, so one end is canonical (real files) and the other
is a pointer. Both directions are valid.

### Cross-project store as canonical

```
~/loom/.felt/<project-name>/     ← real files
<project-path>/.felt/            ← symlink → ~/loom/.felt/<project-name>/
```

The typical case. One git repo to back up, and `felt` from inside any project
sees its own fibers normally — the symlink is transparent.

### Per-project as canonical

```
<project-path>/.felt/            ← real files
~/loom/.felt/<project-name>/     ← symlink → <project-path>/.felt/
```

Use this when the project has a sync constraint that wants the bytes inside its
own perimeter.

### Choosing

| If the project… | Direction |
|---|---|
| is a normal repo and you control all the sync | cross-project as canonical |
| has its own git remote, separate from the cross-project store's | per-project as canonical |
| sits in iCloud / Dropbox / a folder-scoped sync service | per-project as canonical |
| holds content that must not enter the shared history | per-project as canonical |

## Setting up the symlink without losing fibers

The trap: `ln -s` over an existing `.felt/` either fails (regular directory) or
silently replaces it (existing symlink). Either way fibers can vanish.

```bash
# 1. Check both ends for existing content.
ls <project-path>/.felt/
ls ~/loom/.felt/<project-name>/

# 2. If both have content, merge by hand BEFORE linking. Inspect every name
#    collision. Decide which fiber is the keeper. Copy the non-overlapping
#    fibers from the soon-to-be-symlink side into the canonical side.

# 3. Move the soon-to-be-symlink side aside. Do not delete it yet.
mv <project-path>/.felt <project-path>/.felt.pre-link

# 4. Create the symlink (direction per the choice above).
ln -s ~/loom/.felt/<project-name>/ <project-path>/.felt

# 5. Verify from the project side.
felt ls
ls <project-path>/.felt/

# 6. Only once verified, remove the backup.
rm -rf <project-path>/.felt.pre-link
```

For the reverse direction, swap which side is the symlink target. The
move-aside, verify, then remove discipline is the same.

**Never `rm -rf` either side before verifying.** Fibers hold accreted context
that is expensive to reconstruct.

## Links across stores

A `[[wikilink]]` targeting a fiber in a different store reads as broken to
`felt check`. felt scopes to one store at a time, so this is expected rather
than a bug.

If the link genuinely matters:

- **Fully qualify it** — `[[<other-project>/<slug>]]` resolves if both fibers
  are visible from the store you are reading in (which they are, from the
  cross-project side).
- **Mirror** the target into both stores. Worth it only for a stable reference
  doc, never for an ordinary thread.
- **Drop the wikilink** and write prose. Often the link was not earning its
  place anyway.

Otherwise treat the warning as informational. Do not "fix" it by inventing a
stub fiber.
