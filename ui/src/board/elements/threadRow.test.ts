// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { threadRow } from './threadRow.js'

const now = 1_800_000_000_000, hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()

describe('threadRow', () => {
  it('draws a waiting thread as its dot, slug, run, what it wants and a chevron, and opens on a click', () => {
    const asked = card({ id: 'hub/q', name: 'Asked', status: 'active', dispatchedAt: when(3), handedOffAt: when(1), ask: { text: 'Which **one**?', at: when(1) } })
    const open = vi.fn()
    const row = threadRow(asked, { waits: new Map(), now, open })
    expect([...row.children].map(part => part.className)).toStrictEqual(['constitution-state-dot', 'ov-slug', 'ov-time', 'ov-want', 'ov-open'])
    expect([row.dataset.attention, row.dataset.fiber, row.querySelector('.ov-slug')!.textContent, row.querySelector('.ov-want')!.textContent!.trim()]).toStrictEqual(['waiting', 'hub/q', 'q', 'Which one?'])
    row.click()
    expect(open).toHaveBeenCalledWith(asked)
  })
  it('says a quiet thread\'s faint word, and marks a thread drawn below another', () => {
    const seat = card({ id: 'office', column: 'roles' })
    const row = threadRow(seat, { waits: new Map(), now, open: () => {}, deep: true })
    expect([row.className, row.querySelector('.ov-slug')!.textContent, row.querySelector('.ov-word')!.textContent]).toStrictEqual(['ov-thread ov-deep', '↳ office', 'seat'])
  })
})
