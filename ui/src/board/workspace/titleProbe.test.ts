// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const reads: string[] = []
const bodies = new Map<string, string>()
vi.mock('../FileViewerPanel.js', () => ({
  readThumbnailMetadata: vi.fn(async (src: string, _signal: AbortSignal, onSource: (source: Uint8Array) => void) => {
    reads.push(decodeURIComponent(src))
    if (src.includes('report.html')) onSource(new TextEncoder().encode('<title>The report</title>'))
    const body = [...bodies].find(([name]) => decodeURIComponent(src).includes(name))?.[1]
    if (body) onSource(new TextEncoder().encode(body))
  }),
}))
const watched = new Set<string>()
vi.mock('../LiveFileRefresh.js', () => ({ liveFileWatched: (url: string) => watched.has(decodeURIComponent(url)) }))
const { probeDocumentTitles, PROBE_RETRY_MS } = await import('./titleProbe.js')
const { declaredTitle } = await import('./DocumentTitles.js')
const { buildChannel } = await import('./documents.js')

describe('title probe', () => {
  it('peeks each titled document once, reports before PDFs before audio, and names the index', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const channel = buildChannel({ uid: 'probe', owner: 'probe-host', name: 'Probe', path: '/f.md', fiberDir: '/', body: '',
      embeds: [{ path: '/song.mp3' }, { path: '/plot.png' }, { path: '/paper.pdf' }, { path: '/report.html' }] })
    probeDocumentTitles('', channel.documents)
    probeDocumentTitles('', channel.documents)
    await vi.waitFor(() => expect(reads).toHaveLength(3))
    expect(reads.map(src => src.match(/\/(\w+\.\w+)/)?.[1])).toEqual(['report.html', 'paper.pdf', 'song.mp3'])
    expect(declaredTitle(channel.documents.find(d => d.name === 'report.html')!.key)?.title).toBe('The report')
    // The PDF and the song could not be read, so a render after the retry interval peeks them again; the report is done.
    probeDocumentTitles('', channel.documents)
    await Promise.resolve()
    expect(reads).toHaveLength(3)
    vi.advanceTimersByTime(PROBE_RETRY_MS)
    probeDocumentTitles('', channel.documents)
    await vi.waitFor(() => expect(reads).toHaveLength(5))
    vi.useRealTimers()
    expect(reads.slice(3).map(src => src.match(/\/(\w+\.\w+)/)?.[1])).toEqual(['paper.pdf', 'song.mp3'])
  })

  it('peeks a document again when its modification time or latest receipt moves', async () => {
    const reads0 = reads.length
    bodies.set('/replaced.html', '<title>First draft</title>')
    const build = (modifiedAt: string, sentAt: number) => buildChannel({ uid: 'replaced', owner: 'replaced-host', name: 'Replaced', path: '/f.md', fiberDir: '/', body: '',
      embeds: [{ path: '/replaced.html' }],
      sent: [{ path: '/replaced.html', owner: 'replaced-host', time: sentAt }],
      fileModifiedAt: new Map([['replaced-host:/replaced.html', modifiedAt]]),
    })
    const first = build('2026-10-05T10:00:00Z', 1000)
    const key = first.documents.find(d => d.name === 'replaced.html')!.key
    probeDocumentTitles('', first.documents)
    await vi.waitFor(() => expect(declaredTitle(key)?.title).toBe('First draft'))
    probeDocumentTitles('', build('2026-10-05T10:00:00Z', 1000).documents)
    await Promise.resolve()
    expect(reads.length - reads0).toBe(1)
    bodies.set('/replaced.html', '<title>Second draft</title>')
    probeDocumentTitles('', build('2026-10-05T11:00:00Z', 1000).documents)
    await vi.waitFor(() => expect(declaredTitle(key)?.title).toBe('Second draft'))
    expect(reads.length - reads0).toBe(2)
    // A fresh receipt alone (a re-send) is a new version too.
    bodies.set('/replaced.html', '<title>Third draft</title>')
    probeDocumentTitles('', build('2026-10-05T11:00:00Z', 2000).documents)
    await vi.waitFor(() => expect(declaredTitle(key)?.title).toBe('Third draft'))
    expect(reads.length - reads0).toBe(3)
  })

  it('leaves a report the stage is already reading to name itself, and keeps a peek when its file time first arrives', async () => {
    const reads0 = reads.length
    const build = (modifiedAt?: string) => buildChannel({ uid: 'mounted', owner: 'mounted-host', name: 'Mounted', path: '/f.md', fiberDir: '/', body: '',
      embeds: [{ path: '/mounted.html' }, { path: '/beside.html' }],
      ...(modifiedAt ? { fileModifiedAt: new Map([['mounted-host:/beside.html', modifiedAt]]) } : {}),
    })
    watched.add('/api/v1/file?path=/mounted.html&origin=mounted-host')
    probeDocumentTitles('', build().documents)
    await vi.waitFor(() => expect(reads.length - reads0).toBe(1))
    expect(reads.at(-1)).toContain('/beside.html')
    probeDocumentTitles('', build('2026-10-05T10:00:00Z').documents)
    await Promise.resolve(); await Promise.resolve()
    expect(reads.length - reads0).toBe(1)
  })
})
