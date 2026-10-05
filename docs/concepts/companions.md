# Companion files

A fiber owns a directory, not just a file. The `<slug>/<slug>.md` layout exists
for that reason: whatever the work produced can sit beside the markdown that
describes it.

```
.felt/bao-analysis/mock-validation/
├── mock-validation.md
├── report.html
├── residuals.png
├── chains.pdf
└── interview.m4a
```

felt does not manage these files. It does not copy, index, or validate them.
They stay ordinary files in a directory that happens to be a fiber, and they
travel with the fiber through `nest`, `unnest`, git, and sync.

## Embedding an artifact

Declare a companion in the body with an `:::{embed}` directive:

```markdown
:::{embed} residuals.png
:::

:::{embed} build/paper.pdf
:title: Latest build
:::
```

Paths resolve relative to the fiber's directory. Absolute paths also work.
The Board reader lists declared files on the fiber page and opens each as a
separate document; the directive itself does not appear in the rendered prose.
A `:title:` option supplies the document's label.

| Extension | Board reader |
|---|---|
| `.html` `.htm` | live HTML document |
| `.md` | rendered prose |
| plain text and source files | scrollable text or code |
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.avif` | image |
| `.pdf` | native PDF viewer |
| `.wav` `.mp3` `.m4a` `.ogg` `.flac` `.aac` | audio player |
| `.mp4` `.mov` `.webm` | video player |
| other formats | file details and download |

!!! note "Who does the rendering"
    The Board's document workspace reads `:::{embed}` directives — see
    [the Shuttle board guide](../shuttle/board.md). The `felt` CLI treats the
    directive as ordinary body text. A plain markdown viewer or an Obsidian
    vault shows it as a literal block.

## The `report.html` convention

felt names exactly one companion: `report.html`.

Put what a human *reads* — findings, figures, analysis prose — in a sibling
`report.html` when it outgrows the outcome line. felt detects the file during
its directory walk and surfaces the absolute path as `report_path` in JSON
output:

```bash
felt show mock-validation -j | jq -r .report_path
```

felt implies nothing further. It does not open the file, render it, or require
it. Most fibers need no report; work whose story is commits plus an outcome
line does fine without one.

To make the report the first document selected when the channel opens, declare
it at the top of the body:

```markdown
:::{embed} report.html
:::

The jackknife covariance is the default. …
```

HTML beats markdown here: sections, tables, inlined plots, and collapsible
depth in one self-contained file. Keep it self-contained — base64 the images —
so the report renders wherever the fiber is opened, including on a different
machine.

shuttle workers follow a shape for these reports — current state, standing
findings, open questions, pointers to depth — rewritten whole each session.
See [Optional: report.html](../shuttle/constitutions.md#optional-reporthtml).

## Sent files (shuttle only)

A shuttle worker can also push a file at you directly, with
`shuttle send-file <path> [path...]`.
`shuttle hook event` records that push on the host's event stream
(`~/.shuttle/events.jsonl`). The Board overview shows recent sends in its
receipt ribbon and folios; the reader groups repeated sends under each
document's Receipts menu. See [the Board guide](../shuttle/board.md#board-what-the-work-produced).

The two channels overlap — the file a worker sends is very often its own
`report.html`, a companion. What differs is durability.

| | Companion | Send |
|---|---|---|
| What it is | a file in the fiber directory | an event record pointing at a path |
| Travels with | `nest`, `unnest`, git, sync | nothing — it stays on the machine that ran the worker |
| Lifetime | as long as the fiber | as long as the live `events.jsonl`; a trail that rolled over is gone |
| Scope | any machine that has the fiber | that host, capped at 50 entries per card |

Sending a file does not put it in the fiber, and putting a file in the fiber
does not surface it on the board.

!!! note "Needs `~/.shuttle`"
    `shuttle hook event` refuses to create its own directory, so an install
    without daemon state grows no event stream and every trail stays empty. See [The event
    stream and the
    ledgers](../shuttle/installation.md#the-event-stream-and-the-ledgers).
