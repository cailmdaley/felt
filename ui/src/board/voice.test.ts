// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card, voiceStatus } from './testFixtures.js'
import { Voice, constitutionFor, voicePollDelay, type VoiceStatus } from './voice'

const status = (changes: Partial<VoiceStatus> = {}): VoiceStatus => voiceStatus({ enabled: true, state: 'listening', ...changes })
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
    voice.mount(); await flush()
    expect(sources.map(s => s.url)).toEqual(['/api/v1/voice/events?rex=1'])
    sources[0].emit(null)

    slow = true
    await vi.advanceTimersByTimeAsync(2_000)
    sources[0].emit({ fiber_id: 'rex/worker', origin: 'local', name: 'Worker' })
    expect(voice.status?.target?.fiber_id).toBe('rex/worker')
    release(); await flush()
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
      voice.mount(); await flush()
      return voice
    }
    const move = { fiber_id: 'uid', origin: 'fir', name: 'Worker' }
    const emit = (source: Source): void => source.listeners.get('focus')!(new MessageEvent('focus', { data: JSON.stringify(move) }))

    it('hands on what Rex moved to, voice on or off, over a single stream', async () => {
      const voice = await start(), moved: unknown[] = []
      voice.onRex = event => moved.push(event)
      expect(live()).toHaveLength(1)
      emit(live()[0])
      await voice.set({ enabled: false })
      emit(live()[0])
      expect(moved).toEqual([move, move])
      voice.dispose()
      expect(live()).toHaveLength(0)
    })
    const opened = (fiber: string): VoiceStatus['target'] => ({ fiber_id: fiber, origin: 'fir', name: fiber, source: 'inbox' })
    it('moves to a card the inbox opens, once, and again if the board left it', async () => {
      const target = (source: Source, value: unknown): void => source.listeners.get('target')!(new MessageEvent('target', { data: JSON.stringify(value) }))
      const voice = await start(), moved: unknown[] = []
      voice.onRex = event => moved.push(event.fiber_id)
      target(live()[0], opened('card'))
      target(live()[0], opened('card'))
      target(live()[0], { fiber_id: 'board', origin: 'fir', name: 'board' })
      target(live()[0], opened('card'))
      expect(moved).toEqual(['card', 'card'])
      voice.dispose()
    })
    it('hears the inbox of a remote recorder from its polled status, and not a card found on arrival', async () => {
      const voice = await start(), moved: unknown[] = []
      voice.onRex = event => moved.push(event.fiber_id)
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ...status(), target: opened('remote') }) })))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(moved).toEqual(['remote'])
      voice.dispose()
      const later = new Voice('')
      later.onRex = event => moved.push(event.fiber_id)
      later.mount(); await flush()
      expect(moved).toEqual(['remote'])
      later.dispose()
    })
    it('closes while hidden, reopens on return, and moves nothing for it', async () => {
      let hidden = false
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
      const voice = await start(), moved: unknown[] = []
      voice.onRex = event => moved.push(event)
      hidden = true
      document.dispatchEvent(new Event('visibilitychange')); await flush()
      expect(live()).toHaveLength(0)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange')); await flush()
      expect(live()).toHaveLength(1)
      expect(moved).toEqual([])
      voice.dispose()
    })
    it('opens nothing for a tab loaded hidden, until it is shown', async () => {
      let hidden = true
      vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
      const voice = await start()
      expect(Source.all).toHaveLength(0)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange')); await flush()
      expect(live()).toHaveLength(1)
      voice.dispose()
    })
    it('ignores a move while the window is phone-narrow, and hears the next once it widens', async () => {
      const voice = await start(), moved: unknown[] = []
      voice.onRex = event => moved.push(event)
      let narrow = true
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: narrow && query.includes('max-width') }) as MediaQueryList)
      emit(live()[0])
      expect(moved).toEqual([])
      narrow = false
      emit(live()[0])
      expect(moved).toEqual([move])
      voice.dispose()
    })
    it('hands on a page a session asked for, on a phone too', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList)
      const voice = await start(), opened: unknown[] = []
      voice.onOpen = event => opened.push(event)
      const page = { fiber_id: 'uid', origin: 'fir', page: 'tapestry' }
      live()[0].listeners.get('open')!(new MessageEvent('open', { data: JSON.stringify(page) }))
      expect(opened).toEqual([page])
      voice.dispose()
    })
    it('asks for no Rex moves on a phone', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse') }) as MediaQueryList)
      const voice = await start()
      expect(live()[0].url).toBe('/api/v1/voice/events')
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
  describe('following what the board shows', () => {
    const worker = card({ id: 'project/a', uid: 'uid-a', name: 'A', originId: 'owner', shuttleKind: 'oneshot' })
    const other = card({ id: 'project/b', uid: 'uid-b', name: 'B', originId: 'owner', shuttleKind: 'oneshot' })
    const held = { fiber_id: 'uid-b', origin: 'owner', name: 'B' }
    let current: VoiceStatus, posts: unknown[], focused: boolean
    const mounted = async (start: VoiceStatus): Promise<Voice> => {
      vi.useFakeTimers()
      current = start
      posts = []
      focused = true
      vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)))
          if (current.follow) current = { ...current, target: JSON.parse(String(init.body)) as VoiceStatus['target'] }
        }
        return { ok: true, json: async () => current }
      }))
      const voice = new Voice('')
      voice.mount(); await flush()
      return voice
    }

    it('sets the target from what the board shows, once the view holds', async () => {
      const voice = await mounted(status({ target: held }))
      voice.see(other)
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(300)
      voice.see(other)
      await vi.advanceTimersByTimeAsync(300)
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(400); await flush()
      expect(posts).toEqual([{ fiber_id: 'uid-a', origin: 'owner', name: 'A' }])
      await vi.advanceTimersByTimeAsync(2_000); await flush()
      voice.dispose()
    })
    it('remembers a board view while pinned without moving the target or repeating the write', async () => {
      const voice = await mounted(status({ follow: false, target: held, recorder: 'audio-host' }))
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(400); await flush()
      expect(posts).toEqual([{ fiber_id: 'uid-a', origin: 'owner', name: 'A', recorder: 'audio-host' }])
      expect(voice.status?.target).toEqual(held)
      window.dispatchEvent(new Event('focus')); await flush()
      expect(posts).toHaveLength(1)
      voice.dispose()
    })
    it('routes the page viewed on a phone to its recorder', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: true }) as MediaQueryList)
      const voice = await mounted(status({ source: 'phone', target: held, recorder: 'audio-host' }))
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(400); await flush()
      expect(posts).toEqual([{ fiber_id: 'uid-a', origin: 'owner', name: 'A', recorder: 'audio-host' }])
      voice.dispose()
    })
    it('lets the last focused of Rex and the board decide', async () => {
      const voice = await mounted(status({ target: held }))
      focused = false
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(400); await flush()
      expect(posts).toEqual([])
      focused = true
      window.dispatchEvent(new Event('focus')); await flush()
      expect(posts).toEqual([{ fiber_id: 'uid-a', origin: 'owner', name: 'A' }])
      focused = false
      current = status({ target: held })
      await vi.advanceTimersByTimeAsync(2_000); await flush()
      expect(posts).toHaveLength(1)
      voice.dispose()
    })
    it('leaves a target that already agrees alone, and survives a refused write', async () => {
      const voice = await mounted(status({ target: held }))
      voice.see(other)
      await vi.advanceTimersByTimeAsync(400); await flush()
      expect(posts).toEqual([])
      vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === 'POST' ? { ok: false, status: 503 } as Response : { ok: true, json: async () => current } as Response)
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(400); await flush()
      await vi.advanceTimersByTimeAsync(2_000); await flush()
      voice.dispose()
    })
    it.each([
      ['voice is off', status({ enabled: false, target: held })],
    ])('changes nothing while %s, and claims the view when following returns', async (_, start) => {
      const voice = await mounted(start)
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(400); await flush()
      expect(posts).toEqual([])
      current = status({ target: held })
      await vi.advanceTimersByTimeAsync(15_000); await flush()
      expect(posts).toEqual([{ fiber_id: 'uid-a', origin: 'owner', name: 'A' }])
      voice.dispose()
    })
    it('claims the view when focus lands in a report frame, with no window focus event', async () => {
      const voice = await mounted(status({ target: held }))
      focused = false
      voice.see(worker)
      await vi.advanceTimersByTimeAsync(2_000); await flush()
      expect(posts).toEqual([])
      focused = true
      await vi.advanceTimersByTimeAsync(2_000); await flush()
      expect(posts).toEqual([{ fiber_id: 'uid-a', origin: 'owner', name: 'A' }])
      voice.dispose()
    })
    it('leaves the target where it is on a fiber with no constitution, or off any fiber', async () => {
      const voice = await mounted(status({ target: held }))
      voice.see(card({ id: 'notes', originId: 'owner' }))
      await vi.advanceTimersByTimeAsync(400); await flush()
      voice.see(null)
      await vi.advanceTimersByTimeAsync(400); await flush()
      window.dispatchEvent(new Event('focus')); await flush()
      expect(posts).toEqual([])
      voice.dispose()
    })
    it('reads a plain fiber as the nearest constitution above it on the same host', () => {
      const hub = card({ id: 'project', originId: 'owner', shuttleKind: 'standing' })
      const elsewhere = card({ id: 'project/sub', originId: 'other', shuttleKind: 'oneshot' })
      const page = card({ id: 'project/sub/tapestry', originId: 'owner' })
      expect(constitutionFor(page, [hub, elsewhere, page])).toBe(hub)
      expect(constitutionFor(hub, [hub, page])).toBe(hub)
      expect(constitutionFor(page, [elsewhere, page])).toBe(page)
    })
  })
})
