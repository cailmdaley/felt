// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { scheduledChip } from './ScheduledChip.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
import { scheduledTime, zone } from './civilDay.js'

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
    expect(chip.querySelector('summary')!.title).toContain('Check convergence')
    expect(chip.querySelector('.kbn-scheduled-lines')!.textContent).toContain('Inspect residuals')
    expect(scheduledChip({})).toBeNull()
  })
  it('formats the instant in the supplied zone', () => {
    const instant = Date.parse('2026-11-16T02:00:00Z')
    expect(scheduledTime(instant, zone('America/Los_Angeles'))).toContain('15 Nov')
    expect(scheduledTime(instant, zone('Europe/Paris'))).toContain('03:00')
  })
})
