import { defineConfig, type Plugin } from 'vite'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Offline verification build (see harness/harness.ts). Emits a single IIFE
 * bundle + one CSS file + the harness page into harness-dist/, loadable over
 * `file://` (ES modules are CORS-blocked under file://; an IIFE script tag is
 * not). Not part of the shipped app — a dev/verification artifact only.
 */

const OUT_DIR = 'harness-dist'

/**
 * Ship the harness page WITH its bundle — see the note in
 * vite.harness-board.config.ts. A lib build emits no HTML and `emptyOutDir`
 * clears the directory each run, so a hand-copied page disappears on the next
 * build and the following browser pass opens ERR_FILE_NOT_FOUND.
 */
function harnessPage(from: string): Plugin {
  return {
    name: 'harness-page',
    // `writeBundle` runs after the emptyOutDir sweep, so the page cannot be
    // cleared by its own build.
    writeBundle() {
      copyFileSync(resolve(__dirname, from), resolve(__dirname, OUT_DIR, 'index.html'))
    },
  }
}

export default defineConfig({
  base: './',
  define: { 'import.meta.env.VITE_SHUTTLE_BASE': '""' },
  plugins: [harnessPage('harness/index.html')],
  build: {
    outDir: OUT_DIR,
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
