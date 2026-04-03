---
title: Citation audit
status: closed
tags:
    - pure-eb
    - literature
    - astra
    - example
    - lightcone
    - felt
depends-on:
    - astra-semantics
created-at: 2026-04-02T14:08:29.833604617+02:00
closed-at: 2026-04-02T19:39:34.498290592+02:00
outcome: 'Built a working ASTRA-style citation graph for the UNIONS B-modes paper by treating manuscript statements as claims and cited-paper anchors as evidence. The process surfaced three main lessons: rich citation graphs are useful for real manuscript QA, direct source-backed evidence is much better than audit-log summaries, and unpublished local manuscripts need a first-class document+commit+quote evidence shape rather than being forced into doi or artifact. The resulting workflow is credible for research use, but rich ASTRA content is still more naturally authored via direct frontmatter edits than via complex CLI flags.'
description: Build a traceable citation graph for the UNIONS B-modes paper by mapping manuscript claims to supporting evidence in the cited literature or local companion-paper sources, while recording any citation fixes discovered along the way.
inputs:
    - id: bmodes_tex
      type: data
      source: docs/unions_release/unions_bmodes/unions_bmodes.tex
      description: B-modes manuscript source containing the citation-bearing sentences under review.
    - id: bmodes_bib
      type: data
      source: docs/unions_release/unions_bmodes/unions_bmodes.bib
      description: Bibliography entries for all cited papers.
    - id: literature_cache
      type: data
      source: docs/arxiv/
      description: Cached arXiv source trees used for primary-text verification.
outputs:
    - id: citation_ledger
      type: data
      description: JSON ledger mapping citation-bearing sentences to cited keys and bibliography metadata.
    - id: foundations_report
      type: report
      description: Worker audit report for foundational weak-lensing and early-detection citations.
    - id: methods_report
      type: report
      description: Worker audit report for methodology, estimator, and covariance citations.
    - id: survey_results_report
      type: report
      description: Worker audit report for Stage-III survey and B-mode-results citations.
    - id: unions_internal_report
      type: report
      description: Worker audit report for UNIONS companion-paper and internal-method citations.
insights:
    aperture_mass_foundation_support:
        claim: The manuscript's aperture-mass discussion is supported when it presents aperture mass dispersion as the foundational real-space E/B-separation method and attributes the zero-separation limitation to later finite-interval work.
        created_at: 2026-04-02T16:52:00Z
        tags:
            - citation_graph
            - literature
            - methods
        notes: The current wording keeps the foundational aperture-mass attribution while sourcing the zero-separation limitation to later finite-interval E/B-separation work.
        evidence:
            - id: schneider_aperture_mass
              doi: 10.1051/aas:1996132
              quote:
                type: TextQuoteSelector
                exact: The aperture mass can thus be used to detect dark matter concentrations.
              location:
                type: LineSelector
                start: 381
                end: 381
            - id: schneider_aperture_mass_dispersion
              doi: 10.1046/j.1365-8711.1998.01741.x
              quote:
                type: TextQuoteSelector
                exact: The dispersion of \m, \ave{\m^2(\theta)}, can be expressed as a convolution of the power spectrum of the projected density field with a filter function which is strongly peaked.
              location:
                type: LineSelector
                start: 1970
                end: 1972
            - id: sek_zero_separation
              doi: 10.1051/0004-6361/200913413
              quote:
                type: TextQuoteSelector
                exact: the calculation of the aperture dispersion requires the knowledge of the shear correlation functions down to zero separation
              location:
                type: LineSelector
                start: 221
                end: 225
            - id: schneider22_zero_separation
              doi: 10.1051/0004-6361/202142479
              quote:
                type: TextQuoteSelector
                exact: the calculation of the aperture mass dispersion requires knowledge of the shear correlation function down to zero separation
              location:
                type: LineSelector
                start: 282
                end: 284
    cfht_megacam_lineage_support:
        claim: The manuscript's detector-lineage sentence is supported when it frames the repeating pattern as suggestive of a detector-level phenomenon rather than a pipeline-specific artifact, and notes that CFHTLenS and the UNIONS weak-lensing data both used MegaCam on CFHT.
        created_at: 2026-04-02T16:45:00Z
        tags:
            - citation_graph
            - literature
            - survey
        notes: The current wording avoids over-claiming survey lineage and instead emphasizes the shared MegaCam/CFHT hardware context.
        evidence:
            - id: guinot_megacam_cfht
              doi: 10.1051/0004-6361/202141847
              quote:
                type: TextQuoteSelector
                exact: CFIS is a large imaging survey observing the Northern hemisphere with the wide-field imager \textsc{MegaCAM} on CFHT (pixel scale of 0.187 arcsec).
              location:
                type: LineSelector
                start: 202
                end: 202
            - id: heymans_cfhtlens_megacam
              doi: 10.1111/j.1365-2966.2012.21952.x
              quote:
                type: TextQuoteSelector
                exact: This work is based on observations obtained with MegaPrime/MegaCam
              location:
                type: LineSelector
                start: 625
                end: 625
    config_space_binning_support:
        claim: The manuscript's xi binning sentence is supported when it refers to the 20 logarithmic bins over 1--250 arcmin as the configuration-space data-vector binning in Paper III, rather than as the cosmological-inference scale range.
        created_at: 2026-04-02T16:28:41Z
        tags:
            - citation_graph
            - literature
            - methods
        notes: Uses the provisional local-document evidence extension because Paper III is a local companion manuscript rather than a DOI-backed publication.
        evidence:
            - id: paper_iii_data_vector_binning
              document:
                path: docs/unions_release/unions_2d_shear_xi/main.tex
                commit: f5a0138e8a6e81d14dbbac7c25bce8526454121a
              quote:
                type: TextQuoteSelector
                exact: In Fig. xi_pm we present the xi_pm(theta) data vectors computed by TreeCorr, where we have binned the separation angle theta into 20 logarithmically-spaced bins over 1--250 arcmin.
              location:
                type: LineSelector
                start: 234
                end: 234
            - id: paper_iii_inference_scale_cuts
              document:
                path: docs/unions_release/unions_2d_shear_xi/main.tex
                commit: f5a0138e8a6e81d14dbbac7c25bce8526454121a
              quote:
                type: TextQuoteSelector
                exact: we obtain theta in [5, 83] arcmin for xi_plus and theta in [12,83] for xi_minus
              location:
                type: LineSelector
                start: 636
                end: 636
    higher_order_bmode_support:
        claim: The manuscript's higher-order B-mode sentence is supported when it states that lens-lens coupling, source clustering, and intrinsic alignments can generate B modes, that these signals are far below current sensitivity, and that future ultra-high-precision cross-correlation approaches involving CMB rotation reconstructions and large-scale-structure tracers may access them.
        created_at: 2026-04-02T16:28:41Z
        tags:
            - citation_graph
            - literature
            - foundations
        notes: The original sentence was too categorical about the required detection strategy and has been weakened to match the cited support.
        evidence:
            - id: hilbert_born_lenslens
              doi: 10.1051/0004-6361/200811054
              quote:
                type: TextQuoteSelector
                exact: Cosmic-shear B-modes, which are induced by Born corrections and lens-lens coupling, are at least three orders of magnitude smaller than cosmic-shear E-modes.
              location:
                type: LineSelector
                start: 132
                end: 132
            - id: schneider_source_clustering
              doi: 10.1051/0004-6361:20020626
              quote:
                type: TextQuoteSelector
                exact: B-modes in fact are produced by lensing itself. The effect comes about through the clustering of source galaxies.
              location:
                type: LineSelector
                start: 180
                end: 183
            - id: crittenden_intrinsic_alignments
              doi: 10.1086/338838
              quote:
                type: TextQuoteSelector
                exact: the distortion field resulting from intrinsic spin alignments is not curl free
              location:
                type: LineSelector
                start: 54
                end: 56
            - id: cooray_future_precision
              doi: 10.1086/340892
              quote:
                type: TextQuoteSelector
                exact: all these corrections are at least two orders of magnitude below the convergence or E-mode power and hence relevant only to future ultra high precision measurements
              location:
                type: LineSelector
                start: 111
                end: 113
            - id: robertson_cross_correlation
              doi: 10.1088/1475-7516/2025/02/034
              quote:
                type: TextQuoteSelector
                exact: the curl can be probed in cross-correlation between a direct reconstruction and a template formed using pairs of large-scale structure tracers to emulate the lens-lens coupling
              location:
                type: LineSelector
                start: 92
                end: 92
    hsc_large_scale_bmode_support:
        claim: The manuscript's HSC Y3 sentence is supported when it separates the detection of significant large-scale B modes from the later attribution of a leading additive contaminant to PSF fourth-moment leakage.
        created_at: 2026-04-02T19:15:00Z
        tags:
            - citation_graph
            - literature
            - survey
        notes: Li et al. and Dalal et al. support the presence of large-scale B modes in the HSC Y3 analysis, while Zhang et al. support the PSF fourth-moment leakage mechanism in the affected region.
        evidence:
            - id: li_hsc_large_scale_bmodes
              doi: 10.1103/PhysRevD.108.123518
              quote:
                type: TextQuoteSelector
                exact: including galaxy shapes in this region causes significant B-modes in 2PCFs at high redshifts and large scales
              location:
                type: LineSelector
                start: 601
                end: 602
            - id: dalal_hsc_large_scale_bmodes
              doi: 10.1103/PhysRevD.108.123519
              quote:
                type: TextQuoteSelector
                exact: we find evidence of significant B modes at large scales, namely \ell < 300
              location:
                type: LineSelector
                start: 1177
                end: 1178
            - id: zhang_hsc_fourth_moment
              doi: 10.1093/mnras/stad1801
              quote:
                type: TextQuoteSelector
                exact: leakage from the spin-2 combination of PSF fourth moments is the leading contributor to additive shear systematics
              location:
                type: LineSelector
                start: 101
                end: 101
    hybrideb_bandpower_support:
        claim: The manuscript's HybridEB sentence is supported when it states that the estimator forms Fourier band-powers from linear combinations of binned xi_pm measurements and projects out ambiguous modes to minimize E/B mixing.
        created_at: 2026-04-02T16:58:00Z
        tags:
            - citation_graph
            - literature
            - methods
        notes: The original wording over-claimed cross-method equivalence; Becker and Rozo directly support the band-power construction and the projection of ambiguous modes to minimize E/B mixing.
        evidence:
            - id: becker_rozo_linear_combinations
              doi: 10.1093/mnras/stv3018
              quote:
                type: TextQuoteSelector
                exact: They can be written as linear combinations of the binned cosmic shear correlation functions.
              location:
                type: LineSelector
                start: 46
                end: 47
            - id: becker_rozo_ambiguous_modes
              doi: 10.1093/mnras/stv3018
              quote:
                type: TextQuoteSelector
                exact: these vectors correspond to ambiguous modes which cannot uniquely be classified as either E- or B-modes on a finite patch of sky
              location:
                type: LineSelector
                start: 187
                end: 189
    psf_leakage_method_support:
        claim: The manuscript's object-wise PSF-leakage sentence is supported by Paper I for the concrete SNR-size regression correction and by Guerrini et al. for the broader PSF-leakage diagnostic framework used to assess its impact.
        created_at: 2026-04-02T13:25:11Z
        tags:
            - citation_graph
            - literature
            - psf
        notes: Uses the provisional local-document evidence extension for Paper I pending upstream ASTRA support for unpublished manuscripts.
        evidence:
            - id: paper_i_psf_method
              document:
                path: docs/unions_release/unions_shear_catalog_paper/draft_corrected.tex
                commit: c873aa76e2687f2abf3b769573e07ad777dd093b
              quote:
                type: TextQuoteSelector
                exact: We build a 20 x 20 grid in (SNR, size) and compute the PSF leakage coefficient alpha using a linear regression in each bin.
              location:
                type: LineSelector
                start: 929
                end: 929
            - id: guerrini_psf_framework
              doi: 10.1051/0004-6361/202453512
              quote:
                type: TextQuoteSelector
                exact: The goal of this paper is to provide a methodology to compute fast and accurate estimates of PSF systematics that pollute two-point cosmic shear correlation function.
              location:
                type: LineSelector
                start: 1043
                end: 1043
    treecorr_method_support:
        claim: The manuscript's xi estimator sentence is supported when it cites TreeCorr as a tree-based correlation package, with Jarvis et al. 2004 as the foundational methodological reference.
        created_at: 2026-04-02T13:25:11Z
        tags:
            - citation_graph
            - literature
            - methods
        notes: TreeCorr's documentation points to Jarvis, Bernstein, and Jain 2004 as the foundational reference; the ASCL software record can be cited alongside it for package provenance.
        evidence:
            - id: jarvis_tree_algorithm
              doi: 10.1111/j.1365-2966.2004.07926.x
              quote:
                type: TextQuoteSelector
                exact: The specific technique for implementing this type of algorithm is to create a so-called kd-tree (with k=2 in this case) for the data.
              location:
                type: LineSelector
                start: 701
                end: 703
---

(citation-audit)=
# Citation audit

## Comments
**2026-04-02 14:17** — Extracted 51 unique cited keys across 57 citation-bearing sentences from unions_bmodes.tex. Built tmp/citation_audit/ledger.json, cached missing arXiv sources into docs/arxiv/, and launched four audit workers (foundations, methods, survey_results, unions_internal). Early manual finding: line 255 cites jarvis15 for TreeCorr, but the jarvis15 BibTeX entry is the 2004 aperture-mass skewness paper rather than a TreeCorr software citation.
**2026-04-02 14:19** — First worker reports back. Foundations: all supported except line 160 wording is too strong about future detection strategy; should narrow to cross-correlation with CMB lensing + LSS tracers. UNIONS/internal: line 222 cites the wrong paper for the object-wise PSF-leakage correction; line 256 overstates the connection to cosmological-inference scales; line 546 should drop or narrow 'direct predecessor'.
**2026-04-02 15:26** — Updated felt's ASTRA model and skill docs to match upstream claim/evidence semantics for literature audits: manuscript statement as claim, cited-source selector as evidence when possible. Remaining schema edge case: unpublished local companion manuscripts such as Paper I do not fit cleanly into ASTRA's current doi|artifact evidence model.
**2026-04-02 16:08** — Pivoted from audit-only findings toward a citation graph. The first two seed cases are now encoded as manuscript claims with direct evidence: TreeCorr via the Jarvis et al. (2004) DOI-backed method paper, and the PSF-leakage sentence via a provisional local-document anchor for Paper I plus the Guerrini et al. (2025) framework paper.
**2026-04-02 16:56** — Converted the first two findings into citation-graph style entries. TreeCorr is now represented as a manuscript claim anchored to the Jarvis et al. (2004) DOI-backed tree algorithm paper, with the software record noted in the citation choice. The PSF-leakage sentence is now anchored to Paper I via the provisional local-document evidence extension (path + commit + quote + line selector) plus the Guerrini et al. (2025) DOI-backed framework paper. Also rephrased the manuscript TreeCorr sentence and rebuilt successfully.
**2026-04-02 17:48** — Richer citation-graph fields restored after upgrading felt: local document anchors and line selectors now round-trip correctly through the active binary.
**2026-04-02 18:04** — Line 160 converted into citation-graph form and the manuscript wording was weakened accordingly. The support now cleanly splits into: production mechanisms (`hilbert.etal09`, `schneider.etal02b`, `crittenden.etal02`), tiny amplitude / future ultra-high-precision relevance (`cooray.hu02`), and a possible cross-correlation route via CMB rotation reconstructions and LSS tracers (`robertson.etal25`).
**2026-04-02 18:11** — Line 256 converted into citation-graph form and narrowed to the supported claim. Paper III supports the 20-bin 1--250 arcmin data-vector binning, but its actual cosmological-inference scale cuts are narrower; the manuscript now says "configuration-space data-vector binning" rather than "range adopted for cosmological inference."
**2026-04-02 18:36** — Line 546 narrowed from 'direct predecessor' to published CFHT/MegaCam lineage support via guinot.etal22; added ASTRA insight cfht_megacam_lineage_support.
**2026-04-02 18:37** — Line 168 narrowed to foundational aperture-mass E/B language only; moved the finite-interval motivation to the following COSEBI sentence conceptually and added ASTRA insight aperture_mass_foundation_support.
**2026-04-02 18:38** — Line 173 narrowed to HybridEB band-power construction plus explicit E/B separation; dropped the stronger COSEBI/pure-mode equivalence and added ASTRA insight hybrideb_bandpower_support.
**2026-04-02 18:57** — Split line 160 into future-precision and cross-correlation clauses; restored the zero-separation caveat at line 168 with finite-interval citations; strengthened line 173 to explicit ambiguous-mode projection; switched line 256 to Paper~\paperconfig{}; added direct MegaCam evidence for CFHTLenS from Asgari et al. 2017 for pending line 546 refinement.
**2026-04-02 19:05** — Rewrote line 548 to frame the repeated pattern as detector-level rather than pipeline-specific, and switched the same-camera evidence from Asgari et al. to the direct CFHTLenS source Heymans et al. 2012.
**2026-04-02 19:15** — Split the HSC Y3 sentence into separate detection and mechanism claims: Li et al. and Dalal et al. now support the large-scale B-mode detection, while Zhang et al. supports the PSF fourth-moment leakage attribution. Also rewrote the conclusion to mirror the supported CFHTLenS/UNIONS MegaCam link rather than the broader "surveys sharing the MegaCam camera" phrasing.
