// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
import { waitingNote } from './ThreadPeek.js'

describe('what waits for a next worker', () => {
  const feed = parseCompositeFeed({
    host: 'local',
    fibers: [2, 0, undefined].map((pending_results, n) => ({
      origin: 'local', felt_store: '/felt', path: `c${n}.md`, pending_results,
      fiber: { id: `c${n}`, name: `c${n}`, status: 'open', shuttle: { kind: 'oneshot' } },
    })),
  })

  it('reaches the card as a number, absent when nothing waits', () => {
    expect(feed.entries.map(e => e.pendingResults)).toStrictEqual([2, undefined, undefined])
    expect(cardFromCompositeEntry(feed.entries[0]).pendingResults).toBe(2)
  })

  it('is drawn as a muted count that names itself in full', () => {
    const note = waitingNote({ pendingResults: 2 })!
    expect(note.className).toBe('kbn-waiting')
    expect(note.textContent).toBe('2 waiting')
    expect(note.title).toBe('2 waiting for its next worker')
    expect(waitingNote({ pendingResults: 0 })).toBeNull()
    expect(waitingNote({})).toBeNull()
  })
})
