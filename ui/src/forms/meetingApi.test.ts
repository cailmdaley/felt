import { describe, expect, it, vi } from 'vitest'
import { joinMeeting, joinMeetingBody, parseCaptureMeetingCapabilities, stopMeeting } from './meetingApi'

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('parseCaptureMeetingCapabilities', () => {
  it('keeps only known unique modes in daemon order', () => {
    expect(parseCaptureMeetingCapabilities({
      available: true, modes: ['phone', 'room', 'phone', 'unknown', 3, null, 'call'], meeting: null,
    })).toEqual({ available: true, modes: ['phone', 'room', 'call'] })
  })

  it('does not infer modes from missing or malformed capabilities', () => {
    for (const modes of [undefined, null, 'phone', {}, []]) {
      expect(parseCaptureMeetingCapabilities({ available: true, modes, meeting: null })).toEqual({ available: true, modes: [] })
    }
    for (const value of [undefined, null, [], 'phone', {}, { available: 'true', modes: ['phone'] }]) {
      expect(parseCaptureMeetingCapabilities(value).available).toBe(false)
    }
  })

  it('fails closed for unavailable or occupied recorders but permits replacing a failed meeting', () => {
    const modes = ['phone']
    for (const state of ['starting', 'loading', 'live', 'stopping', 'unknown']) {
      expect(parseCaptureMeetingCapabilities({ available: true, modes, meeting: { state } }).available).toBe(false)
    }
    expect(parseCaptureMeetingCapabilities({ available: false, modes, meeting: null }).available).toBe(false)
    expect(parseCaptureMeetingCapabilities({ available: true, modes, meeting: { state: 'failed' } })).toEqual({ available: true, modes })
  })
})

describe('stopMeeting', () => {
  it('posts to the local meeting stop route and treats a missing meeting as already stopped', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
    await expect(stopMeeting('http://daemon', fetcher)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith('http://daemon/api/v1/meeting/stop', { method: 'POST' })
  })
})

describe('joinMeeting', () => {
  it('names the constitution, its owner and the mode, and carries a note only when there is one', () => {
    expect(joinMeetingBody({ fiberId: 'loom/shear', origin: 'cluster', mode: 'room', note: '  ' })).toEqual({
      fiber_id: 'loom/shear',
      origin: 'cluster',
      meeting: { mode: 'room' },
    })
    expect(joinMeetingBody({ fiberId: 'loom/shear', mode: 'call', note: 'B-mode telecon' })).toEqual({
      fiber_id: 'loom/shear',
      meeting: { mode: 'call' },
      note: 'B-mode telecon',
    })
  })

  it('posts to the local join route and reports how the worker received the meeting', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      reply({ meeting: { state: 'live', fiber: 'loom/shear' }, delivery: { delivered: true, delivery: 'resume' } }),
    )
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', origin: 'local', mode: 'call' }, fetcher))
      .resolves.toMatchObject({ kind: 'joined', delivery: 'resume', meeting: { state: 'live', fiber: 'loom/shear' } })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('http://daemon/api/v1/meeting/join')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toMatchObject({ fiber_id: 'loom/shear', meeting: { mode: 'call' } })
  })

  it('reports a sent but unconfirmed delivery as unconfirmed, not as a failure', async () => {
    const detail = "native message queued behind the receiver's current turn; no model response to it observed yet"
    const current = vi.fn<typeof fetch>().mockResolvedValue(
      reply({ meeting: { state: 'live' }, delivery: { delivered: null, delivery: 'message', detail, receipt: { status: 'unknown', detail } } }, 202),
    )
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', mode: 'room' }, current))
      .resolves.toMatchObject({ kind: 'unconfirmed', detail, meeting: { state: 'live' } })

    // A daemon that still renders an unknown receipt as a failure: the receipt decides.
    const older = vi.fn<typeof fetch>().mockResolvedValue(
      reply({
        recording: true,
        error: 'native message sent; no correlated receiver turn observed: context deadline exceeded',
        meeting: { state: 'live' },
        delivery: {
          delivered: false,
          delivery: 'message',
          receipt: { status: 'unknown', detail: 'native message sent; no correlated receiver turn observed: context deadline exceeded' },
        },
      }, 400),
    )
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', mode: 'room' }, older))
      .resolves.toMatchObject({ kind: 'unconfirmed', detail: 'native message sent; no correlated receiver turn observed: context deadline exceeded', meeting: { state: 'live' } })

    const refused = vi.fn<typeof fetch>().mockResolvedValue(
      reply({
        recording: true,
        error: 'receiver native inbox denied this message; no turn started',
        meeting: { state: 'live' },
        delivery: { delivered: false, delivery: 'message', receipt: { status: 'rejected' } },
      }, 502),
    )
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', mode: 'room' }, refused))
      .resolves.toMatchObject({ kind: 'recording', error: 'receiver native inbox denied this message; no turn started', meeting: { state: 'live' } })
  })

  it('keeps a recording that the worker did not receive distinct from a failed start', async () => {
    const recording = vi.fn<typeof fetch>().mockResolvedValue(
      reply({ recording: true, error: 'Fiber is closed — reopen it before dispatching.', meeting: { state: 'live' } }, 422),
    )
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', mode: 'room' }, recording))
      .resolves.toMatchObject({ kind: 'recording', error: 'Fiber is closed — reopen it before dispatching.', meeting: { state: 'live' } })

    const busy = vi.fn<typeof fetch>().mockResolvedValue(
      reply({ error: 'a meeting is already active', meeting: { state: 'live' } }, 409),
    )
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', mode: 'room' }, busy))
      .resolves.toEqual({ kind: 'error', message: 'A meeting is already starting or running.' })

    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'))
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', mode: 'room' }, offline))
      .resolves.toEqual({ kind: 'error', message: "Couldn't reach Shuttle: connection refused" })
  })
})
