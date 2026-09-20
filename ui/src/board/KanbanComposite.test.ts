import { describe, expect, it } from 'vitest'
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
})
