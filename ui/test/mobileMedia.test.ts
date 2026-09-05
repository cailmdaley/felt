import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MOBILE_MAX_PX,
  MOBILE_MEDIA,
  MOBILE_SHORT_MAX_PX,
  SHORT_MEDIA,
} from '../src/board/mobile.js'

/**
 * THE THRESHOLD, IN ONE PLACE.
 *
 * WHY THIS FILE IS NOT BESIDE THE CODE IT GUARDS, which is the repo's
 * convention everywhere else: it has to READ the stylesheets, and the two ways
 * to do that both cost more than the exception does. Vite's `?raw` import
 * comes back empty under vitest (the CSS transform wins over the query), and
 * `node:fs` needs `@types/node`, which the board deliberately does not carry —
 * adding it would put node's globals in front of every browser module in
 * `src/`. Out here, `tsconfig`'s `include: ["src"]` leaves the file alone and
 * vitest still finds it.
 *
 * Media queries cannot read a custom property, so the board's mobile
 * threshold is written by hand in every stylesheet that answers to it — and
 * for a year it was one number, which made drift a typo away rather than a
 * design decision away. Then the threshold stopped being a number: a phone in
 * landscape is 874px wide and 402px tall, so the contract became a
 * disjunction, and a hand-written disjunction copied into eight files is a
 * different order of hazard.
 *
 * So this suite reads the actual CSS. Any `@media` prelude that mentions the
 * width half must carry the short-and-handheld half too, or the file it lives
 * in has quietly opted a whole view out of landscape.
 */

/** Every source file that could carry a media prelude: the board's own CSS
 *  and the views' CSS, plus the two form components that keep their styles in
 *  a template literal. Read through Vite's raw glob rather than `fs` — the
 *  build type-checks this file with the DOM lib and no node types, and a test
 *  that only runs under vitest is not worth a `@types/node` dependency. */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const ROOTS = ['board', 'board/views', 'forms']

function sheets(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  for (const rel of ROOTS) {
    for (const name of readdirSync(join(SRC, rel))) {
      if (!/\.(css|tsx)$/.test(name)) continue
      // Comments are stripped first: the board's CSS explains the threshold at
      // length and says `@media …` while doing it, and a scanner that reads
      // documentation as code finds violations everywhere.
      const text = readFileSync(join(SRC, rel, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
      out.push({ path: `${rel}/${name}`, text })
    }
  }
  return out
}

const PRELUDE = /@media([^{]*)\{/g

describe('the mobile threshold is one contract', () => {
  it('is a disjunction of a width and a short handheld viewport', () => {
    expect(MOBILE_MEDIA).toBe(`(max-width: ${MOBILE_MAX_PX}px), ${SHORT_MEDIA}`)
    expect(SHORT_MEDIA).toBe(`(max-height: ${MOBILE_SHORT_MAX_PX}px) and (pointer: coarse)`)
  })

  // A scanner that finds nothing passes every assertion below it. This is the
  // one that says the glob is still pointed at real files.
  it('actually reads the board stylesheets', () => {
    const paths = sheets().map((f) => f.path)
    expect(paths).toContain('board/KanbanModal.css')
    expect(paths).toContain('board/views/DayView.css')
    expect(paths).toContain('forms/StashForm.tsx')
    expect(sheets().filter((f) => f.text.includes('max-width: 700px')).length).toBeGreaterThan(4)
  })

  it('every stylesheet that names the width also names the short viewport', () => {
    const offenders: string[] = []
    for (const { path, text } of sheets()) {
      for (const m of text.matchAll(PRELUDE)) {
        const prelude = m[1].trim().replace(/\s+/g, ' ')
        if (!prelude.includes(`max-width: ${MOBILE_MAX_PX}px`)) continue
        // The whole prelude must BE the contract — not merely contain it, so a
        // stray extra clause is caught as loudly as a missing one.
        if (prelude !== MOBILE_MEDIA) offenders.push(`${path}: @media ${prelude}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the short-only blocks are written exactly as SHORT_MEDIA', () => {
    const offenders: string[] = []
    for (const { path, text } of sheets()) {
      for (const m of text.matchAll(PRELUDE)) {
        const prelude = m[1].trim().replace(/\s+/g, ' ')
        if (!prelude.includes(`max-height: ${MOBILE_SHORT_MAX_PX}px`)) continue
        // The one legitimate other use of the number is its COMPLEMENT — a
        // rule for viewports that are NOT short, which the Week view uses to
        // gate a two-line row. That is the contract being respected, not
        // drifted from, so it is named here rather than flagged.
        const complement = `not all and (max-height: ${MOBILE_SHORT_MAX_PX}px)`
        if (prelude !== SHORT_MEDIA && prelude !== MOBILE_MEDIA && prelude !== complement) {
          offenders.push(`${path}: @media ${prelude}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
