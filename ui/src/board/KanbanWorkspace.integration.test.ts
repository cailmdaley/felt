// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { deskOrder } from './deskOrdering.js'
import type { MeetingRecord } from './meeting.js'
import { card, response } from './testFixtures.js'

interface WorkspaceBoard {
  launchFromDrag(card: KanbanCard): Promise<boolean>
  syncWorkspaceRuntime(): void
  mount(host: HTMLElement): void
  unmount(): void
  render(data: KanbanResponse): void
  fetchAndRender(): Promise<void>
  workspace: { update(): void; open(card: KanbanCard, origin?: string): void; returnToOrigin(): void; escapeHome(): void; reader?: { el: HTMLElement } }
  lastResponse: KanbanResponse | null
  pendingDeskData: KanbanResponse | null
  meetingStatus: { meeting: MeetingRecord | null }
  deskProjection: ReturnType<typeof deskOrder>
  presentMeeting(): void
  deskEl: HTMLDivElement | null
  workspaceCards(): KanbanCard[]
}
beforeEach(() => { vi.stubGlobal('innerWidth', 1440) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const flushTasks = async (): Promise<void> => { for (let i = 0; i < 200; i++) await Promise.resolve() }

describe('Desk runtime handoff to the workspace', () => {
  it('updates the workspace without querying the band manager as an open Dock', () => {
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    const update = vi.fn()
    board.workspace = { update, open: vi.fn(), returnToOrigin: vi.fn(), escapeHome: vi.fn() }
    Object.defineProperty(board, 'dock', { get: () => { throw new Error('The band manager has no open card') } })
    board.syncWorkspaceRuntime()
    expect(update).toHaveBeenCalledOnce()
  })
})

describe('Desk dispatch into the document workspace', () => {
  it('explains a booting dispatch refusal on the Desk drag path and sends no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'booting', ready: false }), { status: 503 })))
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    await expect(board.launchFromDrag(card({ id: 'work/task', originId: 'owner' })))
      .rejects.toThrow('The daemon is starting. Nothing was launched; try again shortly.')
    expect(fetch).toHaveBeenCalledOnce()
    const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(payload).toMatchObject({ fiber_id: 'work/task', origin: 'owner', force: true, ad_hoc: true, resume_mode: 'fresh' })
    expect(payload).not.toHaveProperty('user_message')
  })
})

describe('Desk rows in the document workspace', () => {
  const readerRows = (board: WorkspaceBoard): string[] =>
    (board.workspace.reader as unknown as { deskCards(): KanbanCard[] }).deskCards().map(item => item.id)

  it('keeps Reader navigation in Desk order before, during, and after a poll', () => {
    const make = (lateDue: string): KanbanResponse => response({
      now: {
        drafts: [card({ id: 'draft' })],
        inFlight: [
          card({ id: 'flight', status: 'active', workerState: 'running', runtimePhase: 'working' }),
          card({ id: 'turn', status: 'active', workerState: 'running', runtimePhase: 'waiting' }),
        ],
        awaitingReview: [card({ id: 'review', status: 'closed' })],
      },
      roles: [card({ id: 'roles/editor', shuttleSeat: true, shuttleRole: 'editor' })],
      stash: [
        card({ id: 'zeta/watch', createdAt: '2026-10-01T00:00:00Z', effectiveHorizon: 'stashed' }),
        card({ id: 'alpha/dated-late', due: lateDue, createdAt: '2026-10-02T00:00:00Z', effectiveHorizon: 'stashed' }),
        card({ id: 'alpha/watch', createdAt: '2026-10-03T00:00:00Z', effectiveHorizon: 'stashed' }),
        card({ id: 'alpha/dated-soon', due: '2026-10-30', createdAt: '2026-10-01T00:00:00Z', effectiveHorizon: 'stashed' }),
      ],
    })
    const deskRows = (data: KanbanResponse): string[] => {
      const order = deskOrder(data)
      const renderer = new KanbanSurfaceRenderer({
        getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
        stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn(),
      })
      const root = document.createElement('div')
      root.append(renderer.renderNowSection(order.now, data.staleness))
      root.append(renderer.renderRolesSection(order.roles, data.staleness))
      root.append(renderer.renderStashSection(order.resting, data.staleness))
      return [...root.querySelectorAll<HTMLElement>('[data-fiber-id]')].map(el => el.dataset.fiberId!)
    }
    const first = make('2026-11-02')
    const next = make('2026-10-31')
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.fetchAndRender = vi.fn(async () => {})
    window.history.replaceState(null, '', '#/desk')
    board.mount(document.body)
    try {
      board.lastResponse = first
      board.render(first)
      board.workspace.open(first.now.drafts[0], 'Desk')
      expect(readerRows(board)).toEqual(deskRows(first))

      board.lastResponse = next
      board.render(next)
      expect(board.pendingDeskData).toBe(next)
      expect(readerRows(board)).toEqual(deskRows(next))

      board.workspace.returnToOrigin()
      expect([...board.deskEl!.querySelectorAll<HTMLElement>('[data-fiber-id]')].map(el => el.dataset.fiberId))
        .toEqual(deskRows(next))
      expect(readerRows(board)).toEqual(deskRows(next))
    } finally {
      board.unmount()
    }
  })

  it('keeps a hosted meeting card in the same Desk and Reader position', async () => {
    const host = card({ id: 'draft' })
    const otherDraft = card({ id: 'other-draft' })
    const working = card({ id: 'working', status: 'active', workerState: 'running', runtimePhase: 'working' })
    const turn = card({ id: 'turn', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
    const review = card({ id: 'review', status: 'closed' })
    const data = response({ now: { drafts: [otherDraft, host], inFlight: [working, turn], awaitingReview: [review] } })
    const meeting: MeetingRecord = {
      state: 'live', title: null, started_at: null, tail: [], transcript: null, mirror_host: null,
      fiber: host.id, joined: false, phone: false, launch: null, tmux_session: null, error: null,
    }
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.fetchAndRender = vi.fn(async () => {})
    window.history.replaceState(null, '', '#/desk')
    board.mount(document.body)
    try {
      board.meetingStatus.meeting = meeting
      board.lastResponse = data
      board.render(data)
      const drawn = [...board.deskEl!.querySelectorAll<HTMLElement>('[data-fiber-id]')].map(el => el.dataset.fiberId)
      board.workspace.open(host, 'Desk')
      await flushTasks()
      expect(drawn).toEqual(['other-draft', 'turn', 'draft', 'working', 'review'])
      expect(readerRows(board)).toEqual(drawn)
    } finally {
      board.unmount()
    }
  })

  it('refreshes Reader columns through meeting start and end without changing row order', async () => {
    const host = card({ id: 'draft-host' })
    const working = card({ id: 'working', status: 'active', workerState: 'running', runtimePhase: 'working' })
    const data = response({ now: { drafts: [host], inFlight: [working], awaitingReview: [] } })
    const meeting: MeetingRecord = {
      state: 'live', title: null, started_at: null, tail: [], transcript: null, mirror_host: null,
      fiber: host.id, joined: false, phone: false, launch: null, tmux_session: null, error: null,
    }
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.fetchAndRender = vi.fn(async () => {})
    window.history.replaceState(null, '', '#/desk')
    board.mount(document.body)
    try {
      board.lastResponse = data
      board.render(data)
      board.workspace.open(host, 'Desk')
      await flushTasks()
      const stops = board.workspace as unknown as { deskStop(card: KanbanCard): string }
      expect(stops.deskStop(host)).toBe('Drafts')
      expect(readerRows(board)).toEqual(['draft-host', 'working'])

      const rolePage = card({ id: 'roles/editor', shuttleSeat: true, shuttleRole: 'editor' })
      board.workspace.open(rolePage, 'Desk')
      await flushTasks()
      expect(stops.deskStop(host)).toBe('Drafts')

      board.workspace.update()
      board.meetingStatus.meeting = meeting
      board.presentMeeting()

      expect(readerRows(board).filter(id => id !== rolePage.id)).toEqual(['draft-host', 'working'])
      expect(stops.deskStop(host)).toBe('In flight')

      board.meetingStatus.meeting = null
      board.presentMeeting()

      expect(readerRows(board).filter(id => id !== rolePage.id)).toEqual(['draft-host', 'working'])
      expect(stops.deskStop(host)).toBe('Drafts')
    } finally {
      board.unmount()
    }
  })

  it('keeps Desk order and gives an unplaced Reader page an Open stop', async () => {
    const data = response({
      now: {
        drafts: [card({ id: 'draft' })],
        inFlight: [card({ id: 'working', status: 'active', workerState: 'running', runtimePhase: 'working' })],
        awaitingReview: [card({ id: 'review', status: 'closed' })],
      },
      roles: [card({ id: 'roles/seat', shuttleSeat: true, shuttleRole: 'editor', shuttleKind: 'oneshot' })],
      stash: [card({ id: 'resting/item', effectiveHorizon: 'stashed' })],
    })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.fetchAndRender = vi.fn(async () => {})
    window.history.replaceState(null, '', '#/desk')
    board.mount(document.body)
    try {
      board.lastResponse = data
      board.render(data)
      for (const page of [card({ id: 'notes/x' }), card({ id: 'roles/editor' })]) {
        board.workspace.open(page, 'Desk')
        await flushTasks()
        const stops = board.workspace as unknown as { deskStop(card: KanbanCard): string }
        expect(readerRows(board)).toEqual(['draft', 'working', 'review', 'roles/seat', 'resting/item', page.id])
        expect(stops.deskStop(page)).toBe('Open')
      }
    } finally {
      board.unmount()
    }
  })

  it('reuses the current projection on a same-host meeting poll and redraws only if the Desk has no list', () => {
    const host = card({ id: 'meeting-host' })
    const data = response({ now: { drafts: [host], inFlight: [], awaitingReview: [] } })
    const meeting: MeetingRecord = {
      state: 'live', title: null, started_at: null, tail: [], transcript: null, mirror_host: null,
      fiber: host.id, joined: false, phone: false, launch: null, tmux_session: null, error: null,
    }
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.fetchAndRender = vi.fn(async () => {})
    window.history.replaceState(null, '', '#/desk')
    board.mount(document.body)
    try {
      board.meetingStatus.meeting = meeting
      board.lastResponse = data
      board.render(data)
      expect(board.deskEl!.hasChildNodes()).toBe(true)
      expect(board.deskEl!.querySelector('.kbn-card--meeting')).not.toBeNull()
      const projection = board.deskProjection
      const sync = vi.spyOn(board as any, 'syncWorkspaceRuntime')

      board.meetingStatus.meeting = { ...meeting, tail: ['12:00:00 S1  Still recording'] }
      board.presentMeeting()

      expect(board.deskProjection).toBe(projection)
      expect(sync).not.toHaveBeenCalled()

      board.deskEl!.replaceChildren()
      board.presentMeeting()

      expect(sync).toHaveBeenCalledOnce()
      expect(board.deskEl!.querySelector('.kbn-section-now')).not.toBeNull()
    } finally {
      board.unmount()
    }
  })

  it('keeps the Desk projection stable across same-host meeting polls while Reader defers the draw', async () => {
    const host = card({ id: 'meeting-host' })
    const data = response({ now: { drafts: [host], inFlight: [], awaitingReview: [] } })
    const meeting: MeetingRecord = {
      state: 'live', title: null, started_at: null, tail: [], transcript: null, mirror_host: null,
      fiber: host.id, joined: false, phone: false, launch: null, tmux_session: null, error: null,
    }
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.fetchAndRender = vi.fn(async () => {})
    window.history.replaceState(null, '', '#/desk')
    board.mount(document.body)
    try {
      board.lastResponse = data
      board.render(data)
      board.workspace.open(host, 'Desk')
      await flushTasks()
      const sync = vi.spyOn(board as any, 'syncWorkspaceRuntime')

      board.meetingStatus.meeting = meeting
      board.presentMeeting()
      const projection = board.deskProjection
      expect(sync).toHaveBeenCalledOnce()

      board.meetingStatus.meeting = { ...meeting, tail: ['12:00:00 S1  Still recording'] }
      board.presentMeeting()

      expect(board.deskProjection).toBe(projection)
      expect(sync).toHaveBeenCalledOnce()

      board.workspace.escapeHome()
      await flushTasks()
      expect(board.deskEl!.querySelector('.kbn-card--meeting')).not.toBeNull()
      expect(sync).toHaveBeenCalledTimes(2)
    } finally {
      board.unmount()
    }
  })

  it('keeps cycle ghosts out of the stepping order', () => {
    const draft = card({ id: 'draft' })
    const restingFirst = card({ id: 'resting/first', effectiveHorizon: 'stashed' })
    const restingSecond = card({ id: 'resting/second', effectiveHorizon: 'stashed' })
    const seat = card({ id: 'roles/editor', shuttleSeat: true, shuttleRole: 'editor' })
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.lastResponse = response({
      now: { drafts: [draft], inFlight: [], awaitingReview: [] },
      stash: [restingFirst, restingSecond],
      roles: [seat],
    })
    board.deskProjection = deskOrder(board.lastResponse)
    const deskEl = document.createElement('div')
    board.deskEl = deskEl
    const deskRow = (item: KanbanCard, className: string): HTMLElement => {
      const element = document.createElement('article')
      element.className = className
      element.dataset.fiberId = item.id
      element.dataset.cardOrigin = item.originId
      element.dataset.cardUid = item.uid ?? item.id
      return element
    }
    // Desk rows use different classes for each region. The lens displays a
    // Resting card in Drafts, but that illustration cannot set row order.
    deskEl.append(
      deskRow(restingFirst, 'kbn-card kbn-card--lens-ghost'),
      deskRow(draft, 'kbn-card'),
      deskRow(seat, 'kbn-role-chip'),
      deskRow(restingSecond, 'kbn-cluster-item'),
      deskRow(restingFirst, 'kbn-cluster-item'),
    )

    expect(board.workspaceCards()).toBe(board.deskProjection.rows)
    expect(board.workspaceCards().map(item => item.id)).toEqual(deskOrder(board.lastResponse).rows.map(item => item.id))
  })
})

describe('the Desk\'s map', () => {
  const stored = new Map<string, string>()
  beforeEach(() => {
    stored.clear()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
    window.location.hash = ''
  })
  const data = response({ now: { drafts: [], inFlight: [card({ id: 'flight', status: 'active', workerState: 'running', runtimePhase: 'working', shuttleKind: 'oneshot' })], awaitingReview: [] } })
  const opened = (): { board: WorkspaceBoard; host: HTMLElement } => {
    const host = document.createElement('div'), board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    document.body.append(host)
    board.mount(host)
    board.lastResponse = data
    board.render(data)
    return { board, host }
  }
  const tab = (host: HTMLElement): string | undefined => host.querySelector<HTMLElement>('.kbn-viewtab-active')?.dataset.view

  it('turns the In flight column into the map, keeps the Desk tab lit and is remembered', () => {
    const { board, host } = opened()
    expect(host.querySelectorAll('.kbn-col-map').length).toBe(1)
    expect(host.querySelector('.kbn-viewtab[data-view="map"]')).toBeNull()
    host.querySelector<HTMLElement>('.kbn-col-map')!.click()
    expect(host.querySelector('.ws-family-page')).not.toBeNull()
    expect(board.deskEl!.style.display).toBe('none')
    expect(tab(host)).toBe('desk')
    board.unmount()
    host.remove()
    const again = opened()
    expect(again.host.querySelector('.ws-family-page')).not.toBeNull()
    again.board.unmount()
    again.host.remove()
  })
  it('flies to the thread Rex moves to and leaves the reader shut', () => {
    stored.set('shuttle.desk.map', '1')
    const { board, host } = opened(), follow = vi.spyOn(board.workspace as unknown as { follow(id: string, owner: string): void }, 'follow')
    ;(board as unknown as { voice: { onRex(target: { fiber_id: string; origin: string }): void } }).voice.onRex({ fiber_id: 'flight', origin: 'local' })
    expect(follow).not.toHaveBeenCalled()
    expect(host.querySelector('.fm-star[data-worker]')?.getAttribute('aria-label')).toMatch(/^flight,/)
    const see = vi.spyOn((board as unknown as { voice: { see(card: KanbanCard | null): void } }).voice, 'see')
    host.querySelector<HTMLElement>('.fm-star[data-root]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(see).toHaveBeenLastCalledWith(null)
    board.unmount()
    host.remove()
  })
  it('comes back to the cards, and stays there', () => {
    stored.set('shuttle.desk.map', '1')
    const { board, host } = opened()
    const desk = [...host.querySelectorAll<HTMLButtonElement>('.ws-family-drawing')].find(button => button.textContent === 'Desk')!
    desk.click()
    expect(board.deskEl!.style.display).toBe('')
    expect(host.querySelector('.ws-family-page')).toBeNull()
    expect(stored.has('shuttle.desk.map')).toBe(false)
    board.unmount()
    host.remove()
  })
})
