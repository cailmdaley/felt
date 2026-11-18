// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdings, reportHoldings } from './holdings.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

const frame = (srcdoc: string): HTMLIFrameElement => Object.assign(document.createElement('iframe'), { srcdoc })
function readerPage(key: string, state: string, content: Node[]): HTMLElement {
  const page = document.createElement('div')
  page.className = `ws-page ${state}`
  page.dataset.key = key
  const body = document.createElement('div')
  body.className = 'ws-content'
  body.append(...content)
  page.append(body)
  return page
}

describe('holdings', () => {
  it('names each kept document with its frames and characters, and counts every frame in the page', () => {
    const thumb = document.createElement('div')
    thumb.className = 'ws-thumbnail'
    thumb.append(frame('<p>preview</p>'), document.createElement('img'))
    const unfolded = document.createElement('div')
    unfolded.className = 'uf'
    unfolded.setAttribute('data-unfolded', '')
    const ufPage = document.createElement('div')
    ufPage.className = 'uf-page'
    ufPage.dataset.key = 'local:/a/plot.html'
    ufPage.append(frame('x'.repeat(40)))
    unfolded.append(ufPage)
    const folded = document.createElement('div')
    folded.className = 'uf'
    document.body.append(
      thumb, unfolded, folded, frame('stray'),
      readerPage('local:/a/tapestry.html', 'ws-parked', [frame('y'.repeat(1000))]),
      readerPage('local:/a/notes.html', 'ws-selected', [frame('z'.repeat(10))]),
      readerPage('local:/a/evicted.html', 'ws-receded', [Object.assign(document.createElement('div'), { className: 'ws-placeholder' })]),
    )
    history.replaceState(null, '', '#/channels')

    const now = holdings()

    expect(now).toMatchObject({
      route: '#/channels', view: 'channels', frames: 5,
      previews: { frames: 1, chars: 14, images: 1 },
      reader: [
        { key: 'local:/a/tapestry.html', state: 'parked', frames: 1, chars: 1000 },
        { key: 'local:/a/notes.html', state: 'selected', frames: 1, chars: 10 },
      ],
      unfolded: [{ key: 'local:/a/plot.html', frames: 1, chars: 40 }],
      images: { count: 1 },
      cache: { chars: 0, entries: 0 },
    })
    expect(now.page).toBe(Math.round(performance.timeOrigin))
    expect(now.nodes).toBe(document.getElementsByTagName('*').length)
  })
})

describe('reportHoldings', () => {
  const standalone = (matches: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: matches && query === '(display-mode: standalone)' }))

  it('posts what the page holds once a minute when it is the installed web app on its own host', async () => {
    vi.useFakeTimers()
    standalone(true)
    const fetch = vi.fn(async () => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    reportHoldings('http://127.0.0.1:4000')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:4000/api/v1/board/holdings')
    expect(JSON.parse(String(init.body))).toMatchObject({ frames: 0, reader: [], unfolded: [] })
  })

  it('stays silent in a browser tab', async () => {
    vi.useFakeTimers()
    standalone(false)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    reportHoldings('')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).not.toHaveBeenCalled()
  })
})
