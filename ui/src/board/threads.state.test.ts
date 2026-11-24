// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { card } from './testFixtures.js'
import { THREAD_LABEL, ThreadIndex, threadState } from './threads.js'
import { constitutionMentions } from './workspace/bodyLinks.js'
import { deskFamily } from './deskOrdering.js'
import { FamilyPage } from './workspace/FamilyPage.js'
import type { KanbanCard } from './KanbanTypes.js'

const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard => card({ shuttleKind: 'oneshot', ...over })

describe('thread state honours the live worker before the draft rule', () => {
  it('an open constitution with a live worker is in flight, whatever its turn and however it rests', () => {
    for (const over of [{ runtimePhase: 'attention' }, { runtimePhase: 'waiting' }, { runtimePhase: 'working' }, { runtimePhase: 'working', effectiveHorizon: 'stashed' }, { workerState: 'blocked' }] as const) {
      expect(threadState(thread({ id: 'a', status: 'open', workerState: 'running', ...over }))).toBe('in-flight')
    }
  })
  it('without a live worker an open constitution is a draft or resting, whatever stale runtime it carries', () => {
    expect(threadState(thread({ id: 'a', status: 'open' }))).toBe('drafts')
    expect(threadState(thread({ id: 'b', status: 'open', effectiveHorizon: 'stashed' }))).toBe('resting')
    expect(threadState(thread({ id: 'c', status: 'open', runtimePhase: 'attention' }))).toBe('drafts')
  })
  it('its family waits for such a thread', () => {
    const root = thread({ id: 'hub', status: 'active' })
    const child = thread({ id: 'hub/child', orchestrator: 'hub', status: 'open', workerState: 'running', runtimePhase: 'attention' })
    expect(deskFamily(new ThreadIndex([root, child]), root, new Map()).waits.map(wait => wait.card.id)).toEqual(['hub/child'])
  })
})

describe('every thread surface names a thread the way the Desk files it', () => {
  // The three shapes a browser review caught disagreeing: the Desk said one
  // thing, the family page, peek, sub-entry or chip another.
  const spawned = thread({ id: 'hub/spawned', orchestrator: 'hub', status: 'active' })
  const standing = thread({ id: 'hub/standing', orchestrator: 'hub', status: 'active', shuttleKind: 'standing' })
  const seat = thread({ id: 'hub/seat', orchestrator: 'hub', status: 'open', shuttleSeat: true, shuttleRole: 'chair' })
  const asking = thread({ id: 'hub/asking', orchestrator: 'hub', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
  const hub = thread({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' })
  const expected: Array<[KanbanCard, string, string]> = [
    [spawned, 'inFlight', 'Quiet'], [standing, 'resting', '↻'], [seat, 'roles', 'seat'], [asking, 'inFlight', 'Working'],
  ]
  it('an armed thread with no worker yet is quiet, a standing one says its next run, a seat seat, an idle worker that asked nothing Working', () => {
    for (const [c, column, label] of expected) {
      expect(c.column).toBe(column)
      expect(constitutionMentions([c], new Map())[0].state).toBe(label)
    }
  })
  it('the constitution\'s view gives a quiet thread its faint word in its quiet fold, else its turn\'s word, as every thread row does', () => {
    const index = new ThreadIndex([hub, ...expected.map(([c]) => c)])
    const page = new FamilyPage({ marks: () => undefined, reach: () => 14 * 86_400_000, files: () => [], refresh: () => {}, lead: async () => undefined, said: () => undefined, open: () => {}, link: () => {}, view: () => {}, seen: () => {}, waits: () => new Map(), shuttleBase: '' }, () => {}); page.update(hub, index)
    page.el.querySelector<HTMLButtonElement>('.ov-quiet')!.click()
    const words = Object.fromEntries([...page.el.querySelectorAll<HTMLElement>('.ov-thread')].map(row => [row.dataset.fiber, row.querySelector('.thread-row-doing')?.textContent]))
    expect(words).toEqual({ [spawned.id]: 'no worker', [standing.id]: '↻', [seat.id]: 'seat', [asking.id]: 'idle' })
  })
})

describe('a family sits where its most urgent member puts it', () => {
  const root = (over: Partial<KanbanCard> = {}) => thread({ id: 'cmbx', status: 'active', workerState: 'running', runtimePhase: 'working', ...over })
  const kid = (id: string, over: Partial<KanbanCard>) => thread({ id: `cmbx/${id}`, orchestrator: 'cmbx', status: 'active', ...over })
  const working = (id: string) => kid(id, { workerState: 'running', runtimePhase: 'working' })
  const idle = (id: string) => kid(id, { workerState: 'running', runtimePhase: 'waiting' })
  const review = (id: string) => kid(id, { status: 'closed' })
  const place = (cards: KanbanCard[]) => {
    const family = deskFamily(new ThreadIndex(cards), cards[0], new Map())
    return { attention: family.attention, waits: family.waits.map(wait => wait.card.id), live: family.live.map(card => card.id) }
  }
  it('what waits outranks a live worker, and an idle worker that asked nothing works', () => {
    expect(place([root(), review('r'), idle('y')])).toEqual({ attention: 'waiting', waits: ['cmbx/r'], live: ['cmbx/y'] })
    expect(place([root({ workerState: undefined, runtimePhase: undefined, status: 'open', effectiveHorizon: 'stashed' }), working('w')]))
      .toEqual({ attention: 'working', waits: [], live: ['cmbx/w'] })
  })
  it('the root waits among its threads, one line each, and the others that work are named after them', () => {
    expect(place([root({ ask: { text: 'Which?', at: '2026-11-09T10:00:00Z' } }), review('a'), working('w')]))
      .toMatchObject({ attention: 'waiting', waits: expect.arrayContaining(['cmbx', 'cmbx/a']), live: ['cmbx/w'] })
  })
  it('an armed root without a worker still stands with a tree whose only life is a working thread', () => {
    expect(place([root({ workerState: undefined, runtimePhase: undefined }), working('w')])).toEqual({ attention: 'working', waits: [], live: ['cmbx/w'] })
  })
  it('a quiet tree is quiet, wherever the root rests', () => {
    expect(place([root({ status: 'open', effectiveHorizon: 'stashed', workerState: undefined, runtimePhase: undefined }), kid('d', { status: 'open' })]))
      .toEqual({ attention: 'quiet', waits: [], live: [] })
  })
  it('every node of the tree reads the same top-level', () => {
    const cards = [root(), idle('y'), working('w')]
    const index = new ThreadIndex(cards)
    for (const c of cards) expect(index.rootOf(c).id).toBe('cmbx')
  })
})

describe('a thread with its orchestrator asks nothing of the human', () => {
  const hub = thread({ id: 'hub', status: 'open' })
  const withOrchestrator = thread({ id: 'hub/fit', orchestrator: 'hub', status: 'closed', column: 'orchestratorReview' })
  const marked = thread({ id: 'hub/marked', orchestrator: 'hub', status: 'closed', reviewMark: { note: 'the fit moved', at: '2026-11-09T10:00:00Z' } })
  const working = thread({ id: 'hub/live', orchestrator: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' })

  it('is With orchestrator, unfinished but not to review', () => {
    expect(threadState(withOrchestrator)).toBe('with-orchestrator')
    expect(THREAD_LABEL['with-orchestrator']).toBe('With orchestrator')
    expect(threadState(marked)).toBe('to-review')
  })
  it('never makes its family wait: a quiet tree stays quiet, and a mark brings the thread to the human', () => {
    expect(deskFamily(new ThreadIndex([hub, withOrchestrator]), hub, new Map()).attention).toBe('quiet')
    expect(deskFamily(new ThreadIndex([hub, withOrchestrator, marked, working]), hub, new Map()).waits.map(wait => wait.card.id)).toEqual(['hub/marked'])
  })
})
