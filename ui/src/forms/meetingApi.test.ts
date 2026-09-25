import { describe, expect, it, vi } from 'vitest'
import { startMeeting, stopMeeting, validateMeetingInput, type MeetingFormInput } from './meetingApi'

const validInput: MeetingFormInput = {
  title: '  Shear telecon  ',
  host: 'local',
  projectDir: ' /work/lensing ',
  under: 'work/lensing',
  mode: 'call',
}

const acceptedMeeting = {
  state: 'starting',
  title: 'Shear telecon',
  host: null,
  fiber: null,
  started_at: null,
  last_line: null,
  transcript: null,
  tmux_session: 'hark-meeting',
  error: null,
}

describe('meeting form validation', () => {
  it('requires a title, host, project, and safe loom-relative parent id', () => {
    expect(validateMeetingInput({ ...validInput, title: '  ', host: '', projectDir: '', under: '' }))
      .toEqual({
        title: 'Enter a meeting title.',
        host: 'Choose a host.',
        projectDir: 'Choose a project.',
        under: 'Choose a parent fiber.',
      })
    expect(validateMeetingInput({ ...validInput, under: '../outside' }).under)
      .toContain('loom-relative')
    expect(validateMeetingInput({ ...validInput, under: '/work/lensing' }).under)
      .toContain('loom-relative')
  })

  it('accepts nested loom fiber ids and both capture modes', () => {
    expect(validateMeetingInput({ ...validInput, under: 'work/lensing/analysis-notes' })).toEqual({})
    expect(validateMeetingInput({ ...validInput, mode: 'room' })).toEqual({})
  })
})

describe('startMeeting request', () => {
  it('posts the contract body and returns the meeting record', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ meeting: acceptedMeeting }), { status: 202 }),
    )
    const meeting = await startMeeting('http://daemon', validInput, fetcher)

    expect(fetcher).toHaveBeenCalledWith('http://daemon/api/v1/meeting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Shear telecon',
        host: 'local',
        project_dir: '/work/lensing',
        under: 'work/lensing',
        mode: 'call',
      }),
    })
    expect(meeting.state).toBe('starting')
  })

  it('does not send invalid input', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(startMeeting('', { ...validInput, under: '' }, fetcher)).rejects.toMatchObject({
      name: 'MeetingValidationError',
      fields: { under: 'Choose a parent fiber.' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('surfaces the daemon validation message', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Remote project is not reachable' }), { status: 422 }),
    )
    await expect(startMeeting('', validInput, fetcher)).rejects.toThrow('Remote project is not reachable')
  })
})

describe('stopMeeting', () => {
  it('posts to the local meeting stop route and treats a missing meeting as already stopped', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }))
    await expect(stopMeeting('http://daemon', fetcher)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith('http://daemon/api/v1/meeting/stop', { method: 'POST' })
  })
})
