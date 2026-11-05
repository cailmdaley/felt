// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { card, response } from './testFixtures.js'
import { Verdicts } from './workspace/Verdicts.js'
import { canExitOffline } from './offlineExits.js'
import { moveDestinations } from './MoveDestinations.js'
import { sessionVerbsFor } from './workspace/lifecycleVerbs.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'

function renderer(stopWorker = vi.fn()): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => null,
    stopDragAutoScroll: () => {},
    transition: vi.fn(),
    setSurface: () => {},
    openDetail: () => {},
    stopWorker,
  })
}

describe('verdict actions ride cards awaiting review and in flight', () => {
  it('keeps an unreadable owner document visibly stale and its worker stoppable', async () => {
    const feed = parseCompositeFeed({ host: 'hub', fibers: [{ origin: 'hub', document_stale: true, felt_store: '/store', path: 'work/task/task.md',
      fiber: { id: 'work/task', uid: 'task-uid', status: 'active', name: 'Conflicted work', shuttle: { kind: 'oneshot', host: 'hub' } },
      runtime: { state: 'running', tmux_session: 'known-worker' },
    }], origins: { hub: { kind: 'local', stale: false } } })
    const conflicted = cardFromCompositeEntry(feed.entries[0])
    expect(conflicted.documentStale).toBe(true)
    expect(conflicted.originStale).toBeDefined()
    const stop = vi.fn(), surfaces = renderer(stop)
    const actions = surfaces.rowActions(conflicted, true, document.createElement('div'))
    expect(actions.filter(action => !action.disabled).map(action => action.label)).toEqual(['Stop worker'])
    await actions.find(action => action.label === 'Stop worker')!.run!()
    expect(stop).toHaveBeenCalledWith(conflicted)
    const root = surfaces.renderNowSection({ drafts: [], inFlight: [conflicted], awaitingReview: [] }, { hub: { status: 'fresh' } })
    const row = root.querySelector<HTMLElement>('[data-fiber-id="work/task"]')!
    expect(row.classList.contains('kbn-card--stale')).toBe(true)
    expect(row.draggable).toBe(false)
  })
  it('keeps exits and planning drag on an offline draft, but never offers a launch', () => {
    const draft = card({ id: 'offline', status: 'open', shuttleKind: 'oneshot', originId: 'worker',
      shuttleHost: 'worker', localExit: true, originStale: { since: '2026-11-04T19:00:00Z' } })
    const surfaces = renderer()
    const actions = surfaces.rowActions(draft, true, document.createElement('div'))
    expect(actions.filter(action => !action.disabled).map(action => action.label)).toContain('Discard')
    expect(actions.find(action => action.disabled)?.label).toContain('travels by Git')
    expect(sessionVerbsFor(draft)).toEqual([])
    expect(moveDestinations(draft, 'drafts').map(dest => dest.id)).not.toContain('inFlight')
    const root = surfaces.renderNowSection({ drafts: [draft], inFlight: [], awaitingReview: [] }, { worker: { status: 'stale' } })
    const row = root.querySelector<HTMLElement>('[data-fiber-id="offline"]')!
    expect(row.draggable).toBe(true)
    expect(row.getAttribute('aria-label')).toContain('An exit can be saved')
    expect(row.classList.contains('kbn-card--stale')).toBe(true)
  })

  it('does not promise planning saves without a quiescent local copy, or launch an unowned archive', () => {
    const archived = card({ id: 'archive', status: 'closed', tempered: true, shuttleKind: 'oneshot', shuttleHost: '' })
    expect(sessionVerbsFor(archived)).toEqual([])
    expect(moveDestinations(archived, 'tempered').map(dest => dest.id)).not.toContain('inFlight')
    const remoteOnly = { ...archived, originStale: { since: '2026-11-04T19:00:00Z' }, shuttleHost: 'worker', localExit: false }
    expect(canExitOffline(remoteOnly)).toBe(false)
    expect(renderer().rowActions(remoteOnly, true, document.createElement('div')).filter(action => !action.disabled)).toEqual([])
    expect(moveDestinations(remoteOnly, 'tempered')).toEqual([])
  })

  it('names why armed or possibly live stale cards cannot mutate execution', () => {
    for (const changes of [{ status: 'active' }, { dispatchedAt: '2026-11-04T19:00:00Z' }, { sessionUuid: 'possibly-live' }, { workerState: 'running' as const }]) {
      const unsafe = card({ id: 'unsafe', shuttleKind: 'oneshot', originStale: { since: '2026-11-04T19:00:00Z' }, ...changes })
      expect(canExitOffline(unsafe)).toBe(false)
      const actions = renderer().rowActions(unsafe, true, document.createElement('div'))
      expect(actions.filter(action => !action.disabled)).toEqual([])
      expect(actions[0].label).toContain('The owner decides')
      expect(moveDestinations(unsafe, null)).toEqual([])
    }
  })

  it('offers the header verbs on review and in-flight cards, none on a plain note', () => {
    const data = response({ now: {
      drafts: [card({ id: 'draft' })],
      inFlight: [card({ id: 'flight', status: 'active', shuttleKind: 'oneshot' })],
      awaitingReview: [card({ id: 'review', status: 'closed', shuttleKind: 'oneshot' })],
    } })
    const surfaces = renderer()
    const root = surfaces.renderNowSection(data.now, data.staleness)
    document.body.append(root)
    try {
      for (const id of ['draft', 'flight', 'review']) {
        expect(root.querySelector(`[data-fiber-id="${id}"] .kbn-card-menu`)).toBeNull()
        root.querySelector<HTMLElement>(`[data-fiber-id="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        const actions = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        // The header's verbs for each place: work in flight can also be closed for review; a plain note takes none.
        expect([...actions].map(button => button.textContent)).toEqual({ draft: [], flight: ['Close for review', 'Temper', 'Discard'], review: ['Temper', 'Discard'] }[id])
        expect([...actions].every(button => button.type === 'button')).toBe(true)
        surfaces.closeMenu()
      }
    } finally { surfaces.closeMenu(); document.body.replaceChildren() }
  })
  it('waits out every Desk verdict on the card\'s own foot, whatever the column', async () => {
    vi.useFakeTimers()
    const draft = card({ id: 'draft', uid: 'draft-uid' }), review = card({ id: 'review', status: 'closed' })
    const data = response({ now: { drafts: [draft], inFlight: [], awaitingReview: [review] } })
    const root = renderer().renderNowSection(data.now, data.staleness)
    document.body.append(root)
    const verdicts = new Verdicts()
    try {
      verdicts.queue(review, 'tempered', vi.fn())
      verdicts.queue(draft, 'composted', vi.fn())
      const foot = (id: string) => root.querySelector<HTMLElement>(`[data-fiber-id="${id}"] .kbn-card-meta`)!
      expect(foot('review').querySelector(':scope > .ws-verdict-undo')?.textContent).toBe('Tempered·undo z')
      expect(foot('draft').querySelector(':scope > .ws-verdict-undo')?.textContent).toBe('Discarded·undo z')
      // A re-render mid-window keeps the line on the rebuilt card.
      const again = renderer().renderNowSection(data.now, data.staleness)
      root.replaceWith(again); await Promise.resolve()
      expect(again.querySelectorAll('.kbn-card-meta > .ws-verdict-undo')).toHaveLength(2)
    } finally { verdicts.dispose(); document.body.replaceChildren(); vi.useRealTimers() }
  })
})
