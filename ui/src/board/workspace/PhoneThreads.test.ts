// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { phoneThreads } from './PhoneThreads.js'

const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
  card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })

describe('the phone thread page', () => {
  const feed = [
    thread({ id: 'hub', status: 'active' }),
    thread({ id: 'hub/a', orchestrator: 'hub', status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }),
    thread({ id: 'hub/b', orchestrator: 'hub', status: 'open' }),
    thread({ id: 'lone', status: 'open' }),
  ]
  const index = new ThreadIndex(feed)

  it('draws the family from its root, waiting threads first, the open thread marked', () => {
    const open = vi.fn()
    const page = phoneThreads(feed[2], index, open)!
    expect(page.querySelector('.ws-phone-threads-waiting')?.textContent).toContain('hub/a')
    expect(page.querySelector('.ws-phone-threads-root .kbn-thread-name')?.textContent).toBe('hub')
    expect([...page.querySelectorAll(':scope > ul .kbn-thread-name')].map(el => el.textContent)).toEqual(['hub/a', 'hub/b'])
    expect(page.querySelector('[aria-current="page"] .kbn-thread-name')?.textContent).toBe('hub/b')
    page.querySelector<HTMLButtonElement>('.ws-phone-threads-root')!.click()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'hub' }))
  })

  it('draws nothing for a constitution with no family', () => {
    expect(phoneThreads(feed[3], index, vi.fn())).toBeNull()
  })
})
