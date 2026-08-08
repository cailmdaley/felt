// What a view can OPEN is a wider set than what it ITERATES.
//
// `ctx.cards` is the eight work surfaces; cycles are annotations and live only
// in `response.cycles`. Clicking a cycle band therefore hands `openCard` an id
// that the cards list has never heard of — which used to resolve to nothing,
// silently, with no throw and no log. These pin both halves of the fix: cycles
// resolve, and an id that resolves nowhere says so.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenTarget } from './KanbanModal.js'
import type { KanbanCard } from './KanbanTypes.js'

function card(id: string, over: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id,
    name: id,
    originId: 'local',
    status: 'open',
    effectiveHorizon: 'now',
    drifted: false,
    isCycle: false,
    cycleStart: null,
    ...over,
  } as KanbanCard
}

const WORK = [card('work/a/run'), card('work/b/triage')]
const CYCLES = [
  card('loom/cycles/sprint-14', { isCycle: true, cycleStart: '2026-08-03', due: '2026-08-16' }),
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveOpenTarget', () => {
  it('finds a card on the work surfaces', () => {
    expect(resolveOpenTarget('work/b/triage', WORK, CYCLES)?.id).toBe('work/b/triage')
  })

  it('finds a CYCLE, which appears on no work surface', () => {
    // The bug: a cycle is absent from ctx.cards by design, so this lookup has
    // to reach past it or every band and chip click is dead.
    expect(WORK.some((c) => c.id === 'loom/cycles/sprint-14')).toBe(false)
    const found = resolveOpenTarget('loom/cycles/sprint-14', WORK, CYCLES)
    expect(found?.id).toBe('loom/cycles/sprint-14')
    expect(found?.isCycle).toBe(true)
  })

  it('warns, rather than failing silently, when an id resolves nowhere', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveOpenTarget('work/ghost', WORK, CYCLES)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    // The id has to be IN the message — a warning that does not say which id
    // missed sends you back to the browser, which is where this started.
    expect(String(warn.mock.calls[0][0])).toContain('work/ghost')
  })

  it('does not warn on a hit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveOpenTarget('work/a/run', WORK, CYCLES)
    resolveOpenTarget('loom/cycles/sprint-14', WORK, CYCLES)
    expect(warn).not.toHaveBeenCalled()
  })

  it('prefers work over a cycle sharing an id, and tolerates empty cycles', () => {
    const shared = card('shared', { name: 'the work one' })
    const shadow = card('shared', { name: 'the cycle one', isCycle: true })
    expect(resolveOpenTarget('shared', [shared], [shadow])?.name).toBe('the work one')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveOpenTarget('work/a/run', WORK, [])?.id).toBe('work/a/run')
    expect(resolveOpenTarget('loom/cycles/sprint-14', WORK, [])).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
