// @vitest-environment jsdom
// Seats: a constitution carrying `shuttle.seat` is drawn among the Roles when
// it is at rest, and is ordinary work everywhere else. The classifier, the read
// model, the Move menu and the Roles band must agree on "at rest".

import { describe, expect, it, vi } from 'vitest'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { classifyFiber } from './KanbanRules.js'
import type { Fiber } from './KanbanFiber.js'
import { mapFeltJsonToFiber } from './KanbanFiber.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { moveDestinations, seatAtRest } from './MoveDestinations.js'
import { card as baseCard } from './testFixtures.js'
import { stripFacts } from './workspace/Dock.js'

const at0 = '2026-01-01T00:00:00Z'

const fiber = (over: Partial<Fiber>): Fiber => ({
  id: 'science/cmbx',
  name: 'cmbx chair',
  status: 'open',
  createdAt: at0,
  hasShuttleBlock: true,
  shuttleKind: 'oneshot',
  shuttleRole: 'cmbx-chair',
  shuttleSeat: true,
  ...over,
})

describe('classifyFiber — a seat at rest is among the Roles', () => {
  it('draws an open seat in Roles whatever its horizon', () => {
    expect(classifyFiber(fiber({}))).toBe('roles')
    expect(classifyFiber(fiber({ horizon: 'stashed' }))).toBe('roles')
  })

  it('draws a standing seat asleep on its cron in Roles', () => {
    expect(classifyFiber(fiber({ status: 'active', shuttleKind: 'standing' }))).toBe('roles')
  })

  it('leaves running, armed and closed seats to the lifecycle columns', () => {
    expect(classifyFiber(fiber({ status: 'open' }), { liveWorker: true })).toBe('inFlight')
    expect(classifyFiber(fiber({ status: 'active' }))).toBe('inFlight')
    expect(classifyFiber(fiber({ status: 'closed' }))).toBe('awaitingReview')
    expect(classifyFiber(fiber({ status: 'closed', tempered: true }))).toBe('tempered')
  })

  it('requires both an office and a boolean seat', () => {
    expect(classifyFiber(fiber({ shuttleSeat: false }))).toBe('drafts')
    expect(classifyFiber(fiber({ shuttleSeat: undefined }))).toBe('drafts')
    expect(classifyFiber(fiber({ shuttleRole: undefined }))).toBe('drafts')
    expect(classifyFiber(fiber({ shuttleSeat: 'cmbx-chair' as unknown as boolean }))).toBe('drafts')
  })
})

describe('mapFeltJsonToFiber reads shuttle.seat', () => {
  it('carries the role slug and boolean seat', () => {
    const f = mapFeltJsonToFiber({
      id: 'science/cmbx', name: 'cmbx chair', status: 'open', created_at: at0,
      shuttle: { kind: 'oneshot', role: 'cmbx-chair', seat: true },
    })
    expect(f?.shuttleRole).toBe('cmbx-chair')
    expect(f?.shuttleSeat).toBe(true)
  })
})

function board(fibers: Record<string, unknown>[]): KanbanResponse {
  return buildKanbanResponseFromComposite(parseCompositeFeed({
    host: 'desk',
    fibers: fibers.map((f, i) => ({ origin: 'desk', felt_store: '/store', path: `${i}.md`, fiber: f })),
    origins: { desk: { kind: 'local', stale: false, fiber_count: fibers.length } },
  }), { nowMs: Date.parse('2026-10-08T12:00:00Z') })
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
})

describe('a seat holds the work filed behind it', () => {
  it('folds an awaiting-review follower under the seat instead of leaving it loose', () => {
    const resp = board([
      { id: 'science/cmbx', uid: 'uid-c', name: 'cmbx', status: 'open', horizon: 'stashed', created_at: at0,
        shuttle: { kind: 'oneshot', host: 'desk', role: 'cmbx-chair', seat: true } },
      { id: 'science/cmbx/gc', uid: 'uid-g', name: 'gc', status: 'closed', closed_at: at0, created_at: at0,
        depends_on: 'science/cmbx', shuttle: { kind: 'oneshot', host: 'desk' } },
    ])
    expect(resp.roles.map((c) => c.id)).toEqual(['science/cmbx'])
    expect(resp.now.awaitingReview).toEqual([])
    expect(resp.folded.map((c) => [c.id, c.foldedUnder])).toEqual([['science/cmbx/gc', 'science/cmbx']])
  })
})

describe('moveDestinations for a seat', () => {
  const seatCard = (over: Partial<KanbanCard> = {}): KanbanCard =>
    baseCard({ id: 'science/cmbx', name: 'cmbx chair', status: 'open', shuttleKind: 'oneshot', shuttleRole: 'cmbx-chair', shuttleSeat: true, createdAt: at0, ...over })

  it('offers a seat at rest only what changes it: start it, or review it', () => {
    const c = seatCard()
    expect(seatAtRest(c)).toBe(true)
    expect(moveDestinations(c, null).map((d) => d.id)).toEqual(['inFlight', 'awaitingReview', 'queue'])
  })

  it('names the way back for a seat in flight "Roles"', () => {
    const c = seatCard({ status: 'active' })
    expect(seatAtRest(c)).toBe(false)
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
    stack: () => {},
    reorderQueue: () => {},
    unqueueRow: () => {},
    openDetail,
    onRefresh: () => {},
  })

  it('is absent when no seat is at rest', () => {
    const resp = board([])
    expect(renderer(resp).renderRolesSection(resp.roles, resp.staleness)).toBeNull()
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
    expect(chips[1].title).toContain('seat of roles/vizier')
    chips[1].click()
    expect(openDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'life/vizier' }))
    expect(band.querySelector('.kbn-bandhead-title')?.textContent).toBe('Roles')
  })

  it('takes a card dropped anywhere on a seat chip as a queue behind it', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ overflowX: 'visible', overflowY: 'visible' } as CSSStyleDeclaration)
    const resp = board([
      { id: 'life/vizier', uid: 'u1', name: 'Vizier', status: 'open', created_at: at0, shuttle: { kind: 'oneshot', host: 'desk', role: 'vizier', seat: true } },
      { id: 'work/draft', uid: 'u2', name: 'Draft', status: 'open', created_at: at0, shuttle: { kind: 'oneshot', host: 'desk' } },
    ])
    const stack = vi.fn()
    const band = new KanbanSurfaceRenderer({
      getDragSourceId: () => 'work/draft',
      setDragSourceId: () => {},
      getLastResponse: () => resp,
      stopDragAutoScroll: () => {},
      transition: () => {},
      setSurface: () => {},
      stack,
      reorderQueue: () => {},
      unqueueRow: () => {},
      openDetail: vi.fn(),
      onRefresh: () => {},
    }).renderRolesSection(resp.roles, resp.staleness)!
    document.body.append(band)
    const chip = band.querySelector<HTMLElement>('.kbn-role-chip')!
    const rect = { x: 100, y: 100, left: 100, top: 100, right: 220, bottom: 122, width: 120, height: 22, toJSON: () => ({}) }
    vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue(rect)
    for (let node = chip.parentElement; node; node = node.parentElement) {
      vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ ...rect, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 })
    }
    const drag = (type: string): Event => {
      // Near the chip's corner: outside a card's inner-60% zone.
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 103, clientY: 102 })
      Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '' } })
      return event
    }
    const over = drag('dragover')
    chip.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(chip.classList.contains('kbn-card-stack-target')).toBe(true)
    chip.dispatchEvent(drag('drop'))
    expect(stack).toHaveBeenCalledWith(expect.objectContaining({ id: 'work/draft' }), 'life/vizier')
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })
})
