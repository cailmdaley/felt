import { describe, expect, it } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import { card } from '../testFixtures.js'
import { ThreadIndex, threadKey } from '../threads.js'
import { inFlightModel, LATELY_MS } from './inFlight.js'
import { familyModel, type MapFeeds } from './model.js'
import { zoomPlate } from './orbit.js'
import { armsOf, radialLayout } from './radial.js'

const now = 1_800_000_000_000, hour = 3_600_000
const noFeeds: MapFeeds = { marks: () => undefined, files: () => [] }
const when = (back: number): string => new Date(now - back).toISOString()
const made = { createdAt: when(200 * hour), shuttleKind: 'oneshot' as const }
const working: Partial<KanbanCard> = { status: 'active', workerState: 'running', runtimePhase: 'working', lastActivityAt: now - hour, workerStartedAt: now - 9 * hour }

const quiet = card({ id: 'quiet', ...made, ...working })
const hub = card({ id: 'hub', ...made, ...working })
const asking = card({ id: 'hub/asking', orchestrator: 'hub', ...made, status: 'active', ask: { text: 'Which one?', at: when(hour) } })
const nested = card({ id: 'hub/asking/deep', orchestrator: 'hub/asking', ...made, ...working })
const review = card({ id: 'review', ...made, status: 'closed', closedAt: when(2 * hour) })
const split = card({ id: 'split', ...made, ...working })
const splitReview = card({ id: 'split/done', orchestrator: 'split', ...made, status: 'closed', closedAt: when(hour) })
const closed = card({ id: 'closed', ...made, status: 'closed', tempered: true, closedAt: when(LATELY_MS / 2) })
const old = card({ id: 'old', ...made, status: 'closed', tempered: true, closedAt: when(2 * LATELY_MS) })
const note = card({ id: 'note', createdAt: made.createdAt, status: 'closed', tempered: true, closedAt: when(hour), shuttleKind: undefined })
const resting = card({ id: 'resting', ...made, status: 'open', effectiveHorizon: 'stashed' })
const cards = [quiet, hub, asking, nested, review, split, splitReview, closed, old, note, resting]
const desk = { drafts: [], inFlight: [quiet, asking, split], awaitingReview: [review, splitReview] }
const index = new ThreadIndex(cards)
const model = inFlightModel(desk, cards, index, noFeeds, now)
const ids = (list: readonly { card: KanbanCard }[]): string[] => list.map(thread => thread.card.id)

describe('everything in flight as one family', () => {
  it('holds the families the Desk has in flight, what came to review, and what closed lately', () => {
    const arms = armsOf(model, model.root, {})
    expect(ids(arms.todo)[0]).toBe('hub')
    expect(new Set(ids(arms.todo))).toEqual(new Set(['hub', 'quiet', 'split']))
    expect(new Set(ids(arms.done))).toEqual(new Set(['review', 'closed']))
    expect([...model.threads.values()].map(thread => thread.card.id)).not.toContain('old')
    expect([...model.threads.values()].map(thread => thread.card.id)).not.toContain('resting')
  })
  it('hangs each family whole, as deep as its own map, under a centre with no fiber', () => {
    const own = familyModel(index, hub, hub, noFeeds, now)
    const on = model.threads.get(threadKey(hub))!
    expect(on.parent).toBe(model.root.key)
    expect(on.depth).toBe(1)
    expect(model.threads.get(threadKey(nested))!.depth).toBe(3)
    expect(on.children).toEqual(own.root.children)
    expect(model.root.card.path).toBe('')
    expect(model.root.name).toBe('In flight · 3')
    expect(model.root.word).toBe('')
    expect(model.root.launches).toEqual([])
    expect(model.current).toBe(model.root.key)
  })
  it('leaves the board\'s own index as it was', () => {
    expect(index.parentOf(hub)).toBeUndefined()
    expect(hub.orchestrator).toBeUndefined()
  })
  it('lets a family speak for its most urgent thread', () => {
    const body = model.threads.get(threadKey(hub))!
    expect(body.tone).toBe('question')
    expect(body.word).toBe('question')
    expect(body.note).toBe('Which one?')
    expect(body.standing).toBe('working')
    expect(body.asks).toBe(1)
    expect(model.threads.get(threadKey(quiet))!.asks).toBe(0)
    expect(model.threads.get(threadKey(quiet))!.tone).toBe('working')
  })
  it('puts what asks first along To do, numbered by place', () => {
    const plate = radialLayout(model, 800, 1000)
    const families = plate.stars.filter(star => star.owner === plate.stars[0])
    const numbered = families.filter(star => star.numeral).sort((a, b) => a.numeral - b.numeral)
    expect(numbered.map(star => star.numeral)).toEqual([1, 2, 3])
    expect(numbered[0].thread.card.id).toBe('hub')
    expect(families.filter(star => star.arm === 'done').every(star => !star.numeral)).toBe(true)
  })
  it('hangs what needs the human under a queued family, and gives a name no room to cross it', () => {
    const plate = radialLayout(model, 1000, 1000), view = { k: 1, x: 0, y: 0 }
    const sky = zoomPlate(plate, view, model, null), ask = sky.asks.find(item => item.thread.card.id === 'hub')!, star = sky.stars.find(item => item.thread === ask.thread)!
    expect(ask.numeral).toBe(1)
    expect(ask.x).toBe(star.x)
    expect(ask.y).toBeGreaterThan(star.y + star.r)
    expect(sky.asks.every(item => item.numeral > 0)).toBe(true)
    expect(sky.asks.some(item => item.thread.card.id === 'review')).toBe(false)
    expect(sky.labels.every(label => Math.abs(label.y - ask.y) > 7 || Math.abs(label.x - ask.x) > 12)).toBe(true)
  })
  it('keeps a body of work with nothing in flight off the map', () => {
    expect(inFlightModel({ drafts: [], inFlight: [], awaitingReview: [] }, [resting], new ThreadIndex([resting]), noFeeds, now).threads.size).toBe(1)
  })
})
