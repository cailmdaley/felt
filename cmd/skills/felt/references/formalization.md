# Formalization

How fibers move through the deterministic 3x3 model: three tiers, three kinds. Formalization is guided by real structure, not by closure state or importance.

---

## The 3x3 Model

### Three tiers

- **Annotated**: any valid felt fiber. Title, outcome, body, tags, and links in any combination. No ASTRA requirement. This covers everything from a bare title to a rich doc fiber.
- **Formalized**: the fiber has at least one well-formed ASTRA object in frontmatter. Deterministic test: could `felt export --format astra` emit this?
- **Analysis-grade**: `analysis-grade: true` in frontmatter. Human-validated and part of the real scientific argument. This is a workflow flag, not a richer schema.

### Three kinds

- **Decision**: `decisions` block with options, default, excluded reasoning, plus optional `insights`
- **Computation**: `inputs` + `outputs`, plus optional `recipe`
- **Finding**: `insights` with a claim and evidence pointers

### 3x3 table

| Kind | Annotated | Formalized | Analysis-grade |
|------|-----------|------------|----------------|
| **Decision** | `adopt-blind-a-as-fiducial-bb` exists as a note that blind A may become the fiducial BB choice | `adopt-blind-a-as-fiducial-bb` has a `decisions:` block with real options, default, and excluded reasoning | `adopt-blind-a-as-fiducial-bb` is also marked `analysis-grade: true` because the collaboration has validated and relied on it |
| **Computation** | `96-bin-powspace-is-optimal` is a breadcrumb or running note about binning tests | `96-bin-powspace-is-optimal` records concrete `inputs:` and `outputs:` for the comparison, optionally with a recipe | `96-bin-powspace-is-optimal` is marked `analysis-grade: true` because the result is part of the real analysis argument |
| **Finding** | `cosebis-blind-independent` is a note that blind independence may hold | `cosebis-blind-independent` has an `insights:` claim with evidence pointers | `cosebis-blind-independent` is marked `analysis-grade: true` after human validation and incorporation into the scientific case |

### Formalization threshold

Formalize when structured content is real enough to write without inventing. A decision has actual options, a computation has concrete inputs and outputs, a finding has a claim with evidence. This can happen before the work is finished; outcome is not a prerequisite. Write inputs while scripts run. Keep it annotated if it is still just a note or question.

---

## Per-Kind Templates

Different fibers need different ASTRA fields. Do not fill fields that do not apply.

### Decision fiber

The core kind. A choice was made between alternatives.

```yaml
decisions:
  covariance_method:
    label: Covariance estimation method
    default: glass
    options:
      glass:
        label: GLASS mock covariance
      analytic:
        label: Analytic (Knox + NKA)
        excluded: true
        excluded_reason: Off-diagonal noise bias >10% at ℓ<100
insights:  # optional — findings that informed the decision
  glass_better:
    claim: Analytic covariance underestimates off-diagonal at our noise level
    evidence:
      - id: cov_comparison
        artifact: results/diagnostics/cov_comparison.png
```

**Minimum:** `decisions` with `label`, `default`, and at least one excluded option with reasoning. If it is important enough to be a decision, record what you did not choose.

**Rationale:** keep it to one line in YAML or put the full argument in the body. The decision block is queryable structure; the body is where causal reasoning lives.

### Computation fiber

A fiber that consumes inputs and produces outputs.

```yaml
inputs:
  - id: mock_cls
    type: data
    from: mock-validation
    description: GLASS mock pseudo-Cℓ for validation
  - id: theory_wn
    type: data
    description: W_n(ℓ) COSEBIS weight functions
outputs:
  - id: optimal_binning
    type: metric
    description: Recovery accuracy per COSEBIS mode
  - id: binning_figure
    type: figure
    recipe:
      command: snakemake results/tapestry/harmonic-cosebis/binning.png
```

**Minimum:** `inputs` + `outputs` with IDs and types. `recipe` is recommended when the output is regenerable, but not required.

### Finding fiber

A concrete claim backed by evidence that reduces uncertainty, whether or not it directly triggers a decision.

```yaml
insights:
  cosebis_blind_independent:
    claim: COSEBIS BB covariance is exactly blind-independent (analytic propagation)
    created_at: 2026-01-21
    evidence:
      - id: covariance_investigation
        artifact: docs/wiki/cosmology_for_covariance.md
```

**Minimum:** `insights` with `claim` + evidence. A finding may later feed into a decision fiber upstream; that is fine. File it when you find it.

---

## Body vs Frontmatter

- **Frontmatter**: structured layer for code and export
- **Body**: explanation, caveats, and narrative for humans and agents
- **Do not duplicate**: the frontmatter should not be copied verbatim into the body

Optional body conventions by kind:

- **Decision**: `## Why this is justified`, `## Consequences`
- **Computation**: `## Notes`, `## Caveats`
- **Finding**: `## Interpretation`, `## Limits`

The frontmatter is for branching, validation, querying, and export. The body is where the argument, caveats, and context live.

---

## Anti-Patterns

- Inventing ASTRA structure before real options, inputs, or evidence exist
- Duplicating frontmatter verbatim into the body
- Formalizing ephemeral thoughts; leave them annotated unless they are a real decision, computation, or finding
- Marking `analysis-grade: true` before human validation
- Treating analysis-grade as a compliment rather than a workflow flag

---

## The Direct-Edit Pattern

**CLI for metadata, file edit for content.**

| Operation | Tool |
|-----------|------|
| Create fiber | `felt "title"` or `felt add "title" [flags]` |
| Change status, tags, links | `felt edit <id> --status ... --tag ... --link ...` |
| Set outcome | `felt edit <id> -o "..."` |
| Append comment | `felt edit <id> --comment "..."` |
| Write/edit body and ASTRA frontmatter | Read + Edit on `.felt/<path>/<slug>.md` |

When adding ASTRA fields, read the file first, then edit the existing frontmatter block directly.

---

## Background Formalization Workflow

Formalization is compatible with asynchronous work:

1. Launch the computation.
2. Formalize the fiber with inputs and expected outputs while it runs.
3. Let the computation finish.
4. Add insights and outcome when the result is known.

Outcome is documentation, not the gate for structured frontmatter.

---

## Progressive Example

### Annotated

```bash
felt "PSF leakage check"
felt edit psf-leakage-check -o "Leakage test in progress; checking whether any tomographic bin needs correction."
```

Edit `.felt/psf-leakage-check/psf-leakage-check.md`:

```markdown
---
title: PSF leakage check
status: active
tags:
  - systematics
depends-on:
  - psf-modeling
outcome: Leakage test in progress; checking whether any tomographic bin needs correction.
---

# PSF leakage check

Measuring additive and multiplicative leakage while the validation jobs run.
Cross-check against shape-PSF correlations if any bin looks marginal.
```

This is already a valid annotated fiber: it has real content, but no ASTRA structure yet.

### Formalized

Same fiber, now with concrete frontmatter while the computation is still running:

```yaml
---
title: PSF leakage check
status: active
tags:
  - systematics
  - tapestry:psf-leakage
depends-on:
  - psf-modeling
outcome: Leakage test in progress; checking whether any tomographic bin needs correction.

inputs:
  - id: shear_catalog
    type: data
    source: KiDS-1000 shape catalog v2
  - id: psf_model
    type: analysis
    from: psf-modeling

outputs:
  - id: leakage_alpha
    type: metric
    description: Additive PSF leakage parameter per bin
  - id: leakage_figure
    type: figure
    recipe:
      command: snakemake results/tapestry/psf-leakage/leakage.png

decisions:
  correction_needed:
    label: Whether to apply PSF leakage correction
    default: no_correction
    options:
      no_correction:
        label: No correction
      subtract_template:
        label: Subtract leakage template
        excluded: true
        excluded_reason: Only if leakage exceeds the agreed threshold
---
```

Now the fiber is formalized because `felt export --format astra` could emit it.

### Analysis-grade

Once the result has been checked by a human and relied on in the real analysis, mark that workflow state explicitly:

```yaml
---
title: PSF leakage check
status: closed
analysis-grade: true
tags:
  - systematics
  - tapestry:psf-leakage
depends-on:
  - psf-modeling
outcome: >
  Leakage α < 0.01 for all bins. No correction needed.
  Checked both auto and cross-spectra.

inputs:
  - id: shear_catalog
    type: data
    source: KiDS-1000 shape catalog v2
  - id: psf_model
    type: analysis
    from: psf-modeling

outputs:
  - id: leakage_alpha
    type: metric
    description: Additive PSF leakage parameter per bin
  - id: leakage_figure
    type: figure
    recipe:
      command: snakemake results/tapestry/psf-leakage/leakage.png

decisions:
  correction_needed:
    label: Whether to apply PSF leakage correction
    default: no_correction
    options:
      no_correction:
        label: No correction
      subtract_template:
        label: Subtract leakage template
        excluded: true
        excluded_reason: α stayed below the agreed threshold in every bin

insights:
  leakage_negligible:
    claim: PSF leakage α < 0.01 for all tomographic bins
    created_at: 2026-02-12
    evidence:
      - id: leakage_measurement
        artifact: results/tapestry/psf-leakage/evidence.json
---
```

The body now carries the interpretation, caveats, and why the threshold is the right one. The frontmatter stays structural.

---

## ASTRA Export

```bash
felt export --format astra
```

Formalized fibers are the exportable set. Analysis-grade fibers are a flagged subset of that set.

For the full ASTRA schema: `~/Documents/projects/ASTRA/spec/0.1/analysis.schema.json`.
