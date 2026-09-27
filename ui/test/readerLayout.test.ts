import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Two layout contracts the reader and the card panel keep in CSS, where a
 * DOM test in jsdom cannot see them (it computes no layout).
 *
 * 1. An inactive reader tab stays LAID OUT. A browser's PDF viewer lives in
 *    its frame; under `display: none` the frame collapses to nothing and
 *    WebKit's viewer re-fits the document to that zero-size box, so flipping
 *    back to a PDF tab found it at another scale and position. The hidden cell
 *    must be invisible and stacked, never removed from layout.
 *    A linked-fiber tab is the exception: it holds no PDF viewer, and keeping
 *    it laid out would wake its deferred attachment previews.
 * 2. Attachments and the sent-files trail share one band, side by side on a
 *    wide card (never in a phone sheet), with the trail's height taken from
 *    the attachment cards.
 *
 * Out here rather than beside the code for the reason `mobileMedia.test.ts`
 * gives: it reads the stylesheet, and `tsconfig`'s `include: ["src"]` leaves
 * this directory alone. The visual check is the fiber-detail harness:
 * `npx vite build -c vite.harness.config.ts`, then open
 * `harness-dist/index.html?pdfs=1&fixtures=<dir with paper-a.pdf, paper-b.pdf>`.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../src/board/FiberDetailModal.css', import.meta.url)),
  'utf8',
)
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** The declarations of every rule whose selector list is exactly `selector`. */
function declarations(selector: string): string {
  const out: string[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(CODE); m; m = re.exec(CODE)) {
    if (m[1].trim() === selector) out.push(m[2])
  }
  return out.join(';')
}

describe('an inactive reader tab', () => {
  const hidden = declarations('.kbn-detail-view-cell[hidden]')

  it('is never taken out of layout', () => {
    expect(hidden, 'the [hidden] cell rule must exist').not.toBe('')
    expect(hidden).not.toMatch(/display:\s*none/)
    expect(hidden).toMatch(/display:\s*block/)
  })

  it('is invisible, inert to the pointer, and stacked over the view area', () => {
    expect(hidden).toMatch(/visibility:\s*hidden/)
    expect(hidden).toMatch(/pointer-events:\s*none/)
    expect(hidden).toMatch(/position:\s*absolute/)
    expect(hidden).toMatch(/inset:\s*0/)
    expect(declarations('.kbn-detail-views')).toMatch(/position:\s*relative/)
  })
})

describe('a hidden linked-fiber tab', () => {
  it('leaves layout, so its deferred attachment previews stay deferred', () => {
    // It holds no PDF viewer to preserve; laid out, it would read as on
    // screen to the IntersectionObserver that defers its previews.
    const rule = declarations('.kbn-detail-overlay.kbn-linkview-window .kbn-detail-view-cell[hidden]')
    expect(rule).toMatch(/display:\s*none/)
  })
})

describe('the files band', () => {
  it('stacks by default', () => {
    expect(declarations('.kbn-detail-files')).toMatch(/flex-direction:\s*column/)
  })

  it('puts the trail beside the attachments on a wide card, sized by the cards', () => {
    const query = CODE.indexOf('@container kbn-detail (min-width:')
    expect(query, 'the side-by-side layout must be a container query').toBeGreaterThan(-1)
    // The query's own block, up to its matching brace — so a rule that moved
    // out of the query would no longer satisfy the checks below.
    let depth = 0
    let end = CODE.indexOf('{', query)
    for (; end < CODE.length; end++) {
      if (CODE[end] === '{') depth++
      else if (CODE[end] === '}' && --depth === 0) break
    }
    const block = CODE.slice(query, end)
    expect(block).toMatch(/:not\(\.kbn-detail-sheet\) > \.kbn-detail-files:has\(\.kbn-detail-attach\)[^{]*\{[^}]*flex-direction:\s*row/)
    // The trail contributes no height of its own, so it can never make the
    // band taller than one row of attachment cards.
    expect(block).toMatch(/\.kbn-detail-files:has\(\.kbn-detail-attach\) > \.kbn-detail-sent\s*\{[^}]*contain:\s*size/)
  })
})
