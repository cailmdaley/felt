import { describe, expect, it } from 'vitest'
import { hasWorkerToStop } from './KanbanTypes.js'
import { buildKanbanResponseFromComposite, cardFromCompositeEntry } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'

describe('composite app runtime', () => {
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

  it('puts a running app worker on a pinned role in flight, not on the strip', () => {
    const resp = board('pinned', appRuntime('running'))
    expect(inFlightIds(resp)).toEqual(['role'])
    expect(resp.pinned).toEqual([])
    const card = resp.now.inFlight[0]
    expect(card.workerState).toBe('running')
    expect(card.tmuxSession).toBeUndefined()
    expect(card.desktopLink).toBe(desktop)
    expect(card.runtimePhase).toBe('waiting')
  })

  it('puts a running app worker on a standing role in flight, not on the timeline', () => {
    const resp = board('standing', appRuntime('running'))
    expect(inFlightIds(resp)).toEqual(['role'])
    expect(resp.timeline.futureDated.map((c) => c.id)).not.toContain('role')
  })

  it('keeps a blocked app launch in flight, at the top, with its error', () => {
    const resp = board('pinned', appRuntime('blocked', { launch_error: 'The app conversation no longer exists.' }))
    expect(inFlightIds(resp)).toEqual(['role'])
    const card = resp.now.inFlight[0]
    expect(card.workerState).toBe('blocked')
    expect(card.runtimePhase).toBe('blocked')
    expect(card.launchError).toBe('The app conversation no longer exists.')
  })

  it('rests a pinned role on the strip when the daemon holds no worker', () => {
    const resp = board('pinned', undefined)
    expect(inFlightIds(resp)).toEqual([])
    expect(resp.pinned.map((c) => c.id)).toEqual(['role'])
    expect(resp.pinned[0].workerState).toBeUndefined()
  })

  it('keeps a CLI worker in flight with its tmux handle', () => {
    const resp = board('pinned', { state: 'running', surface: 'cli', tmux_session: 'role-shuttle', phase: 'working' })
    expect(inFlightIds(resp)).toEqual(['role'])
    expect(resp.now.inFlight[0]).toMatchObject({ workerState: 'running', tmuxSession: 'role-shuttle', workerSurface: 'cli' })
  })

  it('reads a runtime without a state as a running worker', () => {
    const resp = board('pinned', { tmux_session: 'role-shuttle' })
    expect(resp.now.inFlight[0]?.workerState).toBe('running')
  })

  it('sorts a blocked launch above a busy worker', () => {
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
