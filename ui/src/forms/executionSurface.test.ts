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
  it('keeps terminal agents on the terminal', () => {
    expect(defaultSurface({ cli: 'claude' })).toBe('cli')
  })
  it('qualifies app access by the selected host', () => {
    expect(sessionHelp('app')).toContain('Requires an app connection on the selected host')
    expect(sessionHelp('cli')).toContain('terminal')
  })
})
