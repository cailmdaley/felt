import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { HUB_ROWS, hubTimes, type HubRow } from '../../../harness/hub-family.js'
import { familyModel, needsHuman, type FamilyModel } from './model.js'
import { skyLayout } from './sky.js'
import { ringsLayout } from './rings.js'
import { arrange, spiral, spiralLayout } from './spiral.js'
import { spread } from './drawing.js'

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
const SIZES = [[800, 720], [1056, 640], [900, 560], [1400, 860], [760, 520], [640, 760], [416, 720], [390, 700], [340, 600]] as const

describe.each(SIZES)('the sky at %i by %i', (width, height) => {
  const model = hub(), layout = skyLayout(model, width, height)
  it('names every thread that needs the human, on rim labels that never touch or leave the plate', () => {
    const asking = model.attention.filter(needsHuman)
    expect(asking.length).toBeGreaterThanOrEqual(14)
    const marks = layout.narrow ? layout.numerals : layout.labels
    expect([...new Set(marks.map(mark => mark.thread))]).toEqual(expect.arrayContaining(asking))
    const boxes = layout.narrow
      ? layout.numerals.map(n => ({ left: n.x - 9, right: n.x + 9, top: n.y - 9, bottom: n.y + 9 }))
      : layout.labels.map(l => ({ left: l.side === 'right' ? l.x : l.x - l.width, right: l.side === 'right' ? l.x + l.width : l.x, top: l.y - 12, bottom: l.y + 12 }))
    boxes.forEach((a, n) => {
      expect(a.left).toBeGreaterThanOrEqual(-1)
      expect(a.right).toBeLessThanOrEqual(width + 1)
      expect(a.top).toBeGreaterThanOrEqual(-1)
      expect(a.bottom).toBeLessThanOrEqual(layout.height + 1)
      for (const b of boxes.slice(n + 1)) expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)
    })
  })
  it('keeps labels outside the sky and marks from landing on each other', () => {
    for (const label of layout.labels) {
      expect(Math.hypot(label.x - layout.cx, label.y - layout.cy)).toBeGreaterThan(layout.R)
      expect(label.width).toBeGreaterThan(120)
    }
    layout.stars.forEach((a, n) => {
      for (const b of layout.stars.slice(n + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r)
    })
  })
})

it('keeps every thread of rings at its place while its activity changes, and on its generation', () => {
  const quiet = hub(), busy = hub(HUB_ROWS.map(row => ({ ...row, launches: row.launches + 3, state: row.state === 'done' ? 'work' as const : row.state === 'work' ? 'done' as const : row.state })))
  const place = (model: FamilyModel) => new Map(ringsLayout(model, 800, 720).stars.map(star => [star.thread.key, [star.x, star.y]]))
  expect(place(busy)).toEqual(place(quiet))
  const layout = ringsLayout(quiet, 800, 720), depth = new Map(layout.stars.map(star => [star.thread.depth, Math.hypot(star.x - layout.cx, star.y - layout.cy)]))
  expect(depth.get(0)).toBe(0)
  expect(depth.get(1)!).toBeLessThan(depth.get(2)!)
  expect(layout.stars.map(star => star.thread)).toEqual(expect.arrayContaining([...quiet.threads.values()]))
})
describe.each([[800, 720], [1056, 640], [416, 720]])('the spiral at %i by %i', (width, height) => {
  const model = hub(), layout = spiralLayout(model, width, height)
  it('winds the order out from the centre, evenly along the arc', () => {
    const distance = layout.stars.map(star => Math.hypot(star.x - layout.cx, star.y - layout.cy))
    expect(distance[0]).toBeLessThan(40)
    distance.forEach((d, n) => { if (n) expect(d).toBeGreaterThanOrEqual(distance[n - 1]) })
    expect(Math.max(...distance)).toBeLessThanOrEqual(layout.R + 1)
    const asking = layout.stars.slice(0, model.attention.length)
    const gaps = asking.slice(2).map((star, n) => Math.hypot(star.x - asking[n + 1].x, star.y - asking[n + 1].y))
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.4)
  })
  it('names what needs the human without two names touching', () => {
    if (layout.narrow) return expect(layout.numerals).toHaveLength(model.attention.filter(needsHuman).length)
    expect(layout.labels.map(label => label.thread)).toEqual(expect.arrayContaining(model.attention))
    const boxes = layout.labels.map(l => ({ left: l.side === 'right' ? l.x : l.x - l.width, right: l.side === 'right' ? l.x + l.width : l.x, top: l.y - 12, bottom: l.y + 12 }))
    boxes.forEach((a, n) => { for (const b of boxes.slice(n + 1)) expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true) })
  })
  it('lands what is in play inside the horizon and lets the rest unwind past it', () => {
    const horizon = layout.rings[0].radius, distance = (star: { x: number; y: number }): number => Math.hypot(star.x - layout.cx, star.y - layout.cy)
    const playing = layout.stars.slice(0, model.attention.length), tail = layout.stars.slice(model.attention.length)
    expect(Math.max(...playing.map(distance))).toBeLessThanOrEqual(horizon + 2)
    expect(Math.min(...tail.map(distance))).toBeGreaterThanOrEqual(Math.max(...playing.map(distance)))
    expect(layout.line?.receding).toBeTruthy()
  })
})
describe('arranging the spiral', () => {
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
})
it('stores no pin for a family that has none, and draws its pins on the sequence', () => {
  const model = hub()
  expect(spiral.sequence!(model).map(thread => thread.key)).toEqual(model.order.map(thread => thread.key))
})
it('moves a spiral thread only when its rank does', () => {
  const a = hub(), b = hub()
  expect(spiralLayout(a, 800, 720).stars.map(star => [star.x, star.y])).toEqual(spiralLayout(b, 800, 720).stars.map(star => [star.x, star.y]))
})
it('fills a tall frame with the disc, setting names in the corners, rather than shrinking it to keep the sides', () => {
  const layout = skyLayout(hub(), 800, 720)
  expect(layout.R).toBeGreaterThanOrEqual(280)
  for (const label of layout.labels) expect(Math.abs(label.y - layout.cy)).toBeGreaterThan(200)
})
it('names the root and the largest quiet bodies whole along an orbit, or not at all', () => {
  const model = hub(), layout = skyLayout(model, 800, 720)
  expect(layout.arcs.map(arc => arc.thread)).toContain(model.root)
  for (const arc of layout.arcs) {
    expect(layout.labels.map(label => label.thread)).not.toContain(arc.thread)
    expect(arc.thread.name.length * 6.3 / arc.radius).toBeCloseTo(arc.to - arc.from, 5)
    expect(arc.to - arc.from).toBeLessThanOrEqual(Math.PI * 200 / 180)
  }
  const long = { ...hub(), root: { ...model.root, name: 'x'.repeat(400) } }
  long.order = long.order.map(thread => thread === model.root ? long.root : thread)
  expect(skyLayout(long, 800, 720).arcs.map(arc => arc.thread)).not.toContain(long.root)
})
it('scales the same body from a thread to a whole family', () => {
  const model = hub(), layout = skyLayout(model, 1056, 640)
  const big = (mark: { r: number }): number => mark.r
  const root = layout.stars.find(star => star.thread === model.root)!
  expect(big(root)).toBeGreaterThan(Math.max(...layout.stars.filter(star => star !== root).map(big)))
  expect(model.mass).toBeGreaterThan(100)
  expect(model.counts.review).toBe(6)
})
it('absorbs a merged thread into its orchestrator: its work joins the parent and only its arc remains', () => {
  const model = hub(), merged = [...model.threads.values()].filter(thread => thread.merged)
  expect(merged.length).toBeGreaterThan(5)
  const parent = model.threads.get(merged.find(thread => thread.parent !== model.root.key && thread.launches.length > 0)!.parent!)!
  expect(parent.weight).toBeGreaterThan(parent.launches.length + parent.commits.length + parent.files.length)
  const drawn = merged.find(thread => thread.rank >= 0)!
  expect(skyLayout(model, 800, 720).stars.find(star => star.thread === drawn)!.r).toBeLessThan(2)
})
it('still keeps labels apart with twice the threads, when the rim is full', () => {
  const twice: HubRow[] = [...HUB_ROWS, ...HUB_ROWS.slice(1).map(row => ({ ...row, id: `${row.id}-2`, parent: row.parent === 'hub' ? 'hub' : `${row.parent}-2` }))]
  const layout = skyLayout(hub(twice), 1056, 420)
  for (const side of ['left', 'right']) {
    const rows = layout.labels.filter(label => label.side === side).map(label => label.y).sort((a, b) => a - b)
    rows.forEach((y, n) => { if (n) expect(y - rows[n - 1]).toBeGreaterThanOrEqual(23.99) })
    expect(rows.at(-1)).toBeLessThanOrEqual(420)
  }
})
it('puts the root at the centre and a thread farther out the longer it has been still', () => {
  const model = hub(), layout = skyLayout(model, 1056, 640)
  const at = (id: string) => { const star = layout.stars.find(item => item.thread.card.id === id)!; return Math.hypot(star.x - layout.cx, star.y - layout.cy) }
  expect(at('hub')).toBe(0)
  expect(at('hub/response')).toBeLessThan(at('hub/footprint'))
  expect(at('hub/footprint')).toBeLessThan(at('hub/learn'))
})
it('keeps a family\'s wedge together: a thread sits beside its orchestrator, away from other branches', () => {
  const model = hub(), layout = skyLayout(model, 1056, 640)
  const angle = new Map(layout.stars.map(star => [star.thread.card.id, star.angle]))
  const steward = angle.get('hub/pipeline-steward')!, sibling = angle.get('hub/cosmology')!
  for (const id of ['hub/pipeline-steward/merge', 'hub/pipeline-steward/match']) {
    expect(Math.abs(angle.get(id)! - steward)).toBeLessThan(Math.abs(sibling - steward))
  }
})
it('spreads positions by least squares, stacking only what touches', () => {
  expect(spread([0, 100], 20, -50, 200)).toEqual([0, 100])
  expect(spread([50, 50], 20, 0, 200)).toEqual([40, 60])
  expect(spread([0, 0, 0], 20, 10, 200)).toEqual([10, 30, 50])
  expect(spread([190, 195], 20, 0, 200)).toEqual([180, 200])
})
