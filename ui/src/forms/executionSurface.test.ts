import { describe, expect, it } from 'vitest'
import { defaultSurface, persistedSurface, sessionHelp } from './executionSurface.js'

describe('execution surface choice', () => {
  it('defaults new Codex work to the app', () => expect(defaultSurface({ cli: 'codex' })).toBe('app'))
  it('keeps legacy and explicit CLI blocks on the CLI', () => {
    expect(persistedSurface(undefined)).toBe('cli')
    expect(persistedSurface('cli')).toBe('cli')
    expect(persistedSurface('app')).toBe('app')
  })
})

describe('session destination explanation', () => {
  it('makes the app choice discoverable for terminal agents', () => {
    expect(sessionHelp({ cli: 'claude' }, 'cli')).toContain('Choose a Codex agent')
    expect(defaultSurface({ cli: 'claude' })).toBe('cli')
  })
  it('qualifies app access by the selected host', () => {
    expect(sessionHelp({ cli: 'codex' }, 'app')).toContain('Requires an app connection on the selected host')
    expect(sessionHelp({ cli: 'codex' }, 'cli')).toContain('terminal')
  })
})
