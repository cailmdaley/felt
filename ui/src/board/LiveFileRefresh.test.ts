import { afterEach, describe, expect, it, vi } from 'vitest'

import { LIVE_FILE_POLL_INTERVAL_MS, LiveFileRefresh } from './LiveFileRefresh.js'

function response(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: vi.fn(async () => body),
  } as unknown as Response
}

function harness(fetchFile: typeof fetch) {
  let now = 0
  let visible = true
  let visibilityListener: (() => void) | null = null
  const schedule = vi.fn((callback: () => void) => {
    return callback as unknown as ReturnType<typeof globalThis.setInterval>
  })
  const cancel = vi.fn()
  const poller = new LiveFileRefresh({
    fetch: fetchFile,
    now: () => now,
    isVisible: () => visible,
    setInterval: schedule as unknown as typeof globalThis.setInterval,
    clearInterval: cancel as unknown as typeof globalThis.clearInterval,
    onVisibilityChange: (listener) => {
      visibilityListener = listener
      return () => { visibilityListener = null }
    },
  })
  return {
    poller,
    setNow: (value: number) => { now = value },
    setVisible: (value: boolean) => { visible = value },
    visibilityChanged: () => visibilityListener?.(),
    schedule,
    cancel,
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}

afterEach(() => vi.restoreAllMocks())

describe('LiveFileRefresh', () => {
  it('polls immediately and pauses while the page is hidden', async () => {
    const fetchFile = vi.fn(async () => response(200, 'first')) as unknown as typeof fetch
    const h = harness(fetchFile)
    const stop = h.poller.watch('/api/v1/file?path=%2Freport.html', vi.fn())
    await settle()
    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(h.schedule).toHaveBeenCalledWith(expect.any(Function), LIVE_FILE_POLL_INTERVAL_MS)

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    h.setVisible(false)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(1)

    h.setVisible(true)
    h.visibilityChanged()
    await settle()
    expect(fetchFile).toHaveBeenCalledTimes(2)
    stop()
    expect(h.cancel).toHaveBeenCalledTimes(1)
  })

  it('uses ETag and does not render a 304 again', async () => {
    const unchanged = response(304, '', { etag: 'W/"same"' })
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'report', { etag: 'W/"same"' }))
      .mockResolvedValueOnce(unchanged) as unknown as typeof fetch
    const h = harness(fetchFile)
    const onContent = vi.fn()
    const stop = h.poller.watch('/file?path=%2Freport.html', onContent)
    await settle()
    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()

    expect(fetchFile).toHaveBeenNthCalledWith(2, '/file?path=%2Freport.html', expect.objectContaining({
      cache: 'no-store',
      headers: { 'If-None-Match': 'W/"same"' },
    }))
    expect(unchanged.text).not.toHaveBeenCalled()
    expect(onContent).toHaveBeenCalledTimes(1)
    stop()
  })

  it('shares a URL and falls back to Last-Modified when no ETag is available', async () => {
    const lastModified = 'Tue, 01 Jan 2030 00:00:00 GMT'
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'report', { 'last-modified': lastModified }))
      .mockResolvedValueOnce(response(304, '', { 'last-modified': lastModified })) as unknown as typeof fetch
    const h = harness(fetchFile)
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = h.poller.watch('/file?path=%2Freport.txt', first)
    const stopSecond = h.poller.watch('/file?path=%2Freport.txt', second)
    await settle()

    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledWith('report')
    expect(second).toHaveBeenCalledWith('report')

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenNthCalledWith(2, '/file?path=%2Freport.txt', expect.objectContaining({
      headers: { 'If-Modified-Since': lastModified },
    }))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    stopFirst()
    stopSecond()
  })

  it('hash-compares 200 responses from older daemons and renders only changed content', async () => {
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'same body'))
      .mockResolvedValueOnce(response(200, 'same body'))
      .mockResolvedValueOnce(response(200, 'new body')) as unknown as typeof fetch
    const h = harness(fetchFile)
    const onContent = vi.fn()
    const stop = h.poller.watch('/file?path=%2Freport.md', onContent)
    await settle()
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('same body')

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(onContent).toHaveBeenCalledTimes(1)

    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(onContent).toHaveBeenNthCalledWith(2, 'new body')
    stop()
  })

  it('backs off after errors and resumes after the retry delay', async () => {
    const fetchFile = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(200, 'back online')) as unknown as typeof fetch
    const h = harness(fetchFile)
    const onContent = vi.fn()
    const onError = vi.fn()
    const stop = h.poller.watch('/file?path=%2Freport.txt', onContent, onError)
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(1)
    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS - 1)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(1)

    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(fetchFile).toHaveBeenCalledTimes(2)
    expect(onContent).toHaveBeenCalledTimes(1)
    expect(onContent).toHaveBeenCalledWith('back online')
    stop()
  })
})
