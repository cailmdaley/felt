// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { TranscriptBand } from '../transcript/TranscriptBand.js'
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
    const control = { canJoin: () => canJoin, modes: () => ['call', 'phone'], current: () => recording, join }
    const meetingDock = new Dock('', saved, undefined, undefined, { meeting: control as never })
    const meetingBand = meetingDock.bandFor(task({ sessionUuid: 'session-1', status: 'active' }))
    document.body.append(meetingBand.el)
    const q = <T extends HTMLElement>(selector: string): T => meetingBand.el.querySelector<T>(selector)!
    const toggle = q<HTMLInputElement>('.kbn-ctl-meet-switch input')
    const field = q<HTMLTextAreaElement>('textarea')
    expect([toggle.getAttribute('role'), toggle.checked]).toEqual(['switch', false])
    expect([q('.kbn-ctl-sends').hidden, q('.kbn-ctl-meet-start').hidden]).toEqual([false, true])

    toggle.click()
    expect([q('.kbn-ctl-sends').hidden, q('.kbn-ctl-meet-start').hidden]).toEqual([true, false])
    expect(meetingBand.el.querySelector('[aria-label="Meeting kind"]')).toBeNull()
    expect(field.placeholder).toBe('A note for the meeting (optional)')
    vi.mocked(fetch).mockClear()
    field.value = 'agenda'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(join).toHaveBeenCalledWith(expect.objectContaining({ uid: 'task-uid' }), 'call', expect.any(Function))
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

  it('stops the recording this constitution hosts, by the shared stop path', async () => {
    let recording: Record<string, unknown> | null = { title: 'Standup', state: 'live', fiber: 'a/task', tail: [] }
    let requested = false
    const stop = vi.fn(() => { requested = true })
    const control = { canJoin: () => false, modes: () => ['phone'], current: () => recording, join: vi.fn(), stop, stopRequested: () => requested }
    const meetingDock = new Dock('', saved, undefined, undefined, { meeting: control as never })
    const band = meetingDock.bandFor(task())
    document.body.append(band.el)
    const button = band.el.querySelector<HTMLButtonElement>('.kbn-detail-transcript-stop')!
    expect([button.hidden, button.textContent, button.disabled]).toEqual([false, 'Stop', false])
    button.click()
    expect(stop).toHaveBeenCalledWith(recording)
    meetingDock.syncMeeting()
    expect(button.disabled).toBe(true)
    button.click()
    expect(stop).toHaveBeenCalledTimes(1)

    recording = { ...recording, state: 'failed' }
    requested = false
    meetingDock.syncMeeting()
    expect([button.hidden, button.textContent]).toEqual([false, 'Dismiss'])

    // A recording another constitution hosts shows no Stop here.
    recording = { title: 'Standup', state: 'live', fiber: 'other', tail: [] }
    meetingDock.syncMeeting()
    expect(button.closest('section')!.hidden).toBe(true)
    meetingDock.reset()
  })

  it('keeps the switch on when a meeting fails to start', async () => {
    const control = { canJoin: () => true, modes: () => ['call', 'phone'], current: () => null, join: vi.fn(async () => ({ error: 'hark unavailable', delivered: false })) }
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
    band.el.querySelector<HTMLTextAreaElement>('textarea')!.value = 'a message'
    const verb = button(name)
    verb.click()
    await flush()
    expect(verb.textContent).toBe('Already running')
    expect(verb.disabled).toBe(true)
    dock.syncRuntime(task())
    expect(verb.disabled).toBe(true)
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker' }))
    expect(verb.disabled).toBe(false)
    // The verb names the state it now stands in: a live worker takes the message (Send ↵) and a fresh start is secondary.
    expect(verb.textContent).toBe(name === 'Resume' ? 'Send ↵' : 'New session')
    expect(band.el.querySelector('.kbn-ctl-composer')?.parentElement?.querySelector('.kbn-detail-error')?.textContent).toBe('')
  })

  it('holds Resume on a live worker until there is a message to hand it', () => {
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'live', tmuxSession: 'worker' }))
    const draft = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    draft.value = ''; draft.dispatchEvent(new Event('input'))
    expect(button('Resume').disabled).toBe(true)
    draft.value = 'next turn'; draft.dispatchEvent(new Event('input'))
    expect(button('Resume').disabled).toBe(false)
  })

  it('keeps a message the live worker refused, and restores the verb', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ tmux_session: 'worker' }, 409))
    const draft = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    draft.value = 'do not lose me'; draft.dispatchEvent(new Event('input'))
    button('Resume').click()
    await flush()
    expect(draft.value).toBe('do not lose me')
    expect(button('Resume').textContent).not.toBe('Resuming…')
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

  it.each([['open', 'open'], ['closed', 'closed']])('offers no verdicts on a %s fiber without a shuttle block', (_label, status) => {
    // A note or a role opened from a link is not on the Desk's lifecycle.
    band = dock.bandFor(card({ id: 'roles/surveyor', uid: 'surveyor', status }))
    expect(band.head.querySelector<HTMLElement>('.kbn-ctl-verdict')?.hidden).toBe(true)
  })
  it("lays the chat out as header, drawer, conversation and composer, with every verdict in the Act sheet", () => {
    const review = task({ status: 'closed', sessionUuid: 'resume-me' })
    band = dock.bandFor(review)
    const verbs = (): string[] => [...band.head.querySelectorAll<HTMLButtonElement>('.kbn-ctl-verdict button')]
      .filter(button => !button.hidden).map(button => button.querySelector('.ws-header-tile-title')?.textContent ?? '')
    const message = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    message.value = 'My correction'
    const children = [...band.el.querySelector('.ws-dock-body')!.children].map(child => child.className)
    expect(children).toEqual(['ws-chat-head', 'ws-chat-drawer', 'ws-chat-log', 'ws-chat-compose'])
    expect(band.el.querySelector('.ws-chat-head')!.contains(band.head)).toBe(true)
    expect(band.el.querySelector('.ws-chat-log .ws-transcript')).not.toBeNull()
    expect(band.el.querySelector('.ws-chat-compose .kbn-ctl-compose')).not.toBeNull()
    // The verdicts wait in Act; the undo window is drawn on the header's acts.
    expect(band.head.querySelector('[aria-label="Act"] .kbn-ctl-verdict')).not.toBeNull()
    expect(band.head.dataset.verdictKey).toBeTruthy()
    expect(band.head.dataset.column).toBe('awaitingReview')
    expect(verbs()).toEqual(['Temper', 'Discard'])
    expect(band.el.querySelector<HTMLButtonElement>('.kbn-ctl-resume')?.hidden).toBe(false)
    expect(message.placeholder).toBe('')
    dock.syncRuntime({ ...review, status: 'active', workerState: 'running' })
    expect(band.el.querySelector('textarea')).toBe(message)
    expect(message.value).toBe('My correction')
    expect(band.head.dataset.column).toBe('inFlight')
    expect(verbs()).toEqual(['Close', 'Temper', 'Discard'])
    dock.syncRuntime({ ...review, status: 'open', workerState: undefined })
    expect(verbs()).toEqual(['Close', 'Temper', 'Discard'])
    dock.syncRuntime({ ...review, status: 'closed', tempered: true })
    expect(band.head.querySelector<HTMLElement>('.kbn-ctl-verdict')?.hidden).toBe(true)
    dock.syncRuntime({ ...review, status: 'open', workerState: undefined })
    expect(band.el.querySelector('.kbn-ctl-sends')?.textContent).toContain('New session ↵')
  })
  it('opens matching visual sheets from glyph-only Act and Look controls, one at a time', () => {
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 's', tmuxSession: 't' }))
    document.body.append(band.el)
    const act = band.head.querySelector<HTMLButtonElement>('button[aria-label="Act"]')!
    const look = band.head.querySelector<HTMLButtonElement>('button[aria-label="Look"]')!
    const actions = band.head.querySelector<HTMLElement>('[role="dialog"][aria-label="Act"]')!
    const views = band.head.querySelector<HTMLElement>('[role="dialog"][aria-label="Look"]')!
    expect(band.head.querySelector('details, summary')).toBeNull()
    for (const trigger of [act, look]) {
      expect(trigger.textContent).toBe('')
      expect(trigger.title).toBe(trigger.getAttribute('aria-label'))
      expect(trigger.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    }
    act.focus(); act.click()
    expect(actions.hidden).toBe(false)
    expect(act.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement?.classList.contains('ws-header-tile')).toBe(true)
    for (const tile of actions.querySelectorAll('button')) {
      expect(tile.classList.contains('kbn-ctl-btn')).toBe(false)
      expect(tile.querySelector('[aria-hidden="true"]')).not.toBeNull()
      expect(tile.querySelector('.ws-header-tile-title')).not.toBeNull()
    }
    look.click()
    expect(actions.hidden).toBe(true)
    expect(views.hidden).toBe(false)
    expect([...views.querySelectorAll('.ws-header-tile-title')].map(item => item.textContent))
      .toEqual(['Constitution', 'Sessions', 'Console', 'Sent files', 'Settings'])
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(views.hidden).toBe(true)
    expect(document.activeElement).toBe(look)
    act.click()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(actions.hidden).toBe(true)
    act.click()
    expect(band.handleEscape()).toBe(true)
    expect(actions.hidden).toBe(true)
  })

  it('anchors Rest to Act so its follow-up popover survives the sheet closing', () => {
    const rest = vi.fn()
    dock.reset(); dock = new Dock('', saved, undefined, undefined, { onRest: rest })
    band = dock.bandFor(task({ status: 'active' }))
    document.body.append(band.el)
    const act = band.head.querySelector<HTMLButtonElement>('button[aria-label="Act"]')!
    act.click()
    band.head.querySelector<HTMLButtonElement>('.kbn-ctl-rest')!.click()
    expect(rest).toHaveBeenCalledWith(expect.objectContaining({ id: 'a/task' }), act)
    expect(act.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens settings and sessions from Look into the drawer, and Escape folds the drawer', () => {
    band = dock.bandFor(task({ status: 'active', workerState: 'running', sessionUuid: 's' }))
    document.body.append(band.el)
    const drawer = band.el.querySelector<HTMLElement>('.ws-chat-drawer')!
    expect(drawer.hidden).toBe(true)
    band.el.querySelector<HTMLButtonElement>('.ws-chat-settings')!.click()
    expect(drawer.hidden).toBe(false)
    expect(drawer.querySelector<HTMLElement>('.kbn-ctl-ledger')!.hidden).toBe(false)
    expect(band.handleEscape()).toBe(true)
    expect(drawer.hidden).toBe(true)
    expect(band.handleEscape()).toBe(false)
  })
  it.each([
    ['drafts', { status: 'open' }, ['Launch ↵']],
    ['drafts with a session', { status: 'open', sessionUuid: 's' }, ['New session ↵', 'Resume ⌥↵']],
    ['resting with a session', { status: 'open', effectiveHorizon: 'stashed', sessionUuid: 's' }, ['New session ↵', 'Resume ⌥↵']],
    ['in flight with a live worker', { status: 'active', workerState: 'running', sessionUuid: 's', tmuxSession: 't' }, ['Send ↵', 'New session']],
    ['in flight with a session and no worker', { status: 'active', sessionUuid: 's' }, ['New session ↵', 'Resume ⌥↵']],
    ['in flight without a worker or session', { status: 'active' }, ['Start ↵']],
    ['awaiting review with a session', { status: 'closed', sessionUuid: 's' }, ['New session ↵', 'Resume ⌥↵']],
    ['tempered with a session', { status: 'closed', tempered: true, sessionUuid: 's' }, ['New session ↵', 'Resume ⌥↵']],
    ['discarded with a session', { status: 'closed', tempered: false, sessionUuid: 's' }, ['New session ↵', 'Resume ⌥↵']],
    ['awaiting review without a session', { status: 'closed' }, ['Start ↵']],
  ] as const)('offers a sensible verb set: %s', (_name, patch, verbs) => {
    band = dock.bandFor(task(patch as Partial<KanbanCard>))
    const shown = [...band.el.querySelectorAll<HTMLButtonElement>('.kbn-ctl-sends button')].filter(b => !b.hidden)
    expect(shown.map(b => b.textContent)).toEqual(verbs)
    expect(shown[0].classList.contains('kbn-ctl-secondary')).toBe(false)
    expect(shown[1]?.classList.contains('kbn-ctl-secondary') ?? false).toBe(verbs.length > 1)
  })
  it('keeps a constitution\'s draft across a rebuilt composer and drops it once sent', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) })
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 's' }))
    const message = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    message.value = 'come back to this'
    message.dispatchEvent(new Event('input'))
    dock.reset(); dock = new Dock('', saved)
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 's' }))
    const again = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    expect(again.value).toBe('come back to this')
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
    expect(again.value).toBe('')
    dock.reset(); dock = new Dock('', saved)
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 's' }))
    expect(band.el.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('')
  })
  it('Escape leaves the composer, keeping its draft, and closes nothing', () => {
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 's' }))
    document.body.append(band.el)
    const message = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    message.focus(); message.value = 'half a thought'
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const outer = vi.fn(); document.addEventListener('keydown', outer)
    message.dispatchEvent(event)
    document.removeEventListener('keydown', outer)
    expect(document.activeElement).not.toBe(message)
    expect(message.value).toBe('half a thought')
    expect(event.defaultPrevented).toBe(true)
    expect(outer).not.toHaveBeenCalled()
    band.el.remove()
  })
  it.each([
    ['resting', { status: 'open', effectiveHorizon: 'stashed' }],
    ['awaiting review', { status: 'closed' }],
    ['tempered', { status: 'closed', tempered: true }],
    ['discarded', { status: 'closed', tempered: false }],
    ['drafts', { status: 'open' }],
  ] as const)('Enter starts a new session and Alt-Enter resumes the named one: %s', async (_name, patch) => {
    band = dock.bandFor(task({ ...patch as Partial<KanbanCard>, sessionUuid: 'resume-me' }))
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
  it('offers New session in Act in every state and Resume only for an idle recorded session', async () => {
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 'resume-me' }))
    const fresh = band.el.querySelector<HTMLButtonElement>('.ws-chat-fresh')!
    const resume = band.el.querySelector<HTMLButtonElement>('.ws-chat-resume')!
    expect(fresh.hidden).toBe(false)
    expect(resume.hidden).toBe(false)
    resume.click()
    await flush()
    expect(writes().at(-1)).toMatchObject({ resume_mode: 'previous' })
    dock.bandFor(task({ status: 'active', workerState: 'running', sessionUuid: 'resume-me', tmuxSession: 't' }))
    expect(fresh.hidden).toBe(false)
    expect(resume.hidden).toBe(true)
    dock.bandFor(task({ status: 'active', sessionUuid: undefined }))
    expect(fresh.hidden).toBe(false)
    expect(resume.hidden).toBe(true)
  })
  it('marks Resume while the previous session\'s cache is estimated warm, and leaves it plain when cold or unknown', () => {
    const until = new Date(2026, 9, 23, 14, 5).getTime()
    const warmth = vi.spyOn(TranscriptBand.prototype, 'cacheWarm').mockImplementation(session => session === 'resume-me' ? until : undefined)
    band = dock.bandFor(task({ status: 'closed', sessionUuid: 'resume-me' }))
    const resume = band.el.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!
    expect(resume.dataset.cache).toBe('warm')
    expect(resume.title).toBe('Resume the previous session (⌥↵) · cache warm until 14:05')
    expect(resume.textContent).toBe('Resume ⌥↵')
    warmth.mockReturnValue(undefined)
    dock.bandFor(task({ status: 'closed', sessionUuid: 'resume-me' }))
    expect(resume.dataset.cache).toBeUndefined()
    expect(resume.title).toBe('Resume the previous session (⌥↵)')
    // A live worker takes the message: Resume is Send, and the cache is not its business.
    warmth.mockReturnValue(until)
    dock.bandFor(task({ status: 'active', workerState: 'running', sessionUuid: 'resume-me', tmuxSession: 't' }))
    expect(resume.dataset.cache).toBeUndefined()
  })
  it('Enter sends to a live worker and Alt-Enter starts a new session', async () => {
    band = dock.bandFor(task({ status: 'active', workerState: 'running', sessionUuid: 's', tmuxSession: 't' }))
    const message = band.el.querySelector<HTMLTextAreaElement>('textarea')!
    message.value = 'Carry on'
    message.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
    expect(writes().at(-1)).toMatchObject({ resume_mode: 'previous', user_message: 'Carry on' })
    // The chat shows the message at once; the worker's transcript records it only when it reads it.
    expect(band.el.querySelector('.ws-transcript-msg-sending')?.textContent).toContain('Carry on')
    expect(message.value).toBe('')
  })
  it('names the lifecycle beside the title in the rail\'s words, kept current', () => {
    // The desktop uses the live worker pill; the phone unfolds this state chip.
    band = dock.bandFor(task({ status: 'active', sessionUuid: 's', workerState: 'running', tmuxSession: 't', runtimePhase: 'working' }))
    const chip = band.el.querySelector<HTMLElement>('.ws-chat-head .ws-chat-state')!
    expect(band.el.querySelector('.ws-chat-head .kbn-card-worker')?.textContent).toMatch(/^working/i)
    expect(chip.hidden).toBe(false)
    expect(chip.classList.contains('ws-chat-state-live')).toBe(true)
    expect(chip.textContent).toBe('Working')
    dock.bandFor(task({ status: 'active', sessionUuid: 's', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }))
    expect([chip.hidden, chip.textContent, chip.dataset.state]).toEqual([false, 'Waiting', 'question'])
    dock.bandFor(task({ status: 'closed', sessionUuid: 's' }))
    expect([chip.textContent, chip.dataset.state]).toEqual(['To review', 'to-review'])
    dock.bandFor(task({ status: 'closed', tempered: true, sessionUuid: 's' }))
    expect([chip.textContent, chip.dataset.state]).toEqual(['Tempered', 'tempered'])
  })
  it('lands on the conversation without repeating the outcome, with sent files in Look', () => {
    band = dock.bandFor(task({ status: 'active', sessionUuid: 's', outcome: 'Seed 3000 agrees.' }))
    expect(band.el.querySelector('.ws-chat-outcome')).toBeNull()
    expect(band.el.querySelector('.ws-chat-log .ws-transcript')).not.toBeNull()
    const sent = vi.fn(); band.openSentFiles = sent
    band.el.querySelector<HTMLButtonElement>('.ws-chat-sent-files')!.click()
    expect(sent).toHaveBeenCalledOnce()
  })
  it('inside a thread the header keeps a back control alongside its ancestry', () => {
    band = dock.bandFor(task({ status: 'active', sessionUuid: 's' }))
    const origin = vi.fn(), chair = vi.fn()
    band.setNav({ ancestry: [{ name: 'Chair', open: chair }, { name: 'Validation', open: vi.fn() }], origin: { label: 'Board', open: origin } })
    const trail = band.el.querySelector<HTMLElement>('.ws-chat-head .ws-chat-ancestry')!
    expect(trail.hidden).toBe(false)
    expect(trail.textContent).toBe('Chair/Validation')
    expect(band.el.querySelector('.ws-chat-lead button')).not.toBeNull()
    trail.querySelector<HTMLButtonElement>('.ws-ancestry-link')!.click()
    expect(chair).toHaveBeenCalled()
    const item = band.el.querySelector<HTMLButtonElement>('.ws-chat-lead button')!
    expect(item.textContent).toBe('‹')
    item.click()
    expect(origin).toHaveBeenCalled()
    band.setNav({ origin: { label: 'Board', open: origin } })
    expect(trail.hidden).toBe(true)
    expect(band.el.querySelector('.ws-chat-lead .ws-chat-origin')).not.toBeNull()
  })
})

describe('Dock settings queue', () => {
  it('serializes agent, shape and due writes and keeps the last selected values', async () => {
    // A standing card, so One-shot is a real shape write.
    band.el.remove()
    band = dock.bandFor(task({ id: 'a/standing', uid: 'standing-uid', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *', shuttleTz: 'UTC' }))
    document.body.append(band.el)
    await flush()
    const pending: Array<ReturnType<typeof deferred<Response>>> = []
    vi.mocked(fetch).mockImplementation(async () => {
      const write = deferred<Response>(); pending.push(write); return write.promise
    })
    change('Effort', 'low')
    button('One-shot').click()
    change('Effort', 'high')
    const due = band.el.querySelector<HTMLInputElement>('input[type="date"]')!
    due.value = '2026-10-15'; due.dispatchEvent(new Event('change'))
    due.value = '2026-10-16'; due.dispatchEvent(new Event('change'))
    await flush()
    expect(writes()).toHaveLength(1)
    for (let i = 0; i < 5; i++) {
      pending[i].resolve(response())
      await flush()
      expect(writes()).toHaveLength(Math.min(i + 2, 5))
    }
    expect(writes().map(write => write.effort ?? write.kind ?? write.due)).toEqual([
      'low', 'oneshot', 'high', '2026-10-15', '2026-10-16',
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
    change('Effort', 'high')
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
    expect(writes().some(write => write.fiber === 'a/task' && write.effort === 'high')).toBe(false)
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
    // Through a staged Standing and back: an abandoned promotion writes nothing.
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
    // The session list waits in the chat's drawer, opened from the menu.
    expect(toggle().closest('.ws-chat-drawer')).not.toBeNull()
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
      shuttleKind: 'standing', shuttleSchedule: '0 9 * * *', shuttleTz: 'UTC', shuttleSurface: 'app', due: '2026-10-12' }))
    expect(select('Agent').value).toBe('codex-luna')
    expect(select('Effort').value).toBe('low')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('Standing')
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
    dock.syncRuntime(task({ shuttleAgent: 'codex-luna', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *' }))
    expect(cron.value).toBe('my half typed expression')
    expect(select('Agent').value).toBe('codex-sol')
    band.el.querySelector<HTMLTextAreaElement>('textarea')!.focus()
    await flush()
    dock.syncRuntime(task({ shuttleAgent: 'codex-luna', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *' }))
    expect(select('Agent').value).toBe('codex-luna')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('Standing')
  })
})

describe('Look says who and where once', () => {
  it('names agent, office and host, leaving out an office that repeats the name', async () => {
    const { chatFacts } = await import('./Dock.js')
    expect(chatFacts(card({ id: 'x', name: 'cmbx chair', shuttleRole: 'cmbx-chair', shuttleAgent: 'claude-opus', shuttleHost: 'cineca' }))).toBe('claude-opus · cineca')
    expect(chatFacts(card({ id: 'x', name: 'Noise closure', shuttleRole: 'data-expert', shuttleAgent: 'codex-sol', shuttleHost: 'cineca' }))).toBe('codex-sol · data-expert · cineca')
  })
})
