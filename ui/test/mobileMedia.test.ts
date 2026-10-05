import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MOBILE_MAX_PX, MOBILE_MEDIA, MOBILE_SHORT_MAX_PX, SHORT_MEDIA } from '../src/board/mobile.js'

/**
 * CSS media queries cannot read TypeScript constants. Scan stylesheets and
 * component templates to keep each use of the shared mobile thresholds aligned.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const ROOTS = ['board', 'forms']

function sheets(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(SRC, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!/\.(css|tsx|ts)$/.test(entry.name)) continue
      const text = readFileSync(join(SRC, child), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
      out.push({ path: child, text })
    }
  }
  for (const rel of ROOTS) walk(rel)
  return out
}

const PRELUDE = /@media([^{]*)\{/g
const FORMS = [MOBILE_MEDIA, SHORT_MEDIA]

describe('the mobile viewport contract', () => {
  it('builds both forms from the shared thresholds', () => {
    expect(MOBILE_MEDIA).toBe(`(max-width: ${MOBILE_MAX_PX}px), ${SHORT_MEDIA}`)
    expect(SHORT_MEDIA).toBe(`(max-height: ${MOBILE_SHORT_MAX_PX}px) and (pointer: coarse)`)
  })

  it('scans board styles, nested views, and component templates', () => {
    const paths = sheets().map((f) => f.path)
    expect(paths).toContain('board/KanbanModal.css')
    expect(paths).toContain('board/views/ChronicleView.css')
    expect(paths).toContain('forms/StashForm.tsx')
    expect(paths).toContain('forms/settings/settingsStyles.ts')
    expect(sheets().filter((f) => f.text.includes('max-width: 700px')).length).toBeGreaterThan(4)
  })

  it('uses only the shared forms in media queries that name either threshold', () => {
    const offenders: string[] = []
    for (const { path, text } of sheets()) {
      for (const m of text.matchAll(PRELUDE)) {
        const prelude = m[1].trim().replace(/\s+/g, ' ')
        const names =
          prelude.includes(`${MOBILE_MAX_PX}px`) || prelude.includes(`${MOBILE_SHORT_MAX_PX}px`)
        if (names && !FORMS.includes(prelude)) offenders.push(`${path}: @media ${prelude}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
