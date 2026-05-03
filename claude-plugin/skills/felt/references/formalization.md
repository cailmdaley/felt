# Formalization

How fibers move through three tiers of rigor: Annotated, Formalized, Tempered. Formalization is guided by real structure, not by closure state or importance.

---

## The Tier Ladder

A fiber starts annotated and climbs as structure crystallizes. All three tiers share the same schema; what differs is how much of it is filled.

- **Annotated**: any valid felt fiber. Name, outcome, body, tags, and wikilinks in any combination. No structured frontmatter required. This covers everything from a bare name to a rich doc fiber.
- **Formalized**: the fiber has at least one well-formed structured object in frontmatter — a `decisions:` block, `inputs:`/`outputs:`, or `insights:`. Structure is real enough to be useful, not just a placeholder.
- **Tempered**: `tempered: true` in frontmatter. Human-validated and part of the real scientific argument. This is a workflow flag, not a richer schema.

### Tier progression

A single fiber climbing the ladder:

| Tier | State |
|------|-------|
| **Annotated** | `adopt-blind-a-as-fiducial-bb` exists as a note that blind A may become the fiducial BB choice |
| **Formalized** | It gains a `decisions:` block with real options, default, and excluded reasoning |
| **Tempered** | It is marked `tempered: true` because the collaboration has validated and relied on it |

### Kind is an observation, not a classification

There is no formal typology of fiber kinds. A fiber's shape is whatever its populated frontmatter makes it: `decisions:` populated means the fiber is acting as a decision, `inputs:` and `outputs:` populated means it is acting as a computation, `insights:` populated means it is acting as a finding. A single fiber can play any combination of those roles.

### Formalization threshold

Formalize when structured content is real enough to write without inventing. A decision has actual options, a computation has concrete inputs and outputs, a finding has a claim with evidence. Outcome is not a prerequisite; this can happen before the work is finished. Keep it annotated if it is still just a note or question.

For async compute, launch the job and formalize inputs and expected outputs while it runs; add insights when results come in.

---

## Common Shapes

Different fibers need different frontmatter fields. The shapes below are common patterns, not a formal typology; a single fiber can mix any of them. Do not fill fields that do not apply.

### Decision fiber

A choice was made between alternatives.

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
insights:  # optional: findings that informed the decision
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

A concrete claim backed by evidence that reduces uncertainty, whether or not it directly triggers a decision. For literature audits, the claim should be the manuscript statement under review and the evidence should point into the cited source, not just into your audit notes.

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

### Literature-backed finding fiber

Use this shape when the point of the fiber is to verify that a paper claim is actually supported by the cited literature.

```yaml
insights:
  treecorr_citation_audit:
    claim: The manuscript's TreeCorr sentence should cite the TreeCorr software record rather than the 2004 aperture-mass paper.
    created_at: 2026-04-02T15:30:00Z
    tags: [literature, citation_audit]
    evidence:
      - id: treecorr_record
        doi: 10.48550/arXiv.1508.007
        quote:
          type: TextQuoteSelector
          exact: TreeCorr: Two-point correlation functions
```

If you want to preserve the audit trail itself, record that as a second insight with `artifact` evidence pointing to the ledger or report you generated.

For unpublished companion manuscripts, use the provisional local-document extension instead of forcing them into `artifact`:

```yaml
evidence:
  - id: paper_i_psf_method
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

---

## Body vs Frontmatter

- **Frontmatter**: structured layer for code and tooling
- **Body**: explanation, caveats, and narrative for humans and agents
- **Do not duplicate**: the frontmatter should not be copied verbatim into the body

Optional body conventions by kind:

- **Decision**: `## Why this is justified`, `## Consequences`
- **Computation**: `## Notes`, `## Caveats`
- **Finding**: `## Interpretation`, `## Limits`

The frontmatter is for branching, querying, and downstream tooling. The body is where the argument, caveats, and context live.

---

## Anti-Patterns

- Inventing structure before real options, inputs, or evidence exist
- Duplicating frontmatter verbatim into the body
- Formalizing ephemeral thoughts; leave them annotated unless they are a real decision, computation, or finding
- Marking `tempered: true` before human validation
- Treating tempered as a compliment rather than a workflow flag

---

## Progressive Example

A single fiber, `psf-leakage-check`, climbing the ladder.

### Annotated

```bash
felt add psf-leakage-check "PSF leakage check"
felt edit psf-leakage-check -s active -o "Leakage test in progress; checking whether any tomographic bin needs correction."
```

The file at `.felt/psf-leakage-check/psf-leakage-check.md`:

```markdown
---
name: PSF leakage check
status: active
tags: [systematics]
outcome: Leakage test in progress; checking whether any tomographic bin needs correction.
---

# PSF leakage check

Measuring additive and multiplicative leakage while the validation jobs run.
Cross-check against shape-PSF correlations if any bin looks marginal.
```

Real content, no structured frontmatter yet.

### Formalized

Still mid-computation. Append structured fields to the existing frontmatter:

```yaml
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
      command: snakemake results/psf-leakage/leakage.png
decisions:
  correction_needed:
    label: Whether to apply PSF leakage correction
    default: no_correction
    options:
      no_correction: {label: No correction}
      subtract_template:
        label: Subtract leakage template
        excluded: true
        excluded_reason: Only if leakage exceeds the agreed threshold
```

The fiber now carries real structure grounded in actual computation.

### Tempered

The result is in, human-checked, and relied on downstream. Close the fiber, refine the outcome, add the insight, and set the workflow flag:

```yaml
status: closed
tempered: true
outcome: >
  Leakage α < 0.01 for all bins. No correction needed.
  Checked both auto and cross-spectra.
insights:
  leakage_negligible:
    claim: PSF leakage α < 0.01 for all tomographic bins
    created_at: 2026-02-12
    evidence:
      - id: leakage_measurement
        artifact: results/psf-leakage/evidence.json
```

The body now carries interpretation, caveats, and why the threshold is the right one. The frontmatter stays structural.
