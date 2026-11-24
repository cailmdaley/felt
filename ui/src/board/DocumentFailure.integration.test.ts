// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The bug: a worker sent an image from a folder its host's daemon could not
// read. The bytes never arrived, and the reader said "This browser cannot show
// this image". The real host and viewer run here; only the owner is mocked.
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('an image the reader could not show', () => {
  it.each([
    ['/Documents/talk/01-title.png', 403, 'host-a could not read this file', 'The worker can send it again.'],
    ['/scratch/frame.png', 404, 'Not found on host-a', '/scratch/frame.png'],
    ['/remote/frame.png', 502, 'host-a is unreachable', 'Retry'],
    ['/remote/frame.png', null, 'host-a is unreachable', 'Retry'],
    ['/figure.heic', 200, 'This browser cannot show this image', 'Download'],
  ] as const)('%s answering %s names its cause', async (path, status, cause, detail) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (status === null) throw new TypeError('Failed to fetch')
      return new Response(null, { status })
    }))
    const { DocumentHost } = await import('./workspace/DocumentHost.js')
    const track = document.createElement('div')
    document.body.append(track)
    const host = new DocumentHost(track, { shuttleBase: '', buildProse: () => document.createElement('div'), onSelect: vi.fn() })
    try {
      const doc = { key: `host-a:${path}`, owner: 'host-a', path, name: path.split('/').at(-1)!, kind: 'image' as const, provenance: [] }
      host.setChannel([doc], doc.key)
      const content = host.get(doc.key)!.content
      await vi.waitFor(() => expect(content.querySelector('img')).not.toBeNull())
      content.querySelector('img')!.dispatchEvent(new Event('error'))
      await vi.waitFor(() => expect(content.querySelector('[role="status"] p')?.textContent).toBe(cause))
      expect(content.textContent).toContain(detail)
      if (status !== 200) expect(content.textContent).not.toContain('This browser')
    } finally {
      host.dispose()
    }
  })
})
