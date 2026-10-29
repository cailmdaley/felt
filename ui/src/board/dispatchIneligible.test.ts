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

  it('names kitty as the remedy when no tmux server is reachable', () => {
    expect(dispatchIneligibleReason({ reason: 'tmux_server_unavailable' })).toContain('kitty')
  })

  it('names Rex and Rex Server access as the remedy for an unavailable Rex server', () => {
    const reason = dispatchIneligibleReason({ reason: 'rex_server_unavailable' })
    expect(reason).toContain('Open Rex')
    expect(reason).toContain('grant Rex Server access')
    expect(reason).toContain('Full Disk Access')
    expect(reason).not.toContain('kitty')
    expect(dispatchIneligibleReason({ reason: 'not_eligible', detail: 'rex_server_unavailable' })).toBe(reason)
  })

  it('falls back to per-detail copy when the daemon sends no message', () => {
    expect(dispatchIneligibleReason({ reason: 'not_eligible', detail: 'project_dir_missing' }))
      .toBe("The fiber's project_dir does not exist on the owning host.")
  })
})
