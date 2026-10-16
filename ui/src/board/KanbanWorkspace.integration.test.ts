// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard } from './KanbanTypes.js'
import { card } from './testFixtures.js'
import { workspaceToken } from './workspace/measures.js'

interface WorkspaceBoard {
  launchFromDrag(card: KanbanCard): Promise<boolean>
  syncWorkspaceRuntime(): void
  workspace: { update(): void }
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

describe('Reader placement beneath the board bar', () => {
  it('makes the reader re-read its tokens when the map’s overhang changes', () => {
    const board = new KanbanModal({ shuttleBase: '' }) as unknown as {
      container: HTMLElement; tabsEl: HTMLElement; readerSlotEl: HTMLElement; placeReader(): void
    }
    const container = document.createElement('div'), bar = document.createElement('div'), slot = document.createElement('div')
    const reader = document.createElement('div')
    container.append(bar, slot, reader); document.body.append(container)
    Object.assign(board, { container, tabsEl: bar, readerSlotEl: slot })
    bar.getBoundingClientRect = () => new DOMRect(0, 0, 800, 40)
    let mapBottom = 52
    slot.getBoundingClientRect = () => new DOMRect(300, 20, 200, mapBottom - 20)
    board.placeReader()
    reader.style.setProperty('--ws-stage-top', 'first')
    expect(workspaceToken(reader, 'stage-top')).toBe('first')
    reader.style.setProperty('--ws-stage-top', 'second')
    board.placeReader()
    expect(workspaceToken(reader, 'stage-top')).toBe('first')
    mapBottom = 60
    board.placeReader()
    expect(container.style.getPropertyValue('--kbn-bar-overhang')).toBe('20px')
    expect(workspaceToken(reader, 'stage-top')).toBe('second')
    container.remove()
  })
})
