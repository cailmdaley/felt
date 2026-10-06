// Bundle composition: builds the board and writes every module's rendered size
// per chunk to $ANALYZE_JSON (default modsizes.json).
//   ANALYZE_JSON=/tmp/mods.json npx vite build -c scripts/perf/vite.analyze.config.ts
import { defineConfig, mergeConfig } from 'vite'
import base from '../../vite.config'
import { writeFileSync } from 'node:fs'
export default mergeConfig(base, defineConfig({
  build: { outDir: process.env.ANALYZE_OUT ?? 'dist-analyze' },
  plugins: [{
    name: 'module-sizes',
    generateBundle(_o, bundle) {
      const rows: any[] = []
      for (const [f, c] of Object.entries(bundle)) {
        if ((c as any).type !== 'chunk') continue
        for (const [id, m] of Object.entries((c as any).modules)) rows.push({ chunk: f, id, len: (m as any).renderedLength })
      }
      writeFileSync(process.env.ANALYZE_JSON ?? 'modsizes.json', JSON.stringify(rows))
    },
  }],
}))
