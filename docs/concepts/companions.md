# Companion files

A fiber owns a directory, not just a file. That is the reason for the
`<slug>/<slug>.md` layout: whatever the work produced can sit beside the
markdown that describes it.

```
.felt/bao-analysis/mock-validation/
├── mock-validation.md
├── report.html
├── residuals.png
├── chains.pdf
└── interview.m4a
```

felt does not manage these files. It does not copy, index, or validate them.
They are just files in a directory that happens to be a fiber, and they travel
with the fiber through `nest`, `unnest`, git, and sync.

## Embedding an artifact

The body can inline any companion where it helps the reader, using an
`:::{embed}` directive:

```markdown
:::{embed} residuals.png
:::

:::{embed} build/paper.pdf
:height: 600
:title: Latest build
:::
```

Paths resolve relative to the fiber's directory. Absolute paths also work.

The renderer dispatches by file extension:

| Extension | Rendered as |
|---|---|
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.avif` | image |
| `.wav` `.mp3` `.m4a` `.ogg` `.flac` `.aac` | audio player |
| everything else, `.pdf` and `.html` included | fixed-height iframe |

!!! note "Who does the rendering"
    The `:::{embed}` directive is understood by the Shuttle board's fiber
    viewer — see [the Shuttle layer](../shuttle/index.md). The `felt` CLI
    itself treats the directive as ordinary body text. In a plain markdown
    viewer or an Obsidian vault it will show up as a literal block, so use it
    where the board (or your own renderer) is the intended reader.

## The `report.html` convention

There is exactly one named companion: `report.html`.

When a fiber's product is something a human *reads* — findings, figures,
analysis prose — that outgrows the outcome line, it goes in a sibling
`report.html`. felt detects the file during its directory walk and surfaces the
absolute path as `report_path` in JSON output:

```bash
felt show mock-validation -j | jq -r .report_path
```

Nothing else is implied. felt does not open it, render it, or require it. Most
fibers have none; work whose story is commits plus an outcome line does not
need a report.

To make the report the first thing a reader meets, embed it explicitly at the
top of the body:

```markdown
:::{embed} report.html
:::

The jackknife covariance is now the default. …
```

Why HTML rather than markdown: sections, tables, inlined plots, and
collapsible depth in one self-contained file. Keep it self-contained — base64
the images — so the report renders wherever the fiber is opened, including on
a different machine.

Shuttle workers follow a shape for these reports (Current State / Findings /
Open Questions) and ship a template; see
[Constitutions](../shuttle/constitutions.md).
