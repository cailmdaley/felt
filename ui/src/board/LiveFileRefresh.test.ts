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
    const unchanged = response(304, '', { etag: 'W/"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' })
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'report', { etag: 'W/"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' }))
      .mockResolvedValueOnce(unchanged) as unknown as typeof fetch
    const h = harness(fetchFile)
    const onContent = vi.fn()
    const stop = h.poller.watch('/file?path=%2Freport.html', onContent)
    await settle()
    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()

    expect(fetchFile).toHaveBeenNthCalledWith(2, '/file?path=%2Freport.html', expect.objectContaining({
      cache: 'no-store',
      headers: { 'If-None-Match': 'W/"sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' },
    }))
    expect(unchanged.text).not.toHaveBeenCalled()
    expect(onContent).toHaveBeenCalledTimes(1)
    stop()
  })

  it('shares a URL and polls unconditionally, comparing bodies, when the owner offers no digest ETag', async () => {
    const lastModified = 'Tue, 01 Jan 2030 00:00:00 GMT'
    const legacyEtag = '"1735689600-6"'
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'report', { 'last-modified': lastModified, etag: legacyEtag }))
      .mockResolvedValueOnce(response(200, 'report', { 'last-modified': lastModified, etag: legacyEtag }))
      .mockResolvedValueOnce(response(200, 'rewrite', { 'last-modified': lastModified, etag: legacyEtag })) as unknown as typeof fetch
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
    expect(fetchFile).toHaveBeenNthCalledWith(2, '/file?path=%2Freport.txt', expect.objectContaining({ headers: {} }))
    expect(first).toHaveBeenCalledTimes(1)

    h.setNow(2 * LIVE_FILE_POLL_INTERVAL_MS)
    await h.poller.pollNow()
    expect(first).toHaveBeenLastCalledWith('rewrite')
    expect(second).toHaveBeenLastCalledWith('rewrite')
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

  it('honors a forced refresh during an in-flight conditional GET', async () => {
    let finishConditional!: (value: Response) => void
    const fetchFile = vi.fn()
      .mockResolvedValueOnce(response(200, 'old', { etag: 'W/"sha256-0000000000000000000000000000000000000000000000000000000000000000"' }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishConditional = resolve
      }))
      .mockResolvedValueOnce(response(200, 'new', { etag: 'W/"sha256-1111111111111111111111111111111111111111111111111111111111111111"' }))
    const h = harness(fetchFile as typeof fetch)
    const onContent = vi.fn()
    const stop = h.poller.watch('/file', onContent)
    await settle()

    h.setNow(LIVE_FILE_POLL_INTERVAL_MS)
    const conditional = h.poller.pollNow()
    const forced = h.poller.refresh('/file')
    finishConditional(response(304))
    await Promise.all([conditional, forced])

    expect(fetchFile).toHaveBeenCalledTimes(3)
    expect(onContent).toHaveBeenLastCalledWith('new')
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
