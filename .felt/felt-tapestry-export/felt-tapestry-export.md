---
title: felt tapestry export
status: closed
tags:
    - tapestry
created-at: 2026-03-14T13:47:20.658053+01:00
closed-at: 2026-03-14T17:51:55.801069+01:00
outcome: |-
    Implemented felt tapestry export as a Go subcommand. Reads .felt/ fibers + results/tapestry/ evidence, writes tapestry.json + artifact images to ~/.felt/tapestries/data/{city}/. No server dependency.

    Conventions: evidence at results/tapestry/{specName}/evidence.json (renamed from results/claims/). Tapestry skill ships with felt as canonical reference.

    Template repo: cailmdaley/tapestries. main = template (viewer + demo), live = GitHub Pages with real data. Cloning main gives a working viewer immediately.

    Viewer rebuild (rare): npm run build:static in portolan, commit to main, merge into live.
---

(felt-tapestry-export)=
Design spec for `felt tapestry export` — a new Go subcommand that exports the tapestry DAG directly from local `.felt/` fibers, replacing the current portolan-server-dependent publish flow.

## Context

The static tapestry viewer (GitHub Pages at `cailmdaley.github.io/tapestries/`) currently requires:
1. A running portolan server to assemble the DAG
2. SSH access to pull remote fibers/evidence
3. Export script + Vite build + git push — all from one machine

This bottlenecks everything through one machine. Remote machines (Cineca, Candide) have their fibers and evidence *locally*, but we SSH-pull them just to push to GitHub.

## Design

### Command: `felt tapestry export`

Reads `.felt/` fibers and `results/tapestry/` evidence in the current project directory. Writes a self-contained export (JSON + artifact images) to a shared tapestries repo clone.

### Output target

`~/.felt/tapestries/` — a single clone of `cailmdaley/tapestries` (or any tapestries template repo). Each project writes to `~/.felt/tapestries/data/{cityName}/`. felt auto-detects this path; no per-project config.

If `~/.felt/tapestries/` does not exist, print a helpful message:
```
No tapestries repo found at ~/.felt/tapestries/
Clone it: git clone git@github.com:cailmdaley/tapestries.git ~/.felt/tapestries
```

### Data flow

```
.felt/*.md  ──→  filter tapestry: tags  ──→  build DAG (nodes, links)
                                                    │
results/tapestry/{specName}/evidence.json  ──→  evidence + staleness
                                                    │
                                              tapestry.json + artifacts
                                                    │
                                         ~/.felt/tapestries/data/{city}/
```

### Step by step

1. **Read all fibers** from `.felt/` using existing `Storage.ListAll()` (or equivalent full-read method)
2. **Filter to tapestry nodes**: fibers with any `tapestry:*` tag
3. **Extract spec names**: from `tapestry:{specName}` tag (e.g., `tapestry:cosebis_data_vector` → `cosebis_data_vector`)
4. **Read evidence**: for each spec, read `results/tapestry/{specName}/evidence.json` if it exists. Extract:
   - `evidence` → metrics (arbitrary key-value)
   - `output` → artifact map (key → filename), filtered to image extensions (`.png`, `.jpg`, `.jpeg`, `.pdf`)
   - `generated` → timestamp string
   - file mtime → for staleness computation
5. **Compute staleness**: for each tapestry node with evidence, compare its evidence mtime against all upstream dependencies' evidence mtimes:
   - Any upstream newer → `stale`
   - No evidence → `no-evidence`
   - Otherwise → `fresh`
6. **Build output JSON** (`tapestry.json`):
   ```json
   {
     "nodes": [
       {
         "id": "fiber-id",
         "title": "...",
         "kind": "",
         "status": "open|active|closed",
         "body": "markdown...",
         "outcome": "...",
         "tags": ["tapestry:specname", ...],
         "createdAt": "2026-01-15T...",
         "closedAt": null,
         "dependsOn": ["other-tapestry-fiber-id", ...],
         "specName": "specname",
         "staleness": "fresh|stale|no-evidence",
         "evidence": {
           "metrics": {...},
           "artifacts": {"key": "filename.png"},
           "mtime": 1710000000000,
           "generated": "2026-01-15T..."
         }
       }
     ],
     "links": [
       {"source": "fiber-a", "target": "fiber-b"}
     ],
     "downstream": {
       "fiber-a": [
         {"id": "non-tapestry-fiber", "title": "...", "status": "...", "kind": ""}
       ]
     },
     "config": null,
     "fibers": []
   }
   ```
   - `nodes`: only tapestry-tagged fibers
   - `links`: edges between tapestry nodes only (filter `dependsOn` to tapestry fiber IDs)
   - `downstream`: for each tapestry node, list ALL fibers (including non-tapestry) that depend on it. Include `{id, title, status, kind}`.
   - `config`: read `config/config.yaml` or `workflow/config/config.yaml` if present. Flatten nested YAML to dot-separated keys (e.g., `data.catalog: HSC_Y3`). Return `null` if no config file.
   - `fibers`: empty by default. With `--all-fibers`, include ALL fibers (full metadata + body + outcome).
7. **Copy artifacts**: for each evidence artifact image, copy from `results/tapestry/{specName}/{filename}` to output dir at `{outDir}/tapestry/{specName}/{filename}`
8. **Update manifest**: read/update `~/.felt/tapestries/data/manifest.json`:
   ```json
   [{"name": "cmbx", "nodeCount": 42, "updated": "2026-03-14T..."}]
   ```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--all-fibers` | false | Include all fibers in output (for sidebar) |
| `--force` | false | Re-copy all artifacts even if they exist |
| `--name` | directory basename | Override city name in output |
| `--out` | `~/.felt/tapestries/data/{name}` | Override output directory |

### Evidence path rename

The evidence directory is being renamed from `results/claims/` to `results/tapestry/`. The export reads from `results/tapestry/`. This rename also needs to happen in:
- Portolan server (`EvidenceReader.ts`, `HttpApiTapestry.ts`)
- Export script (`scripts/export-tapestry.ts`) — eventually replaced by this command
- Any snakemake rules that write evidence

### Template repo

`cailmdaley/tapestries` becomes a GitHub template repo. Structure:
```
index.html              ← Vite-built static viewer (shared)
assets/                 ← JS/CSS bundles
fonts/
favicon.svg
404.html
data/
  manifest.json         ← city list
  {cityName}/
    tapestry.json       ← per-city DAG
    tapestry/           ← artifact images
      {specName}/
        figure.png
    files/              ← linked files (future)
```

Anyone can clone the template to get the viewer. `felt tapestry export` writes to `data/`.

### What felt already has

The felt Go codebase already provides:
- `Storage.ListAll()` / `Storage.ListMetadata()` — reads all `.felt/*.md` fibers
- `Storage.Read(id)` — full fiber with body
- `felt.Parse()` / `felt.ParseWithMode()` — YAML frontmatter + markdown body parsing
- `felt.BuildGraph()` — DAG construction with upstream/downstream
- `felt.Felt` struct — ID, Title, Status, Tags, DependsOn (Dependencies type), Body, Outcome, CreatedAt, ClosedAt
- `felt.HasTag(tag)` — supports prefix matching with trailing colon
- `felt.FindProjectRoot()` — discovers `.felt/` directory
- `felt.Graph` — Nodes, Upstream, Downstream maps; BFS traversal methods

### What needs to be written

New file: `cmd/tapestry.go` (or `cmd/tapestry_export.go`)

New internal package: `internal/tapestry/` with:
- `Evidence` struct and `ReadEvidence(projectRoot, specName)` function
- `ComputeStaleness(fiberID, deps, evidenceMap, specMap)` function
- `Export(projectRoot, outDir, options)` — main orchestration
- `ReadConfig(projectRoot)` — YAML config flattening

The command registration pattern follows cobra (see `cmd/ls.go`, `cmd/root.go`):
```go
var tapestryCmd = &cobra.Command{
    Use:   "tapestry",
    Short: "Tapestry operations",
}

var tapestryExportCmd = &cobra.Command{
    Use:   "export",
    Short: "Export tapestry DAG to static site",
    RunE:  func(cmd *cobra.Command, args []string) error { ... },
}

func init() {
    rootCmd.AddCommand(tapestryCmd)
    tapestryCmd.AddCommand(tapestryExportCmd)
}
```

### Evidence JSON format

```json
{
  "evidence": {
    "key": "value",
    "another_key": "another_value"
  },
  "output": {
    "figure": "figure.png",
    "table": "results.csv"
  },
  "generated": "2026-02-22T05:43:12Z"
}
```

- `evidence` → arbitrary metrics (pass through as `node.evidence.metrics`)
- `output` → filename map. Filter to image extensions: `.png`, `.jpg`, `.jpeg`, `.pdf`
- `generated` → ISO timestamp
- File mtime of `evidence.json` → used for staleness comparison
