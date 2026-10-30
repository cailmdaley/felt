// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite, byInFlightBand, deriveCycleLens } from './KanbanReadModel.js'
import { KanbanSurfaceRenderer, restingOrder } from './KanbanSurfaces.js'
import { deskCardKey, deskOrder } from './deskOrdering.js'
import { zone } from './civilDay.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'

function renderer(data: KanbanResponse, openDetail = vi.fn(), openWorker = vi.fn()): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => data,
    stopDragAutoScroll: () => {},
    transition: () => {},
    setSurface: () => {},
    openDetail,
    openWorker,
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
  it('labels the cycle chip count with its unit', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    const cycle = card({ id: 'cycle', isCycle: true, cycleStart: '2026-10-01', due: '2026-10-31' })
    const member = card({ id: 'work/member', status: 'open', shuttleKind: 'oneshot', due: '2026-10-10' })
    const data = response({ cycles: [cycle], now: { drafts: [member], inFlight: [], awaitingReview: [] } })
    const chip = renderer(data).renderCycleLensBar(null, vi.fn(), now)!.querySelector<HTMLButtonElement>('.kbn-lens-chip')!
    expect(chip.querySelector('.kbn-lens-chip-count')?.textContent).toBe('1 card')
    expect(chip.getAttribute('aria-label')).toBe('cycle, 1 card')
    expect(chip.title).toContain('1 card')
  })

  it('renders a due-dated seat like a resting member without moving it out of Roles', () => {
    const now = Date.parse('2026-10-05T12:00:00Z')
    const seat = card({ id: 'seats/vizier', shuttleSeat: true, shuttleRole: 'vizier', due: '2026-10-07', effectiveHorizon: 'stashed' })
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
  it('keeps the terminal in the action menu with the owning host, never on the row', () => {
    const data = workerFeed(['working']), openWorker = vi.fn()
    const worker = data.now.inFlight[0]
    const root = renderer(data, vi.fn(), openWorker).renderNowSection(data.now, {})
    document.body.append(root)
    root.querySelector<HTMLElement>('.kbn-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const terminal = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Open terminal')!
    expect(terminal).toBeDefined()
    terminal.click()
    expect(openWorker).toHaveBeenCalledExactlyOnceWith(worker.tmuxSession, worker.shuttleHost)
    expect(root.querySelector('.kbn-card-worker')).toBeNull()
    root.remove()
  })
  it.each([
    ['identity_pending', 'working', 'Working', 'starting'],
    ['identity_failed', 'yourTurn', 'Your turn', 'blocked'],
  ])('marks %s with a dot: a pending identity is the worker\'s move, a failed one needs repair', (phase, band, caption, label) => {
    const data = workerFeed([phase])
    const surfaces = renderer(data)
    const root = surfaces.renderNowSection(data.now, {})
    expect(flightOrder(root)).toEqual([
      { band, caption, label: caption, ids: ['worker-0'] },
    ])
    expect(root.querySelector('.constitution-state-dot')?.getAttribute('data-turn')).toBe(label)
    expect(root.querySelector('.kbn-card-worker, .kbn-card-phase, .kbn-card-glyph')).toBeNull()
  })
  it('ranks asks and harness prompts first in Your turn, both drawn and named as questions', () => {
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
    // The row carries the turn; the workspace reads the question.
    expect(root.querySelector<HTMLElement>('[data-fiber-id="question"]')?.dataset.turn).toBe('question')
    expect(root.querySelector<HTMLElement>('[data-fiber-id="worker-0"]')?.dataset.turn).toBe('idle')
    expect(root.querySelector<HTMLElement>('[data-fiber-id="worker-1"]')?.dataset.turn).toBe('working')
    question.runtimePhase = 'attention'
    expect(flightOrder(renderer(data).renderNowSection(data.now, {}))).toEqual(flightOrder(root))
    question.ask = undefined
    const attention = renderer(data).renderNowSection(data.now, {})
    expect(attention.querySelector('[data-fiber-id="question"] .constitution-state-dot')?.getAttribute('data-turn')).toBe('question')
  })

  it('draws a launch held in boot quarantine in its own Held band after Working, never as a running worker', () => {
    const data = workerFeed(['working'])
    const held = { ...data.now.inFlight[0], id: 'held', uid: 'held', name: 'Held launch', tmuxSession: undefined, runtimePhase: undefined, workerState: undefined, held: true }
    data.now.inFlight.unshift(held)
    data.now.inFlight.sort(byInFlightBand)
    expect(data.now.inFlight.map(card => card.id)).toEqual(['worker-0', 'held'])
    const root = renderer(data).renderNowSection(data.now, {})
    expect(flightOrder(root)).toEqual([
      { band: 'working', caption: 'Working', label: 'Working', ids: ['worker-0'] },
      { band: 'held', caption: 'Held', label: 'Held', ids: ['held'] },
    ])
  })

  it('renders two quiet captions, puts questions before idle turns, and retains creation order within each', () => {
    const data = workerFeed(['working', 'attention', 'blocked', 'waiting', 'unobserved'])
    const openDetail = vi.fn()
    const root = renderer(data, openDetail).renderNowSection(data.now, {})
    document.body.append(root)
    const column = root.querySelector<HTMLElement>('[data-column="inFlight"]')!
    expect(flightOrder(column)).toEqual([
      { band: 'yourTurn', caption: 'Your turn', label: 'Your turn', ids: ['worker-1', 'worker-3', 'worker-2'] },
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
    const after = workerFeed(['retrying', 'attention', 'waiting', 'blocked', 'working'], 1_800_000_000_000)
    expect(flightOrder(renderer(after).renderNowSection(after.now, {})))
      .toEqual(flightOrder(renderer(before).renderNowSection(before.now, {})))
  })

  it('moves only a crossing card into its creation position in the other band', () => {
    const data = workerFeed(['working', 'attention', 'blocked', 'working', 'unobserved'])
    expect(flightOrder(renderer(data).renderNowSection(data.now, {}))).toEqual([
      { band: 'yourTurn', caption: 'Your turn', label: 'Your turn', ids: ['worker-1', 'worker-2'] },
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
})

describe('Resting rendering follows the ordering contract', () => {
  const paris = zone('Europe/Paris')

  it('draws undated before dated, warm before cold in both halves, and return then creation order', () => {
    const data = response({ stash: [
      card({ id: 'cold/undated', cold: true }),
      card({ id: 'warm/new-late', due: '2026-10-08', createdAt: '2026-10-04T12:00:00Z' }),
      card({ id: 'warm/old-soon', due: '2026-10-07', createdAt: '2026-10-01T12:00:00Z' }),
      card({ id: 'warm/new-soon', due: '2026-10-07T00:00:00+02:00', createdAt: '2026-10-04T12:00:00Z' }),
      card({ id: 'cold/dated', due: '2026-10-06', cold: true }),
      card({ id: 'warm/undated' }),
    ] })
    expect(renderedIds(renderer(data).renderStashSection(restingOrder(data.stash), {})))
      .toEqual(['warm/undated', 'cold/undated', 'warm/new-soon', 'warm/old-soon', 'warm/new-late', 'cold/dated'])
  })

  it('matches the drawn Resting order and ignores feed order and unrelated poll fields', () => {
    interface SeedCard {
      path: string[]
      leaf: number
      created: string | undefined
      due: string | undefined
      cold: boolean
      origin: string
      standing: boolean
    }
    const seedCard = fc.record({
      path: fc.array(fc.constantFrom('a', 'b', 'c'), { minLength: 1, maxLength: 3 }),
      leaf: fc.integer({ min: 0, max: 400 }),
      created: fc.constantFrom<string | undefined>('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', undefined),
      due: fc.constantFrom<string | undefined>(undefined, '2026-11-01', '2026-11-02'),
      cold: fc.boolean(),
      origin: fc.constantFrom('h1', 'h2'),
      standing: fc.boolean(),
    })
    const buildCards = (seeds: SeedCard[]): KanbanCard[] => {
      const seen = new Set<string>()
      const cards: KanbanCard[] = []
      for (const seed of seeds) {
        const id = [...seed.path, `n${seed.leaf}`].join('/')
        const identity = JSON.stringify([seed.origin, id])
        if (seen.has(identity)) continue
        seen.add(identity)
        cards.push(card({
          id, originId: seed.origin, uid: `${seed.origin}-${id}`, createdAt: seed.created,
          due: seed.due, cold: seed.cold, effectiveHorizon: 'stashed',
          ...(seed.standing ? {
            shuttleKind: 'standing', status: 'active',
            nextLaunchAt: seed.due ? `${seed.due}T08:00:00Z` : undefined,
          } : {}),
        }))
      }
      return cards
    }
    const shuffled = <T,>(items: readonly T[], seed: number): T[] => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const j = seed % (i + 1)
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    }
    const drawn = (data: KanbanResponse): string[] => {
      const order = deskOrder(data, paris)
      const root = renderer(data).renderStashSection(order.resting, data.staleness)
      return [...root.querySelectorAll<HTMLElement>('[data-card-uid]')]
        .map(el => JSON.stringify([el.dataset.cardOrigin, el.dataset.cardUid]))
    }

    fc.assert(fc.property(fc.array(seedCard, { maxLength: 40 }), fc.integer(), (seeds, seed) => {
      const cards = buildCards(seeds)
      const stash = cards.filter(item => !item.shuttleKind)
      const future = cards.filter(item => item.shuttleKind)
      const initial = response({ stash, timeline: { past: [], futureDated: future } })
      const initialRows = deskOrder(initial, paris).rows.map(deskCardKey)
      const resting = deskOrder(initial, paris).resting.flat.map(deskCardKey)

      expect(resting).toEqual(drawn(initial))

      const polled = response({
        stash: shuffled(stash, seed).map(item => ({ ...item, lastActivityAt: Math.abs(seed), outcome: String(seed) })),
        timeline: {
          past: [],
          futureDated: shuffled(future, seed + 1).map(item => ({ ...item, lastActivityAt: 5 })),
        },
      })
      expect(deskOrder(polled, paris).resting.flat.map(deskCardKey)).toEqual(resting)
      expect(deskOrder(polled, paris).rows.map(deskCardKey)).toEqual(initialRows)
    }), { seed: 20261030, numRuns: 400 })
  })
})
