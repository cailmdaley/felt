import { describe, expect, it } from 'vitest'
import { dispatchIneligibleReason } from './KanbanModalShared'

describe('dispatchIneligibleReason', () => {
  it('prefers the daemon message over any per-detail copy', () => {
    expect(
      dispatchIneligibleReason({
        reason: 'not_eligible',
        detail: 'project_dir_missing',
        message: "The fiber's project_dir (/home/me/dev/felt) does not exist on the owning host.",
      }),
    ).toBe("The fiber's project_dir (/home/me/dev/felt) does not exist on the owning host.")
  })

  it('falls back to per-detail copy when the daemon sends no message', () => {
    expect(dispatchIneligibleReason({ reason: 'not_eligible', detail: 'project_dir_missing' }))
      .toBe("The fiber's project_dir does not exist on the owning host.")
  })
})
