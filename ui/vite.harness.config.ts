import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * Offline verification build (see harness/harness.ts). Emits a single IIFE
 * bundle + one CSS file into harness-dist/, loadable over `file://` (ES modules
 * are CORS-blocked under file://; an IIFE script tag is not). Not part of the
 * shipped app — a dev/verification artifact only.
 */
export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_SHUTTLE_BASE': '""' },
  build: {
    outDir: 'harness-dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, 'harness/harness.ts'),
      formats: ['iife'],
      name: 'BoardHarness',
      fileName: () => 'harness.js',
    },
  },
})
