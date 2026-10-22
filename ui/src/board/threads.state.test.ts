// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { card } from './testFixtures.js'
import { ThreadIndex, threadState } from './threads.js'
import { installThreadPeek } from './ThreadPeek.js'
import { constitutionMentions } from './workspace/bodyLinks.js'
import { ThreadRail } from './workspace/ThreadRail.js'
import { deskColumn } from './deskColumn.js'
import type { KanbanCard } from './KanbanTypes.js'

const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard => card({ shuttleKind: 'oneshot', ...over })

describe('thread state honours the live worker before the draft rule', () => {
  it('an open constitution whose live worker is stopped on a prompt is waiting on Cail', () => {
    expect(threadState(thread({ id: 'a', status: 'open', workerState: 'running', runtimePhase: 'attention' }))).toBe('waiting')
    expect(threadState(thread({ id: 'b', status: 'open', workerState: 'running', runtimePhase: 'waiting' }))).toBe('waiting')
    expect(threadState(thread({ id: 'c', status: 'open', workerState: 'blocked' }))).toBe('waiting')
  })
  it('an open constitution whose live worker is mid-turn is working, resting horizon or not', () => {
    expect(threadState(thread({ id: 'a', status: 'open', workerState: 'running', runtimePhase: 'working' }))).toBe('working')
    expect(threadState(thread({ id: 'b', status: 'open', effectiveHorizon: 'stashed', workerState: 'running', runtimePhase: 'working' }))).toBe('working')
  })
  it('without a live worker an open constitution is a draft or resting, whatever stale runtime it carries', () => {
    expect(threadState(thread({ id: 'a', status: 'open' }))).toBe('drafts')
    expect(threadState(thread({ id: 'b', status: 'open', effectiveHorizon: 'stashed' }))).toBe('resting')
    expect(threadState(thread({ id: 'c', status: 'open', runtimePhase: 'attention' }))).toBe('drafts')
  })
  it('the family badge counts such a thread as waiting', () => {
    const root = thread({ id: 'hub', status: 'active' })
    const child = thread({ id: 'hub/child', orchestrator: 'hub', status: 'open', workerState: 'running', runtimePhase: 'attention' })
    expect(new ThreadIndex([root, child]).summary(root)).toMatchObject({ waiting: 1, drafts: 0 })
  })
})

describe('every thread surface names a thread the way the Desk files it', () => {
  // The three shapes a browser review caught disagreeing: the Desk said one
  // thing, the rail, peek, sub-entry or chip another.
  const spawned = thread({ id: 'hub/spawned', orchestrator: 'hub', status: 'active' })
  const standing = thread({ id: 'hub/standing', orchestrator: 'hub', status: 'active', shuttleKind: 'standing' })
  const seat = thread({ id: 'hub/seat', orchestrator: 'hub', status: 'open', shuttleSeat: true, shuttleRole: 'chair' })
  const asking = thread({ id: 'hub/asking', orchestrator: 'hub', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
  const hub = thread({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' })
  const expected: Array<[KanbanCard, string, string]> = [
    [spawned, 'inFlight', 'Working'], [standing, 'scheduled', 'Resting'], [seat, 'roles', 'Roles'], [asking, 'inFlight', 'Waiting'],
  ]
  it('an armed thread with no worker yet is Working, a standing one Resting, a seat Roles', () => {
    for (const [c, column, label] of expected) {
      expect(deskColumn(c)).toBe(column)
      expect(constitutionMentions([c])[0].state).toBe(label)
    }
  })
  it('the rail, the peek and the sub-entries all draw that label', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    try {
      const index = new ThreadIndex([hub, ...expected.map(([c]) => c)])
      const rail = new ThreadRail(vi.fn(), vi.fn()); rail.show(hub, index)
      const host = document.createElement('div'); installThreadPeek(host, host, hub, index, vi.fn())
      const labels = (root: ParentNode, scope: string) => Object.fromEntries([...root.querySelectorAll<HTMLElement>(`${scope} .kbn-thread-row`)]
        .map(row => [row.querySelector('.kbn-thread-name')!.textContent, row.querySelector('small')!.textContent]))
      const want = Object.fromEntries(expected.map(([c, , label]) => [c.name, label]))
      expect(labels(rail.el, '.ws-thread-tree > ul')).toEqual(want)
      // The waiting thread is a sub-entry; the peek draws the rest beneath it.
      expect(labels(host, '.kbn-thread-subentries')).toEqual({ [asking.name]: 'Waiting' })
      expect(labels(host, '.kbn-thread-family')).toEqual(want)
      expect([...host.querySelectorAll('.kbn-thread-peek h4')].map(h => h.textContent)).toEqual(['Working', 'Roles', 'Resting'])
      expect(host.querySelector('.kbn-thread-badge-waiting')).not.toBeNull()
    } finally { vi.unstubAllGlobals() }
  })
})
