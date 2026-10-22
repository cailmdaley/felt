// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildKanbanResponseFromComposite, inFlightBand } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { findCardColumn, verdictTargets } from './KanbanSurfaces.js'
import { moveDestinations } from './MoveDestinations.js'
import { applyOptimisticSurface, applyOptimisticTransition } from './KanbanModal.js'
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

describe('a root on the Desk for its threads', () => {
  const tempered = () => board([
    { id: 'hub', status: 'closed', tempered: true },
    { id: 'hub/child', parent: 'hub', status: 'active', ask: true },
  ])
  const resting = () => board([
    { id: 'hub', status: 'open', horizon: 'stashed' },
    { id: 'hub/child', parent: 'hub', status: 'active', phase: 'working' },
  ])
  it('sits in the band its most urgent thread asks for, not its own turn', () => {
    const settled = tempered().now.inFlight[0]
    expect(inFlightBand(settled)).toBe('yourTurn')
    const busy = board([
      { id: 'hub', status: 'active', phase: 'working' },
      { id: 'hub/child', parent: 'hub', status: 'active', ask: true },
      { id: 'quiet', status: 'active', phase: 'working' },
    ])
    expect(inFlightBand(busy.now.inFlight.find(c => c.id === 'hub')!)).toBe('yourTurn')
    expect(ids(busy.now.inFlight)).toEqual(['hub', 'quiet'])
    expect(inFlightBand(resting().now.inFlight[0])).toBe('working')
  })
  it('can still be launched: its own column is where a move starts from', () => {
    for (const b of [tempered(), resting()]) {
      const root = b.now.inFlight[0]
      expect(root.threadPromoted).toBe(true)
      expect(findCardColumn(b, root.id)).not.toBe('inFlight')
      expect(moveDestinations(root, findCardColumn(b, root.id)).map(d => d.id)).toContain('inFlight')
    }
    expect(findCardColumn(tempered(), 'hub')).toBe('tempered')
  })
  it('takes the verdicts its own status allows, not its borrowed column\'s', () => {
    expect(verdictTargets(tempered().now.inFlight[0], 'inFlight')).toEqual([])
    expect(verdictTargets(resting().now.inFlight[0], 'inFlight')).toEqual(['tempered', 'composted'])
  })
  it('stays where its threads keep it when rested or judged, as the next refresh will draw it', () => {
    const rest = applyOptimisticSurface(resting(), 'hub')!
    expect(ids(rest.now.inFlight)).toEqual(['hub'])
    expect(rest.now.inFlight[0]).toMatchObject({ threadPromoted: true, effectiveHorizon: 'stashed' })
    expect(rest.stash).toEqual([])
    const judged = applyOptimisticTransition(resting(), 'hub', 'tempered')!
    expect(ids(judged.now.inFlight)).toEqual(['hub'])
    expect(judged.now.inFlight[0]).toMatchObject({ threadPromoted: true, status: 'closed', tempered: true })
    expect(judged.timeline.past).toEqual([])
    // Launched, it is in flight on its own account.
    const launched = applyOptimisticTransition(tempered(), 'hub', 'inFlight')!
    expect(ids(launched.now.inFlight)).toEqual(['hub'])
    expect(launched.now.inFlight[0].threadPromoted).toBeUndefined()
  })
  it('a root with no threads at work still leaves the Desk', () => {
    const lone = board([{ id: 'solo', status: 'active', phase: 'working' }])
    expect(ids(applyOptimisticSurface(lone, 'solo')!.stash)).toEqual(['solo'])
    expect(ids(applyOptimisticTransition(lone, 'solo', 'tempered')!.timeline.past)).toEqual(['solo'])
  })
})
