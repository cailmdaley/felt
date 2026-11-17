// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { threadRow } from './threadRow.js'

const now = 1_800_000_000_000, hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()

describe('threadRow', () => {
  const parts = (row: HTMLElement) => [...row.children].map(part => [part.className.replace('el-time ', ''), part.textContent])
  it('says what a thread is doing: what it wants, else what it last said, else its faint word or its turn, and when it last spoke', () => {
    const asked = card({ id: 'felt/ui-pass', name: 'UI pass', shuttleRole: 'felt-ui', status: 'active', ask: { text: 'Which **one**?', at: when(1) } })
    expect(parts(threadRow(asked, { waits: new Map(), now }))).toStrictEqual([
      ['constitution-state-dot', ''], ['thread-row-slug', 'ui-pass'], ['thread-row-role', 'felt-ui'], ['thread-row-doing', 'Which one?'], ['thread-row-age', '1h ago'],
    ])
    const busy = card({ id: 'felt', shuttleRole: 'felt/mill', status: 'active', workerState: 'running', runtimePhase: 'working', lastActivityAt: now - 2 * hour })
    expect(parts(threadRow(busy, { waits: new Map(), now, said: { text: 'Landed *it*.', at: now - 5 * 60_000 } }))).toStrictEqual([
      ['constitution-state-dot', ''], ['thread-row-slug', 'felt'], ['thread-row-doing', 'Landed it.'], ['thread-row-age', '5m ago'],
    ])
    // Working with nothing said: its turn's word, timed from its launch.
    const launched = threadRow({ ...busy, dispatchedAt: when(23) }, { waits: new Map(), now })
    expect([launched.querySelector('.thread-row-doing')!.textContent, launched.querySelector('.thread-row-age')!.textContent]).toStrictEqual(['working', '23h ago'])
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
