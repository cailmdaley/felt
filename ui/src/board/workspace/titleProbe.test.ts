// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

const reads: string[] = []
vi.mock('../FileViewerPanel.js', () => ({
  readThumbnailMetadata: vi.fn(async (src: string, _signal: AbortSignal, onSource: (source: Uint8Array) => void) => {
    reads.push(decodeURIComponent(src))
    if (src.includes('report.html')) onSource(new TextEncoder().encode('<title>The report</title>'))
  }),
}))
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
})
