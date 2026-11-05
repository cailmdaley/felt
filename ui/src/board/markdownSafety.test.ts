// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { loadMath } from './mathDollars.js'
import { renderMarkdown } from './utils.js'

// Review-2's xss.mjs probes: labels bypass renderer.html, and marked's
// code/pre/kbd state can pass subsequent markup through as escaped text.
// Keep the routes, not just one spelling of the original event handler.
const CORPUS = [
  ['link label image', '[<img src=x onerror="alert(1)">](https://example.com)'],
  ['unsafe link label', '[<img src=x onerror="alert(1)">](javascript:1)'],
  ['reference label', '[<img src=x onerror="alert(1)">][a]\n\n[a]: https://example.com'],
  ['post-code', 'before <code>inside <img src=x onerror="alert(1)">'],
  ['post-pre', 'before <pre>inside <img src=x onerror="alert(1)">\n\ntext'],
  ['post-kbd', '<kbd>a <svg onload="alert(1)">'],
  ['unclosed post-code', '<code><img src=x onerror="alert(1)" '],
  ['unclosed post-pre', 'x <pre> <img src=x onerror="alert(1)" \n\ntext'],
  ['unclosed post-kbd', '<kbd>a <svg onload="alert(1)" '],
  ['autolink attribute', '<http://x"onmouseover="alert(1)>'],
  ['fence language attribute', '```js"onmouseover="alert(1) extra\ncode\n```'],
  ['fence language tag', '```<img/src=x/onerror=alert(1)>\ncode\n```'],
  ['image alt and destination', '![a" onerror="alert(1)](https://example.com/a.png)'],
  ['nested image link', '[![<img src=x onerror=alert(1)>](https://x/y.png)](https://e)'],
  ['nested strong label', '[**<svg onload="alert(1)">**](https://e)'],
  ['table', '| a |\n|:-|\n| <img src=x onerror="alert(1)"> |'],
  ['heading', '# <img src=x onerror="alert(1)">'],
  ['task list', '1. [ ] <img src=x onerror="alert(1)">'],
  ['entities', '&lt;img src=x onerror=alert(1)&gt;'],
  ['link title', '[a](https://x "t\\"onmouseover=\\"alert(1)")'],
  ['SVG script', '<svg><script>alert(1)</script><a xlink:href="javascript:alert(1)">x</a></svg>'],
  ['nested namespaces', '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">'],
  ['javascript destination', '[x](javascript:alert(1))'],
  ['encoded javascript', '[x](jav&#x61;script:alert(1))'],
  ['control-character javascript', '<a href="java&#x09;script:alert(1)">x</a>'],
  ['data link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
  ['data image', '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj4=)'],
  ['raw data image', '<img src="data:image/png;base64,eA==" onerror="alert(1)">'],
  ['raw script', '<script>alert(1)</script>'],
  ['embedded document', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['form', '<form action="/api/v1/dispatch"><button>dispatch</button></form>'],
  ['attribute breakout', '[x](https://x.test/\"onmouseover=\"alert%281%29)'],
  ['clobbering', '<a id="location" name="location" data-arbitrary="x">x</a>'],
  ['math commands', '$\\href{javascript:alert(1)}{x}$ $$\\htmlData{a=b}{x}$$'],
] as const

function renderDOM(source: string, opts?: Parameters<typeof renderMarkdown>[1]): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = renderMarkdown(source, opts)
  return root
}

function expectSafeDOM(root: HTMLElement, untrusted: boolean): void {
  expect(root.querySelectorAll('script, svg, math, iframe, object, embed, form, button, style, link, meta, base')).toHaveLength(0)
  if (untrusted) expect(root.querySelectorAll('img')).toHaveLength(0)
  for (const node of root.querySelectorAll('*')) {
    expect(node.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    for (const attr of node.attributes) {
      expect(attr.name).not.toMatch(/^on/i)
      expect(['srcdoc', 'id', 'name', 'data-arbitrary']).not.toContain(attr.name)
      if (attr.name === 'href' || attr.name === 'src') {
        expect(['http:', 'https:', 'mailto:']).toContain(new URL(attr.value, 'https://board.invalid/').protocol)
      }
    }
    if (node instanceof HTMLInputElement) {
      expect(node.type).toBe('checkbox')
      expect(node.disabled).toBe(true)
    }
  }
}

const MODES: { name: string; opts?: Parameters<typeof renderMarkdown>[1] }[] = [
  { name: 'default consumers', opts: undefined },
  { name: 'transcripts and stories', opts: { untrusted: true } },
  { name: 'owner-routed fiber body', opts: { basePath: '/fibers/example', projectDir: '/repo', wikilinks: true } },
  { name: 'untrusted with base path', opts: { basePath: '/fibers/example', untrusted: true } },
]

describe('Markdown final DOM boundary', () => {
  beforeAll(loadMath)

  for (const mode of MODES) {
    describe(mode.name, () => {
      it.each(CORPUS)('sanitizes %s', (_name, source) => {
        expectSafeDOM(renderDOM(source, mode.opts), mode.opts?.untrusted === true)
      })

      it('sanitizes the combined hostile corpus after browser reparsing', () => {
        const first = renderDOM(CORPUS.map(([, source]) => source).join('\n\n'), mode.opts)
        const reparsed = document.createElement('div')
        reparsed.innerHTML = first.innerHTML
        expectSafeDOM(reparsed, mode.opts?.untrusted === true)
      })

      it('preserves useful Markdown structure, links, and literal code', () => {
        const root = renderDOM('# Heading\n\n**bold** *italic* ~~deleted~~ [web](https://example.test) [mail](mailto:a@example.test) [section](#part)\n\n`<img onerror=alert(1)>`\n\n```js\nconst x = "<svg onload=alert(1)>"\n```\n\n> quote\n\n- item\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done', mode.opts)
        expect(root.querySelector('h1')?.textContent).toBe('Heading')
        expect(root.querySelector('strong')?.textContent).toBe('bold')
        expect(root.querySelector('em')?.textContent).toBe('italic')
        expect(root.querySelector('del')?.textContent).toBe('deleted')
        expect(root.querySelector('a[href="https://example.test"]')?.textContent).toBe('web')
        expect(root.querySelector('a[href="mailto:a@example.test"]')).not.toBeNull()
        expect(root.querySelector('a[href="#part"]')).not.toBeNull()
        expect(root.querySelector('code.md-inline-code')?.textContent).toBe('<img onerror=alert(1)>')
        expect(root.querySelector('pre code.language-js')?.textContent).toBe('const x = "<svg onload=alert(1)>"')
        expect(root.querySelector('blockquote')?.textContent).toContain('quote')
        expect(root.querySelector('ul li')?.textContent).toBe('item')
        expect(root.querySelectorAll('table td')).toHaveLength(2)
        expect(root.querySelector('input:checked:disabled')).not.toBeNull()
        expectSafeDOM(root, mode.opts?.untrusted === true)
      })
    })
  }

  it('keeps owner-routing and wikilink metadata, without allowing arbitrary data attributes', () => {
    const root = renderDOM('[file](notes.md) [[project/target|Target]] ![map](plot.png)', {
      basePath: '/fibers/example', projectDir: '/repo', originId: 'worker', wikilinks: true,
    })
    const file = root.querySelector('a.md-link-file')!
    expect(file.getAttribute('data-file-path')).toBe('/fibers/example/notes.md')
    expect(file.getAttribute('data-file-path-alt')).toBe('/repo/notes.md')
    expect(file.getAttribute('data-file-url-alt')).toContain('origin=worker')
    expect(root.querySelector('.kbn-wikilink')?.getAttribute('data-fiber')).toBe('project/target')
    expect(root.querySelector('.kbn-wikilink')?.getAttribute('data-wikilink-raw')).toBe('[[project/target|Target]]')
    expect(root.querySelector('img')?.getAttribute('src')).toContain('/api/v1/file?path=')
  })

  it('preserves KaTeX HTML formatting', () => {
    const root = renderDOM('$\\frac{1}{2}$ and $$E=mc^2$$')
    expect(root.querySelectorAll('.katex')).toHaveLength(2)
    expect(root.querySelector('.katex-display')).not.toBeNull()
    expect(root.querySelector('.katex .vlist [style]')).not.toBeNull()
    expectSafeDOM(root, false)
  })
})
