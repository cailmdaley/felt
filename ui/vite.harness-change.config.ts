import { defineConfig } from 'vite'
import { changeAliases } from './change-build.js'
import { resolve } from 'node:path'

// ES modules preserve the production reader's lazy grammar-chunk failure boundary.
export default defineConfig({
  root: resolve(__dirname, 'harness/change'),
  base: './',
  resolve: { alias: changeAliases },
  build: { outDir: resolve(__dirname, 'harness-change-dist'), emptyOutDir: true },
})
