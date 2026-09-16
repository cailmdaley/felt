import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  MOBILE_MAX_PX,
  MOBILE_MEDIA,
  MOBILE_SHORT_MAX_PX,
  NARROW_MEDIA,
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
const ROOTS = ['board', 'forms']

/**
 * Walks each root RECURSIVELY. It used to name the three directories that
 * happened to hold stylesheets, which meant the guard silently stopped
 * covering the codebase the first time a feature landed in a subdirectory of
 * its own — the one file nobody would think to add here is the one in a
 * folder that did not exist when this list was written.
 */
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
      // Comments are stripped first: the board's CSS explains the threshold at
      // length and says `@media …` while doing it, and a scanner that reads
      // documentation as code finds violations everywhere.
      const text = readFileSync(join(SRC, child), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
      out.push({ path: child, text })
    }
  }
  for (const rel of ROOTS) walk(rel)
  return out
}

const PRELUDE = /@media([^{]*)\{/g

/** The three forms the board is allowed to write, and nothing else. A prelude
 *  that mentions either number must be exactly one of these. */
const FORMS = [MOBILE_MEDIA, SHORT_MEDIA, NARROW_MEDIA]

describe('the mobile threshold is one contract', () => {
  it('has three named forms built from the same two numbers', () => {
    expect(MOBILE_MEDIA).toBe(`(max-width: ${MOBILE_MAX_PX}px), ${SHORT_MEDIA}`)
    expect(SHORT_MEDIA).toBe(`(max-height: ${MOBILE_SHORT_MAX_PX}px) and (pointer: coarse)`)
    expect(NARROW_MEDIA).toBe(
      `(max-width: ${MOBILE_MAX_PX}px) and (min-height: ${MOBILE_SHORT_MAX_PX + 1}px)`,
    )
  })

  // NARROW and SHORT must PARTITION the mobile viewports, not merely differ:
  // a height that matched both would apply a stacking reflow and its opposite
  // at once, and one that matched neither would drop a phone out of both.
  it('narrow and short are exact complements in height', () => {
    const shortMax = Number(/max-height: (\d+)px/.exec(SHORT_MEDIA)![1])
    const narrowMin = Number(/min-height: (\d+)px/.exec(NARROW_MEDIA)![1])
    expect(narrowMin).toBe(shortMax + 1)
  })

  // A scanner that finds nothing passes every assertion below it. This is the
  // one that says the reader is still pointed at real files.
  it('actually reads the board stylesheets', () => {
    const paths = sheets().map((f) => f.path)
    expect(paths).toContain('board/KanbanModal.css')
    expect(paths).toContain('board/views/DayView.css')
    expect(paths).toContain('forms/StashForm.tsx')
    // The canary for the RECURSION. `forms/settings/` is the first feature to
    // land a stylesheet in a directory of its own, and it is exactly the case
    // the old flat list stopped covering without a word — so a walk that went
    // back to naming directories has to fail here rather than pass quietly.
    expect(paths).toContain('forms/settings/settingsStyles.ts')
    expect(sheets().filter((f) => f.text.includes('max-width: 700px')).length).toBeGreaterThan(4)
  })

  it('every prelude that names either number is exactly one of the three forms', () => {
    const offenders: string[] = []
    for (const { path, text } of sheets()) {
      for (const m of text.matchAll(PRELUDE)) {
        const prelude = m[1].trim().replace(/\s+/g, ' ')
        const names =
          prelude.includes(`${MOBILE_MAX_PX}px`) || prelude.includes(`${MOBILE_SHORT_MAX_PX}px`)
        if (!names) continue
        // The whole prelude must BE a form — not merely contain one — so a
        // stray extra clause is caught as loudly as a missing one, and so is a
        // hand-rolled fourth threshold.
        if (!FORMS.includes(prelude)) offenders.push(`${path}: @media ${prelude}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
