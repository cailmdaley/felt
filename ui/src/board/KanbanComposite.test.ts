import { describe, expect, it } from 'vitest'
import { hasWorkerToStop } from './KanbanTypes.js'
import { buildKanbanResponseFromComposite, cardFromCompositeEntry } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'

describe('composite app runtime', () => {
  it('carries the owner-served launch instant into the board without a second runtime read', () => {
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'local', felt_store: '/felt', path: 'idea.md',
      fiber: { id: 'idea', name: 'Idea', status: 'active' },
      runtime: { state: 'running', started_at: 1791121680000 },
    }] })
    expect(feed.entries[0].runtime?.startedAt).toBe(1791121680000)
    expect(cardFromCompositeEntry(feed.entries[0]).workerStartedAt).toBe(1791121680000)
  })
  it('retains an app worker state without inventing a tmux session', () => {
    const feed = parseCompositeFeed({
      fibers: [{
        origin: 'local', felt_store: '/felt', path: 'idea.md',
        fiber: { id: 'idea', name: 'Idea', status: 'active', shuttle: { kind: 'oneshot', agent: 'codex-sol', surface: 'app' } },
        runtime: { state: 'blocked', launch_error: 'turn/start timed out' },
      }],
    })
    expect(feed.entries[0].runtime).toMatchObject({ state: 'blocked', launchError: 'turn/start timed out' })
    expect(feed.entries[0].runtime?.phase).toBeUndefined()
    expect(feed.entries[0].runtime?.tmuxSession).toBeUndefined()
  })
  it('keeps native desktop links separate from mobile universal links', () => {
    const desktop = 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'local', felt_store: '/felt', path: 'idea.md',
      fiber: { id: 'idea', name: 'Idea', status: 'active' },
      runtime: { state: 'running', desktop_link: desktop, session_link: desktop },
    }] })
    expect(feed.entries[0].runtime?.desktopLink).toBe(desktop)
    expect(feed.entries[0].runtime?.sessionLink).toBeUndefined()
  })

})

describe('observed worker identity', () => {
  it.each(['app', 'cli'] as const)('keeps a live %s worker separate from changed launch settings', (surface) => {
    const nextSurface = surface === 'app' ? 'cli' : 'app'
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'local', felt_store: '/felt', path: 'idea.md',
      fiber: { id: 'idea', name: 'Idea', status: 'active', shuttle: {
        kind: 'oneshot', agent: 'next-agent', surface: nextSurface,
        runtime: { session_uuid: 'saved-id' },
      } },
      runtime: { state: 'running', surface, agent: 'actual-agent',
        session_uuid: 'actual-id', tmux_session: surface === 'cli' ? 'actual-tmux' : null },
    }] })
    const card = cardFromCompositeEntry(feed.entries[0])
    expect(card.shuttleSurface).toBe(nextSurface)
    expect(card.shuttleAgent).toBe('next-agent')
    expect(card.workerSurface).toBe(surface)
    expect(card.workerAgent).toBe('actual-agent')
    expect(card.sessionUuid).toBe('actual-id')
    expect(hasWorkerToStop(card)).toBe(true)
  })
})

describe('worker liveness is the daemon runtime, not a tmux name', () => {
  const desktop = 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
  const appRuntime = (state: string, extra: Record<string, unknown> = {}) => ({
    state, phase: state === 'running' ? 'waiting' : undefined, surface: 'app', tmux_session: null,
    session_uuid: '01a0be38-6c36-7cd1-aec9-53a680d1f693', agent: 'codex-sol',
    launch_error: null, last_activity_at: 1_790_727_579_437, desktop_link: desktop, ...extra,
  })
  const board = (kind: 'pinned' | 'standing' | 'oneshot', runtime: unknown, status = 'active') =>
    buildKanbanResponseFromComposite(parseCompositeFeed({
      host: 'laptop',
      fibers: [{
        origin: 'laptop', felt_store: '/felt', path: 'role.md',
        fiber: { id: 'role', name: 'Role', status, shuttle: {
          kind, agent: 'codex-sol', surface: 'app', host: 'laptop', project_dir: '/p',
          ...(kind === 'standing' ? { schedule: '0 9 * * *' } : {}),
        } },
        runtime,
      }],
      origins: { laptop: { kind: 'local', stale: false, fiber_count: 1 } },
    }), { nowMs: 1_790_727_600_000 })
  const inFlightIds = (resp: ReturnType<typeof board>) => resp.now.inFlight.map((c) => c.id)

  // Every kind against every runtime shape the daemon serves. Any runtime
  // puts the card in flight, whatever its kind; with none, a standing
  // constitution waits on the timeline and an active one-shot stays in flight
  // — the retired `pinned` included, which reads as a one-shot. The card carries the runtime's own fields.
  const runtimes: [shape: string, runtime: unknown, fields: Record<string, unknown> | null][] = [
    ['no worker', undefined, null],
    ['a running app worker', appRuntime('running'),
      { workerState: 'running', tmuxSession: undefined, desktopLink: desktop, runtimePhase: 'waiting' }],
    ['a blocked app launch', appRuntime('blocked', { launch_error: 'The app conversation no longer exists.' }),
      { workerState: 'blocked', runtimePhase: 'blocked', launchError: 'The app conversation no longer exists.' }],
    ['an idle app conversation', appRuntime('idle'), { workerState: 'running', desktopLink: desktop }],
    ['a CLI worker', { state: 'running', surface: 'cli', tmux_session: 'role-shuttle', phase: 'working' },
      { workerState: 'running', tmuxSession: 'role-shuttle', workerSurface: 'cli', runtimePhase: 'working' }],
    ['a runtime without a state', { tmux_session: 'role-shuttle' }, { workerState: 'running', tmuxSession: 'role-shuttle' }],
  ]
  const restingPlace = { pinned: 'inFlight', standing: 'timeline', oneshot: 'inFlight' } as const
  // Each surface's whole id list, so a card on two surfaces, or twice on one,
  // is as wrong as a card on the wrong one.
  const placeOf = (resp: ReturnType<typeof board>) => ({
    inFlight: inFlightIds(resp),
    timeline: resp.timeline.futureDated.map((c) => c.id),
  })
  const only = (surface: keyof ReturnType<typeof placeOf>) => ({
    inFlight: [], timeline: [], [surface]: ['role'],
  })

  it('places each kind by the daemon runtime and carries that runtime onto the card', () => {
    const wrong: unknown[] = []
    for (const kind of ['pinned', 'standing', 'oneshot'] as const) {
      for (const [shape, runtime, fields] of runtimes) {
        const resp = board(kind, runtime)
        const expected = fields ? 'inFlight' : restingPlace[kind]
        const place = placeOf(resp)
        const card = resp.now.inFlight.find((c) => c.id === 'role')
        const got = card && Object.fromEntries(Object.keys(fields ?? { workerState: 0 }).map((k) => [k, card[k as keyof typeof card]]))
        if (JSON.stringify(place) !== JSON.stringify(only(expected))) wrong.push({ kind, shape, expected, place })
        else if (card && JSON.stringify(got) !== JSON.stringify(fields ?? { workerState: undefined })) wrong.push({ kind, shape, fields, got })
      }
    }
    expect(wrong).toEqual([])
  })

  it('sorts a blocked launch into Question, above a busy worker', () => {
    const feed = parseCompositeFeed({
      host: 'laptop',
      fibers: ['busy', 'stuck'].map((id) => ({
        origin: 'laptop', felt_store: '/felt', path: `${id}.md`,
        fiber: { id, name: id, status: 'active', shuttle: { kind: 'oneshot', host: 'laptop', project_dir: '/p' } },
        runtime: id === 'busy'
          ? { state: 'running', tmux_session: 'busy-shuttle', phase: 'working' }
          : appRuntime('blocked', { launch_error: 'gone' }),
      })),
      origins: { laptop: { kind: 'local', stale: false, fiber_count: 2 } },
    })
    const resp = buildKanbanResponseFromComposite(feed, { nowMs: 1_790_727_600_000 })
    expect(resp.now.inFlight.map((c) => c.id)).toEqual(['stuck', 'busy'])
  })
})
