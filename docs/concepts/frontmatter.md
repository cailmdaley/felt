# Frontmatter

A fiber's frontmatter has two halves. felt owns a fixed set of native fields.
Everything else is yours, and felt carries it without opinion.

The rule: **felt owns the fiber; projects own any additional YAML fields.**

## Native fields

| Key | Type | Set by |
|---|---|---|
| `id` | ULID string | minted at `felt add` |
| `name` | string | `felt add <slug> <name>`, `felt edit --name` |
| `status` | `open` / `active` / `closed` | `-s/--status` |
| `tags` | list of strings | `-t/--tag`, `--untag` |
| `created-at` | timestamp | felt, on create |
| `updated-at` | timestamp | felt, on every write |
| `closed-at` | timestamp | felt, when status becomes closed |
| `outcome` | string | `-o/--outcome` |
| `due` | date | `-D/--due` (`YYYY-MM-DD`) |
| `description` | string | **file only** — no CLI flag |

felt parses, validates, and formats these. `description` is the odd one out:
it is native, but there is no `--description` flag. Set it by editing the file.

## Project-owned fields

Every other top-level YAML key is **opaque**. felt preserves it verbatim across
read/edit/write, exposes it in `--json`, and lets you filter and read it — but
it never validates the semantics. If your project wants `dataset:`,
`instrument:`, or an `inputs:` block describing data flow, put it in.

```yaml
---
name: Cosebis data vector
instrument: KiDS-1000
inputs:
  - id: shear_catalogue
    from: catalogue-cuts
---
```

Scalars can be set from the CLI. The value is read as a YAML scalar, so types
survive:

```bash
felt edit damping-prior --set horizon=stashed --set cold=true --set n_patches=200
felt edit damping-prior --unset horizon --unset cold
```

Structured blocks — lists, nested maps — are edited in the file directly.
`--set` handles scalars only.

### Reading them back

```bash
felt show damping-prior --field instrument     # one key, shell-friendly
felt show damping-prior -d compact             # metadata + the extra keys' names
felt ls --has-field instrument                 # fibers that carry the key
felt ls --json --json-field instrument         # just that field, as JSON
felt ls -j                                     # everything, as JSON
```

`--field` formats for shell consumers: scalars on one line, sequences of
scalars one per line, structured values as YAML.

One convention felt *does* understand: `inputs.from` names another fiber as a
data-flow input. `felt show <id> --consumers` gives you the reverse edge, and
`felt check` flags broken `from` references. That is the extent of it — the
rest of the block is still yours.

## Ids

`id` is an intrinsic ULID, minted once at `felt add` and never changed. It is
the fiber's identity for federation and dispatch consumers — the thing that
stays stable when a fiber is renamed, nested, or moved.

The slug path is the *address* you type. The ULID is the *identity*. In JSON
output they are distinguished: `id` is the slug address, `uid` is the ULID.

```bash
felt show bao-analysis/damping-prior -j | jq '{id, uid}'
```

Fibers predating ids can be backfilled with `felt backfill-ids`. Run it on the
canonical store only — see [Fibers](fibers.md#migrating-a-legacy-store).

## Never hand-edit timestamps

`created-at` and `updated-at` belong to felt. It restamps them on every write,
so a value you type in by hand is silently overwritten. `updated-at` in
particular is the git-durable recency anchor — unlike file mtime it survives
the clone, checkout, and reorg rewrites that cross-machine sync inflicts, which
is exactly why felt insists on owning it.

Edit content fields. Leave the clocks alone.
