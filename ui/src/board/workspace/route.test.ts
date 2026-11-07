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
    history.enter('nested/thread', 'host', 'fiber:A', 'desk')
    history.name('Thread A')
    expect(history.backLabel).toBe('Desk')
    history.enter('sibling', 'other-host', 'fiber:B')
    history.name('Thread B')
    expect(history.backLabel).toBe('Thread A')
    history.openDocument('other-host:/files/F.html')
    history.name('Thread B', 'F.html')
    expect(history.backLabel).toBe('Thread B')
    history.openDocument('other-host:/files/G.html')
    expect(history.backLabel).toBe('F.html')
    history.dispose()
    history = create()
    history.start()
    expect(history.backLabel).toBe('F.html')
    for (const [action, doc, label] of [
      [() => history.back(), 'other-host:/files/F.html', 'Thread B'],
      [() => window.history.back(), 'fiber:B', 'Thread A'],
      [() => history.back(), 'fiber:A', 'Desk'],
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
    history.enter('one', 'host', 'fiber')
    history.name('First constitution', 'Constitution')
    history.enter('two', 'host', 'fiber')
    expect(history.backLabel).toBe('First constitution')
    history.name('Second constitution', 'Constitution')
    history.openDocument('F.html')
    expect(history.backLabel).toBe('Constitution')
    history.name('Second constitution', 'F.html')
    history.openDocument('G.html')
    history.name('Second constitution', 'G.html')
    expect(history.backLabel).toBe('F.html')
    history.openDocument('fiber')
    history.name('Second constitution', 'Constitution')
    history.dispose()
    history = create()
    history.start()
    expect(history.backLabel).toBe('G.html')
    history.openDocument('F.html')
    expect(history.backLabel).toBe('Constitution')
    history.name('Second constitution', 'F.html')
    history.enter('two', 'other-owner', 'fiber')
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

  it('pops to the preceding Constitution instead of creating consecutive equal addresses', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.name('One', 'Constitution')
    history.openDocument('file')
    await nextPop(() => history.revisitDocument('fiber'))
    expect(history.backLabel).toBe('Desk')
    await nextPop(() => history.back())
    expect(window.location.hash).toBe('#/desk')
  })

  it('keeps an explicit link back to a preceding page as a new visit', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.name('One', 'Constitution')
    history.openDocument('report', 'report.html')
    history.openDocument('fiber', 'Constitution')
    expect(history.backLabel).toBe('report.html')
    await nextPop(() => history.back())
    expect(parseRoute(window.location.hash)).toMatchObject({ doc: 'report' })
    expect(history.backLabel).toBe('Constitution')
  })

  it('adds a controls visit when Constitution is not the preceding page', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.name('One', 'Constitution')
    history.openDocument('report', 'report.html')
    history.openDocument('table', 'table.html')
    history.revisitDocument('fiber', 'Constitution')
    expect(history.backLabel).toBe('table.html')
    await nextPop(() => history.back())
    expect(parseRoute(window.location.hash)).toMatchObject({ doc: 'table' })
  })

  it('pops if resolving a page address would duplicate its predecessor', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.name('One', 'Constitution')
    history.openDocument('file', 'report.html')
    await nextPop(() => history.name('One', 'Constitution', 'fiber'))
    expect(history.backLabel).toBe('Desk')
    await nextPop(() => history.back())
    expect(window.location.hash).toBe('#/desk')
  })

  it('names the same predecessor by page or constitution as a step changes channel', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.name('One', 'Constitution')
    history.openDocument('report', 'report.html')
    history.enter('two', 'host', 'fiber', undefined, true)
    expect(history.backLabel).toBe('One')
    history.enter('one', 'host', 'table', undefined, true)
    expect(history.backLabel).toBe('Constitution')
    await nextPop(() => history.back())
    expect(history.backLabel).toBe('Desk')
  })

  it('issues one browser Back until its popstate lands', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.openDocument('file')
    const back = vi.spyOn(window.history, 'back')
    await nextPop(() => { history.back(); history.back() })
    expect(back).toHaveBeenCalledOnce()
    await nextPop(() => history.back())
    expect(back).toHaveBeenCalledTimes(2)
    expect(window.location.hash).toBe('#/desk')
  })

  it('does not rewrite unchanged page and constitution names', () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.name('One', 'Constitution')
    const replace = vi.spyOn(window.history, 'replaceState')
    history.name('One', 'Constitution')
    expect(replace).not.toHaveBeenCalled()
  })

  it('pushes different pages and leaves a reselection untouched', () => {
    resetHash('#/board')
    const onRoute = vi.fn()
    const history = create(onRoute)
    history.start()
    const push = vi.spyOn(window.history, 'pushState')
    history.enter('one', 'host-a')
    expect(push).toHaveBeenCalledOnce()
    const entryLength = window.history.length
    history.openDocument('host-a:/store/report.html')
    history.openDocument('host-a:/store/report.html')
    expect(window.history.length).toBe(entryLength + 1)
    expect(parseRoute(window.location.hash)).toEqual({
      kind: 'channel', uid: 'one', owner: 'host-a', doc: 'host-a:/store/report.html',
    })
    expect(onRoute).toHaveBeenCalledTimes(3)
  })

  it('pops when a step would duplicate the preceding channel address', async () => {
    resetHash('#/desk')
    const history = create()
    history.start()
    history.enter('one', 'host', 'fiber')
    history.name('One', 'Constitution')
    history.enter('two', 'host', 'fiber')
    history.name('Two', 'Constitution')
    await nextPop(() => history.enter('one', 'host', 'fiber', undefined, true))
    expect(history.backLabel).toBe('Desk')
    await nextPop(() => history.back())
    expect(window.location.hash).toBe('#/desk')
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
    first.name('One', 'report.html', 'host:/store/report.html')
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
    history.openDocument('host:/store/report.html')
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
