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

  describe('strict untrusted allowlist', () => {
    const label = (html: string): string => `[${html}](https://ok.test/)`
    const STRICT_CORPUS = [
      label('<div style="position:absolute;top:0;background:url(https://evil.test/a.png)" class="change-diff-window" id="root" title="t">painted</div>'),
      `before <code>x <span style="background-image:url('https://evil.test/b.png')" data-tex="x" class="math-pending kbn-wikilink">y</span>`,
      label('<a href="https://evil.test/opener" target="_self" rel="opener" class="md-link-file" data-file-path="/etc/passwd">read</a>'),
      label('<details open><summary>s</summary><img src="https://evil.test/c.png"></details>'),
      label('<a href="/api/v1/dispatch">relative</a>'),
      label('<input type="text" autofocus value="x"><kbd>k</kbd><sub>s</sub>'),
      '$\\smash{\\raisebox{-20em}{\\colorbox{#e1f4e4}{\\texttt{return u.Admin}}}}$',
      '$$\n\\rule{2000px}{20px}\n$$',
    ].join('\n\n')
    const TAGS = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'])
    const ATTRS: Record<string, string[]> = { A: ['class', 'href', 'rel', 'target'], INPUT: ['checked', 'disabled', 'type'], CODE: ['class'], PRE: ['class'], OL: ['start'], TD: ['align'], TH: ['align'] }

    it('keeps only tags and attributes Markdown produces', () => {
      const root = renderDOM(`${STRICT_CORPUS}\n\n3. item\n\n| a |\n|:-|\n| b |\n\n- [x] done\n\n\`\`\`js\nx\n\`\`\``, { untrusted: true })
      for (const node of root.querySelectorAll('*')) {
        if (node.closest('.math-box')) continue
        expect(TAGS).toContain(node.tagName)
        for (const attr of node.attributes) expect(ATTRS[node.tagName] ?? []).toContain(attr.name)
        for (const name of node.classList) expect(name).toMatch(/^(md-link|md-inline-code|md-code-block|language-js)$/)
      }
      expect(root.textContent).toContain('painted')
      expect(root.querySelector('ol')?.getAttribute('start')).toBe('3')
      expect(root.querySelector('td')?.getAttribute('align')).toBe('left')
      expect(root.querySelector('a[href^="/"]')).toBeNull()
    })

    it('forces safe link targets over anything the author wrote, in every mode', () => {
      for (const opts of [{ untrusted: true }, undefined]) {
        const links = [...renderDOM(label('<a href="https://evil.test/x" target="_self" rel="opener">x</a>'), opts).querySelectorAll('a[href]')]
        expect(links.length).toBeGreaterThan(0)
        for (const link of links) {
          expect(link.getAttribute('rel')).toBe('noopener noreferrer')
          expect(link.getAttribute('target')).toBe('_blank')
        }
      }
    })

    it('typesets math only inside its box', () => {
      const root = renderDOM('$C_\\ell$ then\n\n$$\n\\frac{1}{2}\n$$\n\n$\\smash{\\raisebox{-20em}{\\colorbox{#fff}{x}}}$ $\\rule{5em}{5em}$ $\\kern-500em x$', { untrusted: true })
      expect(root.querySelectorAll('.math-box')).toHaveLength(4 + 1)
      expect(root.querySelectorAll('.math-box-display .katex-display')).toHaveLength(1)
      expect(root.querySelector('.math-pending')).toBeNull()
      for (const node of root.querySelectorAll('.katex, [style]')) expect(node.closest('.math-box')).not.toBeNull()
    })

    it('forges nothing through a hand-written placeholder', () => {
      const root = renderDOM(label('<span class="math-pending kbn-wikilink" style="position:fixed" title="t" href="https://evil.test" data-tex="y" data-file-path="/etc/passwd">z</span><span class="kbn-wikilink" data-tex="n">plain</span><b class="math-pending" data-tex="b">bold</b>'), { untrusted: true })
      expect(root.querySelectorAll('.math-box')).toHaveLength(1)
      expect(root.querySelector('.math-box')?.textContent).toBe('y')
      expect(root.innerHTML).not.toMatch(/position:fixed|evil\.test|etc\/passwd|kbn-wikilink|data-tex/)
      expect(root.textContent).toContain('plain')
    })

    const ACTIVE = [
      '\\href{https://evil.test}{x}', '\\href{javascript:alert(1)}{x}', '\\url{https://evil.test}',
      '\\includegraphics{https://evil.test/a.png}', '\\htmlClass{change-diff-window}{x}', '\\htmlId{root}{x}',
      '\\htmlStyle{position:fixed}{x}', '\\htmlData{fiber=x}{x}',
    ]
    for (const opts of [{ untrusted: true }, undefined]) {
      it.each(ACTIVE)(`makes %s inert with ${opts ? 'untrusted' : 'trusted'} text`, tex => {
        const box = renderDOM(`$${tex}$`, opts).querySelector('.math-box')!
        expect(box.querySelectorAll('a, img, [href], [src], [id], .change-diff-window')).toHaveLength(0)
        for (const node of box.querySelectorAll('*')) {
          expect([...node.attributes].map(attr => attr.name).filter(name => name.startsWith('data-'))).toEqual([])
          expect(node.getAttribute('style') ?? '').not.toContain('position')
        }
      })
    }

    it('caps sizes and macro expansion', () => {
      expect(renderMarkdown('$\\rule{2000em}{2000em}$', { untrusted: true })).toContain('border-right-width:20em')
      const bomb = `$\\def\\a{\\b\\b}\\def\\b{\\c\\c}\\def\\c{\\d\\d}\\def\\d{\\e\\e}\\def\\e{\\f\\f}\\def\\f{\\g\\g}\\def\\g{xxxxxxxx}${'\\a'.repeat(16)}$`
      expect(renderDOM(bomb, { untrusted: true }).querySelector('.math-box .katex-error')?.getAttribute('title')).toContain('Too many expansions')
    })

    it('keeps the source of a formula KaTeX cannot finish', () => {
      const tex = `${'{'.repeat(50_000)}x${'}'.repeat(50_000)}`
      for (const opts of [{ untrusted: true }, undefined]) {
        const root = renderDOM(`before $${tex}$ after`, opts)
        expect(root.querySelector('.math-box')).toBeNull()
        expect(root.textContent).toContain('before')
        expect(root.textContent).toContain(tex)
      }
    })

    it('typesets TeX that DOMPurify would read as a URL', () => {
      for (const opts of [{ untrusted: true }, undefined]) {
        expect(renderDOM('$f:X\\to Y$ and $a<b$', opts).querySelectorAll('.math-box')).toHaveLength(2)
      }
    })

    it('keeps the source readable where the sanitizer drops data-tex', () => {
      for (const opts of [{ untrusted: true }, undefined]) {
        const root = renderDOM('$[x]>0$ and $a-->b$', opts)
        expect(root.querySelector('.math-box')).toBeNull()
        expect(root.textContent).toContain('$[x]>0$ and $a-->b$')
      }
    })

    it('does not leak the strict mode into a following trusted render', () => {
      renderDOM('x', { untrusted: true })
      const root = renderDOM('<div style="color: red" class="note">x</div>\n\n![a](https://example.test/a.png)')
      expect(root.querySelector('div.note')?.getAttribute('style')).toBe('color: red')
      expect(root.querySelector('img')).not.toBeNull()
    })
  })

  it('preserves KaTeX HTML formatting', () => {
    const root = renderDOM('$\\frac{1}{2}$ and $$E=mc^2$$')
    expect(root.querySelectorAll('.katex')).toHaveLength(2)
    expect(root.querySelector('.katex-display')).not.toBeNull()
    expect(root.querySelector('.katex .vlist [style]')).not.toBeNull()
    expectSafeDOM(root, false)
  })
})
