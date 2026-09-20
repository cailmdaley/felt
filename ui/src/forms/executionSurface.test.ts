import { describe, expect, it } from 'vitest'
import { defaultSurface, persistedSurface } from './executionSurface.js'

describe('execution surface choice', () => {
  it('defaults new Codex work to the app', () => expect(defaultSurface({ cli: 'codex' })).toBe('app'))
  it('keeps legacy and explicit CLI blocks on the CLI', () => {
    expect(persistedSurface(undefined)).toBe('cli')
    expect(persistedSurface('cli')).toBe('cli')
    expect(persistedSurface('app')).toBe('app')
  })
})
