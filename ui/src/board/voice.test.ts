// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { voiceStatus, settle } from './testFixtures.js'
import { Voice, voicePollDelay, type VoiceStatus } from './voice'

const status = (changes: Partial<VoiceStatus> = {}): VoiceStatus => voiceStatus({ enabled: true, state: 'listening', ...changes })

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
    await settle()
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
    await expect(voice.set({ enabled: true })).rejects.toThrow('Voice request failed (HTTP 503)')
    ok = true
    await voice.set({ enabled: true })
    expect(voice.status?.enabled).toBe(true)
  })
  it('asks only for its status, never naming a target', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return { ok: true, json: async () => status() } }))
    const voice = new Voice('')
    voice.mount(); await settle()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange')); await settle()
    expect(new Set(urls)).toEqual(new Set(['/api/v1/voice']))
    voice.dispose()
  })
  it('shows a pushed route at once and ignores a poll that started before it', async () => {
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
    const voice = new Voice('')
    voice.mount(); await settle()
    expect(sources.map(s => s.url)).toEqual(['/api/v1/voice/events'])
    sources[0].emit(null)

    slow = true
    await vi.advanceTimersByTimeAsync(2_000)
    sources[0].emit({ fiber_id: 'rex/worker', origin: 'local', name: 'Worker' })
    expect(voice.status?.target?.fiber_id).toBe('rex/worker')
    release(); await settle()
    expect(voice.status?.target?.fiber_id).toBe('rex/worker')
    sources[0].emit({ fiber_id: 'rex/worker', origin: 'local', name: 'Worker' })
    voice.dispose()
  })
  describe('the one event stream', () => {
    class Source {
      static all: Source[] = []
      static readonly CLOSED = 2
      readyState = 1
      closed = false
      url: string
      listeners = new Map<string, (event: Event) => void>()
      constructor(url: string) { this.url = url; Source.all.push(this) }
      addEventListener(type: string, fn: (event: Event) => void): void { this.listeners.set(type, fn) }
      close(): void { this.closed = true }
    }
    const live = (): Source[] => Source.all.filter(source => !source.closed)
    const start = async (): Promise<Voice> => {
      vi.useFakeTimers()
      Source.all = []
      vi.stubGlobal('EventSource', Source)
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status() })))
      const voice = new Voice('')
      voice.mount(); await settle()
      return voice
    }
    it('opens a single stream without rex=1, closes while hidden, and reopens on return', async () => {
      let hidden = false
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
      const voice = await start()
      expect(live()).toHaveLength(1)
      expect(live()[0].url).toBe('/api/v1/voice/events')
      hidden = true
      document.dispatchEvent(new Event('visibilitychange')); await settle()
      expect(live()).toHaveLength(0)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange')); await settle()
      expect(live()).toHaveLength(1)
      voice.dispose()
      expect(live()).toHaveLength(0)
    })
    it('opens nothing for a tab loaded hidden, until it is shown', async () => {
      let hidden = true
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
      const voice = await start()
      expect(Source.all).toHaveLength(0)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange')); await settle()
      expect(live()).toHaveLength(1)
      voice.dispose()
    })
    it('hands on a page a session asked for, on a phone too', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList)
      const voice = await start(), opened: unknown[] = []
      voice.onOpen = event => opened.push(event)
      const page = { fiber_id: 'uid', origin: 'fir', page: 'tapestry' }
      live()[0].listeners.get('page')!(new MessageEvent('page', { data: JSON.stringify(page) }))
      expect(opened).toEqual([page])
      voice.dispose()
    })
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
    voice.mount(); await settle()
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
    voice.mount(); await settle()
    expect(voice.status?.error).toBe('stale')
    ok = false
    await vi.advanceTimersByTimeAsync(2_000); await settle()
    expect(voice.status).toBeNull()
    voice.dispose()
  })
  it('reads the recorder at once when settings changes the switch', async () => {
    vi.useFakeTimers()
    let enabled = true
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status({ enabled }) })))
    const voice = new Voice('')
    voice.mount(); await settle()
    enabled = false
    window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: false })); await settle()
    expect(voice.status?.enabled).toBe(false)
    voice.dispose()
  })
  it('retries the settings refresh while the daemon has not reconciled the saved switch', async () => {
    vi.useFakeTimers()
    let enabled = false
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => status({ enabled }) })))
    const voice = new Voice('')
    voice.mount(); await settle()
    window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: true })); await settle()
    enabled = true
    await vi.advanceTimersByTimeAsync(2_000); await settle()
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
    voice.mount(); await settle()
    expect(fetcher).toHaveBeenCalledTimes(1)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange')); await settle()
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
