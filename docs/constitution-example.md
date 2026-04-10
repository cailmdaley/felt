name: "Example: Ralph Constitution"
description: "A working example of a ralph constitution — the spec that drives autonomous iteration loops. This one built the ASTRA document viewer."
---

# ASTRA Document Viewer — Constitution

Two goals, intertwined:

1. **Build the pure-eB B-mode analysis into a proper ASTRA document.** 522 fibers contain the complete history of a weak lensing analysis — data exploration through paper submission. Formalize this into a structured, narrative ASTRA spec with real decisions, real evidence chains, real excluded reasoning. The analysis should be readable cold by someone who wasn't there.

2. **Experiment with forms of expression.** Fork the MyST book-theme and explore how to render this analysis — document with spatial minimap, fullscreen graph views, progressive disclosure. Discover which visual languages make a complex decision space navigable and memorable.

The two goals feed each other. The analysis gives the viewer real content to test against; the viewer reveals where the analysis is thin or confusing. Alternate between them. Don't build a viewer on skeleton data, and don't formalize fibers without seeing how they render.

This is a ralph constitution, not a plan. It describes desired state; the loop finds the path. The loop has creative latitude — follow your nose on both the analysis structure and the visual design. If you discover something better than what's written here, update the constitution.

---

## Desired State

### The analysis

The pure-eB `.felt/` directory becomes a complete, narrative ASTRA specification. Sub-analyses follow the scientific argument — not the chronology of investigation, but the logic of the result. Decisions record what was chosen and what was rejected, with genuine reasoning. Insights carry real claims backed by evidence from the fibers. Inputs and outputs trace the data flow. The `astra.yaml` export is a document someone could hand to a collaborator and say "this is how we got our result."

The 522 fibers are the raw material. Most won't become sub-analyses — they're breadcrumbs, dead ends, process notes. The ASTRA spec distills the ~20-40 that matter into a coherent structure. Tags (`tier:1` for spine nodes) define the narrative skeleton; everything else hangs from it.

### The viewer

A forked MyST book-theme at `LightconeResearch/mystra-theme` that renders this analysis as an interactive document with spatial navigation. MySTRA's content server feeds it JSON; the theme renders document + map.

### The core interaction: minimap ↔ fullscreen

The map starts as a minimap (right panel, alongside the document). Click to expand it fullscreen. The transition is continuous — the minimap *is* the full map, just at a smaller viewport. Document and map are always available; the question is which one dominates the screen.

- **Minimap mode**: document fills the left/center, map is a small companion on the right. Resizable. Collapsible. As you scroll the document, the map highlights the current section. Click a map node → document scrolls there.
- **Fullscreen mode**: map fills the viewport. Click a node → detail panel slides in (like portolan's city detail). Or double-click → returns to document mode scrolled to that section.
- **Smooth transition**: the map doesn't reload or jump when expanding. It's the same D3/canvas instance, just growing.

### Position encodes meaning

This is the fundamental departure from the current tapestry, where nodes land wherever the force simulation settles them. Position should be *geographic* — rivers flow downhill, cities cluster at junctions. The user builds spatial memory over time, and that memory should reward them.

ASTRA gives us the structure to make position meaningful:
- **Data flow direction**: inputs flow left → outputs flow right. The X axis is methodology progression.
- **Investigation depth**: decisions expand downward. Spine stays fixed; branches grow vertically.
- **Affinity clustering**: decisions that share `incompatible_with` or `requires` constraints are nearby. Cross-cutting decisions (grid resolution affecting multiple sub-analyses) sit at intersections.
- **Hierarchy**: sub-analyses nest spatially. A sub-analysis is a region, not just a node.

### Multiple view languages — explore them

The loop should try several approaches to spatial layout. Not all will survive; the point is to discover which ones create the best spatial memory and navigation instinct. Think game design — each view is a way of making a complex decision space navigable.

**Tapestry view** (DAG flow, left-to-right):
- X = methodology progression (data → processing → inference → results)
- Y = investigation depth
- Edges are dependency arrows, organic Bézier curves
- Spine nodes are fixed anchors; everything else flows around them
- Reference: `~/Documents/projects/portolan/src/ui/TapestryDagGraph.ts`

**Strategy map** (portolan-style, positioned):
- Nodes placed with spatial meaning — not force-directed randomness
- Regions for sub-analyses (like continents for cities)
- The user learns the territory: "the covariance decisions are in the northeast, the binning choices are down by the data inputs"
- Terrain metaphor: ridges where decisions are robust, valleys where small changes cascade

**Other possibilities** (follow your nose):
- A **timeline** view where X is when decisions were made, showing the investigation's temporal arc
- A **constraint graph** where `incompatible_with` and `requires` create visible tension lines between options
- A **river delta** where data flows branch and merge — the funnel made literal

Build what's compelling. Kill what isn't. The constitution doesn't prescribe which views survive.

### Document view (the primary reading surface)

The existing MyST book-theme document rendering, enhanced:

- **Spine-first layout.** Only tier:1 sub-analyses visible at page load. Each shows: verdict sentence (fiber outcome), decision count, worst-status badge. Collapsed branches show count + status, never blank.
- **Progressive disclosure.** Three levels, two clicks max:
  - **L0 Spine**: sub-analysis status (verdict + decision summary + badge)
  - **L1 Decisions**: per-decision detail (declarative title from outcome, evidence count, options with excluded reasoning)
  - **L2 Evidence**: full fiber body, output plots, upstream chain
- **Verdict-first everywhere.** Fiber outcomes ARE the declarative titles. The headline sequence reads as a coherent argument, not a pipeline status report.
- **Delta view.** Default to what changed since last visit. New/changed nodes start revealed; stale content fogs. Items fold back after review. Entry point: BLUF briefing (best result, open questions, last change, next decision needed).

### Aesthetic: Porch Morning, not Purple Dashboard

| Element | Value |
|---------|-------|
| Background | #E8DDD0 (map panel), #FAFAF7 (document) |
| Text | #2E2A26 primary, #7A7368 muted |
| Accents | #9A7B35 gold (decisions), #5A7B7B teal (resolved) |
| Stale | #A87070 mauve |
| Open | #7A7368 muted taupe |
| Fonts | EB Garamond (body), JetBrains Mono (code) |
| Nodes | Organic ellipses, not rectangles. Concentric rings. Seeded noise deformation. |
| Edges | Cubic Bézier, multi-strand, slight sag. Not straight arrows. |

Warm, antiquarian, cartographic. The tapestry visual language, not a SaaS dashboard. Think old naval charts, not Figma.

**Status encoding — shape > color:**

| State | Icon | Color | Meaning |
|-------|------|-------|---------|
| Resolved | ✓ | teal | Decision closed with evidence |
| Open | ○ | taupe | In progress or no evidence yet |
| Suspicious | ? | amber | Evidence exists but judgment uncertain |
| Blocked | ✕ | mauve | Depends on unresolved upstream |

Pipeline health ≠ scientific judgment. A mock can be successfully generated (pipeline ✓) but suspicious (science ?). Separate visual channels.

### What it consumes

MySTRA's content server API (already running):
- `GET /config.json` — site manifest + TOC (page hierarchy)
- `GET /content/{slug}.json` — page AST + frontmatter + decision/insight data in the AST
- `GET /myst.xref.json` — cross-references
- `GET /static/*` — result artifacts
- `WS /socket` — live reload

### What it doesn't do

- No editing. Read-only viewer.
- No authentication. Local tool.
- No separate backend. Consumes MySTRA's API only.
- No mobile. Desktop browser.

---

## Context (for iterations)

### Codebase

- **MyST book-theme source**: `github.com/jupyter-book/myst-theme` — Remix + React + Express. The book theme is at `themes/book/` in the monorepo. Fork to `LightconeResearch/mystra-theme`.
- **MySTRA**: `~/Documents/projects/MySTRA/` — content server that transforms astra.yaml → MyST AST JSON. Already works. Launch: `node dist/cli.js ~/Documents/projects/ASTRA/examples/pure_eb/ --content-port 3200`
- **MySTRA transform**: `~/Documents/projects/MySTRA/src/transform/` — renders decisions as tab sets, findings with evidence, methods grouped by tag. This is the AST the theme receives.
- **Pure-eB example**: `~/Documents/projects/ASTRA/examples/pure_eb/` — 522 fibers, growing number formalized with ASTRA fields. `felt export --format astra` → `astra.yaml`.
- **Portolan hex map** (Three.js): `~/Documents/projects/portolan/src/render/` — InstancedMesh bird sprites, VellumShader background, OrthographicCamera. The strategy-map aesthetic: cities as hex positions, workers as flocking birds. Reference for the portolan/strategy-map view language.
- **Portolan tapestry DAG** (D3): `~/Documents/projects/portolan/src/ui/TapestryDagGraph.ts` (379 LOC) + `TapestryView.ts` (503 LOC) — D3 force layout with organic node rendering (noise-deformed ellipses, concentric rings, multi-strand Bézier edges, staleness coloring). Key files: `tapestry-types.ts` for data shapes, `TapestryDagGraph.ts` for the D3 rendering.
- **Design research fibers**: `/tmp/kinelens-fibers/`. Full UX design at `astra-tapestry-ux-design-450ed5dd.md`.

### Design principles (from UX meeting + kinematic_lensing research)

1. **View not data.** Don't restructure fibers — restructure the view. Tags wire fibers to ASTRA decisions.
2. **Lead with science not pipeline.** Group by question, not pipeline step.
3. **Default to delta.** What changed since last session.
4. **Shneiderman's mantra.** Overview first, zoom and filter, details on demand.
5. **Minto Pyramid.** Conclusions first, evidence on demand.
6. **Three levels, two clicks.** Spine → decisions → evidence. Never 522 nodes at once.
7. **Separate pipeline status from scientific judgment.** Shape > color.
8. **Spatial memory rewards the user.** Position should encode meaning so that navigation becomes instinctive over time. Random placement wastes the most powerful cognitive channel humans have.
9. **Briefing not dashboard.** Lead with the scientific verdict, not pipeline metrics.

### Theme fork approach

1. Clone `github.com/jupyter-book/myst-theme` to `LightconeResearch/mystra-theme` (private) ✓
2. The book-theme is at `themes/book/` — it's a Remix app with React components ✓
3. Add map React component(s) in the layout — right panel that expands to fullscreen ✓
4. D3 for the graph rendering, wrapped in React. Canvas for performance if node count demands it.
5. Build and point MySTRA's launcher at the fork
6. MySTRA's `src/theme/launcher.ts` already supports custom theme directories

### What's been built (as of 2026-04-02, updated 2026-04-07)

**MySTRA content server** (`~/Documents/projects/MySTRA/`):
- `GET /astra-graph.json` — walks analysis tree, emits nodes with separate `decisionCount`/`findingCount`, `verdict` (first insight claim or first decision rationale, ≤160 chars), status inference, tag lists, data-flow links. `src/server/routes/graph.ts`.
- `insights→findings` normalization in yaml-loader — felt exports `insights`, ASTRA type system uses `findings`. See fiber `astra-insights-vs-findings`.

**mystra-theme** (`~/Documents/projects/mystra-theme/`):
- Map panel: `themes/book/app/components/astra-map/` — AstraMap.tsx (D3 rendering), useAstraGraph.ts (fetches /astra-graph.json), types.ts.
- Proxy route: `themes/book/app/routes/api.astra-graph.tsx` — Remix route that proxies to content server. Needed because catch-all `$.tsx` route intercepts `*.json` URLs.
- **Topological DAG layout**: X = data-flow depth (longest path from source), Y = **barycenter-sorted** within column (updated 2026-04-07, was tag-sort). Sugiyama barycenter heuristic: 3 iterations of left→right then right→left passes, each re-sorting a column by avg normalized Y of connected neighbors. Significantly reduces edge crossings. Tag sort kept as tie-breaker. Periphery (unconnected nodes) in rightmost column. Root anchored left. **Layout fix (2026-04-06)**: node sizes fit both vertical and horizontal constraints.
- **Organic rendering** (portolan aesthetic): noise-deformed ellipses (`organicEllipse` with `noise2D`), concentric ring fills + strokes (`RING_SCALES = [1.0, 1.15]`), multi-strand cubic Bézier edges with sag/wobble per-strand, knockout backgrounds for edge overlap.
- **Hover tooltips**: full node name, status, separate decision/finding counts (joined with `·`), verdict sentence (italic), tags. 250ms delay. Suppressed when detail panel is open.
- **Label wrapping**: two-line labels with `shortName` (strips Decision:/Finding: prefixes), adaptive truncation (22 chars minimap, 55 fullscreen).
- **Status glyphs** (shape > color): ✓ resolved, ○ open, ? suspicious, ✕ blocked. Rendered below node labels in system-ui font.
- **Fullscreen detail panel**: click node in fullscreen → slide-in panel from right with verdict paragraph (italic, first insight claim or decision rationale), status badge, separate decision/finding counts, tags, upstream/downstream data-flow links (clickable for graph navigation), "Open in Document" button. Gold highlight ring on selected node.
- Fullscreen toggle with transitionend-based re-render (replaces 350ms delay — old SVG stays visible during CSS transition). Minimize button positioned below navbar (top: 64px).
- Current page highlighting: gold stroke + glow ring (scale 1.25). Same treatment for selected node in fullscreen.
- Porch-morning palette: teal (resolved), taupe (open), amber (suspicious), mauve (blocked), gold (root/active/selected).
- **Edge hierarchy**: containment edges suppressed for DAG-connected nodes (only drawn to periphery). Data-flow edges in gold with increased stroke weight (1.2px vs 0.6px containment).
- **Data-flow cross-references**: 22 data-flow edges (updated 2026-04-08, was 16). Extended chain includes: `350-mock→cosmocov-pure-e-b-covariance`, `ccl-v3-2-1-correlation-has-4pi→cosebis-angular-binning`, `data-vectors→bump-no-longer-3-sigma-update→paper-synthesis`, `blinding-framing-for-talk→paper-synthesis`, `switch-fiducial→decision-keep-v1-4-6-in-cat`. Only `decision-exclude-snakemake-rule` remains in periphery (PR workflow, not scientific pipeline). Click navigation confirmed working.
- **Porch-morning document theme**: `themes/book/app/styles/porch-morning.css` (554 lines) — overrides entire MyST book-theme with warm antiquarian aesthetic. EB Garamond body + JetBrains Mono code. Parchment backgrounds (#FAFAF7 document, #F0EBE3 navbar/sidebar, #E8DDD0 active items). Gold links (#9A7B35), teal h3/cross-refs (#5A7B7B). Sidebar active items with gold border-left. Theme toggle hidden. Prose variables, admonitions, tabs, cards, tables all themed. Dark mode class overridden to always warm.
- **Sidebar status glyphs**: `themes/book/app/components/SidebarStatusInjector.tsx` — DOM-injection component that fetches ASTRA graph, builds slug→status map, prepends status glyphs (✓ ○ ? ✕) to each sidebar navigation link. Uses `useAstraGraph` hook, runs on navigation and graph load. Porch-morning palette colors per status. Avoids modifying upstream `packages/site` by injecting into rendered DOM.
- **Spine-first sub-analysis layout**: `MySTRA/src/transform/render-sub-analyses.ts` — index page now features tier:1 nodes under "Analysis Spine" with italic verdict sentences (first insight claim) and status glyphs (✓ resolved · N decisions). Non-spine analyses collapse into "Supporting Analyses (N)" details block by default. Status inferred from decision/finding state: blocked if all options excluded, suspicious if decisions but no findings, resolved if findings present.
- **insights/findings normalization**: `felt export` writes `insights`; MySTRA yaml-loader normalizes `insights→findings` internally. Decision: keep `insights` as the felt-facing name (closed fiber `astra-insights-vs-findings`).

**Launch:**
```bash
cd ~/Documents/projects/MySTRA && node dist/cli.js ~/Documents/projects/ASTRA/examples/pure_eb/ --content-port 3200 --no-theme
cd ~/Documents/projects/mystra-theme/themes/book && CONTENT_CDN_PORT=3200 npx remix dev
# Theme at http://localhost:3000, content at http://localhost:3200
```

---

## Skills

- Activate `/felt` for any fiber work
- Use `--chrome` flag when launching ralph (frontend work needs browser verification)
- Read portolan tapestry code for visual patterns but don't import from it

## Evidence

```bash
# MySTRA content server running?
curl -s http://localhost:3200/config.json | python3 -m json.tool

# Start MySTRA on pure-eB
cd ~/Documents/projects/MySTRA && node dist/cli.js ~/Documents/projects/ASTRA/examples/pure_eb/ --content-port 3200

# Refresh ASTRA export after formalization
cd ~/Documents/projects/ASTRA/examples/pure_eb && felt export --format astra

# Check sub-analysis count
grep -c "^    [a-z]" astra.yaml

# Theme dev server (once fork exists)
cd ~/Documents/projects/mystra-theme && npm run dev

# Screenshot for visual verification (ralph --chrome)
```

## Open Questions (for the loop to research and resolve)

These are invitations, not blockers. The loop has creative agency — research these, try things, update this constitution with what you learn.

- **How many nodes at each level?** Research confirms the three-level model (Ghoniem 2005, Huang 2009, Ware & Bobrow 2005, game design convergence). Thresholds: **spine 5-15** (always visible, below Ghoniem's 20-node comprehension ceiling, matches Civ VI's 8-12 techs per era); **decisions 20-50** (expand one cluster at a time, readable with interaction but not passively — adjacent clusters collapse); **full DAG ~500** (never show raw — search + filter + expand-in-place, like Stellaris showing only 3 choices from 400 techs). Dagster switches to simplified rendering at 50 edges. Furnas's degree-of-interest yields 10-30 visible nodes around a focus. Cockburn et al. confirmed minimaps help when content exceeds ~3x viewport. Test with real pure-eB data and revise if the numbers feel wrong.
- **Which view language wins?** Tapestry DAG, strategy map, something new? Build prototypes, look at them, feel which one creates the best spatial memory. Kill what doesn't work.
- **D3 vs canvas vs WebGL.** Start with D3 (organic SVG aesthetic). Switch if performance demands it.
- **Live reload animation.** Try it. If transitions feel good, keep them. If they're distracting, hard-refresh.
- **What makes position meaningful?** The constitution suggests data-flow direction, investigation depth, affinity clustering. But the loop may discover better axes. The constraint is: position must encode *something*, not be random.
- **Keep enriching the analysis.** 21 nodes formalized. Spine complete. **20/21 nodes resolved** (unchanged). Only `root` remains "open" by design. **Periphery reduced to 1 node** (updated 2026-04-08, was 6): `blinding-framing-for-talk`, `bump-no-longer-3-sigma-update`, `ccl-v3-2-1-correlation-has-4pi`, `cosmocov-pure-e-b-covariance`, `decision-keep-v1-4-6-in-cat` all wired into the main data-flow DAG with scientifically motivated connections. Only `decision-exclude-snakemake-rule` remains genuinely peripheral (PR workflow machinery, not scientific pipeline). **Gotcha:** `felt export --format astra` alphabetizes YAML keys — primary insight key must sort before secondary ones for correct verdict display in graph.ts.
