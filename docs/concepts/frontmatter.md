# Frontmatter

A fiber's frontmatter has two halves. felt owns a fixed set of native fields.
It preserves every other top-level key without interpreting it; the tool that
writes a key owns its meaning.

The rule: **felt owns the fiber; each additional field has its own owner.**

## Native fields

| Key | Type | Set by |
|---|---|---|
| `id` | ULID string | minted at `felt add` |
| `name` | string | `felt add <slug> <name>`, `felt edit --name` |
| `status` | `open` / `active` / `closed` | `felt edit -s/--status`; shuttle lifecycle verbs |
| `tags` | list of strings | `-t/--tag`, `--untag` |
| `created-at` | timestamp | felt, on create |
| `updated-at` | timestamp | felt, on every write |
| `closed-at` | timestamp | felt, when status becomes closed |
| `outcome` | string | `felt edit -o/--outcome`; `shuttle set-outcome` |
| `due` | date | `-D/--due` (`YYYY-MM-DD`) |
| `description` | string | **file only** — no CLI flag |

felt parses, validates, and formats these. `description` stands apart: felt
owns it natively, but only a file edit sets it.

## Project-owned fields

felt treats every other top-level YAML key as **opaque**. It preserves the key
verbatim across read/edit/write, exposes it in `--json`, and lets you filter
and read it. It never validates the semantics. If your project wants
`dataset:`, `instrument:`, or an `inputs:` block describing data flow, put it
in.

```yaml
---
name: Cosebis data vector
instrument: KiDS-1000
inputs:
  - id: shear_catalogue
    from: catalogue-cuts
---
```

Set scalars from the CLI. felt reads the value as a YAML scalar, so types
survive:

```bash
felt edit damping-prior --set instrument=KiDS-1000 --set n_patches=200
felt edit damping-prior --unset instrument --unset n_patches
```

Edit structured blocks — lists, nested maps — in the file directly. `--set`
handles scalars only.

### Reading them back

```bash
felt show damping-prior --field instrument     # one key, shell-friendly
felt show damping-prior -d compact             # metadata + the extra keys' names
felt ls --has-field instrument                 # fibers that carry the key
felt ls --json --json-field instrument         # just that field, as JSON
felt ls -j                                     # everything, as JSON
```

`--field` formats for shell consumers: scalars on one line, sequences of
scalars one per line, structured values as YAML. `shuttle ls` and `shuttle
show` accept the corresponding list/read flags and add the resolved Shuttle
facet to JSON; the `felt` commands leave the block as plain frontmatter.

One convention felt *does* understand: `inputs.from` names another fiber as a
data-flow input. Every `inputs:` entry with a `from:` is an edge, whether or
not it carries an `id:` (the id only labels it). `felt show <id> --consumers`
gives you the reverse edge, `felt check` flags broken `from` references, and
`felt nest` rewrites the ones a move would break. That is all felt itself
reads. The rest of the block stays yours.

### Conventions other tools read

A key felt treats as opaque can still mean something to whatever else looks at
your fibers. These are the ones in this repo, so you recognise them if you meet
them — and so you do not pick the same names for something else. felt validates
none of them; shuttle validates and resolves its own block.

| Key | Read by | Meaning |
|---|---|---|
| `inputs.from` | felt | A data-flow edge to another fiber |
| `shuttle:` | shuttle CLI and daemon | Dispatch configuration and lifecycle state; felt preserves the block without validating or resolving it |
| tag `cycle` + `start:` / `due:` | the shuttle board | A named span of calendar time, drawn as a band. Written by dragging in the Chronicle |
| `horizon: stashed` | the shuttle board | Takes a card off the Now board to Resting. A `due:` day at or past today overrides it and pulls the card back |
| `cold: true` | the shuttle board | Marks a stashed card *held open*: its Resting cluster renders dimmer, wears a `held open` tag, and sorts below the warm clusters. Cleared alongside `horizon` when the card returns to the desk |

The board writes these itself, through the daemon, which shells the same `felt
edit --set` you would type. See [Cycles and eras](../shuttle/cycles.md) and
[The board](../shuttle/board.md#horizon).

## Ids

felt mints `id` as an intrinsic ULID at `felt add` and never changes it. It
identifies the fiber for federation and dispatch consumers, and it holds steady
when a fiber is renamed, nested, or moved.

You type the slug path as the *address*. The ULID carries the *identity*. JSON
output distinguishes them: `id` gives the slug address, `uid` gives the ULID.

```bash
felt show bao-analysis/damping-prior -j | jq '{id, uid}'
```

Every fiber carries one. A felt write to a fiber that has none (a file made
by hand) stamps a fresh ULID into it, and shuttle refuses to dispatch a fiber
without one, since its worker's tmux session is named `<leaf>-<id>-shuttle`.
Backfill a whole store with `felt backfill-ids`. Run it on the canonical store
only — see [Fibers](fibers.md#migrating-a-legacy-store) — and sync before
editing an id-less fiber elsewhere, so two replicas do not mint different ids
for it.

## Never hand-edit timestamps

`created-at` and `updated-at` belong to felt. It restamps them on every write,
so it silently overwrites a value you type in by hand. `updated-at` anchors
recency in a git-durable way: it survives the clone, checkout, and reorg
rewrites that cross-machine sync inflicts, where file mtime does not. So felt
insists on owning it.

Edit content fields. Leave the clocks alone.
