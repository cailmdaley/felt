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

describe('the Desk draws each tree’s topmost awake frontier', () => {
  it('draws two awake children at different depths under quiet ancestry, each in its own column', () => {
    const b = board([
      { id: 'hub', status: 'open', horizon: 'stashed' },
      { id: 'hub/review', parent: 'hub', status: 'closed' },
      { id: 'hub/mid', parent: 'hub', status: 'closed', tempered: true },
      { id: 'hub/mid/ask', parent: 'hub/mid', status: 'active', ask: true },
    ])
    expect(ids(b.now.inFlight)).toStrictEqual(['hub/mid/ask'])
    expect(ids(b.now.awaitingReview)).toStrictEqual(['hub/review'])
    expect(b.stash).toHaveLength(0); expect(b.timeline.past).toHaveLength(0)
    const index = threadIndexFor(b)
    expect(index.ancestry(b.now.inFlight[0]).map(a => [a.name, a.card?.id])).toEqual([['hub', 'hub'], ['hub/mid', 'hub/mid']])
    expect(ids(boardCards(b)).sort()).toEqual(['hub', 'hub/mid', 'hub/mid/ask', 'hub/review'])
  })
  it('folds all awake descendants into an awake ancestor without borrowing their band', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/ask', parent: 'hub', status: 'active', ask: true },
      { id: 'hub/quiet', parent: 'hub', status: 'open' },
      { id: 'hub/quiet/review', parent: 'hub/quiet', status: 'closed' },
      { id: 'hub/draft', parent: 'hub', status: 'open' },
    ])
    expect(ids(desk(b))).toStrictEqual(['hub'])
    expect(b.now.inFlight[0]).toMatchObject({ awakeDescendants: 2, waitingDescendants: 1 })
    expect(inFlightBand(b.now.inFlight[0])).toBe('working')
  })
  for (const root of [
    { status: 'open' }, { status: 'open', horizon: 'stashed' },
    { status: 'closed', tempered: true }, { status: 'closed', tempered: false },
    { status: 'open', seat: true },
  ]) it(`an all-quiet tree keeps only its root in its own place: ${JSON.stringify(root)}`, () => {
    const alone = board([{ id: 'hub', ...root }])
    const b = board([{ id: 'hub', ...root }, { id: 'hub/draft', parent: 'hub', status: 'open' }, { id: 'hub/rest', parent: 'hub', status: 'open', horizon: 'stashed' }])
    expect(ids(desk(b))).toStrictEqual(ids(desk(alone)))
    expect(desk(b)[0]).toMatchObject({ awakeDescendants: 0, waitingDescendants: 0 })
  })
  it('an armed workerless node is quiet; prompts and existing Your-turn inference are awake', () => {
    const b = board([{ id: 'hub', status: 'active' }, { id: 'hub/prompt', parent: 'hub', status: 'open', phase: 'attention' }, { id: 'hub/idle', parent: 'hub', status: 'active', phase: 'waiting' }])
    expect(ids(desk(b)).sort()).toEqual(['hub/idle', 'hub/prompt'])
    expect(b.now.inFlight.every(c => inFlightBand(c) === 'yourTurn')).toBe(true)
  })
  it('a missing orchestrator is an ordinary row with path-only ancestry, and folds its awake descendants', () => {
    const b = board([{ id: 'gone/folder/child', parent: 'missing-uid', status: 'active', ask: true }, { id: 'gone/folder/child/deep', parent: 'gone/folder/child', status: 'closed' }])
    expect(ids(desk(b))).toStrictEqual(['gone/folder/child'])
    expect(threadIndexFor(b).ancestry(b.now.inFlight[0])).toEqual([{ name: 'gone' }, { name: 'folder' }])
    expect(b.now.inFlight[0]).toMatchObject({ awakeDescendants: 1, waitingDescendants: 0 })
  })
  it('breaks a malformed cycle and retains every conversation', () => {
    const b = board([{ id: 'a', parent: 'b', status: 'active', ask: true }, { id: 'b', parent: 'a', status: 'active', phase: 'working' }])
    expect(desk(b)).toHaveLength(1); expect(boardCards(b)).toHaveLength(2)
  })
})
