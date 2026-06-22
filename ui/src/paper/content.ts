import type { GenericParent } from 'myst-common'
import type { MastheadFrontmatter, InputEntry, OutputEntry } from '@lightcone/renderer'

/**
 * One baked page, as MySTRA's `buildAllPages` emits it (see priv/mystra/bake.mjs).
 * `ast` is the mdast root the renderer consumes; the root analysis is slug
 * `index`, sub-analyses get their own slugs.
 */
export interface BakedPage {
  slug: string
  title: string
  level: number
  ast: GenericParent
  frontmatter?: MastheadFrontmatter
  identifiers?: string[]
  dependencies?: unknown
  dois?: unknown
}

/**
 * The structured ASTRA data for one page — what the decisions/outputs/inputs
 * SURFACES render from (the narrative page renders from mdast alone). Produced
 * by MySTRA's `buildASTRADataMap`, keyed by page slug ('index' = root) in
 * `BakedPaper.astra` (see priv/mystra/bake.mjs).
 */
export interface AstraPageData {
  outputs: OutputEntry[]
  inputs: InputEntry[]
}

export interface BakedPaper {
  pages: BakedPage[]
  /** Per-page `{outputs, inputs}` for the non-narrative surfaces, by slug. */
  astra?: Record<string, AstraPageData>
  /**
   * Materialized result artifacts, basename → absolute path on the *owning*
   * host (the one that baked). MySTRA renders figure URLs and output
   * `resolved_path`s as `/static/<basename>`; the daemon serves many projects
   * from one origin, so a bare `/static/…` can't resolve there. `resolveStatic`
   * rewrites each to the owner-routed `/file` byte route using this map.
   */
  files?: Record<string, string>
}

export interface LoadPaperArgs {
  /** Absolute path to the astra.yaml's project dir (owner-routed via origin). */
  path?: string | null
  /** Origin id; omitted/empty/local → the local daemon bakes it. */
  origin?: string | null
  /** Optional universe selection. */
  universe?: string | null
  /** Dev-only: load a static baked fixture from /fixtures/<name>.json. */
  fixture?: string | null
}

/**
 * Fetch the baked paper. Production path: the daemon's owner-routed
 * `GET /api/v1/astra?path=&origin=&universe=` shells out to bake.mjs and
 * returns `{ pages }`. Dev path: `?fixture=iris` loads a locally-baked,
 * gitignored fixture (regenerate via priv/mystra/bake.mjs) so the render is
 * verifiable without a running daemon or MySTRA. Dead-code-eliminated in a
 * production build (`import.meta.env.DEV` is statically false).
 */
export async function loadPaper(args: LoadPaperArgs): Promise<BakedPaper> {
  if (import.meta.env.DEV && args.fixture) {
    const res = await fetch(`/fixtures/${encodeURIComponent(args.fixture)}.json`)
    if (!res.ok) throw new Error(`fixture ${args.fixture} not found (${res.status})`)
    return (await res.json()) as BakedPaper
  }

  if (!args.path) throw new Error('no astra.yaml path given')

  const params = new URLSearchParams({ path: args.path })
  if (args.origin) params.set('origin', args.origin)
  if (args.universe) params.set('universe', args.universe)

  const res = await fetch(`/api/v1/astra?${params.toString()}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(detail || `astra bake failed (${res.status})`)
  }
  return resolveStaticUrls((await res.json()) as BakedPaper, args.origin)
}

const STATIC_PREFIX = '/static/'

/**
 * Build the owner-routed `/file` URL for an absolute path on the bake host.
 * Mirrors the board's `fileUrl` encoding (`board/utils.ts`): percent-encode the
 * path (`~`→`%7E` for parity), and carry `origin` only for a remote bake — a
 * local/empty origin lets the daemon serve the bytes itself.
 */
function fileUrl(absPath: string, origin?: string | null): string {
  let url = `/api/v1/file?path=${encodeURIComponent(absPath).replace(/~/g, '%7E')}`
  if (origin && origin !== 'local') url += `&origin=${encodeURIComponent(origin)}`
  return url
}

/**
 * Rewrite a single `/static/<basename>` reference to the owner-routed `/file`
 * route via the bake's `files` map. An unmaterialized output isn't in the map,
 * so its URL is left untouched — for an inline figure MySTRA already emitted a
 * "Pending Output" admonition in its place, and an output card simply shows no
 * image. A missing `files` map (an older/remote bake) degrades the same way.
 */
function resolveStatic(
  url: string,
  files: Record<string, string>,
  origin?: string | null,
): string {
  if (!url.startsWith(STATIC_PREFIX)) return url
  // Match raw: MySTRA emits bare, never-encoded `/static/<basename>` URLs and
  // `files` is keyed by the raw `basename(absPath)`, so raw-to-raw is exact.
  // (No decodeURIComponent — there's no encoded input to undo, and a literal
  // `%` in a name would throw URIError synchronously inside loadPaper, sinking
  // the WHOLE paper render via PaperApp's catch rather than just one image.)
  const base = url.slice(STATIC_PREFIX.length).split(/[?#]/)[0]
  const abs = files[base]
  return abs ? fileUrl(abs, origin) : url
}

/** Recursively rewrite `/static/…` in any mdast node's `url`/`src` field. */
function rewriteNode(
  node: unknown,
  files: Record<string, string>,
  origin?: string | null,
): void {
  if (!node || typeof node !== 'object') return
  const n = node as { url?: unknown; src?: unknown; children?: unknown }
  if (typeof n.url === 'string') n.url = resolveStatic(n.url, files, origin)
  if (typeof n.src === 'string') n.src = resolveStatic(n.src, files, origin)
  if (Array.isArray(n.children)) for (const c of n.children) rewriteNode(c, files, origin)
}

/**
 * Resolve every `/static/<basename>` figure reference — inline mdast image nodes
 * (the narrative) and `outputs[].resolved_path` (the Outputs surface + cards) —
 * to the owner-routed `/file` byte route, in place. The `files` map is keyed by
 * basename exactly as MySTRA's own `/static` handler resolves; this is that same
 * resolution, precomputed at bake time so one daemon can serve many projects.
 */
function resolveStaticUrls(paper: BakedPaper, origin?: string | null): BakedPaper {
  const files = paper.files
  if (!files) return paper
  for (const page of paper.pages) rewriteNode(page.ast, files, origin)
  for (const data of Object.values(paper.astra ?? {})) {
    for (const out of data.outputs ?? []) {
      const o = out as { resolved_path?: unknown }
      if (typeof o.resolved_path === 'string') {
        o.resolved_path = resolveStatic(o.resolved_path, files, origin)
      }
    }
  }
  return paper
}
