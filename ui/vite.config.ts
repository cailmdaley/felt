import { type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { changeAliases } from './change-build.js'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { keepQueriesUncached } from './src/runtime/uncachedQueries.js'

/**
 * The Shuttle UI build.
 *
 * `index.html` → `src/main.ts`: the kanban board and Stash/Capture, with
 * phone audio owned by the board (vanilla TS DOM with React form islands).
 * `pages.html` → `src/pages/main.ts`: the light pages (`/thread`), each one
 * address, which the daemon serves from this one document.
 * The vellum/parchment look is hand-rolled CSS.
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
 */
const apiTarget = process.env.VITE_SHUTTLE_API ?? 'http://localhost:4000'

/**
 * Write `.gz` and `.br` beside every compressible bundle file (under `subdir`
 * of the output, when given). The daemon's Plug.Static serves them to clients
 * that accept the encoding, so the board crosses the tailnet at about a
 * quarter of its size, with no compression work per request.
 */
export function precompress(subdir = ''): Plugin {
  const compressible = /\.(js|css|svg|json|ttf|otf|webmanifest)$/
  let outDir = ''
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    writeBundle() {
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
        .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
      for (const path of walk(join(outDir, subdir))) {
        if (!compressible.test(path)) continue
        const source = readFileSync(path)
        if (source.length < 1024) continue
        writeFileSync(`${path}.gz`, gzipSync(source, { level: 9 }))
        writeFileSync(`${path}.br`, brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }))
      }
    },
  }
}

/**
 * `framed-runtime.js`: the script the daemon puts at the head of an HTML page
 * it serves into a frame, which the board cannot reach to inject its own
 * runtime (a deck framed inside a report). It asks lone tag and class queries
 * as lists, so WebKit can free the page (`src/runtime/uncachedQueries.ts`).
 */
function framedRuntime(): Plugin {
  return {
    name: 'framed-runtime',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'framed-runtime.js', source: `(${keepQueriesUncached.toString()})();\n` })
    },
  }
}

export default defineConfig({
  base: '',
  test: { setupFiles: ['./test/setup.ts'] },
  resolve: { alias: changeAliases },
  plugins: [react(), framedRuntime(), precompress()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve(__dirname, 'index.html'), pages: resolve(__dirname, 'pages.html') } },
  },
})
