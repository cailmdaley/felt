import { describe, expect, it } from 'vitest'
import { buildKanbanResponseFromComposite, inFlightBand } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { boardCards, threadIndexFor } from './KanbanSurfaces.js'
import type { KanbanResponse } from './KanbanTypes.js'

export type Row = { id: string; parent?: string; status: string; tempered?: boolean; horizon?: string; ask?: boolean; phase?: string; seat?: boolean; kind?: string }
export function board(rows: Row[]): KanbanResponse {
  return buildKanbanResponseFromComposite(parseCompositeFeed({ host: 'owner', fibers: rows.map(row => ({
    origin: 'owner', felt_store: '/store', path: `${row.id}.md`, orchestrator: row.parent,
    fiber: { id: row.id, name: row.id, status: row.status, tempered: row.tempered, horizon: row.horizon,
      created_at: '2026-10-01T09:00:00Z', closed_at: row.status === 'closed' ? '2026-10-02T09:00:00Z' : undefined,
      shuttle: { kind: row.kind ?? 'oneshot', seat: row.seat, role: row.seat ? 'chair' : undefined, ask: row.ask ? { text: 'Which cut?', at: '2026-10-02T09:00:00Z' } : undefined } },
    runtime: row.phase ? { state: 'running', phase: row.phase, session_uuid: `s-${row.id}` } : null,
  })) }))
}
export const ids = (cards: readonly { id: string }[]) => cards.map(c => c.id)
const desk = (b: KanbanResponse) => [...b.now.drafts, ...b.now.inFlight, ...b.now.awaitingReview, ...b.stash, ...b.roles, ...b.timeline.past, ...b.timeline.futureDated]

describe('the Desk draws each family once, in the column of its most urgent need', () => {
  it('a quiet root with a review and a deeper question is one row: the question, with its crumb', () => {
    const b = board([
      { id: 'hub', status: 'open', horizon: 'stashed' },
      { id: 'hub/review', parent: 'hub', status: 'closed' },
      { id: 'hub/mid', parent: 'hub', status: 'closed', tempered: true },
      { id: 'hub/mid/ask', parent: 'hub/mid', status: 'active', ask: true },
    ])
    expect(ids(desk(b))).toStrictEqual(['hub/mid/ask'])
    expect(inFlightBand(b.now.inFlight[0])).toBe('yourTurn')
    const index = threadIndexFor(b)
    expect(index.ancestry(b.now.inFlight[0]).map(a => [a.name, a.card?.id])).toEqual([['hub', 'hub'], ['hub/mid', 'hub/mid']])
    expect(index.family(b.now.inFlight[0]).others).toEqual({ yours: 0, review: 1, working: 0 })
    expect(ids(boardCards(b)).sort()).toEqual(['hub', 'hub/mid', 'hub/mid/ask', 'hub/review'])
  })
  it('a working root with a thread waiting on the human sits in Your turn, led by that thread', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/ask', parent: 'hub', status: 'active', ask: true },
      { id: 'hub/quiet', parent: 'hub', status: 'open' },
      { id: 'hub/quiet/review', parent: 'hub/quiet', status: 'closed' },
      { id: 'hub/draft', parent: 'hub', status: 'open' },
    ])
    expect(ids(desk(b))).toStrictEqual(['hub/ask'])
    expect(inFlightBand(b.now.inFlight[0])).toBe('yourTurn')
    expect(threadIndexFor(b).family(b.now.inFlight[0]).others).toEqual({ yours: 0, review: 1, working: 1 })
  })
  for (const root of [
    { status: 'open' }, { status: 'open', horizon: 'stashed' },
    { status: 'closed', tempered: true }, { status: 'closed', tempered: false },
    { status: 'open', seat: true },
  ]) it(`an all-quiet tree keeps only its root in its own place: ${JSON.stringify(root)}`, () => {
    const alone = board([{ id: 'hub', ...root }])
    const b = board([{ id: 'hub', ...root }, { id: 'hub/draft', parent: 'hub', status: 'open' }, { id: 'hub/rest', parent: 'hub', status: 'open', horizon: 'stashed' }])
    expect(ids(desk(b))).toStrictEqual(ids(desk(alone)))
    expect(threadIndexFor(b).family(desk(b)[0]).others).toEqual({ yours: 0, review: 0, working: 0 })
  })
  it('an armed workerless node asks nothing; a prompt and an idle turn both ask, and the prompt leads', () => {
    const b = board([{ id: 'hub', status: 'active' }, { id: 'hub/idle', parent: 'hub', status: 'active', phase: 'waiting' }, { id: 'hub/prompt', parent: 'hub', status: 'open', phase: 'attention' }])
    expect(ids(desk(b))).toStrictEqual(['hub/prompt'])
    expect(ids(threadIndexFor(b).family(b.now.inFlight[0]).askers)).toStrictEqual(['hub/prompt', 'hub/idle'])
  })
  it('a missing orchestrator is an ordinary root with path-only ancestry', () => {
    const b = board([{ id: 'gone/folder/child', parent: 'missing-uid', status: 'active', ask: true }, { id: 'gone/folder/child/deep', parent: 'gone/folder/child', status: 'closed' }])
    expect(ids(desk(b))).toStrictEqual(['gone/folder/child'])
    expect(threadIndexFor(b).ancestry(b.now.inFlight[0])).toEqual([{ name: 'gone' }, { name: 'folder' }])
    expect(threadIndexFor(b).family(b.now.inFlight[0]).others).toEqual({ yours: 0, review: 1, working: 0 })
  })
  it('breaks a malformed cycle and retains every conversation', () => {
    const b = board([{ id: 'a', parent: 'b', status: 'active', ask: true }, { id: 'b', parent: 'a', status: 'active', phase: 'working' }])
    expect(desk(b)).toHaveLength(1); expect(boardCards(b)).toHaveLength(2)
  })
})
