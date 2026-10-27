import { describe, expect, it, vi } from 'vitest'
import { SentFilesFeed } from './sentFilesFeed.js'

describe('SentFilesFeed', () => {
  it('reports only changes to the session receipt set even when every response is 200', async () => {
    let files = [{ fullPath: '/tmp/a.png', basename: 'a.png', timestamp: 1, sessionId: 's' }]
    const onFiles = vi.fn()
    const feed = new SentFilesFeed({ shuttleBase: '', uid: 'u', session: 's', onFiles,
      fetch: async () => new Response(JSON.stringify({ files }), { status: 200 }) })
    expect(await feed.read()).toBe(true)
    expect(await feed.read()).toBe(false)
    files = []
    expect(await feed.read()).toBe(true)
    expect(onFiles).toHaveBeenCalledTimes(2)
    expect(onFiles).toHaveBeenLastCalledWith([])
  })
})
