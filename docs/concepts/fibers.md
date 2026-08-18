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
- legacy `title` frontmatter keys
- legacy `depends-on` frontmatter keys
- legacy body anchors
- slug collisions between bare and nested fiber forms
- multiple bare `.md` files at the `.felt/` root
- fibers with a blank `name`
- a shuttle `host:` that is this machine under a pre-normalization name
  (differing only by case or a DNS suffix), which the daemon's exact-match
  dispatch would silently skip

```bash
felt check
felt check --json
```

!!! note "Cross-store links look broken"
    A `[[wikilink]]` pointing into a different store reads as broken to
    `felt check`. felt scopes to one store at a time. Expect that warning; it
    marks no defect. See [Cross-project stores](cross-project.md).

## Migrating a legacy store

`felt migrate` normalizes an older store into the current model:

- flat `.felt/<slug>.md` files become `<slug>/<slug>.md`
- `title` frontmatter becomes `name`
- inert `depends-on` keys are dropped
- leading anchor lines like `(slug)=` are stripped from bodies

Look before you leap:

```bash
felt migrate --dry-run
felt migrate
```

`--dir <path>` points the migration at a store other than the current project's.

A separate one-off pass, `felt backfill-ids`, mints intrinsic ULIDs for fibers
that lack them. Run it on the **canonical** copy of a store only, then sync the
files, so replicas inherit the committed ids instead of minting their own. See
[Frontmatter](frontmatter.md#ids) for what the id is for.
