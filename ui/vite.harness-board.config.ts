import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * Offline verification build for the BOARD CHROME (see harness/harness-board.ts).
 * Emits a single IIFE bundle + one CSS file into harness-board-dist/, loadable
 * over `file://` (ES modules are CORS-blocked under file://; an IIFE script tag
 * is not). Not part of the shipped app — a dev/verification artifact only.
 *
 * Mirrors vite.harness.config.ts; differs only in entry/outDir/global name so
 * the two harnesses (board chrome vs fiber-detail panel) build side by side.
 */
export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_SHUTTLE_BASE': '""' },
  build: {
    outDir: 'harness-board-dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, 'harness/harness-board.ts'),
      formats: ['iife'],
      name: 'BoardChromeHarness',
      fileName: () => 'harness-board.js',
    },
  },
})
