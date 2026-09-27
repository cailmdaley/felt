import { describe, expect, it, vi } from 'vitest'
import { joinMeeting, joinMeetingBody, stopMeeting } from './meetingApi'

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

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
      .resolves.toEqual({ kind: 'joined', delivery: 'resume' })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('http://daemon/api/v1/meeting/join')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toMatchObject({ fiber_id: 'loom/shear', meeting: { mode: 'call' } })
  })

  it('keeps a recording that the worker did not receive distinct from a failed start', async () => {
    const recording = vi.fn<typeof fetch>().mockResolvedValue(
      reply({ recording: true, error: 'Fiber is closed — reopen it before dispatching.', meeting: { state: 'live' } }, 422),
    )
    await expect(joinMeeting('http://daemon', { fiberId: 'loom/shear', mode: 'room' }, recording))
      .resolves.toEqual({ kind: 'recording', error: 'Fiber is closed — reopen it before dispatching.' })

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
