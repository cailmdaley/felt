import { describe, expect, it } from 'vitest'
import { hasWorkerToStop } from './KanbanTypes.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
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
    expect(feed.entries[0].runtime).toMatchObject({ phase: 'blocked', launchError: 'turn/start timed out' })
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
