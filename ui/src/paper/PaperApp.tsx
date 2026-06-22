import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Theme } from '@myst-theme/common'
import { ArticleProvider, ThemeProvider, mergeRenderers } from '@myst-theme/providers'
import { DEFAULT_RENDERERS } from 'myst-to-react'
import { SourceFileKind } from 'myst-spec-ext'
import type { References } from 'myst-common'
import {
  AstraDataProvider,
  Breadcrumb,
  DecisionsView,
  FindingsView,
  InputsList,
  LIGHTCONE_OVERRIDES,
  Masthead,
  OutputsGallery,
  PaperSidebar,
  PaperView,
  TableFromData,
  ThemeToggle,
  type HeaderCrumb,
  type MastheadFrontmatter,
  type OutputEntry,
  type ScopeNav,
} from '@lightcone/renderer'
import { THEME_ATTRIBUTE } from '@lightcone/styles'
import {
  loadPaper,
  type AstraPageData,
  type BakedPage,
  type BakedPaper,
  type LoadPaperArgs,
} from './content'

/**
 * The ASTRA paper view, standalone. Mirrors lightcone-ui's theme-paper routes:
 * a ThemeProvider exposing the merged renderer set (upstream `DEFAULT_RENDERERS`
 * first, `LIGHTCONE_OVERRIDES` composed on top so the finding-/decision-/figure/
 * table selectors slot in alongside the base), then the active location.
 *
 * Routing is in-app. lightcone-ui's app gives each location a real React-Router
 * URL (`/findings`, `/outputs/<id>`, `/<sub-analysis>`, …); we have no router
 * and the paper is mounted at `paper.html?path=…`, so following those hrefs
 * would navigate the iframe off the entry into a blank page. Instead we
 * intercept the nav clicks (`onClickInterceptNav`), parse the href into a
 * `Route`, and swap an in-memory location — same sidebar, same components, no
 * navigation. The bake already emits every page (`paper.pages`: root = slug
 * `index`, each sub-analysis its own slug) and per-page ASTRA data
 * (`paper.astra[slug]`), so the scope tree and sub-analysis content are pure
 * client-side wiring over data already in hand — no extra fetch, no config.json.
 *
 * Runs in its own document (the fiber panel mounts paper.html in an <iframe>),
 * so Tailwind's preflight + the parchment html/body base stay isolated from the
 * kanban board.
 */

type Surface = 'narrative' | 'findings' | 'outputs' | 'decisions' | 'inputs'

const SURFACE_LABELS: Record<Exclude<Surface, 'narrative'>, string> = {
  findings: 'Findings',
  outputs: 'Outputs',
  decisions: 'Decisions',
  inputs: 'Inputs',
}

/**
 * A resolved in-app location. `slug` `''` is the root analysis (page `index`);
 * else a sub-analysis slug (possibly nested, `a/b`). `outputId` set → the
 * per-output detail view (its surface is always `outputs`).
 */
interface Route {
  slug: string
  surface: Surface
  outputId?: string
}

const ROOT_ROUTE: Route = { slug: '', surface: 'narrative' }

/** Normalise a slug/path: drop surrounding slashes, fold `index`/empty → `''`. */
function normaliseSlug(slug?: string): string {
  if (!slug || slug === 'index') return ''
  return slug.replace(/^\/+|\/+$/g, '')
}

/**
 * Parse a clicked internal href into a Route, mirroring lightcone-ui's URL
 * scheme: `/`, `/findings`, `/outputs/<id>`, `/<slug>`, `/<slug>/findings`,
 * `/<slug>/outputs/<id>`. Returns null for an href we don't own — an external
 * link, or a bare `#anchor` (no leading `/`) that should scroll natively.
 */
function parseRoute(href: string): Route | null {
  if (!href.startsWith('/')) return null
  const path = normaliseSlug(href.split(/[?#]/)[0])
  if (path === '') return { ...ROOT_ROUTE }
  // Output detail: [<slug>/]outputs/<id>. Checked before the bare-surface
  // pattern so `/outputs/foo` is a detail page, not the outputs surface.
  let m = path.match(/^(?:(.+)\/)?outputs\/([^/]+)$/)
  if (m) return { slug: m[1] ?? '', surface: 'outputs', outputId: m[2] }
  // Surface: [<slug>/]findings|outputs|decisions|inputs. (A sub-analysis whose
  // slug is literally a surface word is shadowed by the surface — the same
  // ambiguity lightcone-ui's extractSurface carries; pathological in practice.)
  m = path.match(/^(?:(.+)\/)?(findings|outputs|decisions|inputs)$/)
  if (m) return { slug: m[1] ?? '', surface: m[2] as Surface }
  // Otherwise a sub-analysis narrative page.
  return { slug: path, surface: 'narrative' }
}

/** The sub-analysis scope tree, built from the baked pages (root excluded). */
function buildScopeNav(
  pages: BakedPage[],
  rootSlug: string,
  activeSlug: string,
): ScopeNav {
  return {
    rootTitle: pages.find((p) => p.slug === rootSlug)?.title ?? 'Analysis',
    pages: pages
      .filter((p) => p.slug !== rootSlug)
      .map((p) => ({ slug: p.slug, title: p.title })),
    activeSlug,
  }
}

/** Breadcrumb trail back up the hierarchy (root + ancestors, not the current page). */
function buildCrumbs(
  activeSlug: string,
  pages: BakedPage[],
  rootSlug: string,
): HeaderCrumb[] {
  const norm = normaliseSlug(activeSlug)
  if (!norm) return []
  const titleBySlug = new Map(pages.map((p) => [normaliseSlug(p.slug), p.title]))
  const crumbs: HeaderCrumb[] = [
    { label: pages.find((p) => p.slug === rootSlug)?.title ?? 'Analysis', href: '/' },
  ]
  const parts = norm.split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    const anc = parts.slice(0, i + 1).join('/')
    crumbs.push({ label: titleBySlug.get(anc) ?? parts[i], href: `/${anc}` })
  }
  return crumbs
}

/**
 * Masthead frontmatter for a route. Root pages use their frontmatter as-is.
 * Sub-analysis pages promote the sub title to the H1 (so the header reads "I'm
 * in feature_extraction") while inheriting authors/DOI from the root paper, so
 * the parent identity isn't lost — the breadcrumb still carries the trail back.
 */
function mastheadFor(
  page: BakedPage,
  rootPage: BakedPage | undefined,
  isSub: boolean,
): MastheadFrontmatter {
  if (!isSub) return (page.frontmatter ?? {}) as MastheadFrontmatter
  const root = (rootPage?.frontmatter ?? {}) as MastheadFrontmatter
  return { ...root, title: page.frontmatter?.title ?? page.slug }
}

export function PaperApp(args: LoadPaperArgs) {
  const [theme, setTheme] = useState<Theme>(Theme.light)
  const [paper, setPaper] = useState<BakedPaper | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [route, setRoute] = useState<Route>(ROOT_ROUTE)
  // Element id to scroll to after the next route change (a cross-surface
  // `#decision-…` / `#section-…` target), or null to scroll to the top.
  const pendingScroll = useRef<string | null>(null)

  const renderers = useMemo(
    () => mergeRenderers([DEFAULT_RENDERERS, LIGHTCONE_OVERRIDES]),
    [],
  )

  useEffect(() => {
    document.documentElement.setAttribute(THEME_ATTRIBUTE, theme)
  }, [theme])

  const setThemeAndPersist = useCallback((next: Theme) => setTheme(next), [])

  useEffect(() => {
    let live = true
    setError(null)
    setPaper(null)
    setRoute(ROOT_ROUTE)
    loadPaper(args)
      .then((p) => live && setPaper(p))
      .catch((e) => live && setError(String(e?.message ?? e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.path, args.origin, args.universe, args.fixture])

  // On a route change, scroll to the pending anchor if it resolves, else top —
  // the in-app analogue of the browser's native hash scroll after navigation.
  useEffect(() => {
    const id = pendingScroll.current
    pendingScroll.current = null
    const t = window.setTimeout(() => {
      const el = id ? document.getElementById(id) : null
      if (el) el.scrollIntoView({ block: 'start' })
      else window.scrollTo({ top: 0 })
    }, 0)
    return () => window.clearTimeout(t)
  }, [route])

  // A recognised internal link swaps the in-app route; any unrecognised href
  // (external, or a bare `#anchor`) keeps native behavior (new tab / in-page
  // scroll). The hash, if any, becomes the post-navigation scroll target.
  const onClickInterceptNav = useCallback((e: React.MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
    const anchor = (e.target as HTMLElement | null)?.closest?.('a')
    const href = anchor?.getAttribute('href')
    if (!href) return
    const next = parseRoute(href)
    if (!next) return
    e.preventDefault()
    const hashIdx = href.indexOf('#')
    pendingScroll.current = hashIdx >= 0 ? href.slice(hashIdx + 1) : null
    setRoute(next)
  }, [])

  if (error) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '4rem 1.5rem' }}>
        <p style={{ fontFamily: 'var(--font-technical, monospace)', color: 'var(--color-mauve, #a87070)' }}>
          Could not render this astra.yaml: {error}
        </p>
      </main>
    )
  }

  if (!paper) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '4rem 1.5rem' }}>
        <p style={{ fontFamily: 'var(--font-technical, monospace)', color: 'var(--color-muted, #7a7368)' }}>
          baking…
        </p>
      </main>
    )
  }

  const rootPage = paper.pages.find((p) => p.slug === 'index') ?? paper.pages[0]
  if (!rootPage) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '4rem 1.5rem' }}>
        <p>No pages baked from this astra.yaml.</p>
      </main>
    )
  }
  const rootSlug = rootPage.slug

  // Resolve the active page from the route slug; fall back to root on a miss
  // (a malformed/stale link can't blank the view).
  const wantSlug = route.slug === '' ? rootSlug : route.slug
  const page = paper.pages.find((p) => p.slug === wantSlug) ?? rootPage
  const activeSlug = page === rootPage ? '' : page.slug
  const isSub = activeSlug !== ''

  // A sub-analysis with no astra entry shows empty surfaces — never the root's
  // outputs/inputs (can't happen on a real bake, where buildASTRADataMap emits
  // one entry per page slug, but defensive parity beats leaking root data).
  const astra: AstraPageData | null =
    paper.astra?.[page.slug] ?? (isSub ? null : paper.astra?.[rootSlug]) ?? null
  const scopeNav = buildScopeNav(paper.pages, rootSlug, activeSlug)
  const crumbs = buildCrumbs(activeSlug, paper.pages, rootSlug)
  const mastheadFrontmatter = mastheadFor(page, rootPage, isSub)
  const sectionHrefBase = isSub ? `/${activeSlug}` : '/'

  return (
    <ThemeProvider theme={theme} setTheme={setThemeAndPersist} renderers={renderers}>
      <div onClick={onClickInterceptNav}>
        {route.outputId ? (
          <OutputDetail
            outputId={route.outputId}
            output={(astra?.outputs ?? []).find((o) => o.id === route.outputId) ?? null}
            outputs={astra?.outputs ?? []}
            page={page}
            baseSlug={activeSlug}
            scopeNav={scopeNav}
            mastheadFrontmatter={mastheadFrontmatter}
          />
        ) : route.surface === 'narrative' ? (
          <PaperView
            article={{ slug: page.slug, mdast: page.ast, frontmatter: page.frontmatter }}
            astra={astra}
            scopeNav={scopeNav}
            crumbs={crumbs}
            mastheadFrontmatter={isSub ? mastheadFrontmatter : undefined}
          />
        ) : (
          <SurfaceView
            surface={route.surface}
            page={page}
            astra={astra}
            scopeNav={scopeNav}
            crumbs={crumbs}
            mastheadFrontmatter={mastheadFrontmatter}
            galleryBaseSlug={isSub ? activeSlug : ''}
            scopeLabel={isSub ? activeSlug : 'parent'}
            sectionHrefBase={sectionHrefBase}
          />
        )}
      </div>
    </ThemeProvider>
  )
}

/**
 * A non-narrative surface — the shell lightcone-ui's `SurfacePage` builds
 * (`ArticleProvider` + `AstraDataProvider`, masthead, breadcrumb, section label,
 * the surface view, then the sidebar). Findings/Decisions walk the page mdast;
 * Outputs/Inputs read the structured `{outputs, inputs}` from the bake.
 */
function SurfaceView({
  surface,
  page,
  astra,
  scopeNav,
  crumbs,
  mastheadFrontmatter,
  galleryBaseSlug,
  scopeLabel,
  sectionHrefBase,
}: {
  surface: Exclude<Surface, 'narrative'>
  page: BakedPage
  astra: AstraPageData | null
  scopeNav: ScopeNav
  crumbs: HeaderCrumb[]
  mastheadFrontmatter: MastheadFrontmatter
  /** "" for root scope (links → `/outputs/<id>`), else the sub-analysis slug. */
  galleryBaseSlug: string
  /** DecisionsView scope label: "parent" at root, the slug for a sub-analysis. */
  scopeLabel: string
  sectionHrefBase: string
}) {
  const references = { article: page.ast } as References
  const nodes = (page.ast.children ?? []) as never
  const outputs = astra?.outputs ?? []
  const inputs = astra?.inputs ?? []

  return (
    <ArticleProvider
      kind={SourceFileKind.Article}
      references={references}
      frontmatter={page.frontmatter as never}
    >
      <AstraDataProvider value={{ inputs, outputs }}>
        <ThemeToggle />
        <main className="lc-page">
          <Masthead frontmatter={mastheadFrontmatter} fallbackTitle={page.slug} />
          <Breadcrumb crumbs={crumbs} />
          <div className="lc-page-label" aria-label="Section">
            <span className="lc-page-label__name">{SURFACE_LABELS[surface]}</span>
            <span className="lc-page-label__rule" />
          </div>
          {surface === 'findings' && <FindingsView nodes={nodes} />}
          {surface === 'outputs' && <OutputsGallery outputs={outputs} baseSlug={galleryBaseSlug} />}
          {surface === 'decisions' && (
            <DecisionsView nodes={nodes} astraOutputs={outputs} scopeLabel={scopeLabel} />
          )}
          {surface === 'inputs' && <InputsList inputs={inputs} />}
        </main>
        <PaperSidebar
          mdast={page.ast}
          scopeNav={scopeNav}
          activeSurface={surface}
          outputs={outputs}
          includeSupportingDocuments={false}
          /* On a surface, the narrative-section links would otherwise be bare
             `#section-…` anchors that don't resolve (the sections aren't on
             this page). The base makes them `/#section-…` (root) or
             `/<slug>#section-…` (sub) — which onClickInterceptNav routes back to
             that scope's narrative, then scrolls to the section. */
          sectionHrefBase={sectionHrefBase}
        />
      </AstraDataProvider>
    </ArticleProvider>
  )
}

/**
 * The per-output detail page — lightcone-ui's `OutputDetail` (its theme-app
 * `$.tsx`, not the renderer package), ported. The page label is the output id
 * with a `← Back` to the outputs surface; three spec sections (Artefact /
 * Recipe / Decisions). The right rail is the outputs sidebar with the leaf
 * highlighted (`activeOutputId`). All fields come from the baked per-page ASTRA
 * output object; a missing `output` (stale link) renders a quiet not-found.
 */
function OutputDetail({
  outputId,
  output,
  outputs,
  page,
  baseSlug,
  scopeNav,
  mastheadFrontmatter,
}: {
  outputId: string
  output: OutputEntry | null
  outputs: OutputEntry[]
  page: BakedPage
  /** "" for root, else the sub-analysis slug. */
  baseSlug: string
  scopeNav: ScopeNav
  mastheadFrontmatter: MastheadFrontmatter
}) {
  const references = { article: page.ast } as References
  const isRoot = baseSlug === ''
  const outputsHref = isRoot ? '/outputs' : `/${baseSlug}/outputs`
  // Join the decisions surface correctly for both scopes — lightcone-ui's
  // reference concatenates `${sectionHrefBase}decisions`, which produces
  // `/<slug>decisions` for a sub-analysis (works only at root, where the base
  // is `/`). A proper join keeps sub-analysis decision links valid.
  const decisionsBase = isRoot ? '/decisions' : `/${baseSlug}/decisions`
  const sidebar = (
    <PaperSidebar
      mdast={page.ast}
      scopeNav={scopeNav}
      activeSurface="outputs"
      outputs={outputs}
      activeOutputId={outputId}
      includeSupportingDocuments={false}
      sectionHrefBase={isRoot ? '/' : `/${baseSlug}`}
    />
  )
  const label = (
    <div className="lc-page-label lc-page-label--spec" aria-label="Output">
      <span className="lc-page-label__name lc-page-label__name--spec">{outputId}</span>
      <span className="lc-page-label__rule" />
      <a className="lc-page-label__back" href={outputsHref}>
        ← Back
      </a>
    </div>
  )

  if (!output) {
    return (
      <ArticleProvider kind={SourceFileKind.Article} references={references} frontmatter={page.frontmatter as never}>
        <ThemeToggle />
        <main className="lc-page">
          <Masthead frontmatter={mastheadFrontmatter} fallbackTitle={page.slug} />
          {label}
          <section className="lc-section lc-spec-section">
            <div className="lc-section__body">
              <p className="lc-spec__no-data">Output “{outputId}” not found in this analysis.</p>
            </div>
          </section>
        </main>
        {sidebar}
      </ArticleProvider>
    )
  }

  return (
    <ArticleProvider kind={SourceFileKind.Article} references={references} frontmatter={page.frontmatter as never}>
      <ThemeToggle />
      <main className="lc-page">
        <Masthead frontmatter={mastheadFrontmatter} fallbackTitle={page.slug} />
        {label}
        <SpecSection num="I" title="Artefact">
          {output.description && <p className="lc-spec__desc">{output.description.trim()}</p>}
          {output.resolved_path && output.type === 'figure' && (
            <figure className="lc-spec__figure">
              <img src={output.resolved_path} alt={output.label ?? output.id} />
              {output.description && (
                <figcaption className="lc-spec__caption">{output.description.trim()}</figcaption>
              )}
            </figure>
          )}
          {output.type === 'table' &&
            (output.table_data && output.table_data.headers.length > 0 ? (
              <TableFromData data={output.table_data} label={output.label ?? output.id} />
            ) : output.resolved_path ? (
              <p className="lc-spec__no-data">No table data available.</p>
            ) : null)}
        </SpecSection>
        {output.recipe?.command && (
          <SpecSection num="II" title="Recipe">
            <pre className="lc-spec__recipe">
              <code>{output.recipe.command}</code>
            </pre>
            {output.recipe.container && (
              <p className="lc-spec__recipe-meta">
                container: <code>{output.recipe.container}</code>
              </p>
            )}
          </SpecSection>
        )}
        <SpecSection num="III" title="Decisions affecting this artefact">
          {output.decisions && output.decisions.length > 0 ? (
            <ul className="lc-spec__decisions">
              {output.decisions.map((d) => (
                <li key={d}>
                  <a href={`${decisionsBase}#decision-${d}`}>{d}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="lc-spec__decisions-empty">
              None — no decision flows into this artefact's recipe chain.
            </p>
          )}
        </SpecSection>
      </main>
      {sidebar}
    </ArticleProvider>
  )
}

function SpecSection({
  num,
  title,
  children,
}: {
  num: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="lc-section lc-spec-section">
      <div className="lc-section__label" data-num={num}>
        {title}
      </div>
      <div className="lc-section__body">{children}</div>
    </section>
  )
}
