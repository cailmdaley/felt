# Fibers and the store

## One fiber, one concern

Give each concern its own fiber. A task, a decision, a question, a finding, a
spec, a reference doc — anything worth naming.

On disk, a fiber owns a directory holding a markdown file with YAML
frontmatter:

```
.felt/covariance-estimation/covariance-estimation.md
```

The frontmatter carries metadata. The body holds plain markdown. That covers
the whole format.

```markdown
---
id: 01KTCA2CGCYT0VW8320JRE79VS
name: Covariance estimation
status: active
tags:
    - decision
created-at: 2026-01-31T02:40:05.884858+01:00
outcome: Jackknife over 200 patches beats the analytic model below ℓ=300.
---

The pipeline needs a covariance we trust at large scales. …
```

felt reads the markdown tree directly. It computes everything else —
back-references, reverse consumers, body search — on demand by walking the
tree.

## Name, body, outcome

Three fields carry the content, and they have distinct jobs.

- **`name`** labels the fiber concisely. Keep the content out of it.
- **`outcome`** states the conclusion in one line. `felt show` prints it, and a
  kanban card shows it. (`felt ls` lists the status icon, the id, the name, and
  the tags.)
- **body** carries the substance: what is true now, why it matters, what
  connects.

The body describes the present state, not the journey. Chronology lives in the
git log of the file — fibers are ordinary text files, so version control does
that job already.

## Addressing a fiber

Address a fiber by its slug path. Nested fibers use `/`:

```bash
felt show covariance-estimation
felt show bao-analysis/damping-prior
```

A bare slug resolves as long as it is unique across the store. Ambiguity raises
an error rather than a guess.

### Commands that delete or move never act on a guess

An address resolves in one of these ways:

- the exact id;
- a path relative to the current fiber's scope or one of its ancestors;
- a unique bare slug (`jackknife-patches`), or a correct partial path whose
  every segment matches the end of exactly one id (`a2/jackknife`).

`felt check` accepts all of these silently, and so does every command. Two
looser matches are **guesses**:

- a path that matches nothing, rescued by its last segment when that names
  exactly one fiber — the stale path `felt check` warns about;
- a prefix completion (`proj/a/lea` for `proj/a/leaf2`).

From a project view, the enclosing store's answer is also a guess when it
comes by tail, prefix or last segment rather than by the path itself.

An exact address always wins over a completion: an id or scoped path that
names a fiber outright — including, from a project view, an id written out
from the enclosing store's root — is never answered by some other fiber that
merely begins with the same letters.

`show` and `edit` accept a guess. `rm`, `nest` and `unnest` refuse it and name
the fiber it would have reached:

```
"a/zzz" only reaches a fiber by guessing, and this command does not act on a guess; did you mean b/zzz?
```

## Store layout

A store lives in a `.felt/` directory at a project root. It follows the shape
`.felt/<path>/<slug>/<slug>.md`.

Each fiber owns a directory for a reason. Companion files — plots, PDFs, a
`report.html` — live beside the markdown. See
[Companion files](companions.md).

```
.felt/
├── .gitignore
├── project.md                      ← entry-point fiber (bare, at root)
└── bao-analysis/
    ├── bao-analysis.md
    ├── damping-prior/
    │   └── damping-prior.md
    └── mock-validation/
        ├── mock-validation.md
        └── report.html             ← companion file
```

### The entry-point fiber

The directory rule has one exception. A single bare `.felt/<slug>.md` at the
store root serves as the **entry-point fiber** — the project's front door. felt
preserves it as-is and never migrates it.

Two or more bare `.md` files at the root create ambiguity. felt cannot tell the
entry point from stray legacy files, so `felt check` flags it and
`felt migrate` converts them all to directory form.

### Stray fiber files

Below the root, a fiber is only ever `<path>/<slug>/<slug>.md`. A bare
`.felt/bao-analysis/damping-prior.md` that carries fiber frontmatter — `name:`
plus a key only fibers carry, such as `status`, `tags`, `outcome` or a
timestamp — is a **stray fiber file**. It is not a fiber until it moves: `ls`
does not list it, and `show`, `edit`, `rm`, `nest` and `add` refuse its id
with a pointer to the file rather than acting on some other fiber of the same
name, from a project view as well. A link to it is reported broken. `felt
check` reports the file as an error naming its directory-form home, and `felt
migrate` folds it there. The id it gains is the one its path already spelled,
so links written to it resolve without edits once it moves.

Migrate never moves a stray it cannot fold safely: when its home already holds
a fiber, when a file or a symlink sits where its directory would go, when the
stray is a symlink or the target of one, or when its name differs from its
directory's only in case (`Notes/notes.md`, which wants renaming to
`Notes/Notes.md` instead). Those are reported with the reason, for a move by
hand.

Markdown without fiber frontmatter — a transcript, a survey, notes kept beside
a fiber, a skill's `SKILL.md` — is a companion file, and felt leaves it alone,
as it does anything under a hidden directory.

## Creating a store

```bash
cd my-project
felt init
```

`felt init` creates or repairs `.felt/` and writes a `.gitignore` that ignores
`*.md.lock`, felt's per-fiber write locks.

Re-running it is safe. It leaves existing files alone.

Then add your first fiber:

```bash
felt add covariance-estimation "Covariance estimation" \
  -t decision \
  -o "Jackknife over 200 patches beats the analytic model below l=300."
```

Commit your fibers. Git versions the text like any source file, so the log
tracks how the thinking moved.

## Checking the store

`felt check` lints the store. It reports:

- broken narrative wikilinks and broken body links
- broken `inputs.from` data-flow references
- stale paths: a multi-segment reference such as `[[a/x]]` where no fiber
  lives at that path, which still resolves because its final segment names
  exactly one fiber (a warning: typically a link left behind by an older move,
  or by a move made outside felt)
- legacy `title` frontmatter keys
- legacy `depends-on` frontmatter keys
- legacy body anchors
- slug collisions between bare and nested fiber forms
- multiple bare `.md` files at the `.felt/` root
- stray fiber files below the root (see
  [Stray fiber files](#stray-fiber-files))
- fibers with a blank `name`
- a shuttle `host:` that is this machine under a pre-normalization name
  (differing only by case or a DNS suffix), which the daemon's exact-match
  dispatch would silently skip

```bash
felt check
felt check --json
```

Errors make `felt check` exit non-zero, with or without `--json`; warnings and
notes print without failing it.

!!! note "Links across projects"
    From a project whose `.felt/` is a symlinked view into a larger store,
    links resolve against the whole store, so `[[other-project/slug]]` is sound.
    A link into a store that is not joined to this one by any symlink cannot
    resolve, and `felt check` is right to flag it. See
    [Cross-project stores](cross-project.md#links-across-projects).

## Migrating a legacy store

`felt migrate` normalizes an older store into the current model:

- flat `.felt/<slug>.md` files become `<slug>/<slug>.md`
- stray fiber files below the root fold into `<path>/<slug>/<slug>.md`
- `title` frontmatter becomes `name`
- inert `depends-on` keys are dropped
- leading anchor lines like `(slug)=` are stripped from bodies

Look before you leap:

```bash
felt migrate --dry-run
felt migrate
```

`--dir <path>` points the migration at a store other than the current project's.

Afterwards, `felt check` should pass. Two things outside the store may still
point at the old layout: hex-suffixed ids in CLAUDE.md or other notes
(`rg '<slug>-[0-9a-f]{8}'` finds them; drop the suffix), and code or hooks that
glob `.felt/*.md` directly, which must walk directories and read
`<slug>/<slug>.md` instead.

A separate one-off pass, `felt backfill-ids`, mints intrinsic ULIDs for fibers
that lack them. Run it on the **canonical** copy of a store only, then sync the
files, so replicas inherit the committed ids instead of minting their own. See
[Frontmatter](frontmatter.md#ids) for what the id is for.
