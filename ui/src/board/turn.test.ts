// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite, inFlightBand, isQuestion } from './KanbanReadModel.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { card } from './testFixtures.js'
import { turnOf, type Turn } from './turn.js'
import { Dock } from './workspace/Dock.js'
import { workerPlate } from './workspace/workerPlate.js'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const live = (over: Partial<KanbanCard>): KanbanCard =>
  card({ id: 'w', status: 'active', workerState: 'running', tmuxSession: 'w-shuttle', ...over })
const ASK = { text: 'OK to adopt the estimator?', at: '2026-10-18T10:00:00Z' }

describe('turnOf', () => {
  it.each<[string, Partial<KanbanCard>, Turn, string, boolean]>([
    ['a question asked while working', { runtimePhase: 'working', ask: ASK, lastActivityAt: NOW - 1000 }, 'question', 'question', true],
    ['a question asked, then idle', { runtimePhase: 'waiting', ask: ASK }, 'question', 'question', true],
    ['a harness prompt, over an ask', { runtimePhase: 'attention', ask: ASK }, 'prompt', 'at a prompt', true],
    ['a blocked turn', { runtimePhase: 'blocked', workerState: 'blocked' }, 'blocked', 'blocked', true],
    ['a launch error over cached activity', { runtimePhase: 'waiting', launchError: 'failed' }, 'blocked', 'blocked', true],
    ['failed attribution', { runtimePhase: 'identity_failed' }, 'blocked', 'unattributed', true],
    ['an ended turn', { runtimePhase: 'waiting' }, 'idle', 'idle', true],
    ['work in progress', { runtimePhase: 'working', lastActivityAt: NOW - 1000 }, 'working', 'working', false],
    ['an identity being acquired', { runtimePhase: 'identity_pending' }, 'unknown', 'identifying', false],
    ['a fresh launch with no hook yet', { workerStartedAt: NOW - 60_000 }, 'unknown', 'starting', false],
    ['an old launch with no hook', { workerStartedAt: NOW - 20 * 3_600_000 }, 'unknown', 'no signal', false],
  ])('reads %s', (_, over, turn, word, yours) => {
    expect(turnOf(live(over), NOW)).toMatchObject({ turn, word, yours })
  })

  it('keeps whose move apart from whether the worker is busy', () => {
    expect(turnOf(live({ runtimePhase: 'working', ask: ASK }), NOW)).toMatchObject({ turn: 'question', yours: true, busy: true })
    expect(turnOf(live({ runtimePhase: 'waiting' }), NOW)).toMatchObject({ yours: true, busy: false })
  })

  it('ages a question from when it was asked, and an idle turn from the last event', () => {
    expect(turnOf(live({ runtimePhase: 'working', ask: ASK, lastActivityAt: NOW - 1000 }), NOW).since).toBe(Date.parse(ASK.at))
    expect(turnOf(live({ runtimePhase: 'waiting', lastActivityAt: NOW - 5000 }), NOW).since).toBe(NOW - 5000)
  })

  it('names a working worker\'s silence only past ten minutes', () => {
    expect(turnOf(live({ runtimePhase: 'working', lastActivityAt: NOW - 60_000 }), NOW).since).toBeUndefined()
    expect(turnOf(live({ runtimePhase: 'working', lastActivityAt: NOW - 18 * 3_600_000 }), NOW).since).toBe(NOW - 18 * 3_600_000)
  })

  it('counts an ask only on an active card', () => {
    expect(turnOf(card({ id: 'x', status: 'closed', ask: ASK }), NOW).turn).toBe('none')
    expect(turnOf(card({ id: 'x', status: 'active', ask: ASK }), NOW)).toMatchObject({ turn: 'question', yours: true })
  })
})

// ── Every surface reads the one turn ────────────────────────────────────────

const PHASES = [undefined, 'working', 'waiting', 'attention', 'blocked', 'identity_pending', 'identity_failed'] as const
const runtimeArb = fc.record({
  phase: fc.constantFrom(...PHASES),
  state: fc.constantFrom('running', 'blocked'),
  surface: fc.constantFrom('cli', 'app'),
  launchError: fc.option(fc.constant('refused'), { nil: undefined }),
  idleMs: fc.integer({ min: 0, max: 48 * 3_600_000 }),
  ask: fc.boolean(),
  live: fc.boolean(),
})

type Row = typeof runtimeArb extends fc.Arbitrary<infer T> ? T : never

function feed(rows: Row[]): KanbanResponse {
  return buildKanbanResponseFromComposite(parseCompositeFeed({
    host: 'desk',
    fibers: rows.map((r, i) => ({
      origin: 'desk', felt_store: '/store', path: `${i}.md`,
      fiber: {
        id: `w-${i}`, uid: `uid-${i}`, name: `w-${i}`, status: 'active', created_at: '2026-10-01T12:00:00Z',
        shuttle: {
          kind: 'oneshot', host: 'desk', surface: r.surface,
          ...(r.surface === 'app' ? { runtime: { session_uuid: `0190a0be-6c36-7cd1-aec9-53a680d1f69${i % 10}` } } : {}),
          ...(r.ask ? { ask: ASK } : {}),
        },
      },
      runtime: !r.live ? undefined : {
        state: r.state, phase: r.phase, surface: r.surface,
        tmux_session: r.surface === 'cli' ? `tmux-${i}` : undefined,
        last_activity_at: NOW - r.idleMs, started_at: NOW - 20 * 3_600_000,
        launch_error: r.launchError,
      },
    })),
  }), { nowMs: NOW })
}

function desk(data: KanbanResponse): HTMLElement {
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, stack: () => {},
    reorderQueue: () => {}, unqueueRow: () => {}, openDetail: vi.fn(), onRefresh: () => {},
  }).renderNowSection(data.now, {}, null)
}

const YOURS = new Set(['blocked', 'prompt', 'question', 'idle'])

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('band, pill, dock and order cannot disagree', () => {
  it('draws every in-flight card in the band its pill names', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const dock = new Dock('https://daemon.example', vi.fn(), undefined, vi.fn())
    fc.assert(fc.property(fc.array(runtimeArb, { minLength: 1, maxLength: 8 }), (rows) => {
      const data = feed(rows)
      const root = desk(data)
      const byId = new Map(data.now.inFlight.map(c => [c.id, c]))
      let seenIdle = false
      for (const el of root.querySelectorAll<HTMLElement>('[data-flight-band] .kbn-card')) {
        const c = byId.get(el.dataset.fiberId!)!
        const band = el.closest<HTMLElement>('[data-flight-band]')!.dataset.flightBand
        const turn = turnOf(c)
        // The card, its band and the read model agree on the turn.
        expect(el.dataset.turn).toBe(turn.turn)
        expect(band).toBe(inFlightBand(c))
        expect(band === 'yourTurn').toBe(YOURS.has(turn.turn))
        // The pill, where one is drawn, names the same turn in the same word.
        const pill = el.querySelector<HTMLElement>('.kbn-card-worker')
        if (pill) {
          expect(pill.dataset.turn).toBe(turn.turn)
          expect(pill.querySelector('.ws-worker-state')?.textContent).toBe(turn.word)
        }
        // The dock's control for the same card says the same.
        const control = dock.workerPillFor(c)
        if (control) expect(workerPlate(c, control).dataset.turn).toBe(turn.turn)
        // Questions lead Your turn: no question follows an idle turn.
        if (band === 'yourTurn') {
          if (isQuestion(c)) expect(seenIdle).toBe(false)
          else seenIdle = true
        }
      }
    }), { numRuns: 150 })
  })
})
