// Relative links in a fiber body must resolve the way the images beside them do.
//
// SEPARATE FILE because `renderMarkdown` reaches for a DOM: `escapeHtml` escapes
// by round-tripping through `document.createElement('div').textContent`. There
// is no jsdom in this project and no vitest environment configured, so the shim
// below stands in — faithful to the real thing in the one way that matters
// here: textContent→innerHTML escapes `&`, `<` and `>` and deliberately does
// NOT escape quotes, which is exactly why `escapeAttr` exists alongside it.
// Vitest isolates per file, so the shim cannot leak into the pure-logic suites.

import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(() => {
  if (typeof globalThis.document !== 'undefined') return
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      let html = ''
      return {
        set textContent(value: string) {
          html = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        },
        get innerHTML() {
          return html
        },
      }
    },
  }
})

const { renderMarkdown } = await import('./utils.js')

describe('relative links in a fiber body', () => {
  const opts = { basePath: '/home/ada/loom/.felt/proj', originId: 'local' }
  const hrefIn = (html: string): string => /href="([^"]*)"/.exec(html)?.[1] ?? ''

  it('resolves a sibling file through the owner-routed /file route', () => {
    // The defect: this rendered `href="AGENTS.md"`, which the browser resolved
    // against the page origin — localhost:4000/AGENTS.md, a 404.
    const html = renderMarkdown('[AGENTS.md](AGENTS.md)', opts)
    const href = hrefIn(html)
    expect(href).toContain('/api/v1/file?path=')
    expect(decodeURIComponent(href)).toContain('/home/ada/loom/.felt/proj/AGENTS.md')
    expect(html).toContain('data-file-path=')
  })

  it('resolves the same way the IMAGE beside it does', () => {
    // The two disagreeing was the whole bug: one renderer was overridden per
    // call and the other inherited the global.
    const link = hrefIn(renderMarkdown('[p](fig/plot.png)', opts))
    const img = /src="([^"]*)"/.exec(renderMarkdown('![p](fig/plot.png)', opts))?.[1] ?? ''
    expect(link).toBe(img)
  })

  it('leaves external and in-page links exactly alone', () => {
    for (const href of ['https://arxiv.org/abs/2401.00001', 'http://x.test/a', 'mailto:a@b.test', '#section']) {
      const html = renderMarkdown(`[t](${href})`, opts)
      expect(hrefIn(html)).toBe(href)
      expect(html).not.toContain('data-file-path')
    }
  })

  it('leaves a relative link alone when there is no base to resolve against', () => {
    // A fiber whose dir the daemon could not resolve: an unrewritten href beats
    // a confidently wrong one.
    expect(hrefIn(renderMarkdown('[a](AGENTS.md)'))).toBe('AGENTS.md')
  })

  it('carries the origin for a remote-owned fiber', () => {
    const html = renderMarkdown('[a](notes.md)', { ...opts, originId: 'candide' })
    expect(hrefIn(html)).toContain('origin=candide')
  })
})
