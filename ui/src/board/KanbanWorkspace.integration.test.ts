// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { deskOrder } from './deskOrdering.js'
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
  deskProjection: ReturnType<typeof deskOrder>
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
      root.append(renderer.renderStashSection(order.resting, data.staleness))
      root.append(renderer.renderRolesSection(order.roles, data.staleness))
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
        expect(readerRows(board)).toEqual(['draft', 'working', 'review', 'resting/item', 'roles/seat', page.id])
        expect(stops.deskStop(page)).toBe('Open')
      }
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
