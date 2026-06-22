// On-demand MySTRA bake — the ASTRA path's leanest transform invocation.
//
// MySTRA ships no `bake` subcommand: its CLI only boots a long-running Express
// content server. But the astra.yaml -> mdast transform is a pure, synchronous,
// offline library pair (`loadASTRASource` + `buildAllPages`). This wrapper calls
// them directly and writes the page bundle to stdout, so the Shuttle daemon can
// shell out once per opened astra.yaml instead of standing up a second server.
//
//   LC_MYSTRA_DIR=<mystra-checkout> node bake.mjs <projectDir> [universe]
//     -> stdout: { pages: [{ slug, title, level, ast, frontmatter, ... }] }
//
// `ast` is the mdast root the @lightcone/renderer consumes. The transform is
// offline; figure nodes carry `/static/<id>.<ext>` URLs the daemon serves
// separately, and citations degrade to plain DOI links without a DOI cache.
//
// MySTRA resolution mirrors lightcone-ui's CLI: $LC_MYSTRA_DIR, else a sibling
// checkout next to this repo's parent projects dir. We import its built
// `dist/index.js` (run `npm install && npm run build` in the MySTRA checkout
// once — its dist/ is gitignored).

import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function resolveMystraDist() {
  const fromEnv = process.env.LC_MYSTRA_DIR
  const candidates = [
    fromEnv && join(fromEnv, 'dist', 'index.js'),
    // sibling of the projects dir: <projects>/LightconeResearch/MySTRA
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../LightconeResearch/MySTRA/dist/index.js'),
  ].filter(Boolean)
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) {
    throw new Error(
      `MySTRA dist not found. Set LC_MYSTRA_DIR to a built MySTRA checkout ` +
        `(npm install && npm run build there). Looked at:\n  ${candidates.join('\n  ')}`,
    )
  }
  return hit
}

const [projectDir, universe] = process.argv.slice(2)
if (!projectDir) {
  process.stderr.write('usage: node bake.mjs <projectDir> [universe]\n')
  process.exit(2)
}

const distIndex = resolveMystraDist()
const { loadASTRASource, buildAllPages } = await import(pathToFileURL(distIndex).href)

// buildASTRADataMap lives in the server route module (not re-exported from
// dist/index.js), but it's a pure transform with no server deps — it's what
// MySTRA's /astra/{slug}.json endpoint serves. We call it alongside
// buildAllPages so the daemon hands the paper entry BOTH the mdast pages and
// the structured {outputs, inputs} the decisions/outputs/inputs SURFACES need
// (the narrative page renders from mdast alone; the surfaces don't).
const astraRoute = join(dirname(distIndex), 'server', 'routes', 'astra.js')
const { buildASTRADataMap } = await import(pathToFileURL(astraRoute).href)

const src = loadASTRASource(resolve(projectDir), universe)
const pages = buildAllPages(src.analysis, src.universe, src.results, src.projectDir)

// Map<slug, {outputs, inputs}> → a plain object keyed by slug ('index' = root).
// Defensive: a data-shape problem in the surface extraction must not sink the
// whole bake — the narrative still renders, the surfaces just show empty.
let astra = {}
try {
  astra = Object.fromEntries(buildASTRADataMap(src.analysis, src.results))
} catch (e) {
  process.stderr.write(`buildASTRADataMap failed (surfaces will be empty): ${e?.stack ?? e}\n`)
}

// `files`: every materialized result artifact, keyed by basename → absolute
// path. MySTRA renders figure URLs (and output `resolved_path`s) as
// `/static/<basename>`, resolved server-side against its in-memory results
// scan. The standalone daemon serves many projects from one origin, so a bare
// `/static/<basename>` can't be resolved there — instead the paper entry
// rewrites each `/static/<basename>` to the owner-routed `/api/v1/file?path=…`
// byte route using this map (the same basename→absPath resolution MySTRA's own
// `/static` handler does, just precomputed here at bake time). `src.results` is
// the authoritative `outputId → absPath` map the scan produced; an unmaterialized
// output isn't in it, so its `/static` URL stays unresolved and renders as the
// figure's "Pending Output" placeholder — faithful to lightcone-ui. This is the
// scan map only, not MySTRA's `express.static(results/<universe>/)` fall-through —
// but the scanner indexes every regular file in those dirs, so an
// ASTRA-convention `/static/<outputId>.<ext>` URL is always covered.
const files = Object.fromEntries(
  [...src.results.values()].map((abs) => [basename(abs), abs]),
)

process.stdout.write(JSON.stringify({ pages, astra, files }))
