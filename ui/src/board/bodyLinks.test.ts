// Relative links in a fiber body must resolve the way the images beside them do.
//
// `renderMarkdown` is pure string work and needs no DOM — `escapeHtml` is a
// regex escaper precisely so rendering stays testable headless. (It used to
// round-trip through `document.createElement`, and this file used to carry a
// fake-`document` shim to work around it. The shim is gone; the equivalence of
// the regex escaper to the DOM path was checked against a real browser.)

import { describe, expect, it } from 'vitest'
import { cacheBustUrl, fileInfoUrl, renderMarkdown } from './utils.js'

describe('live artifact URL helpers', () => {
  it('routes metadata probes through the owning daemon', () => {
    expect(fileInfoUrl('http://d:4000', '/tmp/a b.html', 'candide')).toBe(
      'http://d:4000/api/v1/file-info?path=%2Ftmp%2Fa%20b.html&origin=candide',
    )
  })

  it('replaces a prior cache-bust marker instead of growing the URL', () => {
    expect(cacheBustUrl('/api/v1/file?path=%2Fx&_shuttle_refresh=1', 42)).toBe(
      '/api/v1/file?path=%2Fx&_shuttle_refresh=42',
    )
  })
})

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

  it('offers the project dir as a SECOND candidate', () => {
    // The store's one real relative link: `[AGENTS.md](AGENTS.md)` in
    // ai-futures/felt/debug. Anchored to the fiber dir it 404s (verified against
    // the live daemon); the file it means is at the repo root the worker was
    // dispatched into, `shuttle.project_dir`. The markdown cannot say which, so
    // both ride out and the panel probes.
    const html = renderMarkdown('[AGENTS.md](AGENTS.md)', {
      basePath: '/home/ada/loom/.felt/ai-futures/felt/debug',
      originId: 'local',
      projectDir: '/home/ada/dev/felt',
    })
    expect(decodeURIComponent(/data-file-path="([^"]*)"/.exec(html)?.[1] ?? ''))
      .toBe('/home/ada/loom/.felt/ai-futures/felt/debug/AGENTS.md')
    expect(decodeURIComponent(/data-file-path-alt="([^"]*)"/.exec(html)?.[1] ?? ''))
      .toBe('/home/ada/dev/felt/AGENTS.md')
    expect(decodeURIComponent(/data-file-url-alt="([^"]*)"/.exec(html)?.[1] ?? ''))
      .toContain('/home/ada/dev/felt/AGENTS.md')
  })

  it('offers no alternate when there is nothing else it could mean', () => {
    // No project dir, or a project dir that IS the fiber dir — one candidate,
    // so the panel skips the probe entirely.
    expect(renderMarkdown('[a](notes.md)', opts)).not.toContain('data-file-path-alt')
    expect(renderMarkdown('[a](notes.md)', { ...opts, projectDir: opts.basePath }))
      .not.toContain('data-file-path-alt')
  })

  it('never offers an alternate for an external link', () => {
    const html = renderMarkdown('[t](https://arxiv.org/abs/1)', { ...opts, projectDir: '/repo' })
    expect(html).not.toContain('data-file-path-alt')
  })

  it('carries the origin for a remote-owned fiber', () => {
    const html = renderMarkdown('[a](notes.md)', { ...opts, originId: 'kelvin' })
    expect(hrefIn(html)).toContain('origin=kelvin')
  })
})
