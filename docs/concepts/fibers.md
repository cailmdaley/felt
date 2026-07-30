# Fibers and the store

## What a fiber is

A fiber is one concern. A task, a decision, a question, a finding, a spec, a
reference doc — anything worth naming.

On disk a fiber is a directory holding a markdown file with YAML frontmatter:

```
.felt/covariance-estimation/covariance-estimation.md
```

The frontmatter carries metadata. The body is plain markdown. That is the whole
format.

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

There is no database and no index. The markdown tree *is* the store. Everything
else — back-references, reverse consumers, body search — is computed on demand
by walking the tree.

## Name, body, outcome

Three fields carry the content, and they have distinct jobs.

- **`name`** is a concise label. It is not the content.
- **`outcome`** is the one-line conclusion. It is what `felt show` prints and
  what a kanban card shows. (`felt ls` lists the status icon, the id, the name,
  and the tags.)
- **body** is the substance: what is true now, why it matters, what connects.

The body describes the present state, not the journey. Chronology lives in the
git log of the file — fibers are ordinary text files, so version control does
that job already.

## Addressing a fiber

A fiber is addressed by its slug path. Nested fibers use `/`:

```bash
felt show covariance-estimation
felt show bao-analysis/damping-prior
```

A bare slug resolves as long as it is unique across the store. Ambiguity is an
error, not a guess.

## Store layout

A store is a `.felt/` directory at a project root. The standard shape is
`.felt/<path>/<slug>/<slug>.md`.

The fiber owns a directory, which is the point: companion files — plots, PDFs,
a `report.html` — live beside the markdown. See
[Companion files](companions.md).

```
.felt/
├── myst.yml
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

One exception to the directory rule: a single bare `.felt/<slug>.md` at the
store root is the **entry-point fiber** — the project's front door. felt
preserves it as-is and never migrates it.

Two or more bare `.md` files at the root are ambiguous. felt cannot tell the
entry point from stray legacy files, so `felt check` flags it and
`felt migrate` converts them all to directory form.

## Creating a store

```bash
cd my-project
felt init
```

`felt init` creates or repairs `.felt/` and writes two support files:

- `myst.yml` — a MyST project config, so the store renders as a site.
- `.gitignore` — ignores `*.md.lock`, felt's per-fiber write locks.

It is safe to re-run. Existing files are left alone.

Then add your first fiber:

```bash
felt add covariance-estimation "Covariance estimation" \
  -t decision \
  -o "Jackknife over 200 patches beats the analytic model below l=300."
```

Fibers are meant to be committed. They are text; git handles them the way it
handles any source file, and the history you get is the history of the
thinking.

## Checking the store

`felt check` lints the store. It reports:

- broken narrative wikilinks and broken body links
- broken `inputs.from` data-flow references
- legacy `title` frontmatter keys
- legacy `depends-on` frontmatter keys
- legacy MyST body anchors
- slug collisions between bare and nested fiber forms
- multiple bare `.md` files at the `.felt/` root
- fibers with a blank `name`
- orphaned pins — a fiber claiming a pinned role with no `shuttle:` block
  (warning)

```bash
felt check
felt check --json
```

!!! note "Cross-store links look broken"
    A `[[wikilink]]` pointing into a different store reads as broken to
    `felt check`. felt scopes to one store at a time. That warning is expected,
    not a defect. See [Cross-project stores](cross-project.md).

## Migrating a legacy store

`felt migrate` normalizes an older store into the current model:

- flat `.felt/<slug>.md` files become `<slug>/<slug>.md`
- `title` frontmatter becomes `name`
- inert `depends-on` keys are dropped
- leading MyST anchors like `(slug)=` are stripped from bodies
- `myst.yml` is ensured

Look before you leap:

```bash
felt migrate --dry-run
felt migrate
```

`--dir <path>` points the migration at a store other than the current project's.

A separate one-off pass, `felt backfill-ids`, mints intrinsic ULIDs for fibers
created before ids existed. Run it on the **canonical** copy of a store only,
then sync the files, so replicas inherit the committed ids instead of minting
their own. See [Frontmatter](frontmatter.md#ids) for what the id is for.
