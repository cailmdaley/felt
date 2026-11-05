// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard } from './KanbanTypes.js'
import { card } from './testFixtures.js'

interface RestBoard {
  openRestPopover(card: KanbanCard): void
  commitRest(card: KanbanCard, until?: string): Promise<void>
  postJson: ReturnType<typeof vi.fn>
  fetchAndRender: ReturnType<typeof vi.fn>
  showBanner: ReturnType<typeof vi.fn>
}
function board(): RestBoard {
  const value = new KanbanModal({ shuttleBase: '' }) as unknown as RestBoard
  value.postJson = vi.fn().mockResolvedValue(undefined)
  value.fetchAndRender = vi.fn().mockResolvedValue(undefined)
  value.showBanner = vi.fn()
  return value
}
const stale = () => card({ id: 'work/task', shuttleHost: 'worker', originId: 'worker',
  localExit: true, originStale: { since: '2026-11-05T10:00:00Z' } })

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('offline Rest is not a waiting-condition edit', () => {
  it('sends plain Rest without offering --until controls on a stale card', async () => {
    const value = board()
    value.openRestPopover(stale())
    await Promise.resolve()
    expect(value.postJson).toHaveBeenCalledExactlyOnceWith('/api/v1/lifecycle', {
      action: 'rest', fiber: 'work/task', origin: 'worker',
    }, 'Rest failed')
    expect(document.querySelector('.kbn-rest-popover')).toBeNull()
  })
  it.each(['', '2026-12-01', 'work/blocker'])('requires the owner for an explicit until=%j', async until => {
    const value = board()
    await value.commitRest(stale(), until)
    expect(value.postJson).not.toHaveBeenCalled()
    expect(value.showBanner).toHaveBeenCalledWith(expect.stringContaining('owner'), 'info')
  })
  it('preserves healthy-board waiting-condition writes', async () => {
    const value = board()
    await value.commitRest(card({ id: 'work/task', originId: 'worker' }), '')
    expect(value.postJson).toHaveBeenCalledWith('/api/v1/lifecycle', {
      action: 'rest', fiber: 'work/task', origin: 'worker', until: '',
    }, 'Rest failed')
  })
})
