# ASTRA Field Reference

ASTRA (Analysis Specification for Transparent Research Automation) is an open specification for computational science. It gives structure to the things scientists actually decide and discover: which method was chosen and why the alternatives were rejected, what data went in and what came out, what was found and what evidence supports it.

Felt fibers carry ASTRA fields in their YAML frontmatter alongside felt's own fields (`title`, `status`, `tags`, `depends-on`, `outcome`). All ASTRA fields are optional — a fiber with just `title` is valid. Fields accrete as understanding crystallizes: write inputs while scripts run, record excluded options the moment you reject them. `felt export --format astra` emits the formalized subset as a standalone ASTRA spec. Downstream tools consume it directly: Prism executes the analysis across decision universes, MySTRA renders it as a live interactive document, Prism-UI visualizes decisions and evidence in VS Code.

Schema source: `~/Documents/projects/ASTRA/spec/0.1/analysis.schema.json`

---

## Top-Level Fields

These go directly in the fiber's YAML frontmatter alongside felt fields (`title`, `status`, `tags`, `depends-on`, `outcome`).

| Field | Type | Purpose |
|-------|------|---------|
| `description` | string | Detailed description of the analysis |
| `inputs` | array of [Input](#input) | Data and analysis dependencies |
| `outputs` | array of [Output](#output) | Products: figures, metrics, data, tables, reports |
| `decisions` | map of id → [Decision](#decision) | Choice points with options and reasoning |
| `insights` | map of id → [Insight](#insight) | Claims with evidence |
| `success_criteria` | array of [SuccessCriterion](#success-criterion) | Pass/fail conditions |
| `container` | string or [ContainerBuildSpec](#container-build-spec) | Default container image for recipes |
| `analysis-grade` | boolean | Workflow flag: human-validated and analytically relied upon |

---

## Input

An input to the analysis. Two kinds: external data (`type: data`) or another analysis's outputs (`type: analysis`).

```yaml
inputs:
  - id: shear_catalog          # required, snake_case
    type: data                 # required: data | analysis
    description: "KiDS-1000 shape catalog"
    source: /path/to/catalog   # for type: data
    checksum:                  # optional integrity check
      algorithm: sha256
      value: abc123...

  - id: psf_model
    type: analysis
    from: psf-modeling         # reference to sibling fiber
    # OR for external ASTRA analyses:
    # ref: "other-astra-spec"
    # use_outputs: [model_params]
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `id` | yes | string | `^[a-z][a-z0-9_]*$` |
| `type` | yes | `data` or `analysis` | |
| `description` | no | string | |
| `source` | no | string | URI or path (for `data`) |
| `checksum` | no | `{algorithm, value}` | sha256, sha512, md5 |
| `ref` | no | string | External ASTRA analysis reference (for `analysis`) |
| `ref_version` | no | string | Version of referenced analysis |
| `use_outputs` | no | string[] | Which outputs from the referenced analysis |
| `from` | no | string | Parent input or sibling output: `input_id` or `sibling.output_id` |

---

## Output

A product of the analysis.

```yaml
outputs:
  - id: posterior              # required, snake_case
    type: data                 # required: metric | figure | table | data | report
    description: "Posterior samples"

  - id: corner_plot
    type: figure
    from: inference.posterior   # traces provenance from sub-analysis
    recipe:
      command: "python plot_corner.py"
      container: "python:3.11-slim"
      resources: {cpus: 4, memory: "8GB"}
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `id` | yes | string | `^[a-z][a-z0-9_]*$` |
| `type` | yes | `metric`, `figure`, `table`, `data`, `report` | |
| `description` | no | string | |
| `from` | no | string | Sub-analysis provenance: `sub_analysis.output_id` |
| `recipe` | no | [Recipe](#recipe) | How to produce this output |

### Recipe

```yaml
recipe:
  command: "snakemake results/figure.png"   # required
  inputs: [posterior]                        # output IDs that must exist first
  container: "python:3.11-slim"             # overrides node-level container
  resources:
    cpus: 4
    memory: "16GB"
    gpus: 1
    time_limit: "2h"
```

---

## Decision

A choice point with named options. The core ASTRA object for documenting methodology.

```yaml
decisions:
  covariance_method:                  # decision ID (key in map)
    label: Covariance estimation      # required
    rationale: "Off-diagonal noise bias matters at our depth"
    default: glass                    # option ID for baseline
    tags: [systematics]
    when: "parent_decision.option"    # conditional: only exists when that option is active
    options:                          # required, map of option_id -> Option
      glass:
        label: GLASS mock covariance
        description: "Full mock-based covariance from 1000 GLASS realizations"
        insights: [glass_convergence]          # insight IDs supporting this option
        requires: ["mock_count.thousand"]      # must co-select
      analytic:
        label: Analytic (Knox + NKA)
        excluded: true
        excluded_reason: "Off-diagonal noise bias >10% at l<100"
        incompatible_with: ["noise_model.full"]
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `label` | yes | string | Human-readable name |
| `options` | yes | map of id → Option | At least one option |
| `rationale` | no | string | Why this decision exists |
| `default` | no | string | Option ID for baseline universes |
| `tags` | no | string[] | For grouping |
| `when` | no | string | Conditional: `decision_id.option_id` pattern |

### Option

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `label` | yes | string | |
| `description` | no | string | |
| `insights` | no | string[] | Insight IDs supporting this choice |
| `excluded` | no | boolean | Was considered and rejected |
| `excluded_reason` | no | string | Why (required morally when `excluded: true`) |
| `incompatible_with` | no | string[] | `decision.option` pairs that conflict |
| `requires` | no | string[] | `decision.option` pairs that must co-select |

---

## Insight

A scientific finding with evidence. The claim is the thing you want to stand behind; the evidence is the traceable anchor that justifies it.

```yaml
insights:
  leakage_negligible:                          # insight ID (key in map)
    claim: "PSF leakage alpha < 0.01 for all bins"    # required
    created_at: 2026-02-12T00:00:00Z           # required, ISO 8601
    derived: false                             # true if synthesized/inferred
    scope: "KiDS-1000 gold sample"             # applicability conditions
    tags: [systematics, psf]
    notes: "Checked auto and cross-spectra"
    evidence:                                  # required, at least one
      - id: measurement                        # required
        artifact: leakage_figure               # output ID from this fiber
        # OR for literature:
        # doi: "10.48550/arXiv.2007.15633"
        # version: 2                           # arXiv version
        quote:
          type: TextQuoteSelector
          exact: "We find alpha < 0.01 in all bins"
          prefix: "After applying the correction, "
          suffix: ", consistent with no leakage."
        figure:
          type: FigureSelector
          label: "Figure 3a"
          caption: "PSF leakage per tomographic bin"
        table:
          type: TableSelector
          label: "Table 2"
          region: "row 3"
        location:
          type: FragmentSelector
          page: 6
```

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `claim` | yes | string | 1-2 sentences |
| `created_at` | yes | datetime | ISO 8601 |
| `evidence` | yes | array of Evidence | At least one |
| `derived` | no | boolean | Default false. True for synthesis |
| `scope` | no | string | When does this apply? |
| `tags` | no | string[] | |
| `notes` | no | string | Reasoning |

### Evidence

Standard ASTRA supports `doi` or `artifact`. In local felt practice we also allow a provisional `document` source for unpublished in-repo manuscripts while upstream ASTRA support is being discussed. At least one selector (`quote`, `figure`, `table`) should still anchor the evidence.

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `id` | yes | string | |
| `doi` | one of | string | `10.XXXX/...` format. arXiv: `10.48550/arXiv.XXXX.XXXXX` |
| `artifact` | one of | string | Output ID from this fiber's `outputs` |
| `document` | local extension | `{path, commit}` | Immutable anchor for unpublished or local manuscripts |
| `version` | no | integer | arXiv paper version |
| `checksum` | no | `{algorithm, value}` | Artifact integrity |
| `snapshot` | no | string | Path to immutable copy (artifact only) |
| `source_commit` | no | string | Git commit that produced artifact |
| `quote` | no | TextQuoteSelector | `{type, exact, prefix?, suffix?}` |
| `figure` | no | FigureSelector | `{type, label, caption?}` |
| `table` | no | TableSelector | `{type, label, caption?, region?}` |
| `location` | no | FragmentSelector | `{type, page?}` — PDF location hint |

For local unpublished manuscripts, use `document.path` + `document.commit` and a `LineSelector` location hint:

```yaml
evidence:
  - id: paper_i_method
    document:
      path: docs/unions_release/unions_shear_catalog_paper/draft_corrected.tex
      commit: abcdef1234567890
    quote:
      type: TextQuoteSelector
      exact: "We build a 20 x 20 grid in (SNR, size) ..."
    location:
      type: LineSelector
      start: 929
      end: 944
```

This is a felt-side extension pending upstream ASTRA design; the immutable anchors are the quote plus commit, with line numbers used only for navigation.

### Literature audit pattern

When you are auditing a paper citation, keep the two layers distinct:

- **Claim**: the statement in the manuscript being audited, or the narrower proposition that manuscript sentence relies on.
- **Evidence**: the anchor in the cited source that actually supports that claim. Prefer `quote`; add `figure`, `table`, and `location` when they make the support easier to verify.

Example:

```yaml
insights:
  psf_leakage_method_audit:
    claim: The manuscript's PSF-leakage sentence is justified for the concrete SNR-size regression method only when it cites Paper I.
    created_at: 2026-04-02T15:30:00Z
    tags: [literature, citation_audit]
    notes: The broader PSF-leakage framework is still appropriately attributed elsewhere.
    evidence:
      - id: paper_i_method
        doi: "10.48550/arXiv.2501.00001"
        version: 1
        quote:
          type: TextQuoteSelector
          exact: "We divide the sample into bins of signal-to-noise and galaxy-to-PSF size ratio..."
          prefix: "To estimate the leakage correction, "
          suffix: " and fit a linear trend in each cell."
        location:
          type: FragmentSelector
          page: 12
```

If you also want to record what your audit concluded overall, that can be a separate insight with `artifact` evidence pointing to the audit ledger or worker report.

---

## Success Criterion

```yaml
success_criteria:
  - claim: "Parameter shift < 0.5 sigma from DESI 2024"    # required
    output: posterior_shift          # output ID to check
    condition: "value < 0.5"        # evaluation condition
```

---

## Container Build Spec

For when the container image needs building rather than pulling:

```yaml
container:
  build: containers/Containerfile.analysis
  context: .
  args:
    PYTHON_VERSION: "3.11"
```

---

## Felt-to-ASTRA Mapping

felt fields and ASTRA fields coexist in the same frontmatter. felt handles the fiber lifecycle; ASTRA handles the scientific structure.

| felt field | ASTRA equivalent | Notes |
|------------|------------------|-------|
| `title` | `name` | felt uses `title`; ASTRA export maps to `name` |
| `tags` | `tags` | Shared |
| `depends-on` | `inputs` (type: analysis) | felt deps are structural; ASTRA inputs are data-flow |
| `outcome` | — | felt-only. The conclusion/documentation |
| `status` | — | felt-only lifecycle state |
| — | `description` | ASTRA-only. More detailed than title |
| — | `decisions` | ASTRA-only |
| — | `insights` | ASTRA-only |
| — | `inputs`/`outputs` | ASTRA-only data flow |

`felt export --format astra` emits only fibers with at least one ASTRA field. Directory nesting maps to ASTRA `analyses` nesting.

---

## ID Conventions

- Input/output IDs: `^[a-z][a-z0-9_]*$` (snake_case)
- Decision IDs: snake_case (map keys)
- Insight IDs: snake_case (map keys)
- Option IDs: snake_case (map keys)
- Evidence IDs: free-form string, but snake_case recommended
