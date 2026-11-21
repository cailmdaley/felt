// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { threadIndexFor } from './threads.js'
import { ATTENTION_ORDER, attentionOf } from './attention.js'
import { deskOrder } from './deskOrdering.js'
import { hasLiveWorker, type KanbanCard, type KanbanResponse } from './KanbanTypes.js'
import { card, servedFeed } from './testFixtures.js'
import { TURN_WORD, turnOf, type Turn } from './turn.js'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const live = (over: Partial<KanbanCard>): KanbanCard =>
  card({ id: 'w', status: 'active', workerState: 'running', tmuxSession: 'w-shuttle', ...over })
const ASK = { text: 'OK to adopt the estimator?', at: '2026-10-18T10:00:00Z' }

describe('turnOf', () => {
  it.each<[string, Partial<KanbanCard>, Turn, string, boolean, RegExp]>([
    ['a question asked while working', { turn: 'question', runtimePhase: 'working', ask: ASK, lastActivityAt: NOW - 1000 }, 'question', 'question', true, /asked: .* still working/],
    ['a harness prompt', { turn: 'question', runtimePhase: 'attention' }, 'question', 'question', true, /stopped on a harness prompt/],
    ['a harness prompt, over an ask', { turn: 'question', runtimePhase: 'attention', ask: ASK }, 'question', 'question', true, /It also asked/],
    ['a launch error', { turn: 'blocked', runtimePhase: 'waiting', launchError: 'failed' }, 'blocked', 'blocked', true, /^failed$/],
    ['failed attribution', { turn: 'blocked', runtimePhase: 'identity_failed' }, 'blocked', 'blocked', true, /attribution failed/],
    ['an ended turn', { turn: 'idle', runtimePhase: 'waiting' }, 'idle', 'idle', true, /ended its turn/],
    ['work in progress', { turn: 'working', runtimePhase: 'working', lastActivityAt: NOW - 1000 }, 'working', 'working', false, /mid-turn/],
    ['an identity being acquired', { turn: 'starting', runtimePhase: 'identity_pending' }, 'starting', 'starting', false, /acquiring its session/],
    ['a fresh launch with no hook yet', { turn: 'starting', workerStartedAt: NOW - 60_000 }, 'starting', 'starting', false, /no hook event yet/],
    ['an old launch with no hook', { turn: 'no-signal', workerStartedAt: NOW - 20 * 3_600_000 }, 'no-signal', 'no signal', false, /holds no hook event/],
  ])('says %s', (_, over, turn, word, yours, detail) => {
    const state = turnOf(live(over))
    expect(state).toMatchObject({ turn, word, yours })
    expect(state.detail).toMatch(detail)
  })

  it('keeps whose move apart from whether the worker is busy', () => {
    expect(turnOf(live({ turn: 'question', runtimePhase: 'working', ask: ASK }))).toMatchObject({ turn: 'question', yours: true, busy: true })
    expect(turnOf(live({ turn: 'idle', runtimePhase: 'waiting' }))).toMatchObject({ yours: true, busy: false })
  })

  it('ages a question from when it was asked, and an idle turn from the last event', () => {
    expect(turnOf(live({ turn: 'question', runtimePhase: 'working', ask: ASK, lastActivityAt: NOW - 1000 })).since).toBe(Date.parse(ASK.at))
    expect(turnOf(live({ turn: 'idle', runtimePhase: 'waiting', lastActivityAt: NOW - 5000 })).since).toBe(NOW - 5000)
  })

  it('names a working worker\'s silence when its owner says it is quiet', () => {
    expect(turnOf(live({ turn: 'working', runtimePhase: 'working', lastActivityAt: NOW - 3_600_000 })).since).toBeUndefined()
    const quiet = turnOf(live({ turn: 'working', runtimePhase: 'working', lastActivityAt: NOW - 20 * 3_600_000, quietSince: NOW - 18 * 3_600_000 }))
    expect(quiet).toMatchObject({ since: NOW - 18 * 3_600_000, detail: expect.stringMatching(/no hook event since/) })
  })

  it('reads an unreachable owner\'s frozen runtime as no turn at all, keeping only the synced ask', () => {
    const since = '2026-10-16T14:17:00Z'
    const frozen = live({ turn: 'working', runtimePhase: 'working', lastActivityAt: NOW - 98 * 3_600_000, originStale: { since } })
    expect(turnOf(frozen)).toMatchObject({ turn: 'no-signal', word: 'no signal', yours: false, busy: false, since: Date.parse(since) })
    expect(turnOf({ ...frozen, turn: 'question', runtimePhase: 'attention' }).turn).toBe('no-signal')
    expect(turnOf({ ...frozen, ask: ASK })).toMatchObject({ turn: 'question', yours: true, busy: false })
  })

  it('counts an ask only on an active card', () => {
    expect(turnOf(card({ id: 'x', status: 'closed', ask: ASK })).turn).toBe('none')
    expect(turnOf(card({ id: 'x', status: 'active', ask: ASK }))).toMatchObject({ turn: 'question', yours: true })
  })
})

// ── Every surface reads the one turn ────────────────────────────────────────

const PHASES = [undefined, 'working', 'waiting', 'attention', 'blocked', 'identity_pending', 'identity_failed'] as const
const runtimeArb = fc.record({
  phase: fc.constantFrom(...PHASES),
  state: fc.constantFrom('running', 'blocked'),
  launchError: fc.option(fc.constant('refused'), { nil: undefined }),
  idleMs: fc.integer({ min: 0, max: 48 * 3_600_000 }),
  ask: fc.boolean(),
  live: fc.boolean(),
  unreachable: fc.boolean(),
})

type Row = typeof runtimeArb extends fc.Arbitrary<infer T> ? T : never

function feed(rows: Row[]): KanbanResponse {
  return buildKanbanResponseFromComposite(parseCompositeFeed(servedFeed({
    host: 'desk',
    fibers: rows.map((r, i) => ({
      origin: r.unreachable ? 'far' : 'desk', felt_store: '/store', path: `${i}.md`,
      fiber: {
        id: `w-${i}`, uid: `uid-${i}`, name: `w-${i}`, status: 'active', created_at: '2026-10-01T12:00:00Z',
        shuttle: {
          kind: 'oneshot', host: r.unreachable ? 'far' : 'desk',
                    ...(r.ask ? { ask: ASK } : {}),
        },
      },
      runtime: !r.live ? undefined : {
        state: r.state, phase: r.phase,
        tmux_session: `tmux-${i}`,
        last_activity_at: NOW - r.idleMs, started_at: NOW - 20 * 3_600_000,
        launch_error: r.launchError,
      },
    })),
    origins: {
      desk: { kind: 'local', stale: false, fiber_count: rows.length },
      far: { kind: 'remote', stale: true, last_polled_at: '2026-10-16T14:17:00Z', fiber_count: 0 },
    },
  }, NOW)), { nowMs: NOW })
}

function desk(data: KanbanResponse): HTMLElement {
  const index = threadIndexFor(data)
  return new KanbanSurfaceRenderer({ waits: () => new Map(), openDetail: vi.fn(), clear: vi.fn() }).renderDesk(deskOrder(index, new Map()), index)
}

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('the column, the dot and the worker facts cannot disagree', () => {
  it('draws every constitution in a section its state names, its dot saying the same, its turn the same everywhere', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    fc.assert(fc.property(fc.array(runtimeArb, { minLength: 1, maxLength: 8 }), (rows) => {
      const data = feed(rows)
      const root = desk(data)
      const byId = new Map(threadIndexFor(data).roots().map(c => [c.id, c]))
      for (const el of root.querySelectorAll<HTMLElement>('.kbn-family')) {
        const c = byId.get(el.dataset.fiberId!)!
        const attention = attentionOf(c, new Map()), turn = turnOf(c)
        // A lone constitution stands in a section its state names, and its dot says so.
        const section = el.closest<HTMLElement>('[data-column]')!.dataset.column!
        expect(attention === 'quiet' ? ['drafts', 'resting', 'roles'] : attention === 'waiting' ? ['waiting', 'review'] : [attention]).toContain(section)
        expect(el.querySelector<HTMLElement>('.constitution-state-dot')!.dataset.attention).toBe(attention)
        // A frozen runtime from an unreachable owner never claims a turn; only the synced ask does.
        if (c.originStale) expect(turn.turn).toBe(c.ask ? 'question' : hasLiveWorker(c) ? 'no-signal' : 'none')
        // An idle worker that asked nothing works.
        if (turn.turn === 'idle') expect(attention).toBe('working')
        expect(turn.word).toBe(TURN_WORD[turn.turn])
        expect(ATTENTION_ORDER).toContain(attention)
      }
    }), { numRuns: 150 })
  })
})
