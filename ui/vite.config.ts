import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * The Shuttle UI build.
 *
 * Two entries, two worlds:
 *
 *   index.html  → src/main.ts    the kanban board + Stash/Capture (vanilla TS
 *                                 DOM + React form islands). NO Tailwind, the
 *                                 vellum/parchment look is hand-rolled CSS.
 *   paper.html  → src/paper/      the ASTRA paper render: @lightcone/renderer
 *                                 over a baked astra.yaml. React + Tailwind v4.
 *                                 Loaded by the fiber panel in an <iframe>, so
 *                                 its Tailwind preflight + tokens.css html/body
 *                                 reset are fully isolated from the board.
 *
 * The board fetches the daemon with a *relative* base (`/api/v1/...`):
 *
 * Prod (`npm run build`): the daemon serves the bundle at :4000 (Plug.Static,
 * backend slice), so relative fetches are same-origin — zero CORS, zero config.
 * `base: ''` keeps asset URLs relative so the bundle works from any path.
 *
 * Dev (`npm run dev`): this proxy forwards `/api` → the local daemon, so the
 * board's relative fetches reach :4000 without CORS regardless of dev port.
 * Point at a remote/non-default daemon with `VITE_SHUTTLE_API` (proxy target)
 * or `VITE_SHUTTLE_BASE` (absolute base, bypasses the proxy).
 *
 * `@lightcone/renderer` is consumed as TS *source* (it ships no dist; the
 * constitution's "file:-link now, publish later" decision): resolve.alias the
 * three packages to a lightcone-ui checkout. LIGHTCONE_UI_DIR overrides the
 * default sibling layout (~/Documents/projects/LightconeResearch/lightcone-ui).
 * Building the paper bundle requires that checkout present — the board bundle
 * does not, so a host without lightcone-ui still builds + serves the board.
 */
const apiTarget = process.env.VITE_SHUTTLE_API ?? 'http://localhost:4000'

const lightconeUiDir =
  process.env.LIGHTCONE_UI_DIR ??
  resolve(__dirname, '../../LightconeResearch/lightcone-ui')
const rendererSrc = resolve(lightconeUiDir, 'packages/renderer/src')

/**
 * Tailwind v4 auto-detects content by scanning the project tree, but the
 * renderer's source lives in *another repo* (aliased, not under our root), so
 * its utility classes (`hover:text-gold`, …) would never be generated. Inject
 * an `@source` pointing at the renderer src into the paper entry CSS — one
 * env-driven path shared with the alias above, so the two can't drift. Runs
 * before @tailwindcss/vite so the directive is present when Tailwind scans.
 */
function lightconeTailwindSource() {
  const marker = '/* @inject-lightcone-source */'
  return {
    name: 'lightcone-tailwind-source',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (id.includes('/src/paper/') && id.endsWith('.css') && code.includes(marker)) {
        return { code: code.replace(marker, `@source "${rendererSrc}";`), map: null }
      }
      return null
    },
  }
}

export default defineConfig({
  base: '',
  plugins: [lightconeTailwindSource(), tailwindcss(), react()],
  resolve: {
    /**
     * Collapse the myst stack to a SINGLE physical copy. The renderer is
     * aliased to lightcone-ui's `packages/renderer/src`, whose bare imports
     * (`myst-to-react`, `@myst-theme/providers`, …) Node-resolve from
     * lightcone-ui's *own* node_modules — a different path than shuttle-ui's
     * copies of the same packages. Without dedupe the bundle ends up with TWO
     * instances of `@myst-theme/providers`, hence two distinct module-scope
     * `ThemeContext` objects (the renderer set rides in a field of
     * `ThemeContext`, read via `useNodeRenderers`): PaperApp's `ThemeProvider`
     * (shuttle-ui copy) populates one, but PaperView's internal `<MyST>`
     * (lightcone-ui copy) reads the OTHER → it sees no renderers → every
     * MyST-dispatched node falls to myst-to-react's class-less
     * `DefaultComponent`. The chrome
     * (masthead/sections, PaperView's own React) survives, masking the break;
     * the symptom is bare-`<div>` body prose and missing finding/decision/xref
     * treatments — and ONLY in `vite build` (dev's optimizeDeps happens to
     * unify the duplicate). Versions match exactly across both checkouts
     * (@myst-theme/* 1.2.2, myst-common/-spec-ext 1.9.5, react 18.3.1), so
     * forcing one copy is lossless. react/react-dom listed defensively —
     * two Reacts would break hooks outright.
     */
    dedupe: [
      'react',
      'react-dom',
      'myst-to-react',
      'myst-common',
      'myst-spec-ext',
      '@myst-theme/providers',
      '@myst-theme/common',
      // The renderer's SupportingDocuments → PaperModal lazily
      // `import("pdfjs-dist")` for its PDF preview. The importer is the aliased
      // lightcone-ui source, whose tree declares pdfjs-dist but never installed
      // it (its node_modules predate that addition), so a bare resolve from
      // there fails the build. We declare + install pdfjs-dist ourselves; dedupe
      // forces the resolve to our project-root copy regardless of importer
      // location — same mechanism as the myst stack above.
      'pdfjs-dist',
    ],
    alias: [
      { find: '@lightcone/renderer', replacement: resolve(lightconeUiDir, 'packages/renderer/src') },
      { find: '@lightcone/providers', replacement: resolve(lightconeUiDir, 'packages/providers/src') },
      { find: '@lightcone/styles', replacement: resolve(lightconeUiDir, 'packages/styles/src') },
    ],
  },
  server: {
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
    // The renderer source is outside the Vite root — let the dev server read it.
    fs: { allow: [resolve(__dirname), lightconeUiDir] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // The paper entry needs the lightcone-ui checkout (aliased TS source). A
      // host without it still builds + serves the board — the paper entry is
      // dropped rather than failing the whole build. An astra.yaml embed on
      // such a host degrades to a missing iframe; the board is unaffected.
      input: existsSync(rendererSrc)
        ? {
            index: resolve(__dirname, 'index.html'),
            paper: resolve(__dirname, 'paper.html'),
          }
        : { index: resolve(__dirname, 'index.html') },
    },
  },
})
