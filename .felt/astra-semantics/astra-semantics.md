---
title: Astra semantics
status: closed
tags:
    - felt
    - astra
    - literature
    - example
    - lightcone
    - pure-eb
created-at: 2026-04-02T15:15:51.789710643+02:00
closed-at: 2026-04-02T15:26:13.447229527+02:00
description: Clarify how ASTRA claims and evidence should be encoded for literature-backed citation audits, then align felt's model and skill docs with the upstream ASTRA and Paper2ASTRA interpretation.
outcome: 'ASTRA citation audits should encode the manuscript statement under review as the claim and anchor evidence in the cited source with quote/figure/table selectors when possible. felt now supports the richer insight/evidence fields needed for that pattern; remaining gap: unpublished local companion manuscripts do not fit the current doi-or-artifact evidence split cleanly.'
---

(astra-semantics)=
# Astra semantics

Upstream ASTRA and Paper2ASTRA both treat an insight as a claim backed by traceable evidence from the cited source itself. For literature evidence, that means a DOI-backed paper reference plus at least one selector such as a quote, figure, or table; Paper2ASTRA's literature phase is explicitly intended to populate that layer before specification.

felt had drifted only partially from that model. The docs already described rich selectors, but the Go structs only preserved quote text. felt now preserves quote prefix/suffix plus figure, table, location, and insight metadata (`scope`, `tags`, `notes`), and the skill docs now make the literature-audit pattern explicit.

The remaining schema mismatch is unpublished local manuscripts. In the B-modes audit, Paper I is currently `in preparation`, so it does not fit ASTRA's present `doi | artifact` evidence split cleanly. That case likely needs either an ASTRA extension for input-backed evidence or a disciplined temporary convention.
