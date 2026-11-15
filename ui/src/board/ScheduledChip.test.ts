// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { scheduledChip } from './ScheduledChip.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'

describe('scheduled messages', () => {
  it('carries the owner entries to the card and shows the next time and all lines', () => {
    const entries = [
      { id: 'b', not_before: '2026-11-17T10:00:00Z', text: 'Inspect residuals', from: 'fit' },
      { id: 'a', not_before: '2026-11-16T10:00:00Z', text: 'Check convergence', from: 'fit' },
    ]
    const feed = parseCompositeFeed({ host: 'test', fibers: [{ origin: 'test', felt_store: '/felt', path: 'fit.md', scheduled_messages: entries, fiber: { id: 'fit', name: 'Fit', status: 'active', shuttle: { host: 'test', kind: 'oneshot' } } }] })
    const card = cardFromCompositeEntry(feed.entries[0])
    expect(card.scheduledMessages).toEqual(entries)
    const chip = scheduledChip(card)!
    expect(chip.querySelector('summary')!.textContent).toContain('2 scheduled')
    expect(chip.querySelector('.kbn-scheduled-lines')!.textContent).toContain('Check convergence')
    expect(chip.querySelector('.kbn-scheduled-lines')!.textContent).toContain('Inspect residuals')
    expect(scheduledChip({})).toBeNull()
  })
  it('orders instants within the same second numerically', () => {
    const chip = scheduledChip({ scheduledMessages: [
      { id: 'later', not_before: '2026-11-16T10:00:00.5Z', text: 'Later', from: 'fit' },
      { id: 'first', not_before: '2026-11-16T10:00:00Z', text: 'First', from: 'fit' },
    ] })!
    expect(chip.querySelector('.kbn-scheduled-lines')!.textContent).toMatch(/First.*Later/s)
  })
})
