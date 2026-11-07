import { expect, it } from 'vitest'
import { captureOutcome, captureRequestBody } from './captureApi'

it('sends a trimmed note to the project owner with the chosen agent', () => {
  expect(captureRequestBody({ prompt: '  A thought  ', projectDir: '/work', origin: 'owner', agent: 'claude-opus', effort: 'high', chrome: true }))
    .toEqual({ prompt: 'A thought', project_dir: '/work', origin: 'owner', agent: 'claude-opus', effort: 'high', chrome: true })
})
it('requires a confirmed spawn and keeps failures inline', () => {
  const options = { projectDir: '/work' }
  expect(captureOutcome({ ok: true, status: 202 }, { spawned: true, tmux_session: 'worker' }, options)).toEqual({ kind: 'spawned', tmuxSession: 'worker' })
  expect(captureOutcome({ ok: true, status: 200 }, {}, options)).toEqual({ kind: 'error', message: 'Capture failed (200)' })
  expect(captureOutcome({ ok: false, status: 422 }, { reason: 'project_dir_missing' }, options)).toEqual({ kind: 'error', message: 'Project directory not found on the daemon: /work' })
  expect(captureOutcome({ ok: false, status: 502 }, { error: 'Owner unreachable' }, options)).toEqual({ kind: 'error', message: 'Owner unreachable' })
})
