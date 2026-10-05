// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRoute, parseRoute, WorkspaceHistory, type WorkspaceRoute } from './route.js'

const histories: WorkspaceHistory[] = []
afterEach(() => {
  for (const history of histories) history.dispose()
  histories.length = 0
  vi.restoreAllMocks()
})
function resetHash(hash: string): void {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`)
}
function create(onRoute = vi.fn(), onDock = vi.fn()): WorkspaceHistory {
  const history = new WorkspaceHistory(onRoute, onDock)
  histories.push(history)
  return history
}
function nextPop(action: () => void): Promise<PopStateEvent> {
  return new Promise((resolve) => {
    window.addEventListener('popstate', (event) => resolve(event as PopStateEvent), { once: true })
    action()
  })
}

describe('workspace routes', () => {
  it('round-trips channel ids and opaque document keys as encoded components', () => {
    const routes: WorkspaceRoute[] = [
      { kind: 'overview' },
      { kind: 'channel', uid: 'project/fiber', owner: 'host@a' },
      { kind: 'channel', uid: 'project/fiber', owner: 'host@a', doc: 'host@a:/store/analysis/report.html' },
      { kind: 'channel', uid: 'uid', owner: 'host', doc: 'fiber:host:uid' },
    ]
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route)
    expect(formatRoute(routes[0])).toBe('#/board')
  })

  it('rejects malformed, incomplete, and ambiguous hashes', () => {
    for (const hash of [
      '', '#/desk', '#/board/', '#/board/@host', '#/board/uid@',
      '#/board/uid@host/', '#/board/uid@host/doc/extra', '#/board/%GG@host',
      '#/board/uid@host/%E0%A4%A',
    ]) expect(parseRoute(hash)).toBeNull()
  })

  it('applies a valid initial address once and leaves an absent address untouched until navigation', () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.start()
    expect(onRoute).toHaveBeenCalledOnce()
    expect(onRoute).toHaveBeenCalledWith({ kind: 'overview' })

    resetHash('')
    const noInitialRoute = vi.fn()
    const blank = create(noInitialRoute)
    blank.start()
    expect(noInitialRoute).not.toHaveBeenCalled()
    blank.enter('uid', 'host')
    expect(parseRoute(window.location.hash)).toEqual({ kind: 'channel', uid: 'uid', owner: 'host' })
    expect(noInitialRoute).toHaveBeenCalledWith({ kind: 'channel', uid: 'uid', owner: 'host' })
  })

  it('pushes channel entries and replaces the selected document in place', () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    const startingLength = window.history.length
    history.enter('one', 'host-a')
    expect(window.history.length).toBe(startingLength + 1)
    const entryLength = window.history.length
    history.select('host-a:/store/report.html')
    expect(window.history.length).toBe(entryLength)
    expect(parseRoute(window.location.hash)).toEqual({
      kind: 'channel', uid: 'one', owner: 'host-a', doc: 'host-a:/store/report.html',
    })
    expect(onRoute).toHaveBeenCalledTimes(2)
  })

  it('establishes a view-key return point without retaining an older channel depth', async () => {
    resetHash('#/board')
    const history = create()
    history.start()
    history.enter('one', 'host')
    history.view('#/desk')
    expect(window.location.hash).toBe('#/desk')
    history.view()
    history.enter('two', 'host')
    await nextPop(() => history.leave())
    expect(window.location.hash).toBe('#/board')
  })

  it('lets browser Back return to the previous channel rather than overview', async () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.enter('one', 'host')
    history.enter('two', 'host')
    await nextPop(() => window.history.back())
    expect(parseRoute(window.location.hash)).toEqual({ kind: 'channel', uid: 'one', owner: 'host' })
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'channel', uid: 'one', owner: 'host' })
  })

  it('explicit leave unwinds managed channel depth to the overview and ignores its own pop', async () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.enter('one', 'host')
    history.enter('two', 'host')
    const returned = nextPop(() => history.leave())
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/board' })
    await returned
    await Promise.resolve()
    expect(window.location.hash).toBe('#/board')
    expect(onRoute).toHaveBeenCalledTimes(4)
  })

  it('queues a new entry until leave finishes and carries its latest selection', async () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.enter('one', 'host')
    history.enter('two', 'host')
    const returned = nextPop(() => history.leave())
    history.enter('three', 'host')
    history.select('host:/store/report.html')
    await returned
    expect(window.location.hash).toBe(formatRoute({
      kind: 'channel', uid: 'three', owner: 'host', doc: 'host:/store/report.html',
    }))
    expect(onRoute).toHaveBeenLastCalledWith({
      kind: 'channel', uid: 'three', owner: 'host', doc: 'host:/store/report.html',
    })
    expect(onRoute).toHaveBeenCalledTimes(5)
  })

  it('replaces a direct channel address on leave when no managed overview entry exists', () => {
    resetHash(formatRoute({ kind: 'channel', uid: 'direct', owner: 'host' }))
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    const go = vi.spyOn(window.history, 'go')
    history.leave()
    expect(go).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/board')
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/board' })
  })

  it('Back closes the phone dock once without re-applying the channel, then returns to overview', async () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const onDock = vi.fn()
    const history = create(onRoute, onDock)
    history.start()
    history.enter('one', 'host')
    const channelLength = window.history.length
    history.setDock(true)
    history.setDock(true)
    expect(window.history.length).toBe(channelLength + 1)

    await nextPop(() => window.history.back())
    expect(onDock).toHaveBeenCalledExactlyOnceWith(false)
    expect(onRoute).toHaveBeenCalledTimes(2)
    expect(window.location.hash).toBe(formatRoute({ kind: 'channel', uid: 'one', owner: 'host' }))

    await nextPop(() => window.history.back())
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/board' })
    expect(onRoute).toHaveBeenCalledTimes(3)
  })

  it('queues a channel switch until an explicit dock close has returned its entry', async () => {
    resetHash('#/board')
    const onRoute = vi.fn(), onDock = vi.fn()
    const history = create(onRoute, onDock)
    history.start()
    history.enter('one', 'host')
    history.setDock(true)
    const pop = nextPop(() => history.setDock(false))
    history.enter('two', 'host')
    await pop
    expect(parseRoute(window.location.hash)).toEqual({ kind: 'channel', uid: 'two', owner: 'host' })
    expect(onRoute).toHaveBeenCalledTimes(3)
    expect(onDock).not.toHaveBeenCalled()
    await nextPop(() => window.history.back())
    expect(parseRoute(window.location.hash)).toEqual({ kind: 'channel', uid: 'one', owner: 'host' })
  })

  it('leaves from an open dock without leaving a second Back entry behind', async () => {
    resetHash('#/board')
    const onRoute = vi.fn(), onDock = vi.fn()
    const history = create(onRoute, onDock)
    history.start()
    history.enter('one', 'host')
    history.setDock(true)
    await nextPop(() => history.leave())
    expect(window.location.hash).toBe('#/board')
    expect(onDock).toHaveBeenCalledExactlyOnceWith(false)
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '#/board' })
  })

  it('reopens a phone dock when Forward returns to its same-address entry', async () => {
    resetHash('#/board')
    const onDock = vi.fn()
    const history = create(vi.fn(), onDock)
    history.start()
    history.enter('one', 'host')
    history.setDock(true)
    await nextPop(() => window.history.back())
    await nextPop(() => window.history.forward())
    expect(onDock.mock.calls).toEqual([[false], [true]])
  })
})
