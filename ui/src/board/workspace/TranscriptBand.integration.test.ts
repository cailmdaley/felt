// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'

const latestId = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
const earlierId = 'b4edf873-cb1c-40ab-a891-f26f5333b321'
const missingId = 'c5edf873-cb1c-40ab-a891-f26f5333b322'
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status })
const line = (text: string): Uint8Array => new TextEncoder().encode(
  `${JSON.stringify({ type: 'user', message: { content: text } })}\n` +
  `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus', content: [{ type: 'text', text: `Answer: ${text}` }] } })}\n`,
)
const task = (patch: Partial<KanbanCard> = {}): KanbanCard => card({
  id: 'a/task', uid: 'task-uid', originId: 'owner', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus',
  shuttleHost: 'candide', ...patch,
})
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
let docks: Dock[] = []
const makeDock = (): Dock => {
  const dock = new Dock('', vi.fn())
  docks.push(dock)
  return dock
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  try { localStorage.removeItem('shuttle.transcript.folded') } catch { /* unavailable */ }
})
afterEach(() => {
  for (const dock of docks) dock.reset()
  docks = []
  document.body.replaceChildren()
  vi.restoreAllMocks()
  if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Dock worker transcript', () => {
  it('carries same-session task polls into the transcript without rebuilding the composer', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})))
    const dock = makeDock()
    const live = task({ sessionUuid: latestId, workerState: 'running', workerTasks: [{ id: '1', subject: 'Check', status: 'in_progress', activeForm: 'Checking' }] })
    const band = dock.bandFor(live)
    document.body.append(band.el)
    const composer = band.el.querySelector('textarea')
    expect(band.el.querySelector('.ws-transcript-checklist')?.textContent).toContain('Checking')
    dock.syncRuntime({ ...live, workerTasks: [{ id: '1', subject: 'Check', status: 'completed' }] })
    expect(band.el.querySelector('.ws-transcript-checklist')?.textContent).toContain('✓Check')
    expect(band.el.querySelector('textarea')).toBe(composer)
    dock.syncRuntime({ ...live, workerTasks: undefined })
    expect(band.el.querySelector('.ws-transcript-checklist')).toBeNull()
  })
  it('follows the card session through the raw offset route', async () => {
    const requests: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/agents')) return json([{ id: 'claude-opus', cli: 'claude' }])
      if (url.includes('/transcript/raw')) {
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'))
        const bytes = line('Latest word.')
        return new Response(bytes.slice(offset), {
          headers: { 'x-transcript-offset': String(offset), 'x-transcript-byte-count': String(bytes.byteLength) },
        })
      }
      return json({})
    })
    vi.stubGlobal('fetch', fetcher)
    const dock = makeDock()
    const band = dock.bandFor(task({ sessionUuid: latestId, workerState: 'running' }))
    document.body.append(band.el)

    await vi.waitFor(() => expect(band.el.querySelector('.ws-transcript-inline .ws-transcript-msg-agent')?.textContent).toContain('Latest word.'))
    expect(band.el.querySelector<HTMLElement>('.ws-transcript')?.hidden).toBe(false)
    expect(requests).toContain(`/api/v1/transcript/raw?session=${latestId}&offset=0&host=candide`)
  })

  it('reads the conversation inline between the header and the composer, its meter on the header line', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => String(url).endsWith('/agents')
      ? json([{ id: 'claude-opus', cli: 'claude' }])
      : json({})))
    const dock = makeDock()
    const band = dock.bandFor(task({ status: 'closed', sessionUuid: latestId }))
    const transcript = band.el.querySelector<HTMLElement>('.ws-chat-log > .ws-transcript')!
    expect(transcript.classList.contains('ws-transcript-inline')).toBe(true)
    expect(transcript.querySelector('.ws-transcript-headrow')).toBeNull()
    expect(band.head.querySelector('.ws-transcript-meter')).not.toBeNull()
    expect(band.el.querySelector('.ws-chat-log')!.nextElementSibling?.classList.contains('ws-chat-compose')).toBe(true)
  })

  it('pins a History session with read and returns to the latest session', async () => {
    const requests: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.endsWith('/agents')) return json([{ id: 'claude-opus', cli: 'claude' }])
      if (url.includes('/sessions/composite')) return json({ records: [
        { at: 2, fiber: 'a/task', uid: 'task-uid', session: latestId, host: 'candide', harness: 'claude-code', agent: 'claude-opus', kind: 'dispatch' },
        { at: 1, fiber: 'a/task', uid: 'task-uid', session: earlierId, host: 'candide', harness: 'pi', agent: 'pi', kind: 'resume' },
        { at: 0, fiber: 'a/task', uid: 'task-uid', session: missingId, host: 'candide', harness: 'codex', kind: 'dispatch' },
      ] })
      if (url.includes('/sessions/links')) return json({ links: [
        { session: latestId, availability: 'available_local', harness: 'claude-code' },
        { session: earlierId, availability: 'available_local', harness: 'pi' },
        { session: missingId, availability: 'transcript_missing', harness: 'codex' },
      ] })
      if (url.includes('/transcript/raw')) {
        const parsed = new URL(url, 'http://localhost')
        const session = parsed.searchParams.get('session')!
        const offset = Number(parsed.searchParams.get('offset'))
        const bytes = line(session === latestId ? 'Latest word.' : 'Earlier word.')
        return new Response(bytes.slice(offset), {
          headers: { 'x-transcript-offset': String(offset), 'x-transcript-byte-count': String(bytes.byteLength) },
        })
      }
      return json({})
    })
    vi.stubGlobal('fetch', fetcher)
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })

    const dock = makeDock()
    const band = dock.bandFor(task({ sessionUuid: latestId, workerState: 'running', tmuxSession: 'worker' }))
    document.body.append(band.el)
    await vi.waitFor(() => expect(band.el.textContent).toContain('Latest word.'))
    band.el.querySelector<HTMLButtonElement>('.kbn-ctl-history-toggle')!.click()
    await vi.waitFor(() => {
      expect(band.el.querySelectorAll('.kbn-ctl-session-read')).toHaveLength(2)
      expect(band.el.querySelector(`[data-session="${missingId}"] .kbn-ctl-session-read`)).toBeNull()
    })

    const earlierRow = band.el.querySelector<HTMLElement>(`[data-session="${earlierId}"]`)!
    earlierRow.querySelector<HTMLButtonElement>('.kbn-ctl-session-read')!.click()
    await vi.waitFor(() => expect(band.el.textContent).toContain('Earlier word.'))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
    expect(band.el.querySelector<HTMLButtonElement>('.ws-transcript-latest')?.hidden).toBe(false)

    band.el.querySelector<HTMLButtonElement>('.ws-transcript-latest')!.click()
    await vi.waitFor(() => expect(band.el.textContent).toContain('Latest word.'))
    expect(band.el.querySelector<HTMLButtonElement>('.ws-transcript-latest')?.hidden).toBe(true)
    expect(requests.filter((url) => url.includes('/transcript/raw')).map((url) => new URL(url, 'http://localhost').searchParams.get('session')))
      .toEqual([latestId, earlierId, latestId])
  })
})
