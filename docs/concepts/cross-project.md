# Cross-project stores

A felt store lives in a plain `.felt/` directory. Nothing stops you having more
than one. The useful pattern pairs a **per-project store** with a
**cross-project store** that aggregates several projects into one searchable
tree.

A filesystem symlink joins the two. Same bytes, two paths.

## The payoff

**Search across everything.** One store that contains every project answers
"have I solved this before?" and "where did that decision land?" without
guessing which repo it was in.

```bash
felt -C ~/store ls "jackknife covariance"
felt ls "jackknife covariance"          # scoped to the current project
```

**Threads that belong to no project.** Recurring conversations, admin, notes
about the tools themselves. They need a home that keeps them out of any single
project's tree.

**Cross-pollination.** Reading across occasionally surfaces a pattern from
project A that resolves a question in project B. A per-project view cannot show
you that.

You pay one filesystem indirection.

!!! note "Name your cross-project store whatever you like"
    You can call your cross-project store `loom`, for example — felt neither
    ships that name nor expects it. Yours can live anywhere and be called
    anything; the rest of this page uses `~/store` as a neutral stand-in. Only
    the symlink and the `-C` flag do the work.

## The `-C` flag

`-C, --directory <dir>` runs felt as if it had been started in `dir`. It
applies globally, so it works with every verb:

```bash
felt -C ~/store ls "query"
felt -C ~/store tree
felt -C ~/store show some-project/a-fiber
```

That covers the read side of cross-store work. You point felt at a different
working directory; nothing else changes.

## Which end holds the real bytes

A plain symlink joins the two ends. One end holds the real files, and the other
points at them. Both directions work.

### Cross-project store as canonical

```
~/store/.felt/<project-name>/    ← real files
<project-path>/.felt/            ← symlink → ~/store/.felt/<project-name>/
```

Take this in the typical case. You back up one git repo, and `felt` from inside
any project sees its own fibers normally, because the symlink is transparent.

### Per-project as canonical

```
<project-path>/.felt/            ← real files
~/store/.felt/<project-name>/    ← symlink → <project-path>/.felt/
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
ls ~/store/.felt/<project-name>/

# 2. If both have content, merge by hand BEFORE linking. Inspect every name
#    collision. Decide which fiber is the keeper. Copy the non-overlapping
#    fibers from the soon-to-be-symlink side into the canonical side.

# 3. Move the soon-to-be-symlink side aside. Do not delete it yet.
mv <project-path>/.felt <project-path>/.felt.pre-link

# 4. Create the symlink (direction per the choice above).
ln -s ~/store/.felt/<project-name>/ <project-path>/.felt

# 5. Verify from the project side.
felt ls
ls <project-path>/.felt/

# 6. Only once verified, remove the backup.
rm -rf <project-path>/.felt.pre-link
```

For the reverse direction, swap which side is the symlink target. Keep the same
discipline: move aside, verify, then remove.

**Never `rm -rf` either side before verifying.** Fibers hold accreted context
that is expensive to reconstruct.

## Links across stores

A `[[wikilink]]` targeting a fiber in a different store reads as broken to
`felt check`. felt scopes to one store at a time, so expect the warning.

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
