// `[[wikilinks]]` in a fiber body: what they render as, and what they resolve
// to. Both halves are pure — the renderer is string work (bodyLinks.test.ts
// explains why that matters) and the resolver takes its index as an argument —
// so neither needs a DOM or a daemon.

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './utils.js'
import { resolveWikilink, type FiberIndexEntry } from './wikilinks.js'

/** The reading surface's option — see renderMarkdown's `wikilinks`. */
const ON = { wikilinks: true }

const anchorIn = (html: string): string => /<a class="kbn-wikilink"[^>]*>[^<]*<\/a>/.exec(html)?.[0] ?? ''
const attr = (html: string, name: string): string =>
  new RegExp(`${name}="([^"]*)"`).exec(html)?.[1] ?? ''

describe('rendering a wikilink', () => {
  it('emits an inert anchor carrying the target and the source text', () => {
    // Inert by construction: renderMarkdown has no fiber index, so it cannot
    // know what resolves. `data-wikilink-raw` is what lets installWikilinks put
    // an unresolvable one back exactly as written.
    const a = anchorIn(renderMarkdown('see [[ai-futures/felt/debug]] for more', ON))
    expect(attr(a, 'data-fiber')).toBe('ai-futures/felt/debug')
    expect(attr(a, 'data-wikilink-raw')).toBe('[[ai-futures/felt/debug]]')
    expect(a).toContain('>ai-futures/felt/debug</a>')
    expect(a).not.toContain('href')
  })

  it('shows the label of a [[target|label]] and keeps the target', () => {
    const a = anchorIn(renderMarkdown('[[science/unions/shear_2d|the shear paper]]', ON))
    expect(attr(a, 'data-fiber')).toBe('science/unions/shear_2d')
    expect(a).toContain('>the shear paper</a>')
  })

  it('leaves an ordinary markdown link alone', () => {
    expect(renderMarkdown('[a](https://x.test)', ON)).not.toContain('kbn-wikilink')
  })

  it('leaves a lone bracket pair alone', () => {
    // `[[` that never closes is prose, not a reference.
    expect(renderMarkdown('an array of arrays: [[1, 2', ON)).not.toContain('kbn-wikilink')
  })

  it('escapes a target that tries to break out of the attribute', () => {
    // The quote must survive as an entity inside the attribute, never as a
    // quote that ends it and opens a handler.
    const html = renderMarkdown('[[a" onclick="alert(1)]]', ON)
    // (The `onclick=` text below is INSIDE the escaped attribute value, which
    // is the point — it never becomes an attribute of its own.)
    expect(html).toContain('<a class="kbn-wikilink" data-fiber="a&quot; onclick=&quot;alert(1)"')
  })
})

describe('a surface that does not opt in', () => {
  it('leaves the reference as the literal text it was written as', () => {
    // The board grid's card outcomes and Day's prose blocks never run the
    // resolver, so they must not strip the brackets and imply a link.
    expect(renderMarkdown('see [[ai-futures/felt/debug]]'))
      .toContain('see [[ai-futures/felt/debug]]')
  })
})

describe('resolving a wikilink against the fiber index', () => {
  const index: FiberIndexEntry[] = [
    { id: 'ai-futures', name: 'AI futures' },
    { id: 'ai-futures/forth-crete-tutorial', name: 'FORTH Crete tutorial' },
    { id: 'science/unions/shear_2d', name: 'Shear 2D' },
    { id: 'work/euclid/euclid-github/triage', name: 'Triage the Euclid backlog' },
    { id: 'loom/email/triage', name: 'Morning mail triage' },
  ]

  it('takes an exact id', () => {
    expect(resolveWikilink('ai-futures/forth-crete-tutorial', index))
      .toBe('ai-futures/forth-crete-tutorial')
  })

  it('takes a unique trailing segment, which is how a body names a sibling', () => {
    expect(resolveWikilink('shear_2d', index)).toBe('science/unions/shear_2d')
  })

  it('takes a unique exact name for a body that cites a fiber by title', () => {
    expect(resolveWikilink('FORTH Crete tutorial', index))
      .toBe('ai-futures/forth-crete-tutorial')
  })

  it('refuses an ambiguous segment rather than guessing', () => {
    // Two fibers end in `/triage`. Sending the reader to the wrong one is worse
    // than leaving the text inert, so the reference stays literal.
    expect(resolveWikilink('triage', index)).toBeNull()
  })

  it('resolves nothing for a target no fiber carries', () => {
    expect(resolveWikilink('not/a/fiber', index)).toBeNull()
    expect(resolveWikilink('', index)).toBeNull()
  })

  it('tolerates stray slashes and case', () => {
    expect(resolveWikilink('/AI-Futures/', index)).toBe('ai-futures')
  })
})
