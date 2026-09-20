import { describe, it, expect, vi } from 'vitest'
import {
  newSessionLink,
  waitForNewSessionLink,
  type SessionSnapshot,
} from './newSessionWait.js'

const OLD_LINK = 'https://claude.ai/code/session_01OLD'
const NEW_LINK = 'https://claude.ai/code/session_01NEW'
const OLD_UUID = '11111111-1111-4111-8111-111111111111'
const NEW_UUID = '22222222-2222-4222-8222-222222222222'

describe('newSessionLink', () => {
  it('holds while the row still carries the pre-dispatch session', () => {
    const target = { expectedSessionUuid: NEW_UUID }
    const stale: SessionSnapshot = { sessionUuid: OLD_UUID, sessionLink: OLD_LINK }
    expect(newSessionLink(target, stale)).toBeUndefined()
  })

  it('takes the link once the row carries the expected uuid', () => {
    const target = { expectedSessionUuid: NEW_UUID }
    const fresh: SessionSnapshot = { sessionUuid: NEW_UUID, sessionLink: NEW_LINK }
    expect(newSessionLink(target, fresh)).toBe(NEW_LINK)
  })

  it('holds when the expected uuid is there but the link is not yet', () => {
    const target = { expectedSessionUuid: NEW_UUID }
    expect(newSessionLink(target, { sessionUuid: NEW_UUID })).toBeUndefined()
  })

  it('holds on a missing row', () => {
    expect(newSessionLink({ expectedSessionUuid: NEW_UUID }, undefined)).toBeUndefined()
  })

  // Fallback: no uuid from the dispatch response (codex/pi, older daemon).
  it('without an expected uuid, holds on the uuid it saw before dispatching', () => {
    const target = { previousSessionUuid: OLD_UUID, previousSessionLink: OLD_LINK }
    expect(newSessionLink(target, { sessionUuid: OLD_UUID, sessionLink: OLD_LINK })).toBeUndefined()
    // The link alone moving is not enough while the uuid says "old session".
    expect(newSessionLink(target, { sessionUuid: OLD_UUID, sessionLink: NEW_LINK })).toBeUndefined()
    expect(newSessionLink(target, { sessionUuid: NEW_UUID, sessionLink: NEW_LINK })).toBe(NEW_LINK)
  })

  it('without any uuid on the row, judges by the link differing', () => {
    const target = { previousSessionLink: OLD_LINK }
    expect(newSessionLink(target, { sessionLink: OLD_LINK })).toBeUndefined()
    expect(newSessionLink(target, { sessionLink: NEW_LINK })).toBe(NEW_LINK)
  })

  it('with nothing known before, any link is the new one', () => {
    expect(newSessionLink({}, { sessionLink: NEW_LINK })).toBe(NEW_LINK)
  })
})

describe('waitForNewSessionLink', () => {
  const noSleep = () => Promise.resolve()

  it('polls past the stale row and returns the new session link', async () => {
    const rows: Array<SessionSnapshot | undefined> = [
      { sessionUuid: OLD_UUID, sessionLink: OLD_LINK },
      { sessionUuid: NEW_UUID },
      { sessionUuid: NEW_UUID, sessionLink: NEW_LINK },
    ]
    const poll = vi.fn(async () => rows.shift())

    const link = await waitForNewSessionLink({
      target: { expectedSessionUuid: NEW_UUID },
      poll,
      sleep: noSleep,
    })

    expect(link).toBe(NEW_LINK)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('treats a failed poll as "not yet" rather than an error', async () => {
    let call = 0
    const poll = vi.fn(async () => {
      if (++call === 1) throw new Error('offline')
      return { sessionUuid: NEW_UUID, sessionLink: NEW_LINK }
    })

    const link = await waitForNewSessionLink({
      target: { expectedSessionUuid: NEW_UUID },
      poll,
      sleep: noSleep,
    })

    expect(link).toBe(NEW_LINK)
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('gives up after the timeout and returns undefined', async () => {
    let clock = 0
    const poll = vi.fn(async () => ({ sessionUuid: OLD_UUID, sessionLink: OLD_LINK }))

    const link = await waitForNewSessionLink({
      target: { expectedSessionUuid: NEW_UUID },
      poll,
      intervalMs: 3000,
      timeoutMs: 9000,
      sleep: async (ms: number) => { clock += ms },
      now: () => clock,
    })

    expect(link).toBeUndefined()
    // t=0, 3000, 6000 poll; at t=9000 the budget is spent.
    expect(poll).toHaveBeenCalledTimes(4)
  })

  it('returns on the very first poll when the feed has already caught up', async () => {
    const poll = vi.fn(async () => ({ sessionUuid: NEW_UUID, sessionLink: NEW_LINK }))
    const sleep = vi.fn(noSleep)

    expect(
      await waitForNewSessionLink({ target: { expectedSessionUuid: NEW_UUID }, poll, sleep }),
    ).toBe(NEW_LINK)
    expect(sleep).not.toHaveBeenCalled()
  })
})
