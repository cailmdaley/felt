---
title: Unpublished evidence
status: closed
tags:
    - felt
    - astra
    - literature
    - example
    - lightcone
    - pure-eb
depends-on:
    - citation-audit
    - astra-semantics
created-at: 2026-04-02T15:58:57.020878095+02:00
closed-at: 2026-04-02T16:23:51.935900846+02:00
outcome: 'Opened upstream ASTRA issue #53 proposing first-class support for traceable evidence from unpublished or local manuscripts, motivated by the citation-traceability workflow for the UNIONS B-modes paper. Proposed anchor shape: local document path + git commit + quote selector + optional line-based location hint.'
description: Decide how ASTRA-style citation graphs should anchor evidence for local or unpublished manuscripts that lack a DOI, while preserving traceability comparable to published literature evidence.
---

(unpublished-evidence)=
# Unpublished evidence

The immediate trigger is the B-modes citation graph. Published papers can be anchored cleanly with a DOI plus quote/selector, but companion manuscripts such as Paper I are still local `.tex` sources and therefore fall outside ASTRA's current literature evidence model.

The likely requirement is an immutable local-document evidence anchor: repository path, git commit, quote selector, and a line-based location hint. Line numbers alone are too fragile; they need a content anchor and revision anchor.

## Proposed ASTRA Issue

Title: Support traceable evidence for unpublished or local manuscripts

Body:

We ran into a schema limitation while using ASTRA-style insights for citation traceability in an in-progress paper.

Current ASTRA evidence works well for:
- published literature via `doi` + quote/figure/table selectors
- analysis outputs via `artifact`

But there is a third common case in real research workflows:
- local or unpublished manuscripts that are scientifically relevant and citable within a project, but do not yet have a DOI

Concrete example:
- we are building an ASTRA-style citation graph for a paper
- some claims are supported by published papers, which fit `doi`
- other claims are supported by companion manuscripts in the same repo that are still in preparation
- these local manuscripts are not analysis outputs, so `artifact` is not quite right
- they also do not have a DOI, so they cannot be represented as literature evidence under the current model

Our ad hoc workaround is to treat these as local document evidence anchored by:
- repository path
- git commit
- quote selector
- optional line-based location hint

For example:

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

The important part is that the immutable anchors are the quote plus commit; line numbers are only a navigation hint.

Question:
- should ASTRA support a third evidence source for local documents, in addition to `doi` and `artifact`?

Possible directions:
- add `document` as a first-class evidence source
- allow a more general `source` object with typed variants (`doi`, `artifact`, `document`)
- define a recommended convention for unpublished manuscripts if a schema change is not desired

The motivating use case is Paper2ASTRA-like literature extraction and citation traceability inside active research projects, where some of the most important supporting documents are local manuscripts that have not been published yet.

## Comments
**2026-04-02 16:23** — Posted upstream ASTRA issue #53: https://github.com/LightconeResearch/ASTRA/issues/53
