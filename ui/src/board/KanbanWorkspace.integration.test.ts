// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { threadIndexFor } from './threads.js'
import { deskOrder } from './deskOrdering.js'
import { card, response, settle } from './testFixtures.js'

interface WorkspaceBoard {
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
      const index = threadIndexFor(data), order = deskOrder(index, new Map())
      const renderer = new KanbanSurfaceRenderer({ waits: () => new Map(), openDetail: vi.fn(), clear: vi.fn() })
      // A top-level that waits itself is its card and its own line: one row.
      return [...new Set([...renderer.renderDesk(order, index).querySelectorAll<HTMLElement>('[data-fiber-id]')].map(el => el.dataset.fiberId!))]
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
      board.workspace.open(first.now.drafts[0], 'desk')
      expect(readerRows(board)).toEqual(deskRows(first))

      board.lastResponse = next
      board.render(next)
      expect(board.pendingDeskData).toBe(next)
      expect(readerRows(board)).toEqual(deskRows(next))

      board.workspace.returnToOrigin()
      expect([...new Set([...board.deskEl!.querySelectorAll<HTMLElement>('[data-fiber-id]')].map(el => el.dataset.fiberId))])
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
        board.workspace.open(page, 'desk')
        await settle()
        const stops = board.workspace as unknown as { deskStop(card: KanbanCard): string }
        expect(readerRows(board)).toEqual(['working', 'review', 'draft', 'resting/item', 'roles/seat', page.id])
        expect(stops.deskStop(page)).toBe('Open')
      }
    } finally {
      board.unmount()
    }
  })
})
