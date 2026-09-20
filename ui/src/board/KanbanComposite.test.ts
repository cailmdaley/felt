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
