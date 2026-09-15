import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SENT_FOLD_VISIBLE } from '../src/board/FiberDetailModal.js'

/**
 * THE FOLD, IN ONE PLACE.
 *
 * On a phone the sent-files trail shows its most recent chips and hides the
 * rest behind a "show all N" button. How many are shown is a CSS rule — a
 * `:nth-child` selector, because the viewport decides and CSS is what reads a
 * viewport — while the BUTTON's own "there is nothing to unfold" test is TS.
 * Two languages, one number, so the drift this file exists to catch is: the
 * button hides itself at four files while the list still clips at three.
 *
 * Out here rather than beside the code for the reason `mobileMedia.test.ts`
 * gives at length: it has to read the stylesheet, and `tsconfig`'s
 * `include: ["src"]` leaves this directory alone.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../src/board/FiberDetailModal.css', import.meta.url)),
  'utf8',
)
/** Comments say `@media` while explaining the threshold; a scanner that reads
 *  documentation as code finds the rule in the wrong place. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ')

describe('the sent-files fold', () => {
  it('clips the list at the same count the button counts from', () => {
    const rule = /\.kbn-detail-sent-list > :nth-child\(n \+ (\d+)\)/.exec(CODE)
    expect(rule, 'the nth-child fold rule must exist in FiberDetailModal.css').not.toBeNull()
    expect(Number(rule![1])).toBe(SENT_FOLD_VISIBLE + 1)
  })

  it('only clips under the mobile contract', () => {
    // The rule must sit inside a media block — a desktop shows every chip.
    const before = CODE.slice(0, CODE.indexOf('.kbn-detail-sent-list > :nth-child'))
    const opens = (before.match(/@media/g) ?? []).length
    expect(opens).toBeGreaterThan(0)
  })
})
