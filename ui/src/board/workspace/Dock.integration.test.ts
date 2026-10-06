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
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const response = (body: unknown = {}, status = 200): Response => new Response(JSON.stringify(body), { status })
let dock: Dock
let band: Dock
const saved = vi.fn()
const writes = (): Array<Record<string, unknown>> => vi.mocked(fetch).mock.calls
  .filter(([, options]) => options?.method === 'POST').map(([, options]) => JSON.parse(String(options?.body)))
const button = (text: string): HTMLButtonElement => text === 'New session' ? band.el.querySelector('.kbn-ctl-sends .kbn-ctl-send:not(.kbn-ctl-resume)')! : text === 'Resume' ? band.el.querySelector('.kbn-ctl-resume')! : [...band.el.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
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

describe('shared verdict controls', () => {
  it('uses the same lifecycle callback from both verdict buttons of the act zone', async () => {
    const transition = vi.fn()
    const review = task({ status: 'closed' })
    const controls = new Dock('', saved, transition)
    const band = controls.bandFor(review)
    document.body.append(band.head, band.el)
    expect(band.el.dataset.part).toBe('act'); expect(band.el.dataset.act).toBe('composer')
    expect(band.head.dataset.part).toBe('act'); expect(band.head.dataset.act).toBe('verdict')
    band.head.querySelector<HTMLButtonElement>('.kbn-ctl-temper')!.click()
    band.head.querySelector<HTMLButtonElement>('.kbn-ctl-discard')!.click()
    expect(transition.mock.calls.map(([card, target]) => [card.uid, target])).toEqual([
      ['task-uid', 'tempered'], ['task-uid', 'composted'],
    ])
    controls.reset()
    await flush()
  })
})

describe('Dock click boundary', () => {
  it('isolates all control clicks at the band rather than wiring each field', () => {
    const outside = document.createElement('div')
    document.body.append(outside); outside.append(band.el)
    const bubbled = vi.fn()
    outside.addEventListener('click', bubbled)
    band.el.querySelector<HTMLButtonElement>('.kbn-detail-controls-toggle')!.click()
    expect(band.el.querySelector<HTMLButtonElement>('.kbn-detail-controls-toggle')?.getAttribute('aria-expanded')).toBe('true')
    select('Agent').click()
    band.el.querySelector<HTMLTextAreaElement>('textarea')!.click()
    band.el.click()
    expect(bubbled).not.toHaveBeenCalled()
  })
})

describe('anchored pickers', () => {
  it('opens the effort list anchored under its select and commits a pick through the select', async () => {
    band.el.querySelector<HTMLButtonElement>('.kbn-detail-controls-toggle')!.click()
    const effort = select('Effort')
    effort.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    const list = band.el.querySelector<HTMLElement>('.ws-select-picker')!
    expect(list.previousElementSibling).toBe(effort)
    expect(list.style.position).toBe('fixed')
    expect(list.hasAttribute('data-anchored')).toBe(true)
    expect(effort.getAttribute('aria-expanded')).toBe('true')
    expect([...list.querySelectorAll('[role="option"]')].map(o => o.textContent)).toEqual(['low', 'medium', 'high'])
    expect(document.activeElement?.textContent).toBe('medium')
    const changed = vi.fn(); effort.addEventListener('change', changed)
    ;[...list.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(o => o.textContent === 'high')!.click()
    expect(effort.value).toBe('high')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(band.el.querySelector('.ws-select-picker')).toBeNull()
    expect(document.activeElement).toBe(effort)
  })
  it('offers Meeting as a switch whose verb stands in for the send verbs', async () => {
    let recording: { title: string; state: 'live' } | null = null
    let canJoin = true
    const join = vi.fn(async () => ({ error: null, delivered: true }))
    const control = { canJoin: () => canJoin, current: () => recording, join }
    const meetingDock = new Dock('', saved, undefined, undefined, { meeting: control as never })
    const meetingBand = meetingDock.bandFor(task({ sessionUuid: 'session-1', status: 'active' }))
    document.body.append(meetingBand.el)
    const q = <T extends HTMLElement>(selector: string): T => meetingBand.el.querySelector<T>(selector)!
    const toggle = q<HTMLInputElement>('.kbn-ctl-meet-switch input')
    const field = q<HTMLTextAreaElement>('textarea')
    expect([toggle.getAttribute('role'), toggle.checked]).toEqual(['switch', false])
    expect([q('.kbn-ctl-sends').hidden, q('.kbn-ctl-meet-modes').hidden, q('.kbn-ctl-meet-start').hidden]).toEqual([false, true, true])

    toggle.click()
    expect([q('.kbn-ctl-sends').hidden, q('.kbn-ctl-meet-modes').hidden, q('.kbn-ctl-meet-start').hidden]).toEqual([true, false, false])
    expect([...meetingBand.el.querySelectorAll('.kbn-ctl-meet-modes [role="radio"]')].map(r => r.textContent)).toEqual(['Call', 'Room', 'Phone'])
    expect(field.placeholder).toBe('A note for the meeting (optional)')
    ;[...meetingBand.el.querySelectorAll<HTMLButtonElement>('.kbn-ctl-meet-modes [role="radio"]')].find(r => r.textContent === 'Room')!.click()
    vi.mocked(fetch).mockClear()
    field.value = 'agenda'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(join).toHaveBeenCalledWith(expect.objectContaining({ uid: 'task-uid' }), 'room', expect.any(Function))
    expect(writes()).toEqual([])
    await flush()
    expect(toggle.checked).toBe(false)
    expect(q('.kbn-ctl-sends').hidden).toBe(false)

    // A recording elsewhere holds the switch off, naming it on hover.
    toggle.click()
    recording = { title: 'Standup', state: 'live' }
    canJoin = false
    meetingDock.syncMeeting()
    expect([toggle.checked, toggle.disabled, q('.kbn-ctl-meet-switch').title]).toEqual([false, true, 'Recording: Standup'])
    expect(q('.kbn-ctl-sends').hidden).toBe(false)
    meetingDock.reset()
  })

  it('keeps the switch on when a meeting fails to start', async () => {
    const control = { canJoin: () => true, current: () => null, join: vi.fn(async () => ({ error: 'hark unavailable', delivered: false })) }
    const meetingDock = new Dock('', saved, undefined, undefined, { meeting: control as never })
    const meetingBand = meetingDock.bandFor(task())
    document.body.append(meetingBand.el)
    const toggle = meetingBand.el.querySelector<HTMLInputElement>('.kbn-ctl-meet-switch input')!
    toggle.click()
    meetingBand.el.querySelector<HTMLButtonElement>('.kbn-ctl-meet-start')!.click()
    await flush()
    expect(meetingBand.el.querySelector('.kbn-ctl-compose > .kbn-detail-error:last-child')!.textContent).toBe('hark unavailable')
    expect(toggle.checked).toBe(true)
    meetingDock.reset()
  })
})

describe('Dock booting dispatch rejection', () => {
  it.each(['New session', 'Resume'])('explains a 503 booting %s without consuming the draft or retrying', async name => {
    const draft = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    draft.value = 'explicit correction'
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({ error: 'booting', ready: false }, 503))
    button(name).click()
    await flush()
    expect(band.el.textContent).toContain('The daemon is starting. Nothing was launched; try again shortly.')
    expect(button(name).disabled).toBe(false)
    expect(draft.value).toBe('explicit correction')
    expect(writes()).toHaveLength(1)
    expect(saved).not.toHaveBeenCalled()
  })

  it('explains a 503 booting Start retry and keeps the visible message for another explicit try', async () => {
    const draft = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    draft.value = 'corrected message'
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValueOnce(response({ reason: 'arm_refused', needs: 'project_dir', host: 'owner' }, 422))
      .mockResolvedValueOnce(response({ error: 'booting', ready: false }, 503))
    button('Resume').click()
    await flush()
    const dir = band.el.querySelector<HTMLInputElement>('.kbn-start-prompt-input')!
    dir.value = '/srv/project'; dir.dispatchEvent(new Event('input'))
    band.el.querySelector<HTMLButtonElement>('.kbn-start-prompt .kbn-ctl-send')!.click()
    await flush()
    expect(band.el.textContent).toContain('The daemon is starting. Nothing was launched; try again shortly.')
    expect(button('Resume').disabled).toBe(false)
    expect(button('New session').disabled).toBe(false)
    expect(draft.value).toBe('corrected message')
    expect(writes()).toHaveLength(2)
    expect(writes()[1]).toMatchObject({ resume_mode: 'previous', user_message: 'corrected message', project_dir: '/srv/project', origin: 'owner' })
    expect(saved).not.toHaveBeenCalled()
  })
})

describe('Dock dispatch recovery', () => {
  it.each(['New session', 'Resume'])('re-enables %s after a sessionless conflict only when worker state changes', async name => {
    vi.mocked(fetch).mockResolvedValue(response({}, 409))
    const verb = button(name)
    const label = verb.textContent
    verb.click()
    await flush()
    expect(verb.textContent).toBe('Already running')
    expect(verb.disabled).toBe(true)
    dock.syncRuntime(task())
    expect(verb.disabled).toBe(true)
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker' }))
    expect(verb.disabled).toBe(false)
    // The verb names the state it now stands in: a live session makes a fresh start "New session ↵".
    expect(verb.textContent).toBe(name === 'Resume' ? label : 'New session ↵')
    expect(band.el.querySelector('.kbn-ctl-composer')?.parentElement?.querySelector('.kbn-detail-error')?.textContent).toBe('')
  })
})

describe('state-shaped act zone', () => {
  it('leaves the field unworded in every column', () => {
    band = dock.bandFor(task({ status: 'closed' }))
    const message = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    expect(message.placeholder).toBe('')
    dock.syncRuntime(task({ status: 'active', workerState: 'running' }))
    expect(message.placeholder).toBe('')
    dock.syncRuntime(task({ status: 'open' }))
    expect(message.placeholder).toBe('')
  })

  it('seats the verdicts on the status line in every unverdicted column, retaining a draft across runtime changes', () => {
    const review = task({ status: 'closed', sessionUuid: 'resume-me' })
    band = dock.bandFor(review)
    const message = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    message.value = 'My correction'
    expect(band.el.querySelector('.kbn-ctl-verdict')).toBeNull()
    expect(band.head.dataset.column).toBe('awaitingReview')
    expect(band.head.querySelector('.kbn-ctl-verdict')?.textContent).toBe('TemperDiscard')
    expect(band.el.querySelector<HTMLButtonElement>('.kbn-ctl-resume')?.hidden).toBe(false)
    expect(message.placeholder).toBe('')
    dock.syncRuntime({ ...review, status: 'active', workerState: 'running' })
    expect(band.el.querySelector('textarea')).toBe(message)
    expect(message.value).toBe('My correction')
    // In flight the pair stays on the status line beside the worker; the act zone is the composer alone.
    expect(band.head.dataset.column).toBe('inFlight')
    expect(band.head.querySelector<HTMLElement>('.kbn-ctl-verdict')?.hidden).toBe(false)
    expect(band.el.querySelector('.kbn-ctl-temper,.kbn-ctl-discard')).toBeNull()
    dock.syncRuntime({ ...review, status: 'open', workerState: undefined })
    expect(band.head.querySelector<HTMLElement>('.kbn-ctl-verdict')?.hidden).toBe(false)
    dock.syncRuntime({ ...review, status: 'closed', tempered: true })
    expect(band.head.querySelector<HTMLElement>('.kbn-ctl-verdict')?.hidden).toBe(true)
    dock.syncRuntime({ ...review, status: 'open', workerState: undefined })
    expect(band.el.querySelector('.kbn-ctl-sends')?.textContent).toContain('Launch ↵')
  })
  it.each([
    ['drafts', { status: 'open' }, ['Launch ↵']],
    ['pinned with a session', { status: 'active', shuttleKind: 'pinned', sessionUuid: 's' }, ['New session ↵', 'Resume']],
    ['in flight with a live worker', { status: 'active', workerState: 'running', sessionUuid: 's', tmuxSession: 't' }, ['New session ↵', 'Resume']],
    ['in flight without a worker or session', { status: 'active' }, ['Start ↵']],
    ['awaiting review with a session', { status: 'closed', sessionUuid: 's' }, ['New session ↵', 'Resume']],
    ['awaiting review without a session', { status: 'closed' }, ['Start ↵']],
  ] as const)('offers a sensible verb set: %s', (_name, patch, verbs) => {
    band = dock.bandFor(task(patch as Partial<KanbanCard>))
    const shown = [...band.el.querySelectorAll<HTMLButtonElement>('.kbn-ctl-sends button')].filter(b => !b.hidden)
    expect(shown.map(b => b.textContent)).toEqual(verbs)
    expect(shown[0].classList.contains('kbn-ctl-secondary')).toBe(false)
    expect(shown[1]?.classList.contains('kbn-ctl-secondary') ?? false).toBe(verbs.length > 1)
  })
  it('Enter starts a new session and Alt-Enter resumes the named one', async () => {
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 'resume-me' }))
    const message = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    message.value = 'Restart'
    message.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
    expect(writes().at(-1)).toMatchObject({ resume_mode: 'fresh', user_message: 'Restart' })
    message.value = 'Continue'
    message.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }))
    await flush()
    expect(writes().at(-1)).toMatchObject({ resume_mode: 'previous', user_message: 'Continue' })
  })
})

describe('Dock settings queue', () => {
  it('serializes agent, shape and due writes and keeps the last selected values', async () => {
    const pending: Array<ReturnType<typeof deferred<Response>>> = []
    vi.mocked(fetch).mockImplementation(async () => {
      const write = deferred<Response>(); pending.push(write); return write.promise
    })
    change('Effort', 'low')
    button('Pinned').click()
    change('Effort', 'high')
    button('One-shot').click()
    const due = band.el.querySelector<HTMLInputElement>('input[type="date"]')!
    due.value = '2026-10-15'; due.dispatchEvent(new Event('change'))
    due.value = '2026-10-16'; due.dispatchEvent(new Event('change'))
    await flush()
    expect(writes()).toHaveLength(1)
    for (let i = 0; i < 6; i++) {
      pending[i].resolve(response())
      await flush()
      expect(writes()).toHaveLength(Math.min(i + 2, 6))
    }
    expect(writes().map(write => write.effort ?? write.kind ?? write.due)).toEqual([
      'low', 'pinned', 'high', 'oneshot', '2026-10-15', '2026-10-16',
    ])
    expect(select('Effort').value).toBe('high')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('One-shot')
    expect(due.value).toBe('2026-10-16')
  })

  it('keeps independent band queues and cancels unstarted writes when a band is reset', async () => {
    const first = deferred<Response>()
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      if (String(url).endsWith('/agents')) return response(agents)
      return JSON.parse(String(options?.body)).fiber === 'a/task' ? first.promise : response()
    })
    change('Effort', 'low')
    button('Pinned').click()
    const other = dock.bandFor(task({ id: 'a/other', uid: 'other-uid' }))
    await flush()
    const effort = other.el.querySelector<HTMLSelectElement>('[aria-label="Effort"]')!
    effort.value = 'high'; effort.dispatchEvent(new Event('change'))
    await flush()
    expect(writes()).toHaveLength(2)
    expect(writes()[1]).toMatchObject({ fiber: 'a/other', effort: 'high' })
    band.reset()
    first.resolve(response())
    await flush()
    expect(writes()).toHaveLength(2)
    expect(writes().some(write => write.action === 'reshape')).toBe(false)
  })

  it('queues a rapid agent reversal and does not roll back newer intent when an earlier write fails', async () => {
    const first = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(first.promise).mockResolvedValue(response())
    change('Agent', 'codex-luna')
    change('Agent', 'codex-sol')
    await flush()
    expect(writes()).toHaveLength(1)
    first.resolve(response({ error: 'refused' }, 422))
    await flush()
    expect(writes()).toHaveLength(2)
    expect(writes()[1]).toMatchObject({ agent: 'codex-sol', effort: 'medium' })
    expect(select('Agent').value).toBe('codex-sol')
    expect(select('Effort').value).toBe('medium')
  })

  it('rolls back a refused agent without overwriting a newer effort choice', async () => {
    const first = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(first.promise).mockResolvedValue(response())
    change('Agent', 'codex-luna')
    change('Effort', 'high')
    first.resolve(response({ error: 'refused' }, 422))
    await flush()
    expect(select('Agent').value).toBe('codex-sol')
    expect(select('Effort').value).toBe('high')
    expect(writes()[1]).toEqual({ action: 'set-agent', origin: 'owner', fiber: 'a/task', effort: 'high' })
  })

  it('re-anchors the parent results each time they change, flipping above a field low in the viewport', async () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1000 })
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('kbn-detail-parent-dropdown') ? 40 * this.childElementCount : 0
    })
    vi.mocked(fetch).mockImplementation(async () => response({ fibers: [
      { fiber: { id: 'a/b', name: 'Beta' } }, { fiber: { id: 'a/c', name: 'Gamma' } }, { fiber: { id: 'a/d', name: 'Delta' } },
    ] }))
    band.el.querySelector<HTMLButtonElement>('.kbn-ctl-parent')!.click()
    const search = band.el.querySelector<HTMLInputElement>('.kbn-detail-parent-input')!
    search.getBoundingClientRect = () => ({ left: 100, top: 690, width: 200, height: 30, right: 300, bottom: 720, x: 100, y: 690, toJSON: () => ({}) }) as DOMRect
    const dropdown = band.el.querySelector<HTMLElement>('.kbn-detail-parent-dropdown')!
    search.value = 'gamma'; search.dispatchEvent(new Event('focus'))
    await flush()
    expect(dropdown.childElementCount).toBe(1)
    expect([dropdown.dataset.side, dropdown.style.top]).toEqual(['below', '724px'])
    search.value = ''; search.dispatchEvent(new Event('focus'))
    await flush()
    expect(dropdown.childElementCount).toBe(3)
    expect([dropdown.dataset.side, dropdown.style.top]).toEqual(['above', `${690 - 4 - 120}px`])
  })

  it('serializes a parent reversal and addresses queued edits at the confirmed new parent', async () => {
    const first = deferred<Response>()
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (!options?.method) return response({ fibers: [
        { fiber: { id: 'a', name: 'A' } }, { fiber: { id: 'a/b', name: 'B' } },
      ] })
      return writes().length === 1 ? first.promise : response()
    })
    const pick = async (id: string): Promise<void> => {
      band.el.querySelector<HTMLButtonElement>('.kbn-ctl-parent')!.click()
      const search = band.el.querySelector<HTMLInputElement>('.kbn-detail-parent-input')!
      search.value = id; search.dispatchEvent(new Event('focus'))
      await flush()
      const option = [...band.el.querySelectorAll<HTMLButtonElement>('.kbn-detail-parent-option')]
        .find(option => option.querySelector('.kbn-detail-parent-option-id')?.textContent === id)!
      option.click()
    }
    await pick('a/b')
    const due = band.el.querySelector<HTMLInputElement>('input[type="date"]')!
    due.value = '2026-10-16'; due.dispatchEvent(new Event('change'))
    await pick('a')
    await flush()
    expect(writes()).toHaveLength(1)
    first.resolve(response())
    await flush()
    expect(writes()).toEqual([
      { fiber_id: 'a/task', origin: 'owner', parent: 'a/b' },
      { fiber_id: 'a/b/task', origin: 'owner', due: '2026-10-16' },
      { fiber_id: 'a/b/task', origin: 'owner', parent: 'a' },
    ])
    expect(band.el.querySelector('.kbn-ctl-parent')?.textContent).toBe('a')
  })

  it('debounces keyboard stepping before it enters the same per-band write queue', async () => {
    vi.useFakeTimers()
    const step = (group: string, key: string): void => {
      band.el.querySelector<HTMLElement>(`[aria-label="${group}"] [aria-checked="true"]`)!
        .dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    step('Session', 'ArrowRight'); step('Session', 'ArrowRight'); step('Session', 'ArrowRight')
    expect(writes()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes()).toEqual([{ action: 'set-agent', origin: 'owner', fiber: 'a/task', surface: 'app' }])
    select('Effort').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    change('Effort', 'low')
    select('Effort').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    change('Effort', 'high')
    expect(writes()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes().at(-1)).toEqual({ action: 'set-agent', origin: 'owner', fiber: 'a/task', effort: 'high' })
    step('Kind', 'ArrowLeft'); step('Kind', 'ArrowRight')
    expect(writes()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes()).toHaveLength(2)
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
