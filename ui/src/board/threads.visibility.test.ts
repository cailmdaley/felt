// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { boardCards, KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanResponse } from './KanbanTypes.js'

type Row = { id: string; parent?: string | null; status: string; tempered?: boolean; horizon?: string; ask?: boolean; phase?: string }
function board(rows: Row[]): KanbanResponse {
  const fibers = rows.map(row => ({
    origin: 'owner', felt_store: '/store', path: `${row.id}.md`, orchestrator: row.parent ?? null,
    fiber: {
      id: row.id, name: row.id, status: row.status, tempered: row.tempered, horizon: row.horizon,
      created_at: '2026-10-01T09:00:00Z', closed_at: row.status === 'closed' ? '2026-10-02T09:00:00Z' : undefined,
      shuttle: { kind: 'oneshot', ask: row.ask ? { text: 'Which cut?', at: '2026-10-02T09:00:00Z' } : undefined },
    },
    runtime: row.phase ? { state: 'running', phase: row.phase, session_uuid: `s-${row.id}` } : null,
  }))
  return buildKanbanResponseFromComposite(parseCompositeFeed({ host: 'owner', fibers }))
}
const ids = (cards: { id: string }[]) => cards.map(c => c.id)
const desk = (b: KanbanResponse) => [...b.now.drafts, ...b.now.inFlight, ...b.now.awaitingReview]

describe('actionable threads never vanish from the Desk', () => {
  it('promotes a tempered root into the column its waiting thread implies', () => {
    const b = board([
      { id: 'hub', status: 'closed', tempered: true },
      { id: 'hub/child', parent: 'hub', status: 'active', ask: true },
    ])
    expect(ids(b.now.inFlight)).toEqual(['hub'])
    expect(b.now.inFlight[0].threadPromoted).toBe(true)
    expect(ids(b.timeline.past)).toEqual([])
    expect(ids(desk(b))).not.toContain('hub/child')
  })
  it('promotes a discarded root whose thread awaits review into Awaiting review', () => {
    const b = board([
      { id: 'hub', status: 'closed', tempered: false },
      { id: 'hub/child', parent: 'hub', status: 'closed' },
    ])
    expect(ids(b.now.awaitingReview)).toEqual(['hub'])
    expect(b.now.awaitingReview[0].threadPromoted).toBe(true)
  })
  it('brings a resting root back to Now while a thread works, and to Drafts for a draft', () => {
    const working = board([
      { id: 'hub', status: 'open', horizon: 'stashed' },
      { id: 'hub/child', parent: 'hub', status: 'active', phase: 'working' },
    ])
    expect(ids(working.now.inFlight)).toEqual(['hub'])
    expect(ids(working.stash)).toEqual([])
    const drafting = board([
      { id: 'hub', status: 'open', horizon: 'stashed' },
      { id: 'hub/a/draft', parent: 'hub', status: 'open' },
    ])
    expect(ids(drafting.now.drafts)).toEqual(['hub'])
    expect(drafting.now.drafts[0].threadPromoted).toBe(true)
  })
  it('the most urgent descendant decides, at any depth', () => {
    const b = board([
      { id: 'hub', status: 'closed', tempered: true },
      { id: 'hub/review', parent: 'hub', status: 'closed' },
      { id: 'hub/mid', parent: 'hub', status: 'closed', tempered: true },
      { id: 'hub/mid/ask', parent: 'hub/mid', status: 'active', ask: true },
    ])
    expect(ids(b.now.inFlight)).toEqual(['hub'])
    expect(ids(desk(b))).toEqual(['hub'])
  })
  it('leaves a settled root settled when its subtree holds only archived or resting work', () => {
    const b = board([
      { id: 'hub', status: 'closed', tempered: true },
      { id: 'hub/done', parent: 'hub', status: 'closed', tempered: true },
      { id: 'hub/rest', parent: 'hub', status: 'open', horizon: 'stashed' },
    ])
    expect(ids(b.timeline.past)).toEqual(['hub'])
    expect(b.timeline.past[0].threadPromoted).toBeUndefined()
    expect(desk(b)).toEqual([])
  })
  it('a root drawn on the Desk is not marked promoted', () => {
    const b = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/child', parent: 'hub', status: 'active', ask: true },
    ])
    expect(ids(b.now.inFlight)).toEqual(['hub'])
    expect(b.now.inFlight[0].threadPromoted).toBeUndefined()
  })
  it('surfaces a thread whose orchestrator is missing as its own orphaned card', () => {
    const b = board([
      { id: 'gone/child', parent: 'gone', status: 'active', ask: true },
      { id: 'gone/child/deep', parent: 'gone/child', status: 'closed' },
    ])
    expect(ids(b.now.inFlight)).toEqual(['gone/child'])
    const orphan = b.now.inFlight[0]
    expect(orphan.threadOrphaned).toBe(true)
    expect(orphan.threadSummary?.toReview).toBe(1)
    expect(ids(b.threads ?? [])).toEqual(['gone/child/deep'])
    expect(ids(boardCards(b)).sort()).toEqual(['gone/child', 'gone/child/deep'])
  })
  it('a malformed cyclic feed still draws one card for the loop, marked orphaned', () => {
    const b = board([
      { id: 'a', parent: 'b', status: 'active', ask: true },
      { id: 'b', parent: 'a', status: 'active', phase: 'working' },
    ])
    expect(desk(b)).toHaveLength(1)
    expect(desk(b)[0].threadOrphaned).toBe(true)
    expect(boardCards(b)).toHaveLength(2)
  })
  it('draws the promoted-family and orphaned-thread marks on the Desk card', () => {
    const b = board([
      { id: 'hub', status: 'closed', tempered: true },
      { id: 'hub/child', parent: 'hub', status: 'active', ask: true },
      { id: 'gone/child', parent: 'gone', status: 'active', phase: 'working' },
    ])
    const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => b,
      stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: () => {}, onRefresh: () => {} })
    const section = renderer.renderNowSection(b.now, {})
    const hub = section.querySelector<HTMLElement>('[data-fiber-id="hub"]')!
    const orphan = section.querySelector<HTMLElement>('[data-fiber-id="gone/child"]')!
    expect(hub.querySelector('.kbn-thread-mark')?.textContent).toBe('threads open')
    expect(orphan.querySelector('.kbn-thread-mark')?.textContent).toBe('orphaned thread')
    expect(orphan.querySelector<HTMLElement>('.kbn-thread-mark')?.title).toContain('gone')
  })
})
