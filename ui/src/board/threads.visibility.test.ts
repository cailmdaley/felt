import { describe, expect, it } from 'vitest'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { deskOrder } from './deskOrdering.js'
import { attentionOf } from './attention.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { boardCards, threadIndexFor } from './threads.js'
import type { KanbanResponse } from './KanbanTypes.js'
import { servedFeed } from './testFixtures.js'

/** `threadOf` pins the constitution a thread was created under; `mark` is its mark for the human's review. */
export type Row = { id: string; parent?: string; status: string; tempered?: boolean; horizon?: string; ask?: boolean; phase?: string; seat?: boolean; kind?: string; threadOf?: string; mark?: string }
export function board(rows: Row[]): KanbanResponse {
  return buildKanbanResponseFromComposite(parseCompositeFeed(servedFeed({ host: 'owner', fibers: rows.map(row => ({
    origin: 'owner', felt_store: '/store', path: `${row.id}.md`, orchestrator: row.parent,
    fiber: { id: row.id, name: row.id, status: row.status, tempered: row.tempered, horizon: row.horizon,
      created_at: '2026-10-01T09:00:00Z', closed_at: row.status === 'closed' ? '2026-10-02T09:00:00Z' : undefined,
      shuttle: { kind: row.kind ?? 'oneshot', seat: row.seat, role: row.seat ? 'chair' : undefined, ask: row.ask ? { text: 'Which cut?', at: '2026-10-02T09:00:00Z' } : undefined,
        thread_parent: row.threadOf ? { uid: `${row.threadOf}-uid`, host: 'owner', slug: row.threadOf, name: row.threadOf } : undefined,
        review: row.mark ? { note: row.mark, at: '2026-10-02T10:00:00Z' } : undefined } },
    runtime: row.phase ? { state: 'running', phase: row.phase, session_uuid: `s-${row.id}` } : null,
  })) })))
}
export const ids = (cards: readonly { id: string }[]) => cards.map(c => c.id)
const waiting = (b: KanbanResponse): string[] => ids(boardCards(b).filter(card => attentionOf(card, new Map()) === 'waiting')).sort()

describe('a closed thread is its orchestrator\'s to review unless marked for the human', () => {
  it('waits on no one with its orchestrator on the board, and a mark brings it to the human', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/fit', parent: 'hub', threadOf: 'hub', status: 'closed' },
      { id: 'hub/cut', parent: 'hub', threadOf: 'hub', status: 'closed', mark: 'the cut moved the fit' },
    ])
    expect(waiting(b)).toEqual(['hub/cut'])
    expect(boardCards(b).find(c => c.id === 'hub/fit')?.column).toBe('orchestratorReview')
    expect(boardCards(b).find(c => c.id === 'hub/cut')?.reviewMark?.note).toBe('the cut moved the fit')
  })
  it('falls to the human when no orchestrator is in sight', () => {
    const b = board([{ id: 'gone/fit', parent: 'gone', threadOf: 'gone', status: 'closed' }])
    expect(waiting(b)).toEqual(['gone/fit'])
    expect(b.now.awaitingReview[0].column).toBe('orchestratorReview')
  })
})

describe('a family stands once on the Desk, in the section its members put it in, with every member that waits', () => {
  const families = (b: KanbanResponse) => {
    const order = deskOrder(threadIndexFor(b), new Map())
    return Object.fromEntries(Object.entries(order.sections).filter(([, list]) => list.length).map(([section, list]) => [section, list.map(family => [family.root.id, ids(family.waits.map(wait => wait.card)).sort(), ids(family.live)])]))
  }
  it('a working root with an asking thread and a close for review deep below it waits, and names what works below it; a thread\'s draft is quiet', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/ask', parent: 'hub', status: 'active', ask: true },
      { id: 'hub/ask/busy', parent: 'hub/ask', status: 'active', phase: 'working' },
      { id: 'hub/ask/busy/again', parent: 'hub/ask/busy', status: 'active', phase: 'waiting' },
      { id: 'hub/quiet', parent: 'hub', status: 'open' },
      { id: 'hub/quiet/review', parent: 'hub/quiet', status: 'closed' },
      { id: 'hub/quiet/draft', parent: 'hub/quiet', status: 'open' },
    ])
    expect(families(b)).toEqual({ waiting: [['hub', ['hub/ask', 'hub/quiet/review'], ['hub/ask/busy', 'hub/ask/busy/again']]] })
    expect(ids(boardCards(b)).sort()).toEqual(['hub', 'hub/ask', 'hub/ask/busy', 'hub/ask/busy/again', 'hub/quiet', 'hub/quiet/draft', 'hub/quiet/review'])
  })
  it('a resting root with a question below a tempered thread waits for it', () => {
    const b = board([
      { id: 'hub', status: 'open', horizon: 'stashed' },
      { id: 'hub/review', parent: 'hub', status: 'closed' },
      { id: 'hub/mid', parent: 'hub', status: 'closed', tempered: true },
      { id: 'hub/mid/ask', parent: 'hub/mid', status: 'active', ask: true },
    ])
    expect(families(b)).toEqual({ waiting: [['hub', ['hub/mid/ask', 'hub/review'], []]] })
  })
  it('a seat\'s family waits for what waits in it, wherever the seat rests', () => {
    const b = board([
      { id: 'working-seat', seat: true, status: 'active', phase: 'working' },
      { id: 'working-seat/ask', parent: 'working-seat', status: 'active', ask: true },
      { id: 'resting-seat', seat: true, status: 'open', horizon: 'stashed' },
      { id: 'resting-seat/ask', parent: 'resting-seat', status: 'active', ask: true },
      { id: 'quiet-seat', seat: true, status: 'open' },
      { id: 'quiet-seat/review', parent: 'quiet-seat', status: 'closed' },
    ])
    expect(families(b)).toEqual({
      waiting: [['resting-seat', ['resting-seat/ask'], []], ['working-seat', ['working-seat/ask'], []]].sort(),
      review: [['quiet-seat', ['quiet-seat/review'], []]],
    })
  })
  it('a missing orchestrator is an ordinary root with path-only ancestry', () => {
    const b = board([{ id: 'gone/folder/child', parent: 'missing-uid', status: 'active', ask: true }, { id: 'gone/folder/child/deep', parent: 'gone/folder/child', status: 'closed' }])
    expect(families(b).waiting).toEqual([['gone/folder/child', ['gone/folder/child', 'gone/folder/child/deep'], []]])
    expect(threadIndexFor(b).ancestry(b.now.inFlight[0])).toEqual([{ name: 'gone' }, { name: 'folder' }])
  })
  it('breaks a malformed cycle and retains every conversation', () => {
    const b = board([{ id: 'a', parent: 'b', status: 'active', ask: true }, { id: 'b', parent: 'a', status: 'active', phase: 'working' }])
    expect(boardCards(b)).toHaveLength(2)
    expect(deskOrder(threadIndexFor(b), new Map()).rows.map(row => row.id).sort()).toEqual(['a', 'b'])
  })
})
