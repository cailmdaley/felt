// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// Exercise the real shared watcher, renderer and host; only the transport/clock
// are controlled. Recovery must clear the failure surface without repainting.
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('unchanged file recovery', () => {
  it.each([
    ['html', 304], ['html', 200], ['text', 304], ['text', 200],
  ] as const)('clears a stale %s viewer after error → %s without repainting', async (kind, status) => {
    vi.resetModules()
    vi.useFakeTimers()
    const body = kind === 'html' ? '<h1>Report</h1>' : 'Reading position'
    const etag = 'W/"sha256-' + 'a'.repeat(64) + '"'
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(new Response(body, { headers: { etag } }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response(status === 304 ? null : body, { status, headers: { etag } }))
    vi.stubGlobal('fetch', fetchFile)
    const { DocumentHost } = await import('./workspace/DocumentHost.js')
    const track = document.createElement('div')
    document.body.append(track)
    const host = new DocumentHost(track, {
      shuttleBase: '', buildProse: () => document.createElement('div'), onSelect: vi.fn(),
    })
    try {
      const doc = { key: 'host-a:/report', owner: 'host-a', path: kind === 'html' ? '/report.html' : '/report.txt', name: 'Report', kind, provenance: [] }
      host.setChannel([doc], doc.key)
      await vi.advanceTimersByTimeAsync(0)
      const frame = host.get(doc.key)!
      const viewer = frame.viewer!
      const iframe = viewer.querySelector('iframe')
      if (iframe) {
        const { envelope } = await import('./workspace/DocumentBridge.js')
        window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: envelope('ready') }))
        await vi.advanceTimersByTimeAsync(0)
      }
      const contentNode = iframe ?? viewer.querySelector('pre')!
      const srcdoc = iframe?.srcdoc
      viewer.scrollTop = 135
      const changes = new MutationObserver(() => {})
      changes.observe(contentNode, { childList: true, subtree: true, attributes: true, characterData: true })
      await vi.advanceTimersByTimeAsync(4000)
      expect(frame.content.textContent).toContain('host-a is unreachable — showing last loaded copy')
      expect(frame.el.classList.contains('ws-stale')).toBe(true)
      await vi.advanceTimersByTimeAsync(8000)
      expect(fetchFile).toHaveBeenCalledTimes(3)
      expect(frame.content.querySelector('.ws-document-status')).toBeNull()
      expect(frame.el.classList.contains('ws-stale')).toBe(false)
      expect(frame.viewer).toBe(viewer)
      expect(iframe ? viewer.querySelector('iframe') : viewer.querySelector('pre')).toBe(contentNode)
      expect(iframe?.srcdoc).toBe(srcdoc)
      expect(viewer.scrollTop).toBe(135)
      expect(changes.takeRecords()).toHaveLength(0)
      changes.disconnect()
    } finally { host.dispose() }
  })
})
