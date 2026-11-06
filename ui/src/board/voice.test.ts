// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Voice, VoiceRequestError, voicePollDelay, type VoiceStatus } from './voice'
import { card } from './testFixtures'

const status = (changes: Partial<VoiceStatus> = {}): VoiceStatus => ({ available: true, enabled: true, muted: false, state: 'listening', target: null, pending: null, last: null, error: null, ...changes })
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('live voice', () => {
  it('orders a held draft edit before its checkpoint release and refreshes a name conflict', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    let finishEdit!: () => void
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/draft')) await new Promise<void>(resolve => { finishEdit = resolve })
      return { ok: !url.endsWith('/release'), status: url.endsWith('/release') ? 409 : 200, json: async () => status({ held: [] }) }
    }))
    const voice = new Voice('')
    const held = { id: 'held-a', after: 1, through: 3 }
    const edit = voice.editHeld(held, 'me: edited words')
    const release = voice.releaseHeld(held)
    held.after = 2 // Queued writes retain the boundary that was shown.
    const rejected = expect(release).rejects.toBeInstanceOf(VoiceRequestError)
    await flush()
    expect(calls).toEqual([{ url: '/api/v1/voice/draft', body: { id: 'held-a', after: 1, through: 3, text: 'me: edited words' } }])
    finishEdit()
    await edit; await rejected
    expect(calls).toEqual([
      { url: '/api/v1/voice/draft', body: { id: 'held-a', after: 1, through: 3, text: 'me: edited words' } },
      { url: '/api/v1/voice/release', body: { id: 'held-a', after: 1, through: 3 } },
      { url: '/api/v1/voice', body: null },
    ])
    expect(voice.status?.held).toEqual([])
  })
  it('preserves a name claim conflict when the follow-up refresh is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/release')) return { ok: false, status: 409 }
      throw new Error('recorder unreachable')
    }))
    const voice = new Voice('')
    await expect(voice.releaseHeld({ id: 'held-a', through: 3 })).rejects.toMatchObject({ status: 409 })
  })
  it('targets only changed constitutions and reasserts on focus, never a plain note', async () => {
    vi.useFakeTimers()
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
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(50); await flush()
    expect(calls.filter(c => c.url.endsWith('/target')).map(c => c.body)).toEqual([
      { fiber_id: 'durable-a', origin: 'local' }, { fiber_id: 'b', origin: 'remote' }, { fiber_id: 'b', origin: 'remote' },
    ])
    voice.dispose()
  })
  it('explicitly listens here again after another source changes the target, including on phone', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return { ok: true, json: async () => status() }
    }))
    const voice = new Voice('')
    voice.status = status()
    const a = card({ id: 'a', shuttleKind: 'oneshot' })
    voice.select(a); await flush()
    voice.status = status({ target: { fiber_id: 'b', origin: 'remote', name: 'B' } })
    await voice.listenHere(a)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    await voice.listenHere(a)
    expect(calls.filter(c => c.url.endsWith('/target')).map(c => c.body)).toEqual([
      { fiber_id: 'a', origin: 'local' }, { fiber_id: 'a', origin: 'local' }, { fiber_id: 'a', origin: 'local' },
    ])
  })
  it('coalesces focus and visibility into one reassertion', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return { ok: true, json: async () => status() } }))
    const voice = new Voice('')
    voice.mount(); await flush()
    voice.select(card({ id: 'a', shuttleKind: 'oneshot' })); await flush()
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(50); await flush()
    expect(calls.filter(url => url.endsWith('/target'))).toHaveLength(2)
    voice.dispose()
  })
  it('follows a target set elsewhere once, without posting the card it opens', async () => {
    vi.useFakeTimers()
    let current = status()
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url, body })
      if (url.endsWith('/target')) current = status({ target: { ...body, name: body.fiber_id } })
      return { ok: true, json: async () => current }
    }))
    const followed: string[] = []
    const voice = new Voice('')
    voice.onFollow = target => followed.push(target.fiber_id)
    voice.mount(); await flush()
    voice.select(card({ id: 'a', uid: 'durable-a', shuttleKind: 'oneshot' })); await flush()
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(followed).toEqual([])

    current = status({ target: { fiber_id: 'project/b', origin: 'local', name: 'B' } })
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(followed).toEqual(['project/b'])
    voice.select(card({ id: 'project/b', uid: 'durable-b', shuttleKind: 'oneshot' })); await flush()
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(followed).toEqual(['project/b'])
    expect(calls.filter(c => c.url.endsWith('/target')).map(c => c.body)).toEqual([{ fiber_id: 'durable-a', origin: 'local' }])

    voice.select(card({ id: 'a', uid: 'durable-a', shuttleKind: 'oneshot' })); await flush()
    expect(calls.filter(c => c.url.endsWith('/target')).map(c => c.body).at(-1)).toEqual({ fiber_id: 'durable-a', origin: 'local' })
    voice.dispose()
  })
  it('returning to the board follows a change made while away instead of re-asserting its card', async () => {
    vi.useFakeTimers()
    let current = status()
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return { ok: true, json: async () => current } }))
    const followed: string[] = []
    const voice = new Voice('')
    voice.onFollow = target => followed.push(target.fiber_id)
    voice.mount(); await flush()
    voice.select(card({ id: 'a', shuttleKind: 'oneshot' })); await flush()
    const posts = calls.filter(url => url.endsWith('/target')).length
    current = status({ target: { fiber_id: 'rex/worker', origin: 'local', name: 'Worker' } })
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(50); await flush()
    expect(followed).toEqual(['rex/worker'])
    expect(calls.filter(url => url.endsWith('/target'))).toHaveLength(posts)
    window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(50); await flush()
    expect(calls.filter(url => url.endsWith('/target'))).toHaveLength(posts + 1)
    voice.dispose()
  })
  it('clears stale state when the recorder cannot be read', async () => {
    vi.useFakeTimers()
    let ok = true
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => status({ pending: { fiber_id: 'a', words: 1, text: 'stale' } }) })))
    const voice = new Voice('')
    voice.mount(); await flush()
    expect(voice.status?.pending?.text).toBe('stale')
    ok = false
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(voice.status).toBeNull()
    voice.dispose()
  })
  it('refreshes after settings enables voice and reasserts even after it was targeted before', async () => {
    vi.useFakeTimers()
    let enabled = true
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return { ok: true, json: async () => status({ enabled }) } }))
    const voice = new Voice('')
    voice.mount(); await flush()
    voice.select(card({ id: 'a', shuttleKind: 'oneshot' })); await flush()
    enabled = false
    window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: false })); await flush()
    enabled = true
    window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: true })); await flush()
    expect(calls.filter(url => url.endsWith('/target'))).toHaveLength(2)
    voice.dispose()
  })
  it('retries the settings refresh while the daemon has not reconciled the saved switch', async () => {
    vi.useFakeTimers()
    let enabled = false
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return { ok: true, json: async () => status({ enabled }) } }))
    const voice = new Voice('')
    voice.mount(); await flush()
    voice.select(card({ id: 'a', shuttleKind: 'oneshot' })); await flush()
    window.dispatchEvent(new CustomEvent('shuttle-voice-settings-saved', { detail: true })); await flush()
    enabled = true
    await vi.advanceTimersByTimeAsync(2_000); await flush()
    expect(voice.status?.enabled).toBe(true)
    expect(calls.filter(url => url.endsWith('/target'))).toHaveLength(1)
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
