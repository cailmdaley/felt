# Cross-project felt stores

A felt store is just a `.felt/` directory; nothing prevents having more than one. The useful pattern combines a **per-project store** (fibers scoped to that project's concerns) with a **cross-project store** (aggregating fibers from many projects into a single searchable layer), linked by a filesystem symlink.

## Why bother

**Search across.** `felt -C <cross-project-store> ls "query"` finds fibers across every project linked into the store — useful for "have I solved this before?", "where did that decision land?", or surfacing related work from a different project while attention is in this one.

**Threads that span projects.** Some concerns don't belong to a single project — personal admin, recurring conversations, meta-fibers about the tools themselves, working-relationship patterns. A cross-project store gives them a home that doesn't pollute any one project's tree.

**Cross-pollination.** Reading the assemblage occasionally — patterns from project A may resolve a question in project B in ways a per-project view doesn't surface. The cross-project store is what makes that browsing possible.

The cost is one filesystem indirection: each project's fibers live both as their own coherent tree and as a leaf in the cross-project tree. Same bytes, two paths.

## Two valid symlink directions

The link is a filesystem symlink. Which end is the canonical location (real files) and which is the symlink (pointer) depends on the project's constraints.

### Cross-project store as canonical

```
~/<cross-project-store>/.felt/<project-name>/   ← real files
<project-path>/.felt/                            ← symlink → cross-project-store
```

The cross-project store owns the bytes; each project's `.felt/` is a symlink in. This is the typical case: simple, one git repo to back up, `felt` from inside any project sees its fibers normally (the symlink is transparent to most tools).

### Per-project as canonical

```
<project-path>/.felt/                            ← real files
~/<cross-project-store>/.felt/<project-name>/   ← symlink → project
```

The project owns the bytes; the cross-project store symlinks in. Use this when the project has its own sync constraint that wants the bytes inside its perimeter — a separate git remote, an iCloud-synced folder, a privacy boundary, or anything else where it's awkward to have the canonical files live elsewhere.

### Choosing

| If the project… | Direction |
|---|---|
| is a normal repo, you control all the sync | cross-project as canonical |
| has its own remote, separate from the cross-project store's | per-project as canonical |
| is in iCloud / Dropbox / a sync service that scopes to the folder | per-project as canonical |
| holds content that shouldn't end up in the cross-project store's history | per-project as canonical |

## Setting up the symlink without losing fibers

The trap: running `ln -s` over an existing `.felt/` directory either fails (regular directory) or silently replaces it (existing symlink). Either way, fibers can vanish if you're not careful.

Safe sequence:

```
# 1. Check both ends for existing content.
ls <project-path>/.felt/
ls <cross-project-store>/.felt/<project-name>/

# 2. If both have content, merge by hand BEFORE linking.
#    Don't blindly overwrite. Inspect every name collision, decide which
#    fiber is the keeper, copy non-overlapping fibers from the side that
#    will become the symlink into the side that will be canonical.

# 3. Move the soon-to-be-symlink side aside (don't delete yet).
mv <project-path>/.felt <project-path>/.felt.pre-link

# 4. Create the symlink (adjust direction per the choice above).
ln -s <cross-project-store>/.felt/<project-name>/ <project-path>/.felt

# 5. Verify from the project side.
felt ls   # should show the expected fibers
ls <project-path>/.felt/   # should resolve through the symlink

# 6. Once verified, remove the backup.
rm -rf <project-path>/.felt.pre-link
```

For the reverse direction (per-project as canonical), swap which side is the symlink target — the "move aside, verify, then remove" discipline is the same.

**Never `rm -rf` either side before verifying.** Fibers contain accreted context that's expensive to recover; a moment of caution saves a recovery sweep later.

## Cross-store wikilinks

A `[[wikilink]]` that targets a fiber in a different store reads as broken from `felt check`'s perspective — felt scopes to one store at a time. That's expected, not a bug. If the link is genuinely useful, the options are:

- **Fully-qualified path** in the wikilink (`[[<other-project>/<slug>]]` if your tooling resolves it).
- **Mirror** the referenced fiber into both stores (only worth it for a stable reference doc, not for ordinary threads).
- **Drop the wikilink** and use prose — sometimes the link wasn't earning its place anyway.

Otherwise treat the warning as informational. Don't try to "fix" it by inventing a stub.
