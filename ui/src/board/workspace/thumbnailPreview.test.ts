import { expect, it } from 'vitest'
import { buildThumbnailPreview, PREVIEW_LIMIT, ThumbnailPreviewCache } from './thumbnailPreview.js'

it('keeps page structure and small media but drops scripts and large embedded media', () => {
  const data = `data:image/svg+xml;base64,${'a'.repeat(20000)}`
  const source = `<head><style>.plot{background:url('${data}')}</style><script>${'x'.repeat(100000)}</script></head><body><h1>Report</h1><img width="500" height="200" src="${data}"><a href='${data}'>plot</a><img src=data:image/png;base64,${'b'.repeat(20000)}><svg viewBox="0 0 500 200">${'<path/>'.repeat(5000)}</svg><img src="data:image/png;base64,small"><script src="app.js"></script></body>`
  const result = buildThumbnailPreview(source)
  expect(result).toContain('<h1>Report</h1>')
  expect(result).toContain('width="500" height="200"')
  expect(result).toContain('viewBox="0 0 500 200"')
  expect(result).toContain('data:image/png;base64,small')
  expect(result).not.toContain('<script')
  expect(result).not.toContain('<path/>')
  expect(result).not.toContain('a'.repeat(100))
  expect(result).not.toContain('b'.repeat(100))
  expect(result.length).toBeLessThan(2000)
})
it('keeps a large embedded stylesheet as the style it carries, and drops one past the head budget', () => {
  const css = `h1{color:rebeccapurple}${'.x{margin:0}'.repeat(2000)}`
  const encoded = (text: string): string => btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join(''))
  const base64 = buildThumbnailPreview(`<head><link rel="stylesheet" media="screen" href="data:text/css;base64,${encoded(css)}"></head><body><h1>Report</h1>`)
  expect(base64).toContain(`<style media="screen">${css}</style>`)
  expect(base64).not.toContain('<link')
  expect(base64).not.toContain('data:image/svg+xml')
  const escaped = buildThumbnailPreview(`<head><link rel=stylesheet href='data:text/css,${encodeURIComponent(css)}'></head><body>`)
  expect(escaped).toContain(`<style>${css}</style>`)
  const huge = buildThumbnailPreview(`<head><link rel="stylesheet" href="data:text/css;base64,${encoded('p{}'.repeat(PREVIEW_LIMIT))}"><style>h1{color:red}</style></head><body><h1>Report</h1>`)
  expect(huge).not.toContain('<link')
  expect(huge).toContain('<style>h1{color:red}</style>')
  const small = '<link rel="stylesheet" href="data:text/css,h1%7Bcolor:red%7D">'
  expect(buildThumbnailPreview(small)).toBe(small)
})
it('caps the body while keeping the head and bounded output for fragments', () => {
  const head = '<head><style>h1{color:red}</style></head><body>'
  expect(buildThumbnailPreview(head + 'x'.repeat(PREVIEW_LIMIT * 4))).toHaveLength(head.length + PREVIEW_LIMIT)
  expect(buildThumbnailPreview('x'.repeat(PREVIEW_LIMIT * 4))).toHaveLength(PREVIEW_LIMIT)
  const largeHead = '<head><style>' + 'x'.repeat(PREVIEW_LIMIT * 4) + '</style><style>h1{color:red}</style></head><body><h1>Visible report</h1>'
  const preview = buildThumbnailPreview(largeHead)
  expect(preview).toContain('<body><h1>Visible report</h1>')
  expect(preview).toContain('<style>h1{color:red}</style>')
  expect(preview.length).toBeLessThan(PREVIEW_LIMIT * 2)
})
it('reuses previews by resource and etag, invalidates changed revisions, and bounds retention', () => {
  const cache = new ThumbnailPreviewCache(2)
  expect(cache.get('a', '<h1>A</h1>', '1')).toBe('<h1>A</h1>')
  expect(cache.get('a', 'not processed', '1')).toBe('<h1>A</h1>')
  expect(cache.get('a', '<h1>B</h1>', '2')).toBe('<h1>B</h1>')
  cache.get('b', 'b', '1'); cache.get('c', 'c', '1')
  expect(cache.get('a', 'evicted', '2')).toBe('evicted')
  expect(cache.get('a', 'unversioned')).toBe('unversioned')
  cache.get('weak', 'first', 'W/"stat-123"')
  expect(cache.get('weak', 'changed', 'W/"stat-123"')).toBe('changed')
})
