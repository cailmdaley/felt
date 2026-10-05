// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { cacheDocumentTitle, extractDocumentTitle, watchDocumentTitles } from './DocumentTitles.js'
import { buildChannel, documentLabels, documentLabelMetadata } from './documents.js'

it('extracts HTML title, H1 fallback and markdown heading without executing markup', () => {
  expect(extractDocumentTitle('/report.html', '<title>Declared &amp; useful</title><h1>Fallback</h1><script>throw 1</script><p>First lines</p>')).toEqual({ title: 'Declared & useful', preview: 'FallbackFirst lines' })
  expect(extractDocumentTitle('/report.html', '<h1>Actual heading</h1>').title).toBe('Actual heading')
  expect(extractDocumentTitle('/note.md', '# A useful note\n\nBody').title).toBe('A useful note')
  expect(extractDocumentTitle('/code.py', '# a comment').title).toBeUndefined()
})
it('reads uncompressed PDF Title and cheap ID3/Vorbis title tags', () => {
  expect(extractDocumentTitle('/score.pdf', new TextEncoder().encode('%PDF /Title (Wayfaring \\(Stranger\\))')).title).toBe('Wayfaring (Stranger)')
  const title = new TextEncoder().encode('Declared song')
  const bytes = new Uint8Array(21 + title.length)
  bytes.set(new TextEncoder().encode('ID3')); bytes[3] = 3
  bytes.set(new TextEncoder().encode('TIT2'), 10); bytes[17] = title.length + 1; bytes[20] = 3; bytes.set(title, 21)
  expect(extractDocumentTitle('/song.mp3', bytes).title).toBe('Declared song')
  const field = new TextEncoder().encode('TITLE=Vorbis song')
  const vorbis = new Uint8Array(field.length + 4); vorbis[0] = field.length; vorbis.set(field, 4)
  expect(extractDocumentTitle('/song.ogg', vorbis).title).toBe('Vorbis song')
})
it('caches each document and ETag; tabs, frames and filename collision fallbacks share naming', () => {
  const key = 'titles:/report.html'
  let notifications = 0
  const stop = watchDocumentTitles(() => notifications++)
  const first = cacheDocumentTitle(key, '/report.html', '<title>Own report title</title>', 'a')
  expect(cacheDocumentTitle(key, '/report.html', '<title>Not parsed twice</title>', 'a')).toBe(first)
  expect(notifications).toBe(1)
  const channel = buildChannel({ uid: 'u', owner: 'titles', name: 'Note', path: '/note.md', fiberDir: '/', body: '', embeds: [{ path: '/report.html', title: 'Embed title' }] })
  expect(channel.labels[1]).toBe('Own report title')
  expect(documentLabelMetadata(channel.documents[1], channel.labels[1], 'titles').title).toBe('Own report title')
  const fallback = buildChannel({ uid: 'v', owner: 'titles', name: 'Note', path: '/note.md', fiberDir: '/', body: '', embeds: [{ path: '/one/result.txt' }, { path: '/two/result.txt' }] })
  expect(documentLabels(fallback.documents)).toEqual(['Note', 'one/result.txt', 'two/result.txt'])
  stop()
})
