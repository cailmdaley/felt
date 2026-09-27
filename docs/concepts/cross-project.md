# Cross-project stores

A cross-project store turns felt into a wiki or knowledge base that spans many
directories and projects. Each project keeps its own fiber tree where the
project lives, and one store gathers those trees into a single body of
knowledge you can search and link across. The question "have I solved this
before?" gets an answer without first remembering which repo it was in. Threads
that belong to no single project — recurring conversations, admin, notes about
the tools themselves — get a home that stays out of every project's tree. And
reading across the whole body now and then turns up a pattern from one project
that answers a question in another, which no per-project view could show you.

A felt store is a plain `.felt/` directory, and a filesystem symlink is all it
takes to make one project's tree a subtree of a larger store. The same bytes
then sit at two paths: `<project>/.felt/` and `~/store/.felt/<project>/`.

!!! note "Name your cross-project store whatever you like"
    You can call your cross-project store `loom`, for example — felt neither
    ships that name nor expects it. Yours can live anywhere and be called
    anything; the rest of this page uses `~/store` as a neutral stand-in.

## Views and the store

When a project's `.felt/` is a symlink into a larger store, felt run from the
project knows it is looking at a **view** of that store and treats the two
differently.

`felt ls` and `felt tree` stay inside the view. They list the project's own
fibers under short ids relative to the view (`covariance`, not
`my-project/covariance`), and they stay fast however large the store grows.

`felt find` searches the whole store. Hits inside the view print first under
their local ids; the rest follow under a separator naming the enclosing store,
each under its full id there.

```bash
felt ls "jackknife"      # this project only
felt find "jackknife"    # this project, then everything else in the store
```

Those full ids work anywhere felt takes an id. `felt show`, `edit`, `nest` and
`rm` act on the fiber where it lives, so you can read or reshape a fiber from
another project without leaving the one you are in:

```bash
felt show commons/jackknife
felt edit commons/jackknife -o "Settled: 200 patches."
```

At the top of the store itself there is no enclosing view, and `ls`, `tree`
and `find` all cover every project linked in.

The `-C, --directory <dir>` flag runs felt as if it had been started in `dir`,
and works with every verb. It is the way to reach a store from somewhere that is
not a view of it:

```bash
felt -C ~/store tree
felt -C ~/store find "jackknife"
```

## Which end holds the real bytes

One end of the symlink holds the real files and the other points at them. Both
directions work, but they are not symmetric.

### The store as canonical

```
~/store/.felt/<project>/     ← real files
<project>/.felt/             ← symlink → ~/store/.felt/<project>/
```

This is the typical case. One git repository, the store's, backs up every
project, and felt run inside a project sees it as a view of the store, with
everything in the previous section available.

### The project as canonical

```
<project>/.felt/             ← real files
~/store/.felt/<project>/     ← symlink → <project>/.felt/
```

Here the project owns the bytes and the store points in. Use it when the project
has its own reason to keep the files inside its perimeter.

The store still sees the project as one of its subtrees, so `tree`, `find` and
links from the store side behave as above. The project side, though, is an
ordinary top-level store. Nothing in `<project>/.felt/` says a larger store
points at it, so felt run there sees only the project: `find` does not reach
the rest of the store and ids from elsewhere in it do not resolve. Use
`felt -C ~/store` for anything cross-project.

The store's own git history records the symlink, not the fibers behind it; the
project's fibers are versioned wherever the project versions them.

### Choosing

| If the project… | Direction |
|---|---|
| is a normal repo and you control all the sync | store as canonical |
| has its own git remote, separate from the store's | project as canonical |
| sits in iCloud / Dropbox / a folder-scoped sync service | project as canonical |
| holds content that must not enter the store's history | project as canonical |

## Linking a project without losing fibers

`ln -s` over an existing `.felt/` either fails (a regular directory is in the
way) or silently replaces it (an existing symlink is). Either way fibers can
vanish, so move the old side aside first and remove it only once the link is
verified.

```bash
# 1. Check both ends for existing content.
ls <project>/.felt/
ls ~/store/.felt/<project>/

# 2. If both have content, merge by hand BEFORE linking. Inspect every name
#    collision and decide which fiber is the keeper. Copy the non-overlapping
#    fibers from the side that will become the symlink into the canonical side.

# 3. Move the side that will become the symlink out of the way. Do not delete it.
mv <project>/.felt <project>/.felt.pre-link

# 4. Create the symlink (store as canonical shown here).
ln -s ~/store/.felt/<project> <project>/.felt

# 5. Verify from both sides.
felt -C <project> ls -s all
felt -C ~/store tree

# 6. Only once verified, remove the backup.
rm -rf <project>/.felt.pre-link
```

For the project as canonical, the move-aside happens at
`~/store/.felt/<project>` and the symlink points the other way:
`ln -s <project>/.felt ~/store/.felt/<project>`. The discipline is the same.

**Never `rm -rf` either side before verifying.** Fibers hold accreted context
that is expensive to reconstruct.

## Links across projects

A `[[wikilink]]` resolves against the store felt is reading, so what resolves
depends on which store that is.

Inside a view of a store, a link can reach any fiber in the whole store. Local
ids (`[[covariance]]`), full store paths to fibers in this project
(`[[my-project/covariance]]`) and full paths to fibers anywhere else
(`[[commons/jackknife]]`) all resolve, and `felt check` run from the project
treats them as sound.

From a project that is canonical, only the project's own fibers resolve on its
side. A link to `[[commons/jackknife]]` written there is sound when checked from
`~/store` and flagged as broken when checked from the project, since the
project cannot see the store.

Two stores that are not joined by any symlink cannot see each other at all. A
link from one into the other reads as broken from either side, and the warning
is accurate. If the link matters, join the stores; mirroring the target into
both is worth it only for a stable reference document, and often the link reads
just as well as prose. Do not silence the warning by inventing a stub fiber.

## If the shuttle daemon runs on this machine

The daemon polls the stores it is given and assumes none. Point it at a fresh
store on a machine where your fibers already live in other stores, and you get a
healthy daemon serving an empty board — no error, because nothing is wrong.

A cross-project store is the tidy answer: felt re-discovers a store's symlinked
substores, so naming the store reaches every project linked into it, and a new
project joins by symlink rather than by reconfiguring the daemon. See
[Configuring stores](../shuttle/installation.md#configuring-stores) for where
the store list is set, and its [Sharp edges](../shuttle/installation.md#sharp-edges)
for the macOS constraint that decides the direction: launchd cannot read
`~/Documents`, `~/Desktop` or `~/Downloads` at all, so a project in one of those
can only be daemon-visible if its bytes are canonical elsewhere.
