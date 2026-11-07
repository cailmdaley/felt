import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { HUB_ROWS, hubTimes, type HubRow } from '../../../harness/hub-family.js'
import { familyModel, type FamilyModel, type MapThread } from './model.js'
import { armsOf, arrange, radialLayout } from './radial.js'
import { zoomPlate } from './orbit.js'
import { WHOLE } from './zoom.js'

const now = 1_800_000_000_000, hour = 3_600_000
function hubCard(row: HubRow): KanbanCard {
  const moved = now - row.hours * hour, closed = ['review', 'done', 'discard'].includes(row.state)
  return card({
    id: row.id, uid: row.id, name: row.name, orchestrator: row.parent, createdAt: new Date(moved - 100 * hour).toISOString(),
    status: closed ? 'closed' : row.state === 'draft' || row.state === 'rest' ? 'open' : 'active',
    effectiveHorizon: row.state === 'rest' ? 'stashed' : 'now', tempered: row.state === 'done' ? true : row.state === 'discard' ? false : undefined,
    closedAt: closed ? new Date(moved).toISOString() : undefined, lastActivityAt: moved,
    ask: row.state === 'ask' ? { text: row.note, at: new Date(moved).toISOString() } : undefined,
    workerState: ['work', 'turn', 'ask', 'new'].includes(row.state) ? 'running' : undefined,
    runtimePhase: row.state === 'work' ? 'working' : row.state === 'turn' || row.state === 'new' ? 'waiting' : row.state === 'ask' ? 'attention' : undefined,
    launchError: row.state === 'blocked' ? row.note : undefined,
  })
}
function hub(rows: readonly HubRow[] = HUB_ROWS): FamilyModel {
  const cards = rows.map(hubCard), index = new ThreadIndex(cards)
  const byId = new Map(rows.map(row => [row.id, row]))
  return familyModel(index, cards[0], cards[0], {
    marks: thread => { const row = byId.get(thread.id)!; return { launches: hubTimes(row, row.launches, now), commits: hubTimes(row, row.commits, now) } },
    files: thread => { const row = byId.get(thread.id)!; return hubTimes(row, row.files, now).map((at, n) => ({ key: `${row.id}:${n}`, name: 'f.html', at, unread: row.state === 'new' })) },
  }, now)
}
const SIZES = [[800, 720], [800, 1000], [1600, 1000], [1056, 640], [416, 720]] as const
const out = (layout: ReturnType<typeof radialLayout>, star: { x: number; y: number }): number => Math.hypot(star.x - layout.cx, star.y - layout.cy)

const scene = (model: FamilyModel, width: number, height: number) => zoomPlate(radialLayout(model, width, height), WHOLE, model, null)
const boxOf = (label: { x: number; y: number; width: number; side: string }) => ({ left: label.side === 'right' ? label.x : label.x - label.width, right: label.side === 'right' ? label.x + label.width : label.x, top: label.y - 11.5, bottom: label.y + 11.5 })

describe.each(SIZES)('the radial drawing at %i by %i', (width, height) => {
  const model = hub(), layout = radialLayout(model, width, height), arms = armsOf(model), sky = scene(model, width, height)
  const on = (arm: readonly MapThread[]) => arm.map(thread => layout.stars.find(star => star.thread === thread)!)
  it('sets the constitution at the centre and every thread on an arm of its orchestrator', () => {
    expect(layout.stars[0].thread).toBe(model.root)
    expect(out(layout, layout.stars[0])).toBe(0)
    expect(new Set(layout.stars.map(star => star.thread))).toEqual(new Set(model.order))
    for (const star of layout.stars.slice(1)) {
      const own = armsOf(model, star.owner!.thread)
      expect([...own.todo, ...own.done]).toContain(star.thread)
    }
  })
  it('runs to do up the left and just finished down the right, first at the foot of each, reaching no further than the arm', () => {
    const rising = on(arms.todo).filter(star => star.side === 'left'), falling = on(arms.done).filter(star => star.side === 'right')
    rising.forEach((star, n) => { expect(star.x).toBeLessThan(layout.cx + 1); if (n) expect(star.y).toBeLessThan(rising[n - 1].y) })
    falling.forEach((star, n) => { expect(star.x).toBeGreaterThan(layout.cx - 1); if (n) expect(star.y).toBeGreaterThan(falling[n - 1].y) })
    for (const star of [...rising, ...falling]) expect(Math.abs(star.y - layout.cy)).toBeLessThanOrEqual(layout.reach + 1)
    expect(rising.length).toBeGreaterThan(3)
  })
  it('keeps every thread\'s scene inside its orchestrator\'s room, so zooming in arrives at it', () => {
    for (const star of layout.stars) {
      if (!star.owner) continue
      expect(star.room).toBeLessThan(star.owner.room)
      expect(star.scale).toBeCloseTo(star.room / layout.reach)
      expect(Math.hypot(star.x - star.owner.x, star.y - star.owner.y)).toBeLessThanOrEqual(star.owner.room * Math.max(1.02, layout.stretch * 1.02))
    }
  })
  it('sets every name whole, inside the plate, touching no other name and no line of its own arm', () => {
    if (layout.narrow) return expect(sky.numerals.length).toBeGreaterThan(0)
    expect(sky.labels.length).toBeGreaterThan(6)
    const boxes = sky.labels.map(boxOf)
    boxes.forEach((a, n) => {
      expect(a.left).toBeGreaterThanOrEqual(0); expect(a.right).toBeLessThanOrEqual(width)
      expect(a.top).toBeGreaterThanOrEqual(0); expect(a.bottom).toBeLessThanOrEqual(layout.height)
      for (const b of boxes.slice(n + 1)) expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)
    })
  })
  it('names every first-generation thread with a row, and what asks first', () => {
    if (layout.narrow) return
    const named = new Set(sky.labels.map(label => label.thread))
    for (const star of on([...arms.todo, ...arms.done])) if (star.side === (star.arm === 'todo' ? 'left' : 'right') && star.r > 2) expect(named.has(star.thread)).toBe(true)
  })
})
it('holds a family of one to a single body', () => {
  const only = HUB_ROWS.filter(row => row.id === 'hub'), layout = radialLayout(hub(only), 800, 720)
  expect(layout.stars).toHaveLength(1)
  expect(zoomPlate(layout, WHOLE, hub(only), null).labels).toEqual([])
})
it('sets just-finished threads by age on a log scale', () => {
  const rows = (hours: readonly number[]): HubRow[] => [HUB_ROWS[0], ...hours.map((age, n): HubRow => ({ ...HUB_ROWS[1], id: `hub/d${n}`, parent: 'hub', name: `Done ${n}`, state: 'done', hours: age, launches: 1, commits: 0, files: 0 }))]
  const early = radialLayout(hub(rows([2, 100])), 800, 1000), late = radialLayout(hub(rows([20, 100])), 800, 1000)
  const body = (layout: ReturnType<typeof radialLayout>, name: string) => layout.stars.find(star => star.thread.name === name)!
  expect(body(late, 'Done 0').y).toBeGreaterThan(body(early, 'Done 0').y + 30)
  expect(body(late, 'Done 1').y).toBeCloseTo(body(early, 'Done 1').y, 0)
})
describe('arranging the arms', () => {
  const threads = hub().order.slice(0, 6)
  const names = (keys: readonly { key: string }[]): number[] => keys.map(thread => threads.findIndex(item => item.key === thread.key))
  it('keeps a pinned thread at its slot and the rest in order around it', () => {
    expect(names(arrange(threads, { [threads[4].key]: 1 }))).toEqual([0, 4, 1, 2, 3, 5])
    expect(names(arrange(threads, { [threads[0].key]: 5 }))).toEqual([1, 2, 3, 4, 5, 0])
  })
  it('lets the first pin win a contested slot, and forgets pins for threads that left', () => {
    expect(names(arrange(threads, { [threads[4].key]: 1, [threads[3].key]: 1, gone: 0 }))).toEqual([0, 4, 3, 1, 2, 5])
    expect(names(arrange(threads, { [threads[1].key]: 99 }))).toEqual([0, 2, 3, 4, 5, 1])
  })
  it('moves a thread pinned across, to the slot it was given on that arm', () => {
    const model = hub(), { todo, done } = armsOf(model), asking = todo[0], finished = done[0]
    const crossed = armsOf(model, model.root, { [asking.key]: { arm: 'done', slot: 1, standing: asking.standing }, [finished.key]: { arm: 'todo', slot: 0, standing: finished.standing } })
    expect(crossed.done[1]).toBe(asking)
    expect(crossed.todo[0]).toBe(finished)
    expect(crossed.todo).not.toContain(asking)
  })
})
