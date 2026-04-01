---
title: LightconeResearch ecosystem survey
tags:
    - tapestry
depends-on:
    - tapestry-astra-design
created-at: 2026-03-30T00:29:11.91373+02:00
outcome: |-
    Surveyed all LightconeResearch repos:
    - **ASTRA**: Schema + validation + CLI (Python). Most mature — Pydantic models, JSON Schema export, 1200-line CLI. Spec version 0.1.
    - **Prism**: Agent execution layer. Dagster integration, SLURM/Docker/local runners, Claude Code skills (prism-new/build/verify).
    - **Prism-UI**: VS Code extension (React, Zustand, Vite). Was ReactFlow canvas, redesigned 2026-03-04 to 3-column document layout (Sources|Decisions|Outputs). Has useful core/lib/astra/ types and insightUtils.
    - **Tessera**: Verified insights platform (Next.js, Supabase). Defunct — no updates in 2 months. InsightCard/EvidenceBlock/VerificationBadge components exist but superseded by Prism-UI.
    - **Paper2ASTRA**: DOI → complete ASTRA analysis automation. Thin orchestrator over astra+prism CLIs.

    Key finding: Prism-UI's PlatformAdapter abstraction decouples React UI from VS Code, enabling potential web deployment. But the document layout doesn't transfer to the tapestry DAG viewer — only the data types do.
---

(lightconeresearch-ecosystem)=
# LightconeResearch ecosystem survey
