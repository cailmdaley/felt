import { describe, expect, it } from 'vitest'
import { buildKanbanResponseFromComposite, inFlightBand } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { boardCards, threadIndexFor } from './KanbanSurfaces.js'
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
const desk = (b: KanbanResponse) => [...b.now.drafts, ...b.now.inFlight, ...b.now.awaitingReview, ...b.stash, ...b.roles, ...b.timeline.past, ...b.timeline.futureDated]

/** Each section's rows, a root heading a section its own state is not in marked `*`. */
const named = (cards: KanbanResponse['stash']) => cards.map(c => c.deskSection ? `${c.id}*` : c.id).sort()
const column = (b: KanbanResponse) => ({
  drafts: named(b.now.drafts), inFlight: named(b.now.inFlight), review: named(b.now.awaitingReview),
  resting: named(b.stash), roles: named(b.roles), past: named(b.timeline.past),
})

describe('a closed thread is its orchestrator\'s to review unless marked for the human', () => {
  it('stays off Awaiting review with its orchestrator on the board, and a mark brings it there', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/fit', parent: 'hub', threadOf: 'hub', status: 'closed' },
      { id: 'hub/cut', parent: 'hub', threadOf: 'hub', status: 'closed', mark: 'the cut moved the fit' },
    ])
    expect(column(b)).toEqual({ drafts: [], inFlight: ['hub'], review: ['hub/cut'], resting: [], roles: [], past: [] })
    expect(boardCards(b).find(c => c.id === 'hub/fit')?.column).toBe('orchestratorReview')
    expect(boardCards(b).find(c => c.id === 'hub/cut')?.reviewMark?.note).toBe('the cut moved the fit')
  })
  it('falls to the human when no orchestrator is in sight', () => {
    const b = board([{ id: 'gone/fit', parent: 'gone', threadOf: 'gone', status: 'closed' }])
    expect(column(b).review).toEqual(['gone/fit'])
    expect(b.now.awaitingReview[0].column).toBe('orchestratorReview')
  })
})

describe('a family\'s root heads its threads in each section of work they stand in', () => {
  it('the root stands in its own section and heads each other section of work its threads are in; a thread\'s draft is no row', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/ask', parent: 'hub', status: 'active', ask: true },
      { id: 'hub/ask/busy', parent: 'hub/ask', status: 'active', phase: 'working' },
      { id: 'hub/ask/busy/again', parent: 'hub/ask/busy', status: 'active', phase: 'waiting' },
      { id: 'hub/quiet', parent: 'hub', status: 'open' },
      { id: 'hub/quiet/review', parent: 'hub/quiet', status: 'closed' },
      { id: 'hub/quiet/draft', parent: 'hub/quiet', status: 'open' },
    ])
    expect(column(b)).toEqual({ drafts: [], inFlight: ['hub', 'hub*'], review: ['hub/quiet/review'], resting: [], roles: [], past: [] })
    expect(b.now.inFlight.map(c => inFlightBand(c)).sort()).toEqual(['working', 'yourTurn'])
    expect(ids(boardCards(b)).sort()).toEqual(['hub', 'hub/ask', 'hub/ask/busy', 'hub/ask/busy/again', 'hub/quiet', 'hub/quiet/draft', 'hub/quiet/review'])
  })
  it('a quiet root keeps its own place and heads its threads where they stand', () => {
    const b = board([
      { id: 'hub', status: 'open', horizon: 'stashed' },
      { id: 'hub/review', parent: 'hub', status: 'closed' },
      { id: 'hub/mid', parent: 'hub', status: 'closed', tempered: true },
      { id: 'hub/mid/ask', parent: 'hub/mid', status: 'active', ask: true },
    ])
    expect(column(b)).toEqual({ drafts: [], inFlight: ['hub/mid/ask'], review: ['hub/review'], resting: ['hub'], roles: [], past: [] })
  })
  it('a seat keeps its place in the Roles and heads its threads where they stand', () => {
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
