import { describe, expect, it } from 'vitest'
import { dispatchIneligibleReason } from './KanbanModalShared'

describe('dispatchIneligibleReason', () => {
  it('prefers the daemon message, which names the checkout and its holder', () => {
    expect(
      dispatchIneligibleReason({
        reason: 'not_eligible',
        detail: 'project_dir_held',
        message: 'Checkout /home/me/dev/felt is held by tests/holder — one worker per checkout.',
      }),
    ).toBe('Checkout /home/me/dev/felt is held by tests/holder — one worker per checkout.')
  })

  it('falls back to per-detail copy for a held checkout', () => {
    expect(dispatchIneligibleReason({ reason: 'not_eligible', detail: 'project_dir_held' }))
      .toBe("Another worker holds this fiber's checkout — one worker per checkout.")
  })
})
