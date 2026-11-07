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

const column = (b: KanbanResponse) => ({
  drafts: ids(b.now.drafts).sort(), inFlight: ids(b.now.inFlight).sort(), review: ids(b.now.awaitingReview).sort(),
  resting: ids(b.stash).sort(), roles: ids(b.roles).sort(), past: ids(b.timeline.past).sort(),
})

describe('a family stands once in each section it has work in', () => {
  it('a node is a Desk row when no ancestor shares its state, and hangs beneath the nearest one that does otherwise', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/ask', parent: 'hub', status: 'active', ask: true },
      { id: 'hub/ask/busy', parent: 'hub/ask', status: 'active', phase: 'working' },
      { id: 'hub/ask/busy/again', parent: 'hub/ask/busy', status: 'active', phase: 'waiting' },
      { id: 'hub/quiet', parent: 'hub', status: 'open' },
      { id: 'hub/quiet/review', parent: 'hub/quiet', status: 'closed' },
      { id: 'hub/quiet/draft', parent: 'hub/quiet', status: 'open' },
    ])
    expect(column(b)).toEqual({ drafts: ['hub/quiet'], inFlight: ['hub', 'hub/ask'], review: ['hub/quiet/review'], resting: [], roles: [], past: [] })
    expect(inFlightBand(b.now.inFlight.find(c => c.id === 'hub/ask')!)).toBe('yourTurn')
    expect(ids(boardCards(b)).sort()).toEqual(['hub', 'hub/ask', 'hub/ask/busy', 'hub/ask/busy/again', 'hub/quiet', 'hub/quiet/draft', 'hub/quiet/review'])
  })
  it('a quiet root keeps its own place while its threads stand in theirs', () => {
    const b = board([
      { id: 'hub', status: 'open', horizon: 'stashed' },
      { id: 'hub/review', parent: 'hub', status: 'closed' },
      { id: 'hub/mid', parent: 'hub', status: 'closed', tempered: true },
      { id: 'hub/mid/ask', parent: 'hub/mid', status: 'active', ask: true },
    ])
    expect(column(b)).toEqual({ drafts: [], inFlight: ['hub/mid/ask'], review: ['hub/review'], resting: ['hub'], roles: [], past: ['hub/mid'] })
    expect(threadIndexFor(b).ancestry(b.now.inFlight[0]).map(a => [a.name, a.card?.id])).toEqual([['hub', 'hub'], ['hub/mid', 'hub/mid']])
  })
  it('a seat keeps its place in the Roles while its threads stand in their sections', () => {
    const b = board([
      { id: 'working-seat', seat: true, status: 'active', phase: 'working' },
      { id: 'working-seat/ask', parent: 'working-seat', status: 'active', ask: true },
      { id: 'resting-seat', seat: true, status: 'open', horizon: 'stashed' },
      { id: 'resting-seat/review', parent: 'resting-seat', status: 'closed' },
    ])
    expect(column(b)).toEqual({ drafts: [], inFlight: ['working-seat', 'working-seat/ask'], review: ['resting-seat/review'], resting: [], roles: ['resting-seat'], past: [] })
  })
  it('a missing orchestrator is an ordinary root with path-only ancestry', () => {
    const b = board([{ id: 'gone/folder/child', parent: 'missing-uid', status: 'active', ask: true }, { id: 'gone/folder/child/deep', parent: 'gone/folder/child', status: 'closed' }])
    expect(column(b).inFlight).toEqual(['gone/folder/child'])
    expect(column(b).review).toEqual(['gone/folder/child/deep'])
    expect(threadIndexFor(b).ancestry(b.now.inFlight[0])).toEqual([{ name: 'gone' }, { name: 'folder' }])
  })
  it('breaks a malformed cycle and retains every conversation', () => {
    const b = board([{ id: 'a', parent: 'b', status: 'active', ask: true }, { id: 'b', parent: 'a', status: 'active', phase: 'working' }])
    expect(desk(b)).toHaveLength(2); expect(boardCards(b)).toHaveLength(2)
  })
})
