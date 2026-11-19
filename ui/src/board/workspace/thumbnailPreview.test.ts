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
it('reuses previews by resource and etag, invalidates changed revisions, and bounds retention by bytes', () => {
  // Room for 11 characters: '<h1>B</h1>' and one of 'b' or 'c'.
  const cache = new ThumbnailPreviewCache(22)
  expect(cache.get('a', '<h1>A</h1>', '1')).toBe('<h1>A</h1>')
  expect(cache.get('a', 'not processed', '1')).toBe('<h1>A</h1>')
  expect(cache.get('a', '<h1>B</h1>', '2')).toBe('<h1>B</h1>')
  cache.get('b', 'b', '1'); cache.get('c', 'c', '1')
  expect(cache.get('a', 'evicted', '2')).toBe('evicted')
  expect(cache.get('a', 'unversioned')).toBe('unversioned')
  cache.get('weak', 'first', 'W/"stat-123"')
  expect(cache.get('weak', 'changed', 'W/"stat-123"')).toBe('changed')
})

it('keeps large embedded images whole for a larger preview, past the cut, and swaps them for placeholders in a thumbnail', () => {
  const cover = `data:image/png;base64,${'A'.repeat(66 * 1024)}`, roundel = `<svg viewBox="0 0 10 10">${'<circle r="1"/>'.repeat(4000)}</svg>`
  const page = `<head><style>h1{color:red}</style></head><body><h1>Almanac</h1><img src="${cover}"><div style="background:url('${cover}')"></div>${roundel}<p>${'x'.repeat(PREVIEW_LIMIT)}</p>`
  const kept = buildThumbnailPreview(page, true)
  expect([kept.includes(`<img src="${cover}">`), kept.includes(`url('${cover}')`), kept.includes(roundel), kept.includes('\u0000')]).toStrictEqual([true, true, true, false])
  const thumb = buildThumbnailPreview(page)
  expect([thumb.includes(cover), thumb.includes(roundel), thumb.length < PREVIEW_LIMIT + 1024]).toStrictEqual([false, false, true])
})

it('caches a thumbnail and a larger preview of one resource apart', () => {
  const cache = new ThumbnailPreviewCache()
  const page = `<body><img src="data:image/png;base64,${'A'.repeat(20 * 1024)}">`
  expect(cache.get('/a', page, '"v1"')).not.toBe(cache.get('/a', page, '"v1"', true))
  expect(cache.get('/a', page, '"v1"', true)).toContain('AAAA')
})

it('evicts by size, the least recently used first, and keeps nothing larger than its budget', () => {
  const cache = new ThumbnailPreviewCache(2 * 30)
  cache.get('a', 'a'.repeat(10), '1'); cache.get('b', 'b'.repeat(10), '1'); cache.get('c', 'c'.repeat(10), '1')
  // Read again, a is the most recently used; a larger d pushes out b, then c.
  expect(cache.get('a', 'stale', '1')).toBe('a'.repeat(10))
  cache.get('d', 'd'.repeat(20), '1')
  expect([cache.get('d', 'x', '1'), cache.get('a', 'x', '1'), cache.get('b', 'x', '1')]).toStrictEqual(['d'.repeat(20), 'a'.repeat(10), 'x'])
  expect(cache.get('huge', 'h'.repeat(40), '1')).toBe('h'.repeat(40))
  expect(cache.get('huge', 'again', '1')).toBe('again')
})

it('restores a large image kept inside a large SVG, leaving no token behind', () => {
  const image = `data:image/png;base64,${'A'.repeat(20 * 1024)}`
  const svg = `<svg viewBox="0 0 10 10"><image href="${image}"/>${'<circle r="1"/>'.repeat(1200)}</svg>`
  // Last in the page, its token ends the cut markup and is kept whole.
  const kept = buildThumbnailPreview(`<body><h1>Plot</h1>${svg}`, true)
  expect([kept.includes(svg), kept.includes('\u0000')]).toStrictEqual([true, false])
  // Cut through the middle of a token, the half token is dropped.
  const cutThrough = buildThumbnailPreview(`<body>${'x'.repeat(PREVIEW_LIMIT - 2)}${svg}`, true)
  expect([cutThrough.includes('\u0000'), cutThrough.includes('<svg')]).toStrictEqual([false, false])
})

it('loads only the first few images and embedded pages, past which an image draws the placeholder', () => {
  const figures = Array.from({ length: 6 }, (_, i) => `<figure><img src="f${i}.svg" srcset="f${i}@2x.svg 2x" loading="lazy"></figure>`).join('')
  const preview = buildThumbnailPreview(`<body>${figures}<iframe src="deck.html"></iframe><video src="v.mp4" poster="p.png"></video><input type="text" src="x"></body>`)
  expect(preview.match(/src="f\d\.svg"/g)).toEqual(['src="f0.svg"', 'src="f1.svg"', 'src="f2.svg"', 'src="f3.svg"'])
  expect(preview).not.toMatch(/f[45]|deck\.html|v\.mp4|p\.png/)
  expect(preview).toContain('<iframe src="about:blank">')
  expect(preview).toContain('<input type="text" src="x">')
  expect(preview.match(/<img\b/g)).toHaveLength(6)
})
