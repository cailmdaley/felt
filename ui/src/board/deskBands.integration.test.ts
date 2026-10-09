// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite, byInFlightBand, deriveCycleLens } from './KanbanReadModel.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'

function renderer(data: KanbanResponse, openDetail = vi.fn()): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer({
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
}

function workerFeed(phases: string[], activityBase = 0): KanbanResponse {
  return buildKanbanResponseFromComposite(parseCompositeFeed({
    host: 'desk',
    fibers: phases.map((phase, i) => ({
      origin: i % 2 ? 'beta' : 'alpha', felt_store: '/store', path: `${i}.md`,
      fiber: {
        id: `worker-${i}`, uid: `uid-${i}`, name: 'Identical name', status: 'active',
        created_at: `2026-10-0${i + 1}T12:00:00Z`,
        shuttle: { kind: 'oneshot', host: i % 2 ? 'beta' : 'alpha' },
      },
      runtime: phase === 'unobserved' ? undefined : {
        state: phase === 'blocked' ? 'blocked' : 'running', phase,
        tmux_session: phase === 'blocked' ? undefined : `tmux-${i}`,
        last_activity_at: activityBase + i * 1000,
        launch_error: phase === 'blocked' ? 'Needs a project directory' : undefined,
      },
    })).reverse(),
  }), { nowMs: Date.parse('2026-10-05T12:00:00Z') })
}

function flightOrder(root: HTMLElement): unknown {
  return [...root.querySelectorAll<HTMLElement>('[data-flight-band]')].map((band) => ({
    band: band.dataset.flightBand,
    caption: band.querySelector('h3')?.textContent,
    label: band.querySelector('[role="list"]')?.getAttribute('aria-label'),
    ids: [...band.querySelectorAll<HTMLElement>('.kbn-card')].map((el) => el.dataset.fiberId),
  }))
}

function renderedIds(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('[data-fiber-id]')].map((el) => el.dataset.fiberId!)
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('cycle members at rest', () => {
  it('renders a due-dated seat like a resting member without moving it out of Roles', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    const seat = card({ id: 'seats/vizier', shuttleSeat: 'vizier', due: '2026-10-07', effectiveHorizon: 'stashed' })
    const resting = card({ id: 'work/resting', due: seat.due, effectiveHorizon: 'stashed' })
    const data = response({
      roles: [seat], stash: [resting],
      cycles: [card({ id: 'cycle', isCycle: true, cycleStart: '2026-10-01', due: '2026-10-10' })],
    })
    const lens = deriveCycleLens(data, 'cycle', now)
    const openDetail = vi.fn()
    const surfaces = renderer(data, openDetail)
    const root = surfaces.renderNowSection(data.now, {}, lens)
    const drafts = root.querySelector('[data-column="drafts"]')!
    const ghosts = [...drafts.querySelectorAll<HTMLElement>('.kbn-card--lens-ghost')]
    expect(ghosts.map((el) => el.dataset.fiberId).sort()).toEqual([seat.id, resting.id].sort())
    expect(drafts.querySelector('.kbn-col-count')?.textContent).toBe('2')
    const seatGhost = ghosts.find((el) => el.dataset.fiberId === seat.id)!
    expect(seatGhost.getAttribute('aria-label')).toContain('resting, shown for this cycle')
    seatGhost.click()
    expect(openDetail).toHaveBeenCalledWith(seat)
    expect(renderedIds(surfaces.renderRolesSection(data.roles, {})!)).toContain(seat.id)
    expect(data.roles).toEqual([seat])
  })
})

describe('In flight bands', () => {
  it('ranks asks and attention first in Your turn, drawn as questions, with at a prompt for harness attention', () => {
    const feed = parseCompositeFeed({
      host: 'desk',
      fibers: [{
        origin: 'desk', felt_store: '/store', path: 'question.md',
        fiber: {
          id: 'question', name: 'Question worker', status: 'active', created_at: '2026-01-01T12:00:00Z',
          shuttle: { host: 'desk', ask: { text: 'Your view on the cut would help — report §2', at: '2026-10-05T12:00:00Z' } },
        },
        runtime: { state: 'running', phase: 'working', tmux_session: 'tmux-question' },
      }],
    })
    const data = buildKanbanResponseFromComposite(feed)
    const question = data.now.inFlight[0]
    expect(question.ask).toEqual({ text: 'Your view on the cut would help — report §2', at: '2026-10-05T12:00:00Z' })
    data.now.inFlight.push(...workerFeed(['waiting', 'working']).now.inFlight)
    data.now.inFlight.reverse().sort(byInFlightBand)
    expect(data.now.inFlight.map(card => card.id)).toEqual(['question', 'worker-0', 'worker-1'])
    const root = renderer(data).renderNowSection(data.now, {})
    expect(flightOrder(root)).toEqual([
      { band: 'yourTurn', caption: 'Your turn', label: 'Your turn', ids: ['question', 'worker-0'] },
      { band: 'working', caption: 'Working', label: 'Working', ids: ['worker-1'] },
    ])
    expect(root.querySelector('.kbn-card-question')?.textContent).toBe(question.ask!.text)
    expect(root.querySelector<HTMLElement>('[data-fiber-id="question"]')?.dataset.turn).toBe('question')
    expect(root.querySelector<HTMLElement>('[data-fiber-id="worker-0"]')?.dataset.turn).toBe('idle')
    expect(root.querySelector<HTMLElement>('[data-fiber-id="worker-1"]')?.dataset.turn).toBeUndefined()
    question.runtimePhase = 'attention'
    expect(flightOrder(renderer(data).renderNowSection(data.now, {}))).toEqual(flightOrder(root))
    question.ask = undefined
    const attention = renderer(data).renderNowSection(data.now, {})
    expect(attention.querySelector('[data-fiber-id="question"] .kbn-card-question')).toBeNull()
    expect(attention.querySelector('[data-fiber-id="question"]')?.textContent).toContain('at a prompt')
  })

  it('renders two quiet captions, puts questions before idle turns, and retains creation order within each', () => {
    const data = workerFeed(['working', 'attention', 'blocked', 'waiting', 'unobserved'])
    const openDetail = vi.fn()
    const root = renderer(data, openDetail).renderNowSection(data.now, {})
    document.body.append(root)
    const column = root.querySelector<HTMLElement>('[data-column="inFlight"]')!
    expect(flightOrder(column)).toEqual([
      { band: 'yourTurn', caption: 'Your turn', label: 'Your turn', ids: ['worker-2', 'worker-1', 'worker-3'] },
      { band: 'working', caption: 'Working', label: 'Working', ids: ['worker-4', 'worker-0'] },
    ])
    expect(column.querySelector('.kbn-col-count')?.textContent).toBe('5')
    expect(column.querySelectorAll('.kbn-col-list')).toHaveLength(1)
    expect(column.querySelectorAll('.kbn-empty')).toHaveLength(0)
    expect(column.querySelector('[data-flight-band="yourTurn"] .kbn-card[data-fiber-id="worker-3"]')).not.toBeNull()
    expect(column.querySelector('[data-flight-band="working"] .kbn-card[data-fiber-id="worker-0"]')).not.toBeNull()
    const waiting = column.querySelector<HTMLElement>('[data-fiber-id="worker-3"]')!
    expect(waiting.getAttribute('draggable')).toBe('true')
    waiting.click()
    expect(openDetail).toHaveBeenCalledWith(data.now.inFlight.find((c) => c.id === 'worker-3'))
  })

  it('does not reshuffle or change captions when phase or activity changes stay inside a tier', () => {
    const before = workerFeed(['working', 'attention', 'blocked', 'waiting', 'unobserved'])
    const after = workerFeed(['retrying', 'blocked', 'attention', 'waiting', 'working'], 1_800_000_000_000)
    expect(flightOrder(renderer(after).renderNowSection(after.now, {})))
      .toEqual(flightOrder(renderer(before).renderNowSection(before.now, {})))
  })

  it('moves only a crossing card into its creation position in the other band', () => {
    const data = workerFeed(['working', 'attention', 'blocked', 'working', 'unobserved'])
    expect(flightOrder(renderer(data).renderNowSection(data.now, {}))).toEqual([
      { band: 'yourTurn', caption: 'Your turn', label: 'Your turn', ids: ['worker-2', 'worker-1'] },
      { band: 'working', caption: 'Working', label: 'Working', ids: ['worker-4', 'worker-3', 'worker-0'] },
    ])
  })

  it.each([
    [['waiting', 'blocked'], 'Your turn'],
    [['working', 'unobserved'], 'Working'],
  ])('shows only the populated band for %j', (phases, label) => {
    const data = workerFeed(phases)
    const root = renderer(data).renderNowSection(data.now, {})
    expect([...root.querySelectorAll('.kbn-flight-caption')].map((c) => c.textContent)).toEqual([label])
    expect(root.querySelectorAll('.kbn-flight-band')).toHaveLength(1)
  })

  it('keeps the empty launch hint without misleading empty band captions', () => {
    const data = response()
    const root = renderer(data).renderNowSection(data.now, {})
    const column = root.querySelector('[data-column="inFlight"]')!
    expect(column.querySelector('.kbn-empty')?.textContent).toBe('Drag a draft here to start its agent.')
    expect(column.querySelectorAll('.kbn-flight-band')).toHaveLength(0)
  })

  it('keeps a queue peek in dependency order even when creation order is reversed', () => {
    const head = card({ id: 'head', status: 'active', runtimePhase: 'waiting' })
    const next = card({ id: 'next', createdAt: '2026-01-01T09:00:00Z', dependsOn: ['head'], foldedUnder: 'head' })
    const last = card({ id: 'last', createdAt: '2026-10-01T09:00:00Z', dependsOn: ['next'], foldedUnder: 'head' })
    const data = response({ now: { drafts: [], inFlight: [head], awaitingReview: [] }, folded: [last, next] })
    const root = renderer(data).renderNowSection(data.now, {})
    document.body.append(root)
    root.querySelector<HTMLElement>('.kbn-card-queued')!.click()
    expect([...root.querySelectorAll<HTMLElement>('.kbn-card-queued-row')].map((el) => el.textContent))
      .toEqual(['next', 'last'])
  })
})

describe('Resting rendering follows the ordering contract', () => {
  it('draws undated before dated, warm before cold in both halves, and return then creation order', () => {
    const data = response({ stash: [
      card({ id: 'cold/undated', cold: true }),
      card({ id: 'warm/new-late', due: '2026-10-08', createdAt: '2026-10-04T12:00:00Z' }),
      card({ id: 'warm/old-soon', due: '2026-10-07', createdAt: '2026-10-01T12:00:00Z' }),
      card({ id: 'warm/new-soon', due: '2026-10-07T00:00:00+02:00', createdAt: '2026-10-04T12:00:00Z' }),
      card({ id: 'cold/dated', due: '2026-10-06', cold: true }),
      card({ id: 'warm/undated' }),
    ] })
    expect(renderedIds(renderer(data).renderStashSection(data.stash, {})))
      .toEqual(['warm/undated', 'cold/undated', 'warm/new-soon', 'warm/old-soon', 'warm/new-late', 'cold/dated'])
  })
})
