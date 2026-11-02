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
function create(onRoute = vi.fn()): WorkspaceHistory {
  const history = new WorkspaceHistory(onRoute)
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

  it('walks the same cross-channel and file path with app Back and browser Back, including reload', async () => {
    resetHash('#/desk')
    let history = create()
    history.start()
    history.enter('nested/thread', 'host', 'chat:A', 'desk')
    history.name('Thread A')
    expect(history.backLabel).toBe('Desk')
    history.enter('sibling', 'other-host', 'chat:B')
    history.name('Thread B')
    expect(history.backLabel).toBe('Thread A')
    history.openDocument('other-host:/files/F.html')
    history.name('F.html')
    expect(history.backLabel).toBe('Thread B')
    history.openDocument('other-host:/files/G.html')
    expect(history.backLabel).toBe('F.html')
    history.dispose()
    history = create()
    history.start()
    expect(history.backLabel).toBe('F.html')
    for (const [action, doc, label] of [
      [() => history.back(), 'other-host:/files/F.html', 'Thread B'],
      [() => window.history.back(), 'chat:B', 'Thread A'],
      [() => history.back(), 'chat:A', 'Desk'],
    ] as const) {
      await nextPop(action)
      expect(parseRoute(window.location.hash)).toMatchObject({ kind: 'channel', doc })
      expect(history.backLabel).toBe(label)
    }
    await nextPop(() => history.back())
    expect(window.location.hash).toBe('#/desk')
  })

  it('names pages within a channel and constitutions across channels, including reload', () => {
    resetHash('#/desk')
    let history = create()
    history.start()
    history.enter('one', 'host', 'chat')
    history.name('First constitution', 'Chat')
    history.enter('two', 'host', 'fiber')
    expect(history.backLabel).toBe('First constitution')
    history.name('Second constitution', 'Constitution')
    history.openDocument('F.html')
    expect(history.backLabel).toBe('Constitution')
    history.name('Second constitution', 'F.html')
    history.openDocument('G.html')
    expect(history.backLabel).toBe('F.html')
    history.select('chat')
    history.name('Second constitution', 'Chat')
    history.dispose()
    history = create()
    history.start()
    expect(history.backLabel).toBe('F.html')
    history.openDocument('F.html')
    expect(history.backLabel).toBe('Chat')
    history.name('Second constitution', 'F.html')
    history.enter('two', 'other-owner', 'chat')
    expect(history.backLabel).toBe('Second constitution')
  })

  it('backs from a visited file to a deep link before falling back to its origin', async () => {
    resetHash(formatRoute({ kind: 'channel', uid: 'direct', owner: 'host', doc: 'report' }))
    const history = create()
    history.start()
    history.name('Report')
    history.openDocument('attachment')
    expect(history.backLabel).toBe('Report')
    await nextPop(() => history.back())
    expect(parseRoute(window.location.hash)).toMatchObject({ doc: 'report' })
    history.back()
    expect(window.location.hash).toBe('#/board')
  })

  it('refreshes navigation when a tab selection gives consecutive entries the same address', async () => {
    resetHash('#/desk')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    history.enter('one', 'host', 'chat')
    history.name('One')
    history.openDocument('file')
    history.select('chat')
    expect(history.backLabel).toBe('One')
    onRoute.mockClear()
    await nextPop(() => history.back())
    expect(history.backLabel).toBe('Desk')
    expect(onRoute).toHaveBeenCalledOnce()
    await nextPop(() => history.back())
    expect(window.location.hash).toBe('#/desk')
  })

  it('pushes channel entries and replaces the selected document in place', () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    const push = vi.spyOn(window.history, 'pushState')
    history.enter('one', 'host-a')
    expect(push).toHaveBeenCalledOnce()
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

  it('restores the origin view from history state after reload and browser Back', async () => {
    resetHash('')
    const first = create()
    first.start()
    first.enter('one', 'host', undefined, 'desk')
    first.select('host:/store/report.html')
    expect(window.history.state).toMatchObject({
      shuttleWorkspace: { depth: 1, base: true, baseHash: '', originView: 'desk' },
    })
    first.dispose()

    const onRoute = vi.fn()
    const reloaded = create(onRoute)
    reloaded.start()
    expect(reloaded.originView).toBe('desk')
    expect(onRoute).toHaveBeenCalledWith({
      kind: 'channel', uid: 'one', owner: 'host', doc: 'host:/store/report.html',
    })

    await nextPop(() => window.history.back())
    expect(window.location.hash).toBe('')
    expect(reloaded.originView).toBe('desk')
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { originView: 'desk' } })
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: '' })
  })

  it.each(['desk', 'chronicle', 'board'] as const)('returns a directly loaded channel to %s when no managed base exists', originView => {
    const hash = formatRoute({ kind: 'channel', uid: 'one', owner: 'host' })
    resetHash(hash)
    window.history.replaceState({ shuttleWorkspace: { depth: 0, base: false, baseHash: '', originView } }, '', hash)
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    expect(history.originView).toBe(originView)
    expect(history.backLabel.toLowerCase()).toBe(originView)
    history.back()
    expect(window.location.hash).toBe(`#/${originView}`)
    expect(onRoute).toHaveBeenLastCalledWith({ kind: 'overview', hash: `#/${originView}` })
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

})
