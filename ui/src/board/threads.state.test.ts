// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { card } from './testFixtures.js'
import { THREAD_LABEL, ThreadIndex, threadState, type ThreadState } from './threads.js'
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
  it('the rail draws each state label', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    try {
      const index = new ThreadIndex([hub, ...expected.map(([c]) => c)])
      const rail = new ThreadRail(vi.fn(), vi.fn()); rail.show(hub, index)
      // The rail names a state by its group's heading; the Desk's tree by the line's state, which its mark draws.
      const labels = (root: ParentNode, scope: string) => Object.fromEntries([...root.querySelectorAll<HTMLElement>(`${scope} .kbn-thread-row`)]
        .map(row => [row.querySelector('.kbn-thread-name')!.textContent, row.closest('details')?.querySelector('.ws-thread-group-label')?.textContent ?? THREAD_LABEL[row.dataset.threadState as ThreadState]]))
      const want = Object.fromEntries(expected.map(([c, , label]) => [c.name, label]))
      // The rail has no Roles group: a seat rests with Resting.
      expect(labels(rail.el, '.ws-thread-group')).toEqual({ ...want, [spawned.name]: 'Armed', [seat.name]: 'Resting' })
    } finally { vi.unstubAllGlobals() }
  })
})

describe('a family sits where the most urgent need in its tree puts it', () => {
  const root = (over: Partial<KanbanCard> = {}) => thread({ id: 'cmbx', status: 'active', workerState: 'running', runtimePhase: 'working', ...over })
  const kid = (id: string, over: Partial<KanbanCard>) => thread({ id: `cmbx/${id}`, orchestrator: 'cmbx', status: 'active', ...over })
  const working = (id: string) => kid(id, { workerState: 'running', runtimePhase: 'working' })
  const yours = (id: string) => kid(id, { workerState: 'running', runtimePhase: 'waiting' })
  const review = (id: string) => kid(id, { status: 'closed' })
  const place = (cards: KanbanCard[]) => {
    const index = new ThreadIndex(cards), rows = index.frontier()
    expect(rows).toHaveLength(1)
    const family = index.family(rows[0])
    return { lead: rows[0].id, need: family.need, askers: family.askers.map(c => c.id), others: family.others }
  }
  it('Your turn outranks a verdict, which outranks a live worker', () => {
    expect(place([root(), review('r'), yours('y')])).toMatchObject({ lead: 'cmbx/y', need: 'yours', others: { review: 1, working: 1 } })
    expect(place([root(), review('r'), working('w')])).toMatchObject({ lead: 'cmbx/r', need: 'review', others: { yours: 0, working: 2 } })
    expect(place([root({ workerState: undefined, runtimePhase: undefined, status: 'open', effectiveHorizon: 'stashed' }), working('w')]))
      .toMatchObject({ lead: 'cmbx/w', need: 'working', others: { working: 0 } })
  })
  it('the root leads when it holds the winning need itself, and its kin follow in tree order', () => {
    expect(place([root({ runtimePhase: 'waiting' }), yours('a'), yours('b'), working('w')]))
      .toEqual({ lead: 'cmbx', need: 'yours', askers: ['cmbx', 'cmbx/a', 'cmbx/b'], others: { yours: 2, review: 0, working: 1 } })
  })
  it('Working lists no sub-lines: the other workers are a count', () => {
    expect(place([root(), working('a'), working('b')])).toEqual({ lead: 'cmbx', need: 'working', askers: ['cmbx'], others: { yours: 0, review: 0, working: 2 } })
  })
  it('an armed root without a worker still leads a tree whose only life is a working thread', () => {
    expect(place([root({ workerState: undefined, runtimePhase: undefined }), working('w')])).toMatchObject({ lead: 'cmbx', need: 'working', others: { working: 1 } })
  })
  it('a quiet tree is its root, wherever the root rests', () => {
    expect(place([root({ status: 'open', effectiveHorizon: 'stashed', workerState: undefined, runtimePhase: undefined }), kid('d', { status: 'open' })]))
      .toEqual({ lead: 'cmbx', need: null, askers: ['cmbx'], others: { yours: 0, review: 0, working: 0 } })
  })
  it('every node of the tree reads the same family', () => {
    const cards = [root(), yours('y'), working('w')]
    const index = new ThreadIndex(cards)
    for (const c of cards) expect(index.family(c).lead.id).toBe('cmbx/y')
  })
})
