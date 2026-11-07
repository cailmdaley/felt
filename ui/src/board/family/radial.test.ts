import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { HUB_ROWS, hubTimes, type HubRow } from '../../../harness/hub-family.js'
import { familyModel, needsHuman, type FamilyModel, type MapThread } from './model.js'
import { armsOf, arrange, radialLayout } from './radial.js'

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

describe.each(SIZES)('the radial drawing at %i by %i', (width, height) => {
  const model = hub(), layout = radialLayout(model, width, height), arms = armsOf(model)
  const on = (arm: readonly MapThread[]) => arm.map(thread => layout.stars.find(star => star.thread === thread)!)
  it('sets the constitution at the centre and every thread on an arm of its orchestrator', () => {
    expect(layout.stars[0].thread).toBe(model.root)
    expect(out(layout, layout.stars[0])).toBe(0)
    expect(new Set(layout.stars.map(star => star.thread))).toEqual(new Set(model.order))
    for (const star of layout.stars.slice(1)) {
      const parent = layout.stars.find(item => item.thread.key === star.thread.parent)!, own = armsOf(model, parent.thread)
      expect([...own.todo, ...own.done]).toContain(star.thread)
    }
  })
  it('winds to-do and just-finished out from the centre, first at the centre', () => {
    for (const arm of [arms.todo, arms.done]) {
      const reach = on(arm).map(star => out(layout, star))
      reach.forEach((d, n) => { if (n) expect(d).toBeGreaterThan(reach[n - 1]) })
      expect(Math.max(...reach)).toBeLessThanOrEqual(layout.R + 1)
    }
    expect(layout.line?.rising).toBeTruthy()
    expect(layout.line?.receding).toBeTruthy()
  })
  it('keeps every thread within its orchestrator\'s room, so a body holds its own threads and they zoom with it', () => {
    for (const star of layout.stars) {
      if (star.thread.depth < 2) continue
      const parent = layout.stars.find(item => item.thread.key === star.thread.parent)!
      expect(Math.hypot(star.x - parent.x, star.y - parent.y)).toBeLessThanOrEqual(parent.reach + 1)
      expect(star.reach).toBeLessThanOrEqual(parent.reach)
    }
  })
  it('sets every name whole, inside the plate, touching no other name', () => {
    if (layout.narrow) return expect(layout.numerals).toHaveLength(model.attention.filter(needsHuman).length)
    expect(layout.labels.length).toBeGreaterThan(3)
    const boxes = layout.labels.map(l => ({ left: l.side === 'right' ? l.x : l.x - l.width, right: l.side === 'right' ? l.x + l.width : l.x, top: l.y - 12, bottom: l.y + 12 }))
    for (const label of layout.labels) expect(label.width).toBeGreaterThanOrEqual(label.thread.name.length * 7.4)
    boxes.forEach((a, n) => {
      expect(a.left).toBeGreaterThanOrEqual(0); expect(a.right).toBeLessThanOrEqual(width)
      for (const b of boxes.slice(n + 1)) expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)
    })
  })
  it('names what asks at any depth, where a whole name fits', () => {
    if (layout.narrow) return
    const named = layout.labels.map(label => label.thread), asking = model.attention.filter(needsHuman)
    expect(asking.filter(thread => named.includes(thread)).length).toBeGreaterThanOrEqual(asking.length - 2)
  })
})
it('holds a family of one to a single body', () => {
  const only = HUB_ROWS.filter(row => row.id === 'hub'), layout = radialLayout(hub(only), 800, 720)
  expect(layout.stars).toHaveLength(1)
  expect(layout.labels).toEqual([])
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
