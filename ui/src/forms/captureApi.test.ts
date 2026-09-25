import { describe, expect, it } from 'vitest'
import { captureOutcome, captureRequestBody } from './captureApi'

const common = {
  prompt: '  UNIONS shear telecon  ',
  projectDir: '/projects/shear',
  origin: 'remote-project',
  agent: 'claude-opus',
  effort: 'high',
}

describe('meeting capture request', () => {
  it('adds the mode to an ordinary capture body, permits an empty note, and forces the terminal surface', () => {
    expect(captureRequestBody({ ...common, prompt: '  ', surface: 'app', meetingMode: 'room' })).toEqual({
      project_dir: '/projects/shear',
      origin: 'remote-project',
      agent: 'claude-opus',
      effort: 'high',
      surface: 'cli',
      meeting: { mode: 'room' },
    })
    expect(captureRequestBody({ ...common, meetingMode: 'call' })).toEqual({
      prompt: 'UNIONS shear telecon',
      project_dir: '/projects/shear',
      origin: 'remote-project',
      agent: 'claude-opus',
      effort: 'high',
      surface: 'cli',
      meeting: { mode: 'call' },
    })
  })
})

describe('meeting capture response', () => {
  it('reports recording and the selected scribe host when capture succeeds', () => {
    expect(captureOutcome(
      { ok: true, status: 202 },
      { spawned: true, tmux_session: 'capture-scribe', meeting: { state: 'starting' } },
      { projectDir: common.projectDir, meetingMode: 'call', host: 'project host' },
    )).toEqual({ kind: 'meeting-recording', host: 'project host' })
  })

  it('keeps a locally recording meeting as a warning when the scribe fails', () => {
    expect(captureOutcome(
      { ok: false, status: 502 },
      { recording: true, error: 'owner host is unreachable' },
      { projectDir: common.projectDir, meetingMode: 'room', host: 'project host' },
    )).toEqual({
      kind: 'meeting-recording',
      host: 'project host',
      error: 'Recording locally; the scribe didn\'t start: owner host is unreachable',
    })
  })

  it.each([
    [409, 'A meeting is already starting or running.'],
    [503, 'Hark is unavailable on this daemon.'],
  ])('keeps HTTP %i errors inline when no recording began', (status, message) => {
    expect(captureOutcome(
      { ok: false, status },
      {},
      { projectDir: common.projectDir, meetingMode: 'call', host: 'project host' },
    )).toEqual({ kind: 'error', message })
  })

  it('keeps conflicts inline even when the daemon includes the active meeting row', () => {
    expect(captureOutcome(
      { ok: false, status: 409 },
      { spawned: false, meeting: { state: 'live' }, reason: 'meeting_already_running' },
      { projectDir: common.projectDir, meetingMode: 'call', host: 'project host' },
    )).toEqual({ kind: 'error', message: 'A meeting is already starting or running.' })
  })
})
