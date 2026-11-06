// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card } from './testFixtures.js'
import { Voice, voicePollDelay, type VoiceStatus } from './voice'

const status = (changes: Partial<VoiceStatus> = {}): VoiceStatus => ({ available: true, enabled: true, muted: false, state: 'listening', target: null, last: null, error: null, ...changes })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('live voice', () => {
  it('writes in order, one at a time', async () => {
    const calls: unknown[] = []
    let finishFirst!: () => void
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      calls.push(body)
      if (body.muted) await new Promise<void>(resolve => { finishFirst = resolve })
      return { ok: true, json: async () => status(body) }
    }))
    const voice = new Voice('')
    const first = voice.set({ muted: true })
    const second = voice.set({ muted: false })
    await flush()
    expect(calls).toEqual([{ muted: true }])
    finishFirst()
    await first; await second
    expect(calls).toEqual([{ muted: true }, { muted: false }])
    expect(voice.status?.muted).toBe(false)
  })
  it('keeps the write stream going after a refused write', async () => {
    let ok = false
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => status() })))
    const voice = new Voice('')
    await expect(voice.set({ enabled: true })).rejects.toThrow('Voice request failed (503)')
    ok = true
    await voice.set({ enabled: true })
    expect(voice.status?.enabled).toBe(true)
  })
  it('asks only for its status, never naming a target', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return { ok: true, json: async () => status() } }))
    const voice = new Voice('')
    voice.mount(); await flush()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(new Set(urls)).toEqual(new Set(['/api/v1/voice']))
    voice.dispose()
  })
  it('follows a target Rex moved to once, and never posts one', async () => {
    vi.useFakeTimers()
    let current = status()
    const posts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(url)
      return { ok: true, json: async () => current }
    }))
    const followed: string[] = []
    const voice = new Voice('')
    voice.onFollow = target => followed.push(target.fiber_id)
    voice.mount(); await flush()
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(followed).toEqual([])

    current = status({ target: { fiber_id: 'project/b', origin: 'local', name: 'B' } })
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(followed).toEqual(['project/b'])
    expect(posts).toEqual([])
    voice.dispose()
  })
  it('reveals a hand-opened constitution in Rex once, never a followed card or a plain note', async () => {
    vi.useFakeTimers()
    let current = status()
    const reveals: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/reveal')) reveals.push(JSON.parse(String(init!.body)))
      return { ok: true, json: async () => current }
    }))
    const voice = new Voice('')
    voice.onFollow = () => {}
    voice.mount(); await flush()
    const a = card({ id: 'project/a', uid: 'durable-a', shuttleKind: 'oneshot' })
    voice.select(a); await flush()
    voice.select(a); await flush()
    voice.select(card({ id: 'note' })); await flush()
    voice.select(null); voice.select(a); await flush()
    expect(reveals).toEqual([{ fiber_id: 'durable-a', origin: 'local' }, { fiber_id: 'durable-a', origin: 'local' }])

    current = status({ target: { fiber_id: 'project/b', origin: 'local', name: 'B' } })
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    voice.select(card({ id: 'project/b', uid: 'durable-b', shuttleKind: 'oneshot' })); await flush()
    expect(reveals).toHaveLength(2)

    current = status({ enabled: false })
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    voice.select(card({ id: 'project/c', shuttleKind: 'oneshot' })); await flush()
    expect(reveals).toHaveLength(2)
    voice.dispose()
  })
  it('follows a pushed route at once and ignores a poll that started before it', async () => {
    vi.useFakeTimers()
    const sources: Array<{ url: string; emit: (target: unknown) => void }> = []
    vi.stubGlobal('EventSource', class {
      private listeners: Array<(event: Event) => void> = []
      constructor(url: string) {
        sources.push({ url, emit: target => this.listeners.forEach(fn => fn(new MessageEvent('target', { data: JSON.stringify(target) }))) })
      }
      addEventListener(_: string, fn: (event: Event) => void): void { this.listeners.push(fn) }
      close(): void {}
    })
    let release!: () => void
    let slow = false
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (slow) await new Promise<void>(resolve => { release = resolve })
      return { ok: true, json: async () => status() }
    }))
    const followed: string[] = []
    const voice = new Voice('')
    voice.onFollow = target => followed.push(target.fiber_id)
    voice.mount(); await flush()
    expect(sources.map(s => s.url)).toEqual(['/api/v1/voice/events'])
    sources[0].emit(null)
    expect(followed).toEqual([])

    slow = true
    await vi.advanceTimersByTimeAsync(2_000)
    sources[0].emit({ fiber_id: 'rex/worker', origin: 'local', name: 'Worker' })
    expect(followed).toEqual(['rex/worker'])
    expect(voice.status?.target?.fiber_id).toBe('rex/worker')
    release(); await flush()
    expect(voice.status?.target?.fiber_id).toBe('rex/worker')
    sources[0].emit({ fiber_id: 'rex/worker', origin: 'local', name: 'Worker' })
    expect(followed).toEqual(['rex/worker'])
    voice.dispose()
  })
  it('reopens the event stream after the daemon refuses it', async () => {
    vi.useFakeTimers()
    const sources: Array<{ fail: () => void }> = []
    vi.stubGlobal('EventSource', class {
      static CLOSED = 2
      readyState = 0
      private errors: Array<() => void> = []
      constructor() { sources.push({ fail: () => { this.readyState = 2; this.errors.forEach(fn => fn()) } }) }
      addEventListener(type: string, fn: () => void): void { if (type === 'error') this.errors.push(fn) }
      close(): void {}
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status() })))
    const voice = new Voice('')
    voice.mount(); await flush()
    sources[0].fail()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(sources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(2)
    sources[1].fail()
    voice.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sources).toHaveLength(2)
  })
  it('clears stale state when the recorder cannot be read', async () => {
    vi.useFakeTimers()
    let ok = true
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => status({ error: 'stale' }) })))
    const voice = new Voice('')
    voice.mount(); await flush()
    expect(voice.status?.error).toBe('stale')
    ok = false
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(voice.status).toBeNull()
    voice.dispose()
  })
  it('reads the recorder at once when settings changes the switch', async () => {
    vi.useFakeTimers()
    let enabled = true
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status({ enabled }) })))
    const voice = new Voice('')
    voice.mount(); await flush()
    enabled = false
    window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: false })); await flush()
    expect(voice.status?.enabled).toBe(false)
    voice.dispose()
  })
  it('retries the settings refresh while the daemon has not reconciled the saved switch', async () => {
    vi.useFakeTimers()
    let enabled = false
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status({ enabled }) })))
    const voice = new Voice('')
    voice.mount(); await flush()
    window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: true })); await flush()
    enabled = true
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(voice.status?.enabled).toBe(true)
    voice.dispose()
  })
  it('stops polling while hidden and resumes on visibility', async () => {
    vi.useFakeTimers()
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => status() }))
    vi.stubGlobal('fetch', fetcher)
    const voice = new Voice('')
    voice.mount(); await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    voice.dispose()
  })
  it('uses idle cadence on errors', () => {
    expect(voicePollDelay(false, true, status())).toBeNull()
    expect(voicePollDelay(true, false, status())).toBe(15_000)
    expect(voicePollDelay(true, true, status({ enabled: false }))).toBe(15_000)
    expect(voicePollDelay(true, true, status())).toBe(2_000)
  })
})
