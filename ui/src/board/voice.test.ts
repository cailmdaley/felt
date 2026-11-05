// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Voice, voicePollDelay, type VoiceStatus } from './voice'
import { card } from './testFixtures'

const status = (changes: Partial<VoiceStatus> = {}): VoiceStatus => ({ available: true, enabled: true, muted: false, state: 'listening', target: null, pending: null, last: null, error: null, ...changes })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('live voice', () => {
  it('targets only changed constitutions and reasserts on focus, never a plain note', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
      return { ok: true, json: async () => status() }
    }))
    const voice = new Voice('')
    voice.mount(); await flush()
    const a = card({ id: 'a', uid: 'durable-a', shuttleKind: 'oneshot' })
    voice.select(a); await flush()
    voice.select(a); await flush()
    voice.select(card({ id: 'note' })); await flush()
    voice.select(card({ id: 'b', shuttleKind: 'oneshot', originId: 'remote' })); await flush()
    window.dispatchEvent(new Event('focus')); await flush()
    expect(calls.filter(c => c.url.endsWith('/target')).map(c => c.body)).toEqual([
      { fiber_id: 'durable-a', origin: 'local' }, { fiber_id: 'b', origin: 'remote' }, { fiber_id: 'b', origin: 'remote' },
    ])
    voice.dispose()
  })
  it('does not target while disabled or from a phone', async () => {
    let current = status({ enabled: false })
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => current }))
    vi.stubGlobal('fetch', fetcher)
    const voice = new Voice('')
    voice.mount(); await flush()
    voice.select(card({ id: 'a', shuttleKind: 'oneshot' })); await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    current = status()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    await voice.set({ enabled: true }); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    voice.dispose()
  })
  it('pauses polling when hidden and uses idle cadence on errors', () => {
    expect(voicePollDelay(false, true, status())).toBeNull()
    expect(voicePollDelay(true, false, status())).toBe(15_000)
    expect(voicePollDelay(true, true, status({ enabled: false }))).toBe(15_000)
    expect(voicePollDelay(true, true, status())).toBe(2_000)
  })
})
