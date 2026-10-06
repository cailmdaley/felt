import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The Shuttle UI build.
 *
 * `index.html` → `src/main.ts`: the kanban board and Stash/Capture, with
 * meeting audio owned by the board (vanilla TS DOM with React form islands).
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
 * Write `.gz` and `.br` beside every compressible bundle file. The daemon's
 * Plug.Static serves them to clients that accept the encoding, so the board
 * crosses the tailnet at about a quarter of its size, with no compression
 * work per request.
 */
function precompress(): Plugin {
  const compressible = /\.(js|css|svg|json|ttf|otf|webmanifest)$/
  let outDir = ''
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    writeBundle() {
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
        .flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
      for (const path of walk(outDir)) {
        if (!compressible.test(path)) continue
        const source = readFileSync(path)
        if (source.length < 1024) continue
        writeFileSync(`${path}.gz`, gzipSync(source, { level: 9 }))
        writeFileSync(`${path}.br`, brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }))
      }
    },
  }
}

export default defineConfig({
  base: '',
  plugins: [react(), precompress()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
