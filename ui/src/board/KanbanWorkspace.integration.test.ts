// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard } from './KanbanTypes.js'
import { card } from './testFixtures.js'

interface WorkspaceBoard {
  launchFromDrag(card: KanbanCard): Promise<boolean>
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
