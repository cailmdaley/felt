import { defineConfig, type Plugin } from 'vite'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Offline verification build for the BOARD CHROME (see harness/harness-board.ts).
 * Emits a single IIFE bundle + one CSS file + the harness page into
 * harness-board-dist/, loadable over `file://` (ES modules are CORS-blocked
 * under file://; an IIFE script tag is not). Not part of the shipped app — a
 * dev/verification artifact only.
 *
 * Mirrors vite.harness.config.ts; differs only in entry/outDir/global name so
 * the two harnesses (board chrome vs fiber-detail panel) build side by side.
 */

const OUT_DIR = 'harness-board-dist'

/**
 * Ship the harness page WITH its bundle.
 *
 * A lib build emits no HTML, and `emptyOutDir` clears the directory on every
 * run — so a page copied in by hand survives until the next build and then
 * vanishes, and the next browser pass opens ERR_FILE_NOT_FOUND. That reads as
 * a broken harness rather than a missing file, and it has cost real debugging
 * time. Emitting the page as part of the build is what makes the output
 * directory self-sufficient.
 */
function harnessPage(from: string): Plugin {
  return {
    name: 'harness-page',
    // `writeBundle` runs after the emptyOutDir sweep and after the bundle
    // lands, so the page cannot be cleared by its own build.
    writeBundle() {
      copyFileSync(resolve(__dirname, from), resolve(__dirname, OUT_DIR, 'index.html'))
    },
  }
}

export default defineConfig({
  base: './',
  define: {
    'import.meta.env.VITE_SHUTTLE_BASE': '""',
    // React reads `process.env.NODE_ENV` at module scope and there is no
    // `process` in a browser. The app build gets this substitution from
    // @vitejs/plugin-react; this config has no plugins, so it has to say it
    // itself — and it needs to since the settings sheet brought the first
    // React island into the board harness. Without it the bundle throws
    // `ReferenceError: process is not defined` BEFORE the mount's own
    // try/catch, so the page comes up blank with no error on it, which is the
    // worst way for this particular artifact to fail.
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [harnessPage('harness/index-board.html')],
  build: {
    outDir: OUT_DIR,
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
