import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './utils.js'

describe('untrusted markdown', () => {
  it('escapes raw block and inline HTML', () => {
    const block = renderMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>', { untrusted: true })
    const inline = renderMarkdown('before <b>bold</b> after', { untrusted: true })

    expect(block).not.toContain('<img')
    expect(block).not.toContain('<script>')
    expect(block).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(block).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(inline).toContain('before &lt;b&gt;bold&lt;/b&gt; after')
  })

  it('drops unsafe links and keeps only explicitly safe destinations', () => {
    const html = renderMarkdown(
      '[unsafe](javascript:alert(1)) [web](https://example.test) [mail](mailto:a@example.test) [section](#part)',
      { untrusted: true },
    )

    expect(html).not.toContain('javascript:')
    expect(html).toContain('<p>unsafe ')
    expect(html).toContain('href="https://example.test"')
    expect(html).toContain('href="mailto:a@example.test"')
    expect(html).toContain('href="#part"')
  })

  it('renders images as escaped alt text rather than image elements', () => {
    const html = renderMarkdown('![map <b>detail</b>](https://example.test/map.png)', { untrusted: true })

    expect(html).not.toContain('<img')
    expect(html).toContain('[image: map detail]')
  })

  it('leaves existing callers on the trusted rendering path', () => {
    expect(renderMarkdown('<b>trusted</b>')).toContain('<b>trusted</b>')
    expect(renderMarkdown('![map](https://example.test/map.png)')).toContain('<img')
  })
})
