// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ovThreadRow, threadRow } from './threadRow.js'

const now = 1_800_000_000_000, hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()

describe('ovThreadRow', () => {
  it('draws a waiting thread as its dot, slug, run, what it wants and a chevron, and opens on a click', () => {
    const asked = card({ id: 'hub/q', name: 'Asked', status: 'active', dispatchedAt: when(3), handedOffAt: when(1), ask: { text: 'Which **one**?', at: when(1) } })
    const open = vi.fn()
    const row = ovThreadRow(asked, { waits: new Map(), now, open })
    expect([...row.children].map(part => part.className)).toStrictEqual(['constitution-state-dot', 'ov-slug', 'ov-time', 'ov-want', 'ov-open'])
    expect([row.dataset.attention, row.dataset.fiber, row.querySelector('.ov-slug')!.textContent, row.querySelector('.ov-want')!.textContent!.trim()]).toStrictEqual(['waiting', 'hub/q', 'q', 'Which one?'])
    row.click()
    expect(open).toHaveBeenCalledWith(asked)
  })
  it('says a quiet thread\'s faint word, and marks a thread drawn below another', () => {
    const seat = card({ id: 'office', column: 'roles' })
    const row = ovThreadRow(seat, { waits: new Map(), now, open: () => {}, deep: true })
    expect([row.className, row.querySelector('.ov-slug')!.textContent, row.querySelector('.ov-word')!.textContent]).toStrictEqual(['ov-thread ov-deep', '↳ office', 'seat'])
  })
})

describe('threadRow', () => {
  const parts = (row: HTMLElement) => [...row.children].map(part => [part.className, part.textContent])
  it('says what a thread is doing: what it wants, else what it last said, else its faint word or its turn, and when it last spoke', () => {
    const asked = card({ id: 'felt/ui-pass', name: 'UI pass', shuttleRole: 'felt-ui', status: 'active', ask: { text: 'Which **one**?', at: when(1) } })
    expect(parts(threadRow(asked, { waits: new Map(), now }))).toStrictEqual([
      ['constitution-state-dot', ''], ['thread-row-slug', 'ui-pass'], ['thread-row-role', 'felt-ui'], ['thread-row-doing', 'Which one?'], ['thread-row-age', '1h ago'],
    ])
    const busy = card({ id: 'felt', shuttleRole: 'felt/mill', status: 'active', workerState: 'running', runtimePhase: 'working', lastActivityAt: now - 2 * hour })
    expect(parts(threadRow(busy, { waits: new Map(), now, said: { text: 'Landed *it*.', at: now - 5 * 60_000 } }))).toStrictEqual([
      ['constitution-state-dot', ''], ['thread-row-slug', 'felt'], ['thread-row-doing', 'Landed it.'], ['thread-row-age', '5m ago'],
    ])
    expect(threadRow(busy, { waits: new Map(), now }).querySelector('.thread-row-doing')!.textContent).toBe('working')
    expect(threadRow(card({ id: 'office', column: 'roles' }), { waits: new Map(), now }).querySelector('.thread-row-doing')!.textContent).toBe('seat')
  })
  it('as a chip keeps its dot, slug and office; drawn still its dot is no button, and with an opener the row and dot open it', () => {
    const seat = card({ id: 'cmbx/expert', shuttleRole: 'cmbx-expert', column: 'roles' })
    expect(parts(threadRow(seat, { waits: new Map(), now, density: 'chip' })).map(([name]) => name)).toStrictEqual(['constitution-state-dot', 'thread-row-slug', 'thread-row-role'])
    expect(threadRow(seat, { waits: new Map(), now }).querySelector('button')).toBeNull()
    const open = vi.fn(), row = threadRow(seat, { waits: new Map(), now, open })
    row.querySelector<HTMLButtonElement>('button.constitution-state-dot')!.click()
    row.click()
    expect(open.mock.calls).toStrictEqual([[seat], [seat]])
  })
})
