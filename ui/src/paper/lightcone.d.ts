/**
 * Type boundary for the `@lightcone/*` packages.
 *
 * They ship no dist and no `.d.ts` — we consume their TS *source* through a
 * Vite `resolve.alias` (see vite.config.ts). Without these ambient
 * declarations, `tsc` would follow the alias into another repo's source and
 * typecheck it under *our* strict config. Declaring the surface we use keeps
 * the renderer an opaque external boundary for `tsc`; Vite/esbuild still
 * bundles the real source. The myst-ecosystem peers (`myst-to-react`,
 * `@myst-theme/*`, `myst-common`, `myst-spec-ext`) DO ship types, so they need
 * no declaration here.
 */

declare module '@lightcone/renderer' {
  import type { ComponentType, ReactNode } from 'react'
  import type { GenericParent, References } from 'myst-common'
  import type { NodeRenderers } from '@myst-theme/providers'

  export interface MastheadFrontmatter {
    title?: string
    subtitle?: string
    authors?: unknown
    doi?: string
    date?: string
    [key: string]: unknown
  }

  export interface PaperArticle {
    slug: string
    mdast: GenericParent
    frontmatter?: MastheadFrontmatter
    references?: References
    kind?: unknown
  }

  /** A structured ASTRA output (from MySTRA's buildASTRADataMap). */
  export interface OutputEntry {
    id: string
    label?: string
    type?: string
    description?: string
    /** Relative artifact URL, e.g. /static/hubble_diagram.png. */
    resolved_path?: string
    metric?: {
      value?: number | string
      uncertainty?: number | string
      error?: number | string
      unit?: string
      units?: string
    }
    /** Shell recipe that materializes this output (the output-detail page). */
    recipe?: { command?: string; container?: string }
    /** Input ids this output consumes (declared in the recipe). */
    inputs?: string[]
    /** Decision ids parameterizing this output's recipe chain. */
    decisions?: string[]
    /** Parsed inline table for a materialized table output. */
    table_data?: TableData
  }

  /** Parsed CSV/JSON table for a table output (renderer's TableFromData). */
  export interface TableData {
    headers: string[]
    rows: string[][]
    truncated?: boolean
  }

  /** One node in the sub-analysis scope tree (PaperSidebar / PaperView). */
  export interface ScopeNavItem {
    slug: string
    title: string
  }

  /** The scope tree: root + its sub-analysis pages, with the active slug. */
  export interface ScopeNav {
    rootTitle: string
    pages: ScopeNavItem[]
    /** '' (or 'index') = root; else the active sub-analysis slug. */
    activeSlug?: string
  }

  /** A breadcrumb hop back up the sub-analysis hierarchy. */
  export interface HeaderCrumb {
    label: string
    href: string
  }

  /** A structured ASTRA input (from MySTRA's buildASTRADataMap). */
  export interface InputEntry {
    id: string
    label?: string
    type?: string
    description?: string
    source?: string
    from?: string
  }

  export const PaperView: ComponentType<{
    article: PaperArticle
    crumbs?: HeaderCrumb[]
    scopeNav?: ScopeNav
    mastheadFrontmatter?: MastheadFrontmatter
    astra?: { inputs: InputEntry[]; outputs?: OutputEntry[] } | null
    projectLabel?: string
  }>

  // The non-narrative surfaces + the shell pieces lightcone-ui's SurfacePage
  // composes. Findings/Decisions walk the page mdast; Outputs/Inputs read the
  // structured data. Typed at the surface we use — the real source is bundled
  // by Vite through the alias; these declarations only keep `tsc` at the border.
  export const FindingsView: ComponentType<{ nodes: unknown[] }>
  export const DecisionsView: ComponentType<{
    nodes: unknown[]
    astraOutputs?: OutputEntry[]
    scopeLabel?: string
  }>
  export const OutputsGallery: ComponentType<{ outputs: OutputEntry[]; baseSlug?: string }>
  export const InputsList: ComponentType<{ inputs: InputEntry[] }>

  export const Masthead: ComponentType<{
    frontmatter?: MastheadFrontmatter
    fallbackTitle?: string
  }>
  export const Breadcrumb: ComponentType<{ crumbs: HeaderCrumb[] }>
  export const TableFromData: ComponentType<{ data: TableData; label?: string }>
  export const PaperSidebar: ComponentType<{
    mdast: GenericParent
    activeSurface?: string
    scopeNav?: ScopeNav
    sectionHrefBase?: string
    outputs?: OutputEntry[]
    /** Active output id → leaf highlight on /outputs/<id> detail pages. */
    activeOutputId?: string
    includeSupportingDocuments?: boolean
  }>
  export const ThemeToggle: ComponentType<Record<string, never>>
  export const AstraDataProvider: ComponentType<{
    value: { inputs: InputEntry[]; outputs: OutputEntry[] }
    children?: ReactNode
  }>

  export const LIGHTCONE_OVERRIDES: NodeRenderers

  // Other layout/override exports exist but aren't part of our surface yet.
}

declare module '@lightcone/styles' {
  export const THEME_ATTRIBUTE: string
  // The package also exports a `Theme` string-union, but we use `@myst-theme/
  // common`'s `Theme` (a real typed peer) — not re-declared here to avoid two
  // `Theme` types in scope.
}
