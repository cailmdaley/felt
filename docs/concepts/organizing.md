# Organizing fibers

Three surfaces carry structure: **status** says whether something is a todo,
**containment** says what belongs inside what, and **wikilinks** say how ideas
connect in prose. They work independently. Each does one job.

## Statuses

Add a status only when you want one. Most fibers never need one.

| Icon | Status | Meaning |
|---|---|---|
| `·` | untracked | No `status` key at all. A note, a reference doc, a container. |
| `○` | open | Tracked, not started. |
| `◐` | active | In progress. |
| `●` | closed | Done, outcome captured. |

Fibers default to untracked, and untracked ranks no lower than the rest. A
durable reference fiber holds no todo, and giving it a status only adds noise
to `felt ls`.

```bash
felt edit damping-prior -s active
felt edit damping-prior -s closed -o "Gaussian prior at 2.5 Mpc/h; flat prior biased the fit low."
```

Closing stamps `closed-at`. Write the outcome at the same moment — see
[Outcomes](#outcomes-teach) below.

`felt ls` shows open and active by default. Any filter — a query, `-t`, `-n` —
widens automatically to all statuses, so a search finds closed work without
your having to ask twice.

```bash
felt ls                       # open and active
felt ls -s closed             # only closed
felt ls -s all                # everything
felt ls "covariance"          # search, all statuses
```

## Containment

The filesystem carries the hierarchy. A fiber nested inside another fiber's
directory belongs to it. Nesting the directory records the containment;
nothing else needs to stay in sync.

```bash
felt tree
felt tree bao-analysis --depth 2
```

Reshape with `nest` and `unnest`. Both move the whole subtree and rewrite ids
and dependency references as they go.

```bash
felt nest damping-prior bao-analysis     # → bao-analysis/damping-prior
felt unnest bao-analysis/damping-prior   # → damping-prior
```

`felt add` also resolves the leading segment of a slug against existing fibers.
If `project/launch` exists, then:

```bash
felt add launch/log "Launch log"    # lands at project/launch/log
```

`--top-level` opts out and creates at the root. An ambiguous leading segment —
the same basename in several subtrees — aborts and lists the candidates rather
than picking one.

!!! note "Containers should not be todos"
    Keep open/active meaning *todo*. Mark a container fiber that holds children
    untracked or closed; the work lives in the leaves. An active container sits
    in `felt ls` forever and teaches you to ignore the list.

## Wikilinks

Connect fibers in prose with `[[wikilink]]` in the body. felt uses the Obsidian
format deliberately: a `.felt/` directory opens directly as an Obsidian vault,
with backlinks and graph view working out of the box.

```markdown
The jackknife estimate disagrees with [[analytic-covariance]] below ℓ=300,
which is what pushed us to [[bao-analysis/damping-prior|the tighter prior]].
```

Supported forms: `[[slug]]`, `[[slug|label]]`, `[[slug#fragment]]`, and
`[[slug#fragment|label]]`. Ordinary markdown links to files are also checked.

felt computes reverse citations on demand:

```bash
felt show analytic-covariance --citations
felt show analytic-covariance -d summary   # lede + citations + consumers
```

### Links in prose, not in piles

A link earns its place by doing work inside a sentence — naming what the other
fiber is, why it matters here, where to go next.

Avoid a "Related" list at the bottom of a fiber. It usually signals a
relationship you have not thought through yet. Fold those links into the prose
where they belong, or drop the ones that were never earning their keep.

## Outcomes teach

The `outcome` field states the conclusion in one line. `felt show` displays it
at every detail level from `compact` up, and it headlines a shuttle kanban
card. Readers meet this sentence most often, so write it well.

An outcome that says "done" has failed. Say what was learned, decided, or
measured, in a sentence that stands alone:

```yaml
# no
outcome: Finished the covariance work.

# yes
outcome: Jackknife over 200 patches beats the analytic model below l=300; the
  analytic version underestimates the diagonal by ~15% there.
```

Include what you decided *not* to do. Nobody reconstructs that part six months
later.

For anything longer than a sentence, edit the file directly with a `|-` block
scalar:

```yaml
outcome: |-
  Jackknife wins below l=300. Above that the two agree to 2%.

  Rejected: analytic-only (biased low), and the full mock suite (too slow
  to regenerate per systematics variation).
```

`felt edit -o "…"` goes through the shell, which mangles multiline content and
quotes. The block scalar takes the content literally, so paragraphs, lists, and
embeds round-trip cleanly.
