# Companion files

A fiber owns a directory, not just a file. The `<slug>/<slug>.md` layout exists
for that reason: whatever the work produced can sit beside the markdown that
describes it.

```
.felt/bao-analysis/mock-validation/
├── mock-validation.md
├── artifact.html
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
The Board reader lists declared files in the constitution's page tabs and opens each as a separate document.
The directive itself does not appear in the rendered prose.
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

## The `artifact.html` convention

felt recognizes `artifact.html` as a fiber's companion page, with `report.html`
as a compatibility name for existing fibers. If both files exist, readers
select `artifact.html`.

Use `artifact.html` as the living, visual index to a fiber's sub-fibers, sent
files, and findings. It can combine figures, analysis prose, and links when
that helps a reader catch up. felt detects the file during
its directory walk and surfaces the absolute path as `report_path` in JSON
output:

```bash
felt show mock-validation -j | jq -r .report_path
```

felt implies nothing further. It does not open the file, render it, or require
it. Most fibers need no companion page.

To make the artifact the first document selected when the channel opens, declare
it at the top of the body:

```markdown
:::{embed} artifact.html
:::

The jackknife covariance is the default. …
```

HTML supports sections, tables, inlined plots, and collapsible depth in one
self-contained file. Keep it self-contained — base64 the images — so the page
renders wherever the fiber is opened, including on a different machine.

Shuttle workers rewrite the artifact as the work changes. Its findings can use
the concise report register: group by meaning, rewrite instead of appending,
and inline every image. See [Optional: artifact.html](../shuttle/constitutions.md#optional-artifacthtml).

Existing `report.html` files and explicit `:::{embed} report.html`
declarations continue to work. New companion pages use `artifact.html`.

## References between pages

An artifact can refer to a file already in its constitution's pages, whether the file was embedded or sent.
In HTML, use a relative link such as `<a href="./take.mp3">Listen to the take</a>` or name the file in `<code>take.mp3</code>`.
In markdown, use `[Listen to the take](./take.mp3)` or a code span such as `take.mp3`.
Plain text panes also recognize filenames in backticks.

The reader makes these references page links: clicking selects the file in the same reader, updating its tabs and address through the normal navigation path.
Relative links resolve from the source document's directory on its owning host.
A bare filename in code, or in a link's text, must be unique across the constitution's pages; a path in code resolves from the source directory instead.
Ambiguous filenames stay unlinked, and external URLs keep their own navigation.

Audio references also have an inline ▸ button.
It plays the channel's audio-page element without leaving the artifact, changes to ❙❙ while playing, and shows progress as a hairline.
Press it again to pause.
Only one recording plays at a time; changing pages or leaving the reader pauses inline playback.

## Sent files (shuttle only)

A shuttle worker can also push a file at you directly, with
`shuttle send-file <path> [path...]`.
`shuttle hook event` records that push on the host's event stream
(`~/.shuttle/events.jsonl`). The Board overview shows recent sends in its
receipt ribbon and folios; the reader groups repeated sends under each
document's Receipts menu. See [the Board guide](../shuttle/board.md#board-what-the-work-produced).

The two channels overlap — the file a worker sends can also be the fiber's
`artifact.html` companion. What differs is durability.

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
