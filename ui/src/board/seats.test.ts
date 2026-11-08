// @vitest-environment jsdom
// Seats: a constitution carrying `shuttle.seat` is drawn among the Roles when
// it is at rest, and is ordinary work everywhere else. The served column (held
// to daemon/test/fixtures/columns), the read model, the Move menu and the Roles
// band must agree on "at rest".

import { describe, expect, it, vi } from 'vitest'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { mapFeltJsonToFiber } from './KanbanFiber.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { moveDestinations } from './MoveDestinations.js'
import { card as baseCard, servedFeed } from './testFixtures.js'
import { stripFacts } from './workspace/Dock.js'

const at0 = '2026-01-01T00:00:00Z'

describe('mapFeltJsonToFiber reads shuttle.seat', () => {
  it('carries the role slug and boolean seat', () => {
    const f = mapFeltJsonToFiber({
      id: 'science/cmbx', name: 'cmbx chair', status: 'open', created_at: at0,
      shuttle: { kind: 'oneshot', role: 'cmbx-chair', seat: true },
    })
    expect(f?.shuttleRole).toBe('cmbx-chair')
    expect(f?.shuttleSeat).toBe(true)
  })

  it('reads scalar and windowed pulse configuration without deriving a clock', () => {
    expect(mapFeltJsonToFiber({ id: 'a', shuttle: { pulse: '59m' } })?.shuttlePulse).toEqual({ every: '59m' })
    expect(mapFeltJsonToFiber({ id: 'a', shuttle: { pulse: {
      every: '59m', window: { start: '08:00', end: '20:00', tz: 'Europe/Paris' },
    } } })?.shuttlePulse).toEqual({
      every: '59m', window: { start: '08:00', end: '20:00', tz: 'Europe/Paris' },
    })
  })
})

function board(fibers: Record<string, unknown>[]): KanbanResponse {
  return buildKanbanResponseFromComposite(parseCompositeFeed(servedFeed({
    host: 'desk',
    fibers: fibers.map((f, i) => ({ origin: 'desk', felt_store: '/store', path: `${i}.md`, fiber: f })),
    origins: { desk: { kind: 'local', stale: false, fiber_count: fibers.length } },
  })), { nowMs: Date.parse('2026-10-08T12:00:00Z') })
}

describe('the read model files seats on the roles surface', () => {
  const seat = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, uid: `uid-${id}`, name, status: 'open', created_at: at0,
    shuttle: { kind: 'oneshot', host: 'desk', role: 'vizier', seat: true }, ...over,
  })

  it('ignores collaboration and string seats, and requires an office for boolean seats', () => {
    const resp = board([
      seat('work/string-seat', 'String seat', { shuttle: { kind: 'oneshot', role: 'vizier', seat: 'vizier' } }),
      seat('work/roster', 'Roster', { collaboration: { vizier: ['sol'] }, shuttle: { kind: 'oneshot' } }),
      seat('work/no-office', 'No office', { shuttle: { kind: 'oneshot', seat: true } }),
      seat('work/not-seat', 'Not seat', { shuttle: { kind: 'oneshot', role: 'vizier', seat: false } }),
    ])
    expect(resp.roles).toEqual([])
    expect(resp.now.drafts).toHaveLength(4)
    expect(resp.now.drafts.find(c => c.id === 'work/roster')?.shuttleRole).toBeUndefined()
    expect(resp.now.drafts.find(c => c.id === 'work/string-seat')?.shuttleSeat).toBeUndefined()
  })

  it('takes seats off the desk and out of Resting, in name order', () => {
    const resp = board([
      seat('life/vizier', 'Vizier', { horizon: 'stashed' }),
      seat('loom/post', 'Morning post', {
        status: 'active',
        shuttle: { kind: 'standing', host: 'desk', role: 'vizier', seat: true, schedule: { expr: '0 7 * * *', tz: 'UTC' } },
      }),
      { id: 'work/draft', uid: 'uid-d', name: 'Draft', status: 'open', created_at: at0, shuttle: { kind: 'oneshot', host: 'desk' } },
    ])
    expect(resp.roles.map((c) => c.name)).toEqual(['Morning post', 'Vizier'])
    expect(resp.now.drafts.map((c) => c.id)).toEqual(['work/draft'])
    expect(resp.stash).toEqual([])
    expect(resp.timeline.futureDated).toEqual([])
    expect(resp.totals.roles).toBe(2)
  })

  it('carries the owner pulse clock onto the card unchanged', () => {
    const feed = parseCompositeFeed(servedFeed({
      host: 'desk',
      fibers: [{
        origin: 'desk', felt_store: '/store', path: 'life/vizier.md',
        fiber: seat('life/vizier', 'Vizier', { status: 'active', shuttle: {
          kind: 'oneshot', host: 'desk', pulse: '59m',
        } }),
        pulse: { next_tick: '2026-10-08T13:00:00Z', last_tick: '2026-10-08T12:01:00Z', state: 'scheduled' },
      }],
      origins: { desk: { kind: 'local', stale: false, fiber_count: 1 } },
    }))
    const card = buildKanbanResponseFromComposite(feed, { nowMs: Date.parse('2026-10-08T12:00:00Z') }).now.inFlight[0]
    expect(card.shuttlePulse).toEqual({ every: '59m' })
    expect(card.shuttlePulseRuntime).toEqual({
      nextTick: '2026-10-08T13:00:00Z', lastTick: '2026-10-08T12:01:00Z', state: 'scheduled',
    })
  })
})

describe('moveDestinations for a seat', () => {
  const seatCard = (over: Partial<KanbanCard> = {}): KanbanCard =>
    baseCard({ id: 'science/cmbx', name: 'cmbx chair', status: 'open', shuttleKind: 'oneshot', shuttleRole: 'cmbx-chair', shuttleSeat: true, createdAt: at0, ...over })

  it('offers a seat at rest only what changes it: start it, or review it', () => {
    const c = seatCard()
    expect(c.column).toBe('roles')
    expect(moveDestinations(c, null).map((d) => d.id)).toEqual(['inFlight', 'awaitingReview'])
  })

  it('names the way back for a seat in flight "Roles"', () => {
    const c = seatCard({ status: 'active' })
    expect(c.column).toBe('inFlight')
    const back = moveDestinations(c, 'inFlight').find((d) => d.id === 'stashed')
    expect(back?.label).toBe('Roles')
  })
})

describe('the Dock names a seat\'s role', () => {
  it('says "seat of <role>" on a seat and nothing on other work', () => {
    const seat = baseCard({ id: 'science/cmbx', name: 'cmbx chair', status: 'open', shuttleKind: 'oneshot', shuttleRole: 'cmbx-chair', shuttleSeat: true, createdAt: at0 })
    expect(stripFacts(seat).seat?.text).toBe('seat of cmbx-chair')
    expect(stripFacts({ ...seat, shuttleSeat: undefined }).seat).toBeUndefined()
  })
})

describe('the Roles band', () => {
  const renderer = (data: KanbanResponse, openDetail = vi.fn()) => new KanbanSurfaceRenderer({
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => data,
    stopDragAutoScroll: () => {},
    transition: () => {},
    setSurface: () => {},
    openDetail,
  })

  it('keeps an empty drop target reachable for the first seat', () => {
    const resp = board([])
    expect(renderer(resp).renderRolesSection(resp.roles, resp.staleness).textContent).toContain('drag a constitution here')
  })

  it('draws every seat as a chip that opens its fiber, a standing one wearing its next firing', () => {
    const resp = board([
      { id: 'life/vizier', uid: 'u1', name: 'Vizier', status: 'open', created_at: at0, shuttle: { kind: 'oneshot', host: 'desk', role: 'vizier', seat: true, agent: 'claude-opus' } },
      { id: 'loom/post', uid: 'u2', name: 'Morning post', status: 'active', created_at: at0, shuttle: { kind: 'standing', host: 'desk', role: 'vizier', seat: true, schedule: { expr: '0 7 * * *', tz: 'UTC' } } },
    ])
    const openDetail = vi.fn()
    const band = renderer(resp, openDetail).renderRolesSection(resp.roles, resp.staleness)!
    const chips = [...band.querySelectorAll<HTMLElement>('.kbn-role-chip')]
    expect(chips.map((c) => c.querySelector('.kbn-role-chip-name')?.textContent)).toEqual(['Morning post', 'Vizier'])
    expect(chips[0].querySelector('.kbn-role-chip-hint')?.textContent).toMatch(/^↻/)
    expect(chips[1].querySelector<HTMLElement>('.kbn-role-chip-hint')?.hidden).toBe(true)
    expect(chips[1].querySelector<HTMLElement>('.kbn-role-chip-hint')?.textContent).toBe('')
    expect(chips[1].title).toContain('seat of roles/vizier')
    chips[1].click()
    expect(openDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'life/vizier' }))
    expect(band.querySelector('.kbn-bandhead-title')?.textContent).toBe('Roles')
  })
})
