// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'

const agents = [
  { id: 'codex-sol', cli: 'codex', effort_levels: ['low', 'medium', 'high'], default_effort: 'medium' },
  { id: 'codex-luna', cli: 'codex', effort_levels: ['low', 'medium', 'high'], default_effort: 'low' },
]
const task = (patch: Partial<KanbanCard> = {}): KanbanCard => card({
  id: 'a/task', uid: 'task-uid', originId: 'owner', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol',
  shuttleEffort: 'medium', shuttleHost: 'owner', ...patch,
})
const flush = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const response = (body: unknown = {}, status = 200): Response => new Response(JSON.stringify(body), { status })
let dock: Dock
let band: Dock
const saved = vi.fn()
const writes = (): Array<Record<string, unknown>> => vi.mocked(fetch).mock.calls
  .filter(([, options]) => options?.method === 'POST').map(([, options]) => JSON.parse(String(options?.body)))
const button = (text: string): HTMLButtonElement => [...band.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
const select = (label: string): HTMLSelectElement => band.el.querySelector(`select[aria-label="${label}"]`)!
const change = (label: string, value: string): void => { select(label).value = value; select(label).dispatchEvent(new Event('change')) }

beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/agents') ? response(agents) : response()))
  saved.mockClear()
  dock = new Dock('', saved)
  band = dock.bandFor(task())
  document.body.append(band.el)
  await flush()
})
afterEach(() => { dock.reset(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Dock dispatch recovery', () => {
  it.each(['New session', 'Resume'])('re-enables %s after a sessionless conflict only when worker state changes', async name => {
    vi.mocked(fetch).mockResolvedValue(response({}, 409))
    const verb = button(name)
    verb.click()
    await flush()
    expect(verb.textContent).toBe('Already running')
    expect(verb.disabled).toBe(true)
    dock.syncRuntime(task())
    expect(verb.disabled).toBe(true)
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker' }))
    expect(verb.disabled).toBe(false)
    expect(verb.textContent).toBe(name)
    expect(band.el.querySelector('.kbn-ctl-composer')?.parentElement?.querySelector('.kbn-detail-error')?.textContent).toBe('')
  })
})

describe('Dock session history', () => {
  it('reloads on each unfold and retargets open history when the live session or tmux changes', async () => {
    const sessions = ['old-session']
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).includes('/sessions/composite')) return response({ records: sessions.map((session, at) => ({
        at, fiber: 'a/task', uid: 'task-uid', session, host: 'owner', harness: 'codex', kind: 'dispatch',
      })) })
      if (String(url).includes('/sessions/links')) return response({ links: sessions.map(session => ({ session, harness: 'codex', availability: 'available_local' })) })
      return response()
    })
    const toggle = (): HTMLButtonElement => band.el.querySelector('.kbn-ctl-history-toggle')!
    const historyReads = (): number => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/sessions/composite')).length
    toggle().focus(); toggle().click()
    await flush()
    expect(historyReads()).toBe(1)
    expect(band.el.querySelectorAll('.kbn-ctl-session')).toHaveLength(1)
    toggle().click()
    sessions.push('new-session')
    toggle().focus(); toggle().click()
    await flush()
    expect(historyReads()).toBe(2)
    expect(document.activeElement).toBe(toggle())
    expect(band.el.querySelectorAll('.kbn-ctl-session')).toHaveLength(2)
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker-one' }))
    await flush()
    expect(historyReads()).toBe(3)
    const row = (): HTMLElement => band.el.querySelector('[data-session="new-session"]')!
    expect(row().textContent).toContain('attach')
    row().querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    expect(writes().at(-1)).toEqual({ tmux_session: 'worker-one', shuttle_host: 'owner' })
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker-two' }))
    await flush()
    expect(historyReads()).toBe(4)
    row().querySelector<HTMLButtonElement>('button')!.click()
    await flush()
    expect(writes().at(-1)).toEqual({ tmux_session: 'worker-two', shuttle_host: 'owner' })
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker-two' }))
    expect(historyReads()).toBe(4)
    toggle().click()
    dock.syncRuntime(task({ workerState: undefined, sessionUuid: 'new-session', tmuxSession: undefined }))
    expect(historyReads()).toBe(4)
  })
})

describe('Dock poll reconciliation', () => {
  it('re-seeds settings from polls and writes only the edited agent axis', async () => {
    const draft = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    draft.value = 'unsent'
    dock.syncRuntime(task({ id: 'b/task', shuttleAgent: 'codex-luna', shuttleEffort: 'low',
      shuttleKind: 'pinned', shuttleSurface: 'app', due: '2026-10-12' }))
    expect(select('Agent').value).toBe('codex-luna')
    expect(select('Effort').value).toBe('low')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('Pinned')
    expect(band.el.querySelector('[aria-label="Session"] [aria-checked="true"]')?.textContent).toBe('App')
    expect(band.el.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe('2026-10-12')
    expect(band.el.querySelector('.kbn-ctl-parent')?.textContent).toBe('b')
    expect(band.el.querySelector('.kbn-ctl-strip')?.textContent).toContain('codex-luna')
    expect(band.el.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('unsent')
    change('Effort', 'high')
    await flush()
    expect(writes()).toEqual([{ action: 'set-agent', origin: 'owner', fiber: 'b/task', effort: 'high' }])
    button('One-shot').click()
    await flush()
    expect(writes().at(-1)).toEqual({ action: 'reshape', origin: 'owner', fiber: 'b/task', kind: 'oneshot' })
  })

  it('preserves focused settings until a later unfocused poll', async () => {
    const cron = band.el.querySelector<HTMLInputElement>('[aria-label="Cron"]')!
    button('Standing').click()
    cron.value = 'my half typed expression'
    dock.syncRuntime(task({ shuttleAgent: 'codex-luna', shuttleKind: 'pinned' }))
    expect(cron.value).toBe('my half typed expression')
    expect(select('Agent').value).toBe('codex-sol')
    band.el.querySelector<HTMLTextAreaElement>('textarea')!.focus()
    await flush()
    dock.syncRuntime(task({ shuttleAgent: 'codex-luna', shuttleKind: 'pinned' }))
    expect(select('Agent').value).toBe('codex-luna')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('Pinned')
  })
})
