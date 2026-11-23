// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../views/index.js'
import { FRAME_STEPS, formatRoute, LANDING_MS, parseRoute, WorkspaceHistory, type WorkspaceRoute } from './route.js'

const histories: WorkspaceHistory[] = []
afterEach(() => {
  for (const history of histories) history.dispose()
  histories.length = 0
  vi.restoreAllMocks()
})
function resetHash(hash: string): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
}
/** A history whose routes `onRoute` hears as `(route)`, or `(route, 'quiet')` for a scan's. */
function create(onRoute = vi.fn()): WorkspaceHistory {
  const history = new WorkspaceHistory((route, quiet) => quiet ? onRoute(route, 'quiet') : onRoute(route))
  histories.push(history)
  return history
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))
function nextPop(action: () => void): Promise<PopStateEvent> {
  return new Promise((resolve) => {
    window.addEventListener('popstate', (event) => resolve(event as PopStateEvent), { once: true })
    action()
  })
}

describe('workspace routes', () => {
  it('round-trips channel ids and opaque document keys as encoded components', () => {
    const routes: WorkspaceRoute[] = [
      { kind: 'channel', uid: 'project/fiber', owner: 'host@a' },
      { kind: 'channel', uid: 'project/fiber', owner: 'host@a', doc: 'host@a:/store/analysis/report.html' },
      { kind: 'channel', uid: 'uid', owner: 'host', doc: 'fiber:host:uid' },
    ]
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route)
    expect(formatRoute(routes[0])).toBe('#/board/project%2Ffiber@host%40a')
    expect(formatRoute({ kind: 'overview' })).toBe('#/channels')
    expect(parseRoute('#/board')).toEqual({ kind: 'overview', hash: '#/channels' })
  })

  it('rejects malformed, incomplete, and ambiguous hashes', () => {
    for (const hash of [
      '', '#/desk', '#/board/', '#/board/@host', '#/board/uid@',
      '#/board/uid@host/', '#/board/uid@host/doc/extra', '#/board/%GG@host',
      '#/board/uid@host/%E0%A4%A',
    ]) expect(parseRoute(hash)).toBeNull()
  })

  it('applies a valid initial address once and leaves an absent address untouched until navigation', () => {
    resetHash(formatRoute({ kind: 'channel', uid: 'uid', owner: 'host' }))
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.start()
    expect(onRoute).toHaveBeenCalledOnce()
    expect(onRoute).toHaveBeenCalledWith({ kind: 'channel', uid: 'uid', owner: 'host' })

    resetHash('')
    const noInitialRoute = vi.fn()
    const blank = create(noInitialRoute)
    blank.start()
    expect(noInitialRoute).not.toHaveBeenCalled()
    blank.enter('uid', 'host')
    expect(parseRoute(window.location.hash)).toEqual({ kind: 'channel', uid: 'uid', owner: 'host' })
    expect(noInitialRoute).toHaveBeenCalledWith({ kind: 'channel', uid: 'uid', owner: 'host' })
  })

  it('opens the reader as one entry above its view; every move inside it takes that entry\'s place', () => {
    resetHash('#/channels')
    const history = create()
    history.start()
    const length = window.history.length
    history.enter('thread', 'host', 'family:thread', 'channels')
    expect(window.history.length).toBe(length + 1)
    history.enter('orchestrator', 'host', 'family:orchestrator')
    history.show('host:/files/F.html')
    history.enter('thread', 'host')
    history.name('fiber:thread')
    history.enter('orchestrator', 'host', undefined, undefined, true)
    expect(window.history.length).toBe(length + 1)
    expect(parseRoute(window.location.hash)).toEqual({ kind: 'channel', uid: 'orchestrator', owner: 'host' })
    expect(history.backLabel).toBe('Channels')
  })

  it('back from any depth is one step to the view, by the reader\'s back or the browser\'s', async () => {
    for (const back of ['reader', 'browser'] as const) {
      resetHash('#/desk')
      const onRoute = vi.fn()
      const history = create(onRoute)
      history.start()
      history.enter('a', 'host', undefined, 'desk')
      history.enter('b', 'host')
      history.show('host:/files/F.html')
      expect(history.backLabel).toBe('Desk')
      await nextPop(() => back === 'reader' ? history.leave() : window.history.back())
      expect(window.location.hash).toBe('#/desk')
      expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/desk' })
      history.dispose()
    }
  })

  it('a back that lands in a framed page\'s own history goes on back to the view; a frame stepping back by itself is left be', () => {
    resetHash('#/channels')
    const history = create()
    history.start()
    history.enter('a', 'host', 'host:/files/deck.html', 'channels')
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    history.framePopped()
    expect(back).not.toHaveBeenCalled()
    history.leave()
    history.framePopped()
    history.framePopped()
    expect(back).toHaveBeenCalledTimes(3)
  })

  it('a back goes on through a framed page\'s history a bounded number of steps, however often the page steps back', () => {
    vi.useFakeTimers()
    try {
      resetHash('#/channels')
      const history = create()
      history.start()
      history.enter('a', 'host', 'host:/files/deck.html', 'channels')
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
      history.leave()
      // A page whose popstate pushes again reports a step back for every back it is given.
      for (let n = 0; n < 50; n++) history.framePopped()
      expect(back).toHaveBeenCalledTimes(1 + FRAME_STEPS)
    } finally { vi.useRealTimers() }
  })

  it('a back the board never hears land is taken as landed: the view\'s address stands, and what was asked meanwhile goes ahead', () => {
    vi.useFakeTimers()
    try {
      resetHash('#/channels')
      const onRoute = vi.fn()
      const history = create(onRoute)
      history.start()
      history.enter('a', 'host', 'host:/files/deck.html', 'channels')
      // The back stops on an entry a nested frame made, which reports nothing.
      vi.spyOn(window.history, 'back').mockImplementation(() => {})
      history.leave()
      history.enter('b', 'host')
      expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/channels' })
      vi.advanceTimersByTime(LANDING_MS)
      expect(onRoute).toHaveBeenLastCalledWith({ kind: 'channel', uid: 'b', owner: 'host' })
      expect(window.location.hash).toBe(formatRoute({ kind: 'channel', uid: 'b', owner: 'host' }))
    } finally { vi.useRealTimers() }
  })

  it('a scan is quiet; the browser\'s forward reopens the reader where it was left', async () => {
    resetHash('#/channels')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.enter('a', 'host')
    history.enter('b', 'host', undefined, undefined, true)
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'channel', uid: 'b', owner: 'host' }, 'quiet')
    await nextPop(() => history.leave())
    await nextPop(() => window.history.forward())
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'channel', uid: 'b', owner: 'host' })
    await nextPop(() => history.leave())
    expect(window.location.hash).toBe('#/channels')
  })

  it('leaving an address opened directly replaces it with its view', () => {
    resetHash(formatRoute({ kind: 'channel', uid: 'deep', owner: 'host' }))
    const onRoute = vi.fn()
    const history = create(onRoute)
    const length = window.history.length
    history.start()
    history.enter('other', 'host')
    history.leave()
    expect(window.location.hash).toBe('#/channels')
    expect(window.history.length).toBe(length)
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/channels' })
  })

  it('the view under the reader, chosen from it, is back: one step, leaving no second copy of the view', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('a', 'host', undefined, 'desk')
    history.show('host:/f.html')
    await nextPop(() => history.view('#/desk'))
    expect(window.location.hash).toBe('#/desk')
    window.history.pushState({ floor: 1 }, '', '#/desk')
    window.history.back()
    await settle()
    expect(window.location.hash).toBe('#/desk')
  })

  it('an address typed over a freshly loaded view opens a layer above it', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    await new Promise<void>(resolve => { window.addEventListener('hashchange', () => resolve(), { once: true }); window.location.hash = '#/board/typed@host' })
    await settle()
    await nextPop(() => history.leave())
    expect(window.location.hash).toBe('#/desk')
  })

  it('a reload inside the reader keeps the view below it', async () => {
    resetHash('#/desk')
    let history = create()
    history.start()
    history.enter('a', 'host', undefined, 'desk')
    history.enter('b', 'host')
    history.dispose()
    history = create()
    history.start()
    expect(history.backLabel).toBe('Desk')
    await nextPop(() => history.leave())
    expect(window.location.hash).toBe('#/desk')
  })

  it('redirects retired view hashes (#/chronicle, #/globe) to #/desk', () => {
    for (const retired of ['#/chronicle', '#/globe']) {
      resetHash(retired)
      const history = create()
      history.start()
      expect(window.location.hash).toBe('#/desk')
      expect(history.originView).toBe('desk')
      history.dispose()
    }
  })

  it('another view chosen from the reader takes the reader\'s entry, so the browser\'s back returns to the view it covered', async () => {
    resetHash('#/channels')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.enter('a', 'host')
    history.enter('b', 'host')
    history.view('#/desk')
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/desk' })
    expect(history.originView).toBe('desk')
    await nextPop(() => window.history.back())
    expect(window.location.hash).toBe('#/channels')
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/channels' })
  })

  it('what is asked while a back is landing waits for it, then opens a fresh layer', async () => {
    resetHash('#/channels')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.enter('a', 'host')
    await nextPop(() => { history.leave(); history.enter('b', 'host', 'fiber:b') })
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'channel', uid: 'b', owner: 'host', doc: 'fiber:b' })
    await nextPop(() => history.leave())
    expect(window.location.hash).toBe('#/channels')
  })

  it('redirects the old Board address to Channels in place, at start and when it is navigated to', async () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    expect(window.location.hash).toBe('#/channels')
    expect(history.originView).toBe('channels')
    expect(onRoute).not.toHaveBeenCalled()
    history.view('#/desk')
    history.view('#/board')
    expect(window.location.hash).toBe('#/channels')
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/channels' })
    await settle()
  })
})
