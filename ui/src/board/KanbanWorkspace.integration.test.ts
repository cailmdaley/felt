// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'

interface WorkspaceBoard {
  launchFromDrag(card: KanbanCard): Promise<boolean>
  syncWorkspaceRuntime(): void
  workspace: { update(): void }
  lastResponse: KanbanResponse | null
  pendingDeskData: KanbanResponse | null
  deskEl: HTMLDivElement | null
  workspaceCards(): KanbanCard[]
  workspaceDeskRows(): KanbanCard[]
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Desk runtime handoff to the workspace', () => {
  it('updates the workspace without querying the band manager as an open Dock', () => {
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    const update = vi.fn()
    board.workspace = { update }
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
  it('keeps cycle ghosts out of the sidebar order', () => {
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

    const expected = ['draft', 'roles/editor', 'resting/second', 'resting/first']
    expect(board.workspaceCards().map(item => item.id)).toEqual(expected)
    expect(board.workspaceDeskRows().map(item => item.id)).toEqual(expected)
  })

  it('uses fresh projected order while the Desk DOM is parked', () => {
    const completed = card({ id: 'completed', status: 'closed', effectiveHorizon: 'now' })
    const remaining = card({ id: 'remaining' })
    const running = card({ id: 'running', status: 'active', workerState: 'running' })
    const fresh = response({
      now: { drafts: [remaining], inFlight: [running], awaitingReview: [completed] },
    })
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as WorkspaceBoard
    board.lastResponse = fresh
    board.pendingDeskData = fresh
    const deskEl = document.createElement('div')
    board.deskEl = deskEl
    for (const item of [completed, remaining, running]) {
      const element = document.createElement('article')
      element.className = 'kbn-card'
      element.dataset.fiberId = item.id
      element.dataset.cardOrigin = item.originId
      element.dataset.cardUid = item.uid ?? item.id
      deskEl.append(element)
    }

    expect(board.workspaceDeskRows().map(item => item.id)).toEqual([
      'remaining', 'running', 'completed',
    ])
  })
})
