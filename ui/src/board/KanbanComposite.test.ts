import { describe, expect, it } from 'vitest'
import { hasWorkerToStop } from './KanbanTypes.js'
import { buildKanbanResponseFromComposite, cardFromCompositeEntry } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'

describe('constitution roll-up', () => {
  it('heads a thread\'s review with its root in Awaiting review and keeps its draft and the archived off the Desk', () => {
    const fibers = [
      ['hub', null, 'active', undefined],
      ['hub/folder/child', 'hub', 'open', undefined],
      ['hub/folder/child/deep', 'hub/folder/child', 'closed', undefined],
      ['hub/accepted', 'hub', 'closed', true],
      ['hub/discarded', 'hub', 'closed', false],
      ['hub-lookalike', null, 'open', undefined],
    ].map(([id, orchestrator, status, tempered]) => ({
      origin: 'local', felt_store: '/felt', path: `${id}.md`, orchestrator,
      fiber: { id, name: id, status, tempered, shuttle: { kind: 'oneshot' } },
    }))
    const board = buildKanbanResponseFromComposite(parseCompositeFeed({ host: 'local', fibers }))
    expect(board.now.inFlight.map(c => c.id)).toEqual(['hub'])
    expect(board.now.drafts.map(c => c.id)).toStrictEqual(['hub-lookalike'])
    expect(board.now.awaitingReview.map(c => [c.id, c.deskSection])).toStrictEqual([['hub', 'to-review']])
    expect(board.timeline.past).toStrictEqual([])
    expect(board.threads?.map(c => c.id).sort()).toStrictEqual(['hub/accepted', 'hub/discarded', 'hub/folder/child', 'hub/folder/child/deep'])
    expect(board.now.inFlight.find(c => c.id === 'hub')?.threadSummary).toEqual({ unfinished: 2, waiting: 0, working: 0, toReview: 1, drafts: 1, archived: 2 })
    expect(board.threads?.find(c => c.id.endsWith('/child'))?.threadSummary?.toReview).toBe(1)
    expect(board.totals.inFlight).toBe(1)
  })
})

describe('composite app runtime', () => {
  it.each(['rex', 'tmux', null, 'other'])('carries the observed terminal backend %s into the card', terminal => {
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'local', felt_store: '/felt', path: 'idea.md',
      fiber: { id: 'idea', name: 'Idea', status: 'active' },
      runtime: { state: 'running', tmux_session: 'worker', terminal },
    }] })
    expect(cardFromCompositeEntry(feed.entries[0]).terminalBackend).toBe(terminal === 'rex' || terminal === 'tmux' ? terminal : undefined)
  })
  it('carries the owner-served launch instant into the board without a second runtime read', () => {
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'local', felt_store: '/felt', path: 'idea.md',
      fiber: { id: 'idea', name: 'Idea', status: 'active' },
      runtime: { state: 'running', started_at: 1791121680000 },
    }] })
    expect(feed.entries[0].runtime?.startedAt).toBe(1791121680000)
    expect(cardFromCompositeEntry(feed.entries[0]).workerStartedAt).toBe(1791121680000)
  })

})

describe('worker liveness is the daemon runtime', () => {
  const board = (kind: 'pinned' | 'standing' | 'oneshot', runtime: unknown) =>
    buildKanbanResponseFromComposite(parseCompositeFeed({
      host: 'laptop',
      fibers: [{
        origin: 'laptop', felt_store: '/felt', path: 'role.md',
        fiber: { id: 'role', name: 'Role', status: 'active', shuttle: {
          kind, host: 'laptop', project_dir: '/p',
          ...(kind === 'standing' ? { schedule: '0 9 * * *' } : {}),
        } }, runtime,
      }],
      origins: { laptop: { kind: 'local', stale: false, fiber_count: 1 } },
    }), { nowMs: 1_790_727_600_000 })
  it('carries terminal worker identity and treats blocked launches as in flight', () => {
    const running = board('oneshot', { state: 'running', tmux_session: 'role-shuttle', phase: 'working' })
    expect(running.now.inFlight[0]).toMatchObject({ workerState: 'running', tmuxSession: 'role-shuttle', runtimePhase: 'working' })
    expect(hasWorkerToStop(running.now.inFlight[0])).toBe(true)
    const blocked = board('oneshot', { state: 'blocked', launch_error: 'launch refused' })
    expect(blocked.now.inFlight[0]).toMatchObject({ workerState: 'blocked', launchError: 'launch refused' })
  })
  it('does not infer a worker from the stored legacy surface', () => {
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'local', felt_store: '/felt', path: 'role.md',
      fiber: { id: 'role', name: 'Role', status: 'active', shuttle: { kind: 'oneshot', surface: 'app' } },
    }] })
    const card = cardFromCompositeEntry(feed.entries[0])
    expect(card.workerState).toBeUndefined()
    expect(card.workerState).toBeUndefined()
  })
})


describe('owner dispatch failures', () => {
  it('shows a blocked reason without inventing a live worker', () => {
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'owner', felt_store: '/felt', path: 'idea.md',
      fiber: { id: 'idea', name: 'Idea', status: 'active', shuttle: { kind: 'oneshot' } },
      dispatch_error: 'systemError: native thread could not resume',
    }] })
    const card = cardFromCompositeEntry(feed.entries[0])
    expect(card.launchError).toBe('systemError: native thread could not resume')
    expect(card.workerState).toBeUndefined()
    expect(hasWorkerToStop(card)).toBe(false)
  })
  it('retains a terminal launch error on a live worker', () => {
    const feed = parseCompositeFeed({ fibers: [{
      origin: 'owner', felt_store: '/felt', path: 'idea.md',
      fiber: { id: 'idea', name: 'Idea', status: 'active' },
      runtime: { state: 'running', terminal_error: 'terminal_unavailable' },
    }] })
    expect(cardFromCompositeEntry(feed.entries[0])).toMatchObject({
      workerState: 'blocked', runtimePhase: 'blocked', launchError: 'terminal_unavailable',
    })
  })
})
