import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * The Shuttle UI build.
 *
 * One entry: `index.html` → `src/main.ts`, the kanban board + Stash/Capture
 * (vanilla TS DOM with React form islands). The vellum/parchment look is
 * hand-rolled CSS.
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

export default defineConfig({
  base: '',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'index.html') },
    },
  },
})
