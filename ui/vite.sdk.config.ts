import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { precompress } from './vite.config.js'

/**
 * The Shuttle UI primitives as one self-contained ES module,
 * `dist/sdk/shuttle-sdk.js`, minified, with `@ui-sdk/core` and `@ui-sdk/web`
 * bundled in, so a page the daemon serves imports it with no build step of its own:
 *
 *     import { ShuttleClient, createThreadRow } from '/sdk/shuttle-sdk.js'
 *
 * It runs after the board's build, into the same `dist/`, which it leaves as
 * it found it.
 */
export default defineConfig({
  base: '',
  plugins: [precompress('sdk')],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'es2022',
    // An entry rather than a library: Vite leaves an ES library's whitespace in.
    rollupOptions: {
      input: resolve(__dirname, 'src/sdk/index.ts'),
      preserveEntrySignatures: 'strict',
      output: { format: 'es', entryFileNames: 'sdk/shuttle-sdk.js', inlineDynamicImports: true },
    },
    modulePreload: { polyfill: false },
  },
})
