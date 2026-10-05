import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The floating file reader's inactive-PDF layout contract lives in CSS, where
 * a DOM test in jsdom cannot see it (jsdom computes no layout).
 *
 * The inactive PDF cell is COVERED, never hidden. A browser's PDF viewer lives
 * in its frame and scrolls itself, out of the page's reach. In WebKit,
 * `display: none` re-fits the document to a zero-size frame and
 * `visibility: hidden` drops its scroll and paint, so flipping back to a PDF
 * tab found it blank, then at page 1. The inactive cell must stay rendered at
 * full size beneath the active one.
 *
 * Out here rather than beside the code for the reason `mobileMedia.test.ts`
 * gives: it reads the stylesheet, and `tsconfig`'s `include: ["src"]` leaves
 * this directory alone.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../src/board/ReaderWindow.css', import.meta.url)),
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

  it('is never hidden from the browser', () => {
    expect(hidden, 'the [hidden] cell rule must exist').not.toBe('')
    expect(hidden).not.toMatch(/display:\s*none/)
    expect(hidden).toMatch(/display:\s*block/)
    expect(hidden).not.toMatch(/visibility:\s*hidden/)
    expect(hidden).not.toMatch(/opacity:\s*0/)
    expect(hidden).not.toMatch(/content-visibility/)
  })

  it('fills the view area beneath the active cell', () => {
    expect(hidden).toMatch(/position:\s*absolute/)
    expect(hidden).toMatch(/inset:\s*0/)
    expect(hidden).toMatch(/pointer-events:\s*none/)
    expect(hidden).toMatch(/z-index:\s*0/)
    expect(declarations('.kbn-detail-view-cell:not([hidden])')).toMatch(/z-index:\s*1/)
    expect(declarations('.kbn-detail-views')).toMatch(/position:\s*relative/)
    // The covering cell must be opaque, or the tabs beneath show through.
    expect(declarations('.kbn-detail-view-cell')).toMatch(/background:\s*#[0-9A-Fa-f]{6}\s*;/)
  })
})
