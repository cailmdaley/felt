// A sent markdown file's images and relative links resolve against the file's
// own directory on the host that owns it, through the owner-routed /file route.
//
// The defect: the sent-file viewer rendered `.md` with bare `renderMarkdown`,
// so `![](fig.png)` became `<img src="fig.png">`, which the browser resolved
// against the board origin (localhost:4000/fig.png) — a 404 for every figure
// beside every sent report.

import { describe, expect, it, vi } from 'vitest'

let deliver: ((text: string) => void) | null = null
vi.mock('./LiveFileRefresh.js', () => ({
  watchLiveFile: (_src: string, onText: (text: string) => void) => {
    deliver = onText
    return () => {}
  },
}))

import { buildFileViewer, sentMarkdownOptions } from './FileViewerPanel.js'
import { dirname, renderMarkdown } from './utils.js'

const srcIn = (html: string): string => /src="([^"]*)"/.exec(html)?.[1] ?? ''
const hrefIn = (html: string): string => /href="([^"]*)"/.exec(html)?.[1] ?? ''
const pathParam = (url: string): string | null =>
  new URL(url.replace(/&amp;/g, '&'), 'http://board.test').searchParams.get('path')
const originParam = (url: string): string | null =>
  new URL(url.replace(/&amp;/g, '&'), 'http://board.test').searchParams.get('origin')

describe('dirname', () => {
  it('returns the containing directory of an absolute path', () => {
    expect(dirname('/a/b/report.md')).toBe('/a/b')
    expect(dirname('/report.md')).toBe('/')
  })
})

describe('images in a sent markdown file', () => {
  const opts = sentMarkdownOptions('/leonardo/work/run/report.md', 'leonardo')

  it('resolves a sibling image against the file directory on the owning host', () => {
    const src = srcIn(renderMarkdown('![fig](fig.png)', opts))
    expect(src.startsWith('/api/v1/file?path=')).toBe(true)
    expect(pathParam(src)).toBe('/leonardo/work/run/fig.png')
    expect(originParam(src)).toBe('leonardo')
  })

  it('folds ./ and ../ segments into the path the daemon is asked for', () => {
    expect(pathParam(srcIn(renderMarkdown('![a](./figs/a.png)', opts)))).toBe(
      '/leonardo/work/run/figs/a.png',
    )
    expect(pathParam(srcIn(renderMarkdown('![b](../plots/b.png)', opts)))).toBe(
      '/leonardo/work/plots/b.png',
    )
  })

  it('routes an absolute path on the owning host through the same route', () => {
    const src = srcIn(renderMarkdown('![c](/scratch/c.png)', opts))
    expect(pathParam(src)).toBe('/scratch/c.png')
    expect(originParam(src)).toBe('leonardo')
  })

  it('leaves http(s) and data: images exactly alone', () => {
    for (const href of ['https://x.test/a.png', 'http://x.test/b.png', 'data:image/png;base64,iVBORw0KGgo=']) {
      expect(srcIn(renderMarkdown(`![x](${href})`, opts))).toBe(href)
    }
  })

  it('omits origin for a locally owned file', () => {
    const src = srcIn(renderMarkdown('![fig](fig.png)', sentMarkdownOptions('/home/a/r.md', 'local')))
    expect(pathParam(src)).toBe('/home/a/fig.png')
    expect(originParam(src)).toBeNull()
  })

  it('resolves a relative link the same way as the image beside it', () => {
    expect(pathParam(hrefIn(renderMarkdown('[notes](notes.md)', opts)))).toBe(
      '/leonardo/work/run/notes.md',
    )
  })
})

describe('the sent-file viewer', () => {
  it('renders a .md deliverable with its images resolved against its directory', () => {
    const made: Array<Record<string, unknown>> = []
    const fakeDocument = {
      createElement: () => {
        const el: Record<string, unknown> = {
          className: '',
          innerHTML: '',
          scrollTop: 0,
          textContent: '',
          classList: { add: () => {} },
          append: () => {},
          remove: () => {},
        }
        made.push(el)
        return el
      },
    }
    vi.stubGlobal('document', fakeDocument)
    try {
      buildFileViewer('', '/leonardo/work/run/report.md', 'leonardo')
      expect(deliver).not.toBeNull()
      deliver!('# Result\n\n![fig](fig.png)\n')
      const pane = made.find((el) => el.className === 'kbn-fileview-text')
      const src = srcIn(String(pane?.innerHTML ?? ''))
      expect(pathParam(src)).toBe('/leonardo/work/run/fig.png')
      expect(originParam(src)).toBe('leonardo')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
