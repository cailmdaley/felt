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

felt finds the enclosing store along the link the view was mounted by, one
symlink at a time: it looks above the view's path for a `.felt/` that holds
fibers, and only if there is none does it follow the next symlink on that path
and look again. A view linked to `~/store/.felt/science/cmbx` belongs to
`~/store`, with prefix `science/cmbx`, even when `~/store/.felt/science` is
itself a symlink into another repository's `.felt/` (see
[The project as canonical](#the-project-as-canonical)). A view linked straight
into that other `.felt/` belongs to it instead.

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
project's fibers are versioned wherever the project versions them. When that is
another git repository, `felt sync` from the store syncs it too: after the
store's own repository, it runs the same fetch, merge and optional `--push` in
each repository that a symlinked directory inside the store points into, once
per repository, naming each. A symlink to a directory outside git mounts
nothing. A mounted repository whose branch tracks no remote branch is skipped
with a note; one that fails is reported by its path after the others have run, and
sync exits non-zero.
Sync commits nothing, in the store or in a mounted repository.
`git add .felt` in the store stops at the link, so changes to mounted fibers are committed in their own repository; sync says when one holds uncommitted fiber changes.

The same holds one level down. When the mounted directory is itself a store
that projects link into (`~/store/.felt/science` → `~/science/.felt`, and
`<project>/.felt` → `~/store/.felt/science/cmbx`), a project linked through
the store's spelling is a view of `~/store`: `find` and outer ids reach the
whole store, not only `~/science`. A project linked to
`~/science/.felt/cmbx` directly is a view of `~/science`.

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

Two stores that are not joined by any symlink cannot resolve each other's
links. A shared store can declare its expected neighbours in the frontmatter
of its single bare root fiber (`.felt/shared.md`):

```yaml
neighbors: [commons, work]
```

`felt check` groups unresolved links starting with those names into one info
line per absent neighbour, such as `commons: not mounted, 18 links`. A neighbour
is reachable when the enclosing store has that top-level directory or fiber;
links into it are checked normally. Other unresolved links remain errors.
The declaration does not mount stores or change link resolution. Only this
field is read; the root fiber's other custom fields remain opaque.

If a link matters locally, join the stores; do not invent stub fibers to
silence the warning.

## Sharing a store with other people

A store that several people write to is a project-as-canonical store in a repository they all push to.
Each person clones it and, if they keep a larger store of their own, links it in:

```bash
git clone git@example.org:group/shared.git ~/shared
ln -s ~/shared/.felt ~/store/.felt/shared
```

Link to the repository's whole `.felt/`, not to a directory inside it.
The Shuttle daemon discovers a mounted store only when the link's target is named `.felt`.
Keep the link out of the larger store's Git history (add it to that store's `.gitignore`): a tracked link would make Git replace the directory on every other machine, deleting ignored files beside the fibers.

Three conventions keep several people's agents out of each other's way.
None of them needs a field in the fibers.

- **Top-level trees are topics, and anyone adds to any of them.** Knowledge has no owner; open work names the person who answers for it in its `role:` ([Roles](roles.md)), and `felt ls` shows everyone's with the role beside it.
- **Links are written from the shared store's root.** `[[analysis/likelihood]]` resolves in the shared repository on its own and, from a fiber inside the mount, in the larger store too, where the same fiber's id is `shared/analysis/likelihood`.
- **The repository's `AGENTS.md` describes the layout** for agents that change it.

Each person also says, once per checkout of the shared repository, whom that checkout works for:

```bash
git -C ~/shared config felt.person sam
```

felt then stamps every open fiber created in that repository `role: sam`, reading the config of the repository that physically holds the new fiber, so a fiber added through the link in the larger store takes the shared checkout's config, not the larger store's.
A role is `<office>` or `<office>/<person>` (`analyst/sam`); the person responsible is its last segment, so `role: sam` is Sam's own desk, an office like any other with its charter at `roles/sam`. Handing work over is editing it: `felt edit <id> --role <person>`.
A role says who answers for a fiber; it hides nothing. `felt ls`, and the open work listed at the start of an agent's session, show everyone's work, each line carrying its role as `@analyst/sam` before the tags.
`felt ls --person <name>` keeps one person's, and `felt find --person <name>` narrows a search.

felt carries the notes and nothing else.
Messages between people's agents, if wanted, travel some other way: the shared repository itself can carry them as files, with each person's own hook delivering what arrives.

Moving an existing subtree of a store into such a repository is the [linking procedure](#linking-a-project-without-losing-fibers) with one more hazard: other machines hold the same subtree.
Untrack the subtree in the larger store and ignore the path, push that, and on each machine pull first and link second, so that Git removes the tracked files and leaves untracked and ignored ones for you to carry over.

## If the shuttle daemon runs on this machine

The daemon polls the stores it is given and assumes none. Point it at a fresh
store on a machine where your fibers already live in other stores, and you get a
healthy daemon serving an empty board — no error, because nothing is wrong.

A cross-project store is the tidy answer: felt re-discovers a store's symlinked
substores, so naming the store reaches every project linked into it, and a new
project joins by symlink rather than by reconfiguring the daemon. See
[Configuring stores](../shuttle/configuration.md#configuring-stores) for where
the store list is set, and its [Sharp edges](../shuttle/troubleshooting.md)
for the macOS constraint that decides the direction: launchd cannot read
`~/Documents`, `~/Desktop` or `~/Downloads` at all, so a project in one of those
can only be daemon-visible if its bytes are canonical elsewhere.
