// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bandFacts, Dock, stripFacts } from './Dock.js'
import { clockTime } from '../civilDay.js'
import { CLAUDE_OPENING_KEY } from '../conversationOpening.js'
import { card, settle } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'

const agents = [
  { id: 'codex-sol', cli: 'codex', effort_levels: ['low', 'medium', 'high'], default_effort: 'medium' },
  { id: 'codex-luna', cli: 'codex', effort_levels: ['low', 'medium', 'high'], default_effort: 'low' },
]
const task = (patch: Partial<KanbanCard> = {}): KanbanCard => card({
  id: 'a/task', uid: 'task-uid', originId: 'owner', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol',
  shuttleEffort: 'medium', shuttleHost: 'owner', ...patch,
})
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
const session = (label: string): HTMLButtonElement => band.el.querySelector(`.ws-worker-acts button[data-verb="${label}"]`)!
/** The worker line's verbs, then the band's lifecycle verbs, as drawn. */
const shownVerbs = (view: Dock): string[] => [
  ...(view.el.querySelector<HTMLElement>('.ws-worker-acts')?.hidden ? [] : [...view.el.querySelectorAll<HTMLButtonElement>('.ws-worker-acts button')].filter(button => !button.hidden).map(button => button.dataset.verb!)),
  ...[...view.head.querySelectorAll<HTMLButtonElement>('.kbn-ctl-verdict button')].filter(button => !button.hidden).map(button => button.dataset.verb!),
]
const button = (text: string): HTMLButtonElement => [...band.el.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
const select = (label: string): HTMLSelectElement => band.el.querySelector(`select[aria-label="${label}"]`)!
const change = (label: string, value: string): void => { select(label).value = value; select(label).dispatchEvent(new Event('change')) }

beforeEach(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/agents') ? response(agents) : url.endsWith('/config/voice') ? response({ text: '{}', digest: null }) : response()))
  saved.mockClear()
  dock = new Dock('', saved)
  band = dock
  dock.open(task())
  document.body.append(band.el)
  await settle()
})
afterEach(() => { dock.reset(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('change review delivery', () => {
  it('does not send or start a worker when none exists', async () => {
    await expect(dock.sendReview(task(), 'Review')).rejects.toThrow('No live worker')
    expect(writes()).toEqual([])
  })
  it('uses the existing-worker route, accepts a non-JSON 200, and preserves 409 refusal', async () => {
    const live = task({ workerState: 'running' })
    vi.mocked(fetch).mockResolvedValueOnce(new Response('delivered'))
    await dock.sendReview(live, 'Review')
    expect(writes().at(-1)).toMatchObject({ fiber_id: live.id, origin: live.originId, resume_mode: 'previous', existing_only: true, user_message: 'Review' })
    vi.mocked(fetch).mockResolvedValueOnce(response({ tmux_session: 'busy' }, 409))
    await expect(dock.sendReview(live, 'Keep this draft')).rejects.toThrow('already running')
  })
  it('reports a delivered review as delivered after the band moves on', async () => {
    const live = task({ workerState: 'running' }), answer = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(answer.promise)
    const sent = dock.sendReview(live, 'Review')
    await settle()
    dock.reset()
    answer.resolve(response({ tmux_session: 'worker' }))
    await expect(sent).resolves.toBeUndefined()
  })
  it('keeps a review refused after the band moves on as a refusal', async () => {
    const live = task({ workerState: 'running' }), answer = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(answer.promise)
    const sent = dock.sendReview(live, 'Review')
    await settle()
    dock.reset()
    answer.resolve(response({ reason: 'closed' }, 422))
    await expect(sent).rejects.toThrow('Fiber is closed')
  })
  it.each([
    ['a busy poller', { dispatched: false, reason: 'poller_busy', message: 'The request is still queued' }, 504],
    ['a lost forward', { dispatched: false, reason: 'forward_failed', error: ':timeout' }, 502],
  ])('never calls a review undelivered after %s', async (_name, body, status) => {
    vi.mocked(fetch).mockResolvedValueOnce(response(body, status))
    await expect(dock.sendReview(task({ workerState: 'running' }), 'Review')).rejects.toThrow('could not confirm this was delivered, and it may still arrive')
  })
  it('does not claim an unanswered review never arrived', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connection reset'))
    await expect(dock.sendReview(task({ workerState: 'running' }), 'Review')).rejects.toThrow('may still arrive')
  })
  it('does not turn a review refusal into permission to arm a fiber', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ reason: 'arm_refused', needs: 'project_dir', message: 'Missing project directory' }, 422))
    await expect(dock.sendReview(task({ workerState: 'running' }), 'Review')).rejects.toThrow('Missing project directory')
    expect(writes()).toHaveLength(1)
    expect(writes()[0].project_dir).toBeUndefined()
  })
})

describe('band header', () => {
  const visibleVerbs = shownVerbs

  it('× returns directly to Desk and writes nothing', () => {
    const transition = vi.fn()
    dock.reset(); dock = band = new Dock('', saved, transition)
    dock.open(task({ status: 'active', sessionUuid: 'leave' }))
    document.body.append(band.el)
    const leave = band.el.querySelector<HTMLButtonElement>('.ws-band-head > .ws-band-leave')!
    expect(leave.hidden).toBe(true)
    const desk = vi.fn()
    band.setNav({ desk })
    expect(leave.hidden).toBe(false)
    expect(leave.getAttribute('aria-label')).toBe('Return to Desk')
    expect(leave.querySelector('svg path')!.getAttribute('d')).toBe('m4 4 8 8m0-8-8 8')
    vi.mocked(fetch).mockClear()
    leave.click()
    expect(desk).toHaveBeenCalledTimes(1)
    expect(transition).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
    // No lifecycle verb is drawn as ×.
    for (const verb of band.head.querySelectorAll('.kbn-ctl-verdict button svg path')) expect(verb.getAttribute('d')).not.toBe('m4 4 8 8m0-8-8 8')
  })

  it('draws the lifecycle verbs as icons like navigation, and the worker line\'s verbs with their words', () => {
    dock.reset()
    dock.open(task({ status: 'active', sessionUuid: 'words' }))
    const words = (selector: string) => [...band.el.querySelectorAll<HTMLButtonElement>(selector)].filter(button => !button.hidden).map(button => button.querySelector('.ws-header-word')?.textContent)
    expect(words('.ws-worker-acts button')).toEqual(['Resume', 'New session'])
    expect(band.el.querySelector('.ws-band-head .ws-header-word')).toBeNull()
    expect(band.el.querySelector<HTMLButtonElement>('.kbn-ctl-review')!.textContent).toBe('')
  })

  it('keeps the verdict inside the verbs and Settings on the title line', () => {
    dock.reset(); dock = band = new Dock('', saved, undefined, undefined, { onRest: vi.fn() })
    dock.open(task({ status: 'active', sessionUuid: 'narrow' }))
    const header = band.el.querySelector<HTMLElement>('.ws-band-head')!
    expect(header.querySelector('.kbn-ctl-verdict')?.parentElement).toBe(band.head)
    expect(header.querySelector('.ws-band-settings')?.parentElement).toBe(header)
    expect(band.head.parentElement).toBe(header)
  })

  it('draws the verbs selected for each lifecycle state', () => {
    const controls = new Dock('', saved, undefined, undefined, { onRest: vi.fn() })
    const visible = (patch: Partial<KanbanCard>): string[] => { controls.reset(); controls.open(task(patch)); return visibleVerbs(controls) }
    expect(visible({ status: 'open' })).toEqual(['Start', 'Rest'])
    expect(visible({ status: 'active', workerState: 'running', sessionUuid: 'live', tmuxSession: 'worker' }))
      .toEqual(['Send', 'New session', 'Close for review', 'Rest'])
    expect(visible({ status: 'active', sessionUuid: 'idle' })).toEqual(['Resume', 'New session', 'Close for review', 'Rest'])
    expect(visible({ status: 'closed', sessionUuid: 'review' })).toEqual(['Resume', 'New session', 'Temper', 'Discard'])
    expect(visible({ status: 'open', effectiveHorizon: 'stashed', sessionUuid: 'resting' })).toEqual(['Resume', 'New session'])
    expect(visible({ status: 'closed', tempered: true, sessionUuid: 'tempered' })).toEqual(['Resume', 'New session'])
    expect(visible({ status: 'closed', tempered: false, sessionUuid: 'discarded' })).toEqual(['Resume', 'New session'])
    controls.reset()
  })

  it('offers session verbs by whether a worker or a past session stands behind them', () => {
    const offered = (patch: Partial<KanbanCard>): string[] => {
      dock.reset(); dock.open(task(patch))
      return [...band.el.querySelectorAll<HTMLButtonElement>('.ws-worker-acts button')].filter(item => !item.hidden).map(item => item.dataset.verb!)
    }
    expect(offered({ status: 'open' })).toEqual(['Start'])
    expect(offered({ status: 'closed' })).toEqual(['Start'])
    expect(offered({ status: 'open', sessionUuid: 's' })).toEqual(['Resume', 'New session'])
    expect(offered({ status: 'open', effectiveHorizon: 'stashed', sessionUuid: 's' })).toEqual(['Resume', 'New session'])
    expect(offered({ status: 'active', workerState: 'running', sessionUuid: 's', tmuxSession: 't' })).toEqual(['Send', 'New session'])
    dock.reset(); dock.open(card({ id: 'notes/plain', uid: 'plain', status: 'open' }))
    expect(band.el.querySelector<HTMLElement>('.ws-worker-acts')!.hidden).toBe(true)
  })

  it('says no state word beside the title, and marks the state for colour, kept current', () => {
    dock.reset()
    dock.open(task({ status: 'active', sessionUuid: 's', workerState: 'running', tmuxSession: 't', runtimePhase: 'working' }))
    expect([...band.el.querySelector('.ws-band-identity')!.children].map(child => child.className)).toEqual(['ws-header-icon ws-band-back', 'ws-band-title', 'ws-band-meter'])
    expect(band.el.querySelector('.ws-band-head [data-part="lifecycle"]')).toBeNull()
    expect(band.el.dataset.column).toBe('inFlight')
    dock.open(task({ status: 'closed', sessionUuid: 's' }))
    expect(band.el.dataset.column).toBe('awaitingReview')
  })

  it('lays the band out as a head, its worker\'s line, its settings and its status', () => {
    dock.reset()
    dock.open(task({ status: 'closed', sessionUuid: 'resume-me', name: 'A long and particular name' }))
    const children = [...band.el.querySelector('.ws-dock-body')!.children].map(child => child.className)
    expect(children).toEqual(['ws-band-head', 'ws-worker-acts', 'ws-band-drawer', 'kbn-ctl-foot ws-band-status'])
    expect(band.el.querySelector('.ws-band-head')!.contains(band.head)).toBe(true)
    expect(band.head.querySelector(':scope > .kbn-ctl-verdict')).not.toBeNull()
    expect(band.head.dataset.verdictKey).toBeTruthy()
    expect(band.head.dataset.column).toBe('awaitingReview')
    expect(band.el.querySelector('.ws-band-title')?.textContent).toBe('A long and particular name')
    expect(band.el.querySelector('textarea:not(.ws-worker-message), [contenteditable]')).toBeNull()
    expect(visibleVerbs(band)).toEqual(['Resume', 'New session', 'Temper', 'Discard'])
    dock.syncRuntime(task({ status: 'active', workerState: 'running', sessionUuid: 'resume-me', tmuxSession: 't' }))
    expect(band.head.dataset.column).toBe('inFlight')
    expect(visibleVerbs(band)).toEqual(['Send', 'New session', 'Close for review'])
  })

  it('offers named, keyboard-focusable icons in order without sheets', () => {
    dock.reset(); dock = band = new Dock('', saved, undefined, undefined, { onRest: vi.fn() })
    dock.open(task({ status: 'active', sessionUuid: 's' }))
    band.setNav({ constitution: vi.fn() })
    document.body.append(band.el)
    const buttons = [...band.el.querySelectorAll<HTMLButtonElement>('.ws-band-head .ws-header-icon')].filter(button => !button.hidden)
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['Close for review (a)', 'Rest (s)', "Reopen task's last session on owner (c)", 'Constitution', 'Settings'])
    for (const button of buttons) {
      expect(button.title).toBe(button.getAttribute('aria-label'))
      expect(button.tabIndex).toBe(0)
      const svg = button.querySelector('svg')!
      expect(svg).not.toBeNull()
      expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
      expect(svg.getAttribute('stroke')).toBe('currentColor')
      expect(svg.getAttribute('stroke-width')).toBe('1.5')
      expect(svg.getAttribute('fill')).toBe('none')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('focusable')).toBe('false')
      expect(svg.querySelector('path, rect, circle')).not.toBeNull()
      expect(button.textContent).toBe('')
      button.focus(); expect(document.activeElement).toBe(button)
    }
    expect(band.head.querySelector('details, summary, [role="dialog"]')).toBeNull()
  })

  it.each([
    { phone: true, sessionLink: undefined, visible: false },
    { phone: true, sessionLink: 'https://claude.ai/code/session_abc', visible: true },
    { phone: false, sessionLink: undefined, visible: true },
  ])('opens the conversation only with an actionable destination: %j', ({ phone, sessionLink, visible }) => {
    vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const openWorker = vi.fn()
    dock.reset(); dock = band = new Dock('', saved, undefined, openWorker)
    const worker = task({ tmuxSession: 'terminal-worker', workerState: 'running', sessionLink })
    dock.open(worker)
    document.body.append(band.el)
    expect(dock.canOpenConversation(worker)).toBe(visible)
    expect(band.el.querySelector<HTMLElement>('.ws-band-console')!.hidden).toBe(!visible)
    if (!phone) {
      expect(dock.openConversation(worker)).toBe(true)
      expect(openWorker).toHaveBeenCalledWith('terminal-worker', 'owner', undefined)
    } else if (!visible) {
      expect(dock.openConversation(worker)).toBe(false)
      expect(openWorker).not.toHaveBeenCalled()
    }
  })

  it('anchors Rest confirmation to its own button and leaves focus in the confirmation', () => {
    const confirm = document.createElement('button'); document.body.append(confirm)
    const rest = vi.fn(() => confirm.focus())
    dock.reset(); dock = band = new Dock('', saved, undefined, undefined, { onRest: rest })
    dock.open(task({ status: 'active' })); document.body.append(band.el)
    const button = band.head.querySelector<HTMLButtonElement>('.kbn-ctl-rest')!
    button.click()
    expect(rest).toHaveBeenCalledWith(expect.objectContaining({ id: 'a/task' }), button)
    expect(document.activeElement).toBe(confirm)
  })

  it.each([['open', 'open'], ['closed', 'closed']])('offers no verdicts on a %s fiber without a shuttle block', (_label, status) => {
    // A note or a role opened from a link is not on the Desk's lifecycle.
    dock.open(card({ id: 'roles/surveyor', uid: 'surveyor', status }))
    expect(band.head.querySelector<HTMLElement>('.kbn-ctl-verdict')?.hidden).toBe(true)
  })
})

describe('band settings', () => {
  it('opens configuration and sessions together, and Escape folds it', () => {
    dock.reset()
    dock.open(task({ status: 'active', workerState: 'running', sessionUuid: 's' }))
    const drawer = band.el.querySelector<HTMLElement>('.ws-band-drawer')!
    expect(drawer.hidden).toBe(true)
    band.el.querySelector<HTMLButtonElement>('.ws-band-settings')!.click()
    expect(drawer.hidden).toBe(false)
    expect(drawer.querySelector<HTMLElement>('.kbn-ctl-ledger')!.hidden).toBe(false)
    expect(band.handleEscape()).toBe(true)
    expect(drawer.hidden).toBe(true)
    expect(band.handleEscape()).toBe(false)
  })

  it('hands its one sheet to the reader', () => {
    dock.reset()
    dock.open(task({ status: 'active', sessionUuid: 's', outcome: 'Seed 3000 agrees.' }))
    const settings = vi.fn(); band.openSettings = settings
    const opener = band.el.querySelector<HTMLButtonElement>('.ws-band-settings')!
    opener.click()
    expect(settings).toHaveBeenCalledWith(band.el.querySelector('.ws-band-drawer'), opener)
    expect(band.el.querySelector('.ws-band-drawer .kbn-ctl-history')).not.toBeNull()
  })

  it('follows the highlighted thread: its gear opens that thread\'s settings and writes to it', async () => {
    const page = task(), thread = task({ id: 'a/task/thread', uid: 'thread', name: 'The thread', shuttleAgent: 'codex-luna', shuttleEffort: 'low' })
    dock.reset(); dock.open(page); dock.setActionCard(thread)
    const gear = band.el.querySelector<HTMLButtonElement>('.ws-band-settings')!
    expect(gear.getAttribute('aria-label')).toBe('Settings thread')
    gear.click(); await settle()
    const name = band.el.querySelector<HTMLElement>('.ws-band-sheet-name')!
    expect(name.hidden).toBe(false)
    expect(name.textContent).toBe('The thread')
    expect(band.el.querySelector('.ws-band-drawer')!.hasAttribute('data-thread')).toBe(true)
    expect(select('Agent').value).toBe('codex-luna')
    vi.mocked(fetch).mockClear()
    change('Effort', 'high'); await settle()
    expect(writes()).toEqual([{ action: 'set-agent', origin: 'owner', fiber: 'a/task/thread', effort: 'high' }])
    dock.setActionCard(page)
    expect(gear.getAttribute('aria-label')).toBe('Settings')
    gear.click(); await settle()
    expect(name.hidden).toBe(true)
    expect(band.el.querySelector('.ws-band-drawer')!.hasAttribute('data-thread')).toBe(false)
    expect(select('Agent').value).toBe('codex-sol')
  })

  it('keeps the thread\'s ancestry in settings', () => {
    dock.reset()
    dock.open(task({ status: 'active', sessionUuid: 's' }))
    const chair = vi.fn()
    band.setNav({ ancestry: [{ name: 'Chair', open: chair }, { name: 'Validation', open: vi.fn() }] })
    const trail = band.el.querySelector<HTMLElement>('.ws-band-drawer .ws-settings-ancestry')!
    expect(trail.hidden).toBe(false)
    expect(trail.textContent).toBe('Chair/Validation')
    trail.querySelector<HTMLButtonElement>('.ws-ancestry-link')!.click()
    expect(chair).toHaveBeenCalled()
    band.setNav({})
    expect(trail.hidden).toBe(true)
  })

  it('reads current session history for each card it opens, and on every unfold', async () => {
    let session = 'a-first-session'
    vi.mocked(fetch).mockImplementation(async input => {
      const url = String(input)
      if (url.endsWith('/agents')) return response(agents)
      if (url.includes('/sessions/composite')) {
        const uid = new URL(url, 'http://test.invalid').searchParams.get('uid')!
        return response({ records: [{ at: 1, fiber: uid, uid, session: uid === 'task-uid' ? session : 'b-session', host: 'owner', harness: 'codex', kind: 'dispatch' }] })
      }
      return response()
    })
    const slot = document.createElement('div'); document.body.append(slot)
    band.openSettings = drawer => { drawer.hidden = false; slot.replaceChildren(drawer) }
    const open = (): void => band.el.querySelector<HTMLButtonElement>('.ws-band-settings')!.click()
    const rows = (): string[] => [...slot.querySelectorAll<HTMLElement>('[data-session]')].map(row => row.dataset.session!)
    open(); await settle()
    expect(rows()).toEqual(['a-first-session'])
    dock.open(task({ id: 'b/task', uid: 'other-uid' }))
    open(); await settle()
    expect(rows()).toEqual(['b-session'])
    session = 'a-next-session'
    dock.open(task({ sessionUuid: session }))
    open(); await settle()
    expect(rows()).toEqual(['a-next-session'])
    const fold = (): HTMLButtonElement => slot.querySelector('.kbn-ctl-history-toggle')!
    fold().click()
    expect(fold().getAttribute('aria-expanded')).toBe('false')
    session = 'a-latest-session'
    fold().click(); await settle()
    expect(fold().getAttribute('aria-expanded')).toBe('true')
    expect(rows()).toEqual(['a-latest-session'])
  })
})

describe('shared verdict controls', () => {
  it('uses the same lifecycle callback from both verdict buttons of the band', async () => {
    const transition = vi.fn()
    const band = new Dock('', saved, transition)
    band.open(task({ status: 'closed' }))
    document.body.append(band.el)
    expect(band.el.dataset.part).toBe('act'); expect(band.el.dataset.act).toBe('band')
    expect(band.head.dataset.part).toBe('act'); expect(band.head.dataset.act).toBe('verdict')
    band.head.querySelector<HTMLButtonElement>('.kbn-ctl-temper')!.click()
    band.head.querySelector<HTMLButtonElement>('.kbn-ctl-discard')!.click()
    expect(transition.mock.calls.map(([card, target]) => [card.uid, target])).toEqual([
      ['task-uid', 'tempered'], ['task-uid', 'composted'],
    ])
    band.reset()
    await settle()
  })

  it('Close for review moves the card to Awaiting review and nothing else', async () => {
    const transition = vi.fn()
    const band = new Dock('', saved, transition)
    band.open(task({ status: 'active', sessionUuid: 'review' }))
    document.body.append(band.el)
    band.head.querySelector<HTMLButtonElement>('.kbn-ctl-review')!.click()
    expect(transition.mock.calls.map(([card, target]) => [card.uid, target])).toEqual([['task-uid', 'awaitingReview']])
    band.reset()
    await settle()
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
})

describe('opening the conversation by key', () => {
  const posts = (): [string, unknown][] => vi.mocked(fetch).mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url, init]) => [String(url), JSON.parse(String(init!.body))])

  it.each<[string, Partial<KanbanCard>]>([
    ['resting', { status: 'open', effectiveHorizon: 'stashed' }],
    ['awaiting review', { status: 'closed' }],
    ['tempered', { status: 'closed', tempered: true }],
    ['discarded', { status: 'closed', tempered: false }],
  ])('reopens a %s card\'s past session with no dispatch', async (_, state) => {
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockImplementation(async () => response({ attached: true }))
    const keys = new Dock('', saved, undefined, vi.fn())
    expect(keys.openConversation(task({ ...state, sessionUuid: 'past' }))).toBe(true)
    await settle()
    expect(posts()).toEqual([['/api/v1/attach', { session: 'past', shuttle_host: 'owner' }]])
  })

  it('reopens over a dead session\'s link, but keeps a link the human chose', async () => {
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockImplementation(async () => response({ attached: true }))
    const keys = new Dock('', saved, undefined, vi.fn())
    const card = task({ status: 'closed', sessionUuid: 'past', sessionLink: 'https://claude.ai/code/session_abc' })
    keys.openConversation(card)
    await settle()
    expect(posts()).toHaveLength(1)
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === CLAUDE_OPENING_KEY ? 'browser' : null })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    keys.openConversation(card)
    await settle()
    expect(posts()).toHaveLength(1)
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
    vi.unstubAllGlobals()
  })

  it('says a refused reopening', async () => {
    vi.mocked(fetch).mockImplementation(async () => response({ error: 'no transcript for past on this host' }, 422))
    new Dock('', saved, undefined, vi.fn()).openConversation(task({ status: 'closed', sessionUuid: 'past' }))
    await settle()
    expect(document.body.textContent).toContain('no transcript for past on this host')
  })

  it('opens a live worker and never starts a card that has not run', async () => {
    vi.mocked(fetch).mockClear()
    const open = vi.fn()
    const keys = new Dock('', saved, undefined, open)
    expect(keys.openConversation(task({ status: 'active', sessionUuid: 'past', tmuxSession: 'worker-1', workerState: 'running' }))).toBe(true)
    expect(open).toHaveBeenCalledWith('worker-1', 'owner', 'past')
    expect(keys.openConversation(task({ status: 'open' }))).toBe(false)
    await settle()
    expect(posts()).toEqual([])
  })
})

describe('session verbs', () => {
  const opened = () => new Dock('', saved, undefined, openWorker)
  const openWorker = vi.fn()
  beforeEach(() => { openWorker.mockClear(); dock.reset(); dock = band = opened() })

  it('sends pasted images with the line, which grows and keeps Shift+Enter as a break', async () => {
    URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`)
    URL.revokeObjectURL = vi.fn()
    dock.open(task({ sessionUuid: 'prior' }))
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({ dispatched: true }))
    const field = band.el.querySelector<HTMLTextAreaElement>('textarea.ws-worker-message')!
    const shift = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true })
    field.dispatchEvent(shift)
    expect(shift.defaultPrevented).toBe(false)
    const paste = (files: File[], types: string[]): Event => {
      const event = new Event('paste', { cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { files, types } })
      field.dispatchEvent(event)
      return event
    }
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' })
    expect(paste([png], ['Files']).defaultPrevented).toBe(true)
    expect(paste([new File(['x'], 'a.svg', { type: 'image/svg+xml' })], ['Files']).defaultPrevented).toBe(true)
    expect(band.el.querySelectorAll('.ws-worker-image')).toHaveLength(1)
    expect(band.el.querySelector('.ws-worker-receipt')!.textContent).toBe('Only PNG, JPEG, GIF or WebP images')
    expect(paste([], ['text/plain']).defaultPrevented).toBe(false)
    field.value = 'look'; field.dispatchEvent(new Event('input'))
    session('Resume').click()
    await vi.waitFor(() => expect(band.el.querySelector('.ws-worker-receipt')!.textContent).toBe('Sent'))
    const dispatch = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/api/v1/dispatch'))!
    expect(JSON.parse(String(dispatch[1]!.body))).toMatchObject({ user_message: 'look', resume_mode: 'previous', images: [{ name: 'shot.png', data: 'iVBORw==' }] })
    expect(band.el.querySelectorAll('.ws-worker-image')).toHaveLength(0)
    expect(field.value).toBe('')
  })

  it.each([
    ['Start', {}, 'fresh'],
    ['New session', { sessionUuid: 'prior' }, 'fresh'],
    ['Resume', { sessionUuid: 'prior' }, 'previous'],
  ] as const)('%s dispatches with its resume mode and an empty message, then opens the worker', async (label, patch, mode) => {
    dock.open(task(patch))
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({ dispatched: true, tmux_session: 'worker' }))
    session(label).click()
    await settle()
    expect(writes()).toEqual([expect.objectContaining({ fiber_id: 'a/task', origin: 'owner', force: true, ad_hoc: true, resume_mode: mode, user_message: '' })])
    expect(writes()[0]).not.toHaveProperty('existing_only')
    expect(saved).toHaveBeenCalledOnce()
    expect(openWorker).toHaveBeenCalledWith('worker', 'owner')
  })

  it.each([
    ['Enter', { sessionUuid: 'prior' }, 'previous'],
    ['New session', { sessionUuid: 'prior' }, 'fresh'],
    ['Enter', {}, 'fresh'],
  ] as const)('%s carries the line as the opening message, then says it was sent', async (how, patch, mode) => {
    dock.open(task(patch))
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({ dispatched: true }))
    const field = band.el.querySelector<HTMLInputElement>('.ws-worker-message')!
    field.value = '  look at the cut first  '
    field.dispatchEvent(new Event('input'))
    if (how === 'Enter') field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    else session(how).click()
    await settle()
    expect(writes()).toEqual([expect.objectContaining({ fiber_id: 'a/task', resume_mode: mode, user_message: 'look at the cut first' })])
    expect(field.value).toBe('')
    expect(band.el.querySelector('.ws-worker-receipt')?.textContent).toBe('Sent')
  })

  it('types into a live worker only with something to say', async () => {
    dock.open(task({ status: 'active', workerState: 'running', sessionUuid: 'live', tmuxSession: 'worker' }))
    const field = band.el.querySelector<HTMLInputElement>('.ws-worker-message')!
    expect(session('Send').disabled).toBe(true)
    expect(field.placeholder).toBe('Message task')
    field.value = 'one more thing'
    field.dispatchEvent(new Event('input'))
    expect(session('Send').disabled).toBe(false)
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({ tmux_session: 'worker' }))
    session('Send').click()
    await settle()
    expect(writes()).toEqual([expect.objectContaining({ resume_mode: 'previous', user_message: 'one more thing' })])
  })

  it('serves a thread\'s worker from the same path, outside the band', async () => {
    dock.open(task())
    const thread = task({ id: 'a/task/thread', uid: 'thread-uid', name: 'Thread', sessionUuid: 'old' })
    const actions = dock.workerActionsFor(thread)
    document.body.append(actions.el)
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({}))
    const field = actions.el.querySelector<HTMLInputElement>('.ws-worker-message')!
    expect(field.placeholder).toBe('Resume thread with…')
    field.value = 'pick up the plots'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(writes()).toEqual([expect.objectContaining({ fiber_id: 'a/task/thread', resume_mode: 'previous', user_message: 'pick up the plots' })])
    actions.dispose()
  })

  it('leaves a started worker closed under a finger', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('coarse'), addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    dock.open(task())
    vi.mocked(fetch).mockResolvedValue(response({ tmux_session: 'worker' }))
    session('Start').click()
    await settle()
    expect(saved).toHaveBeenCalledOnce()
    expect(openWorker).not.toHaveBeenCalled()
  })

  it('opens the running worker a start finds', async () => {
    dock.open(task({ sessionUuid: 'prior' }))
    vi.mocked(fetch).mockResolvedValue(response({ tmux_session: 'busy-worker' }, 409))
    session('Resume').click()
    await settle()
    expect(openWorker).toHaveBeenCalledWith('busy-worker', 'owner')
    expect(saved).toHaveBeenCalledOnce()
  })

  it('names a sessionless conflict and gives the verbs back', async () => {
    dock.open(task({ sessionUuid: 'prior' }))
    vi.mocked(fetch).mockResolvedValue(response({}, 409))
    session('Resume').click()
    await settle()
    expect(band.el.querySelector('.kbn-detail-error')?.textContent).toBe('A worker is already running for this fiber.')
    expect(session('Resume').disabled).toBe(false)
    expect(openWorker).not.toHaveBeenCalled()
  })

  it('says the word while it works and holds every verb until it lands', async () => {
    dock.open(task({ effectiveHorizon: 'stashed', sessionUuid: 'previous-session' }))
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation(async () => pending.promise)
    const headerNew = session('New session'), headerResume = session('Resume')
    headerResume.click()
    expect(headerResume.querySelector('.ws-header-word')?.textContent).toBe('Resuming…')
    expect([headerNew.disabled, headerResume.disabled]).toEqual([true, true])
    pending.resolve(response())
    await settle()
    expect([headerNew.disabled, headerResume.disabled]).toEqual([false, false])
    expect(headerResume.querySelector('.ws-header-word')?.textContent).toBe('Resume')
  })

  it('asks before a new session cuts a live worker, and Resume never asks', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    dock.open(task({ status: 'active', workerState: 'running', sessionUuid: 'live', tmuxSession: 'worker' }))
    vi.mocked(fetch).mockClear()
    session('New session').click()
    await settle()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(writes()).toEqual([])
    confirm.mockReturnValue(true)
    session('New session').click()
    await settle()
    expect(writes()).toHaveLength(1)
    expect(writes()[0].resume_mode).toBe('fresh')
    confirm.mockRestore()
  })

  it('says when Shuttle did not answer', async () => {
    dock.open(task())
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connection reset'))
    session('Start').click()
    await settle()
    expect(band.el.querySelector('.kbn-detail-error')?.textContent).toContain('Shuttle did not answer (connection reset)')
    expect(session('Start').disabled).toBe(false)
  })

  it('drops a reply that lands after the band moved to another card', async () => {
    dock.open(task())
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementationOnce(async () => pending.promise)
    session('Start').click()
    dock.open(task({ id: 'b/task', uid: 'other-uid' }))
    expect(session('Start').disabled).toBe(false)
    pending.resolve(response({ reason: 'closed' }, 422))
    await settle()
    expect(band.el.querySelector('.kbn-detail-error')?.textContent).toBe('')
  })

  it.each(['New session', 'Resume'])('explains a 503 booting %s without retrying', async name => {
    dock.open(task({ sessionUuid: 'previous-session' }))
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({ error: 'booting', ready: false }, 503))
    session(name).click()
    await settle()
    expect(band.el.textContent).toContain('The daemon is starting. Nothing was launched; try again shortly.')
    expect(session(name).disabled).toBe(false)
    expect(writes()).toHaveLength(1)
    expect(saved).not.toHaveBeenCalled()
  })

  it('answers a refused start with the project-directory prompt, then retries with the confirmed directory', async () => {
    const REASON = 'This fiber has no project directory.'
    dock.open(task({ inheritedProjectDir: { path: '/srv/checkout', from: 'work' } }))
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValueOnce(response({ reason: 'arm_refused', needs: 'project_dir', host: 'owner', message: REASON }, 422))
      .mockResolvedValueOnce(response({ dispatched: true, tmux_session: 'worker' }))
    session('Start').click()
    await settle()
    expect(band.el.querySelector('.kbn-start-prompt-reason')?.textContent).toBe(`On owner: ${REASON}`)
    expect(band.el.querySelector<HTMLInputElement>('.kbn-start-prompt-input')?.value).toBe('/srv/checkout')
    expect(writes()[0]).not.toHaveProperty('project_dir')
    expect(saved).not.toHaveBeenCalled()
    band.el.querySelector<HTMLButtonElement>('.kbn-start-prompt .kbn-ctl-send')!.click()
    await settle()
    expect(writes()[1]).toMatchObject({ fiber_id: 'a/task', origin: 'owner', force: true, ad_hoc: true, resume_mode: 'fresh', user_message: '', project_dir: '/srv/checkout' })
    expect(saved).toHaveBeenCalledOnce()
    expect(openWorker).toHaveBeenCalledWith('worker', 'owner')
  })

  it('repairs a highlighted thread\'s refused start in the band, and clears its prompt on retargeting', async () => {
    const page = task(), thread = task({ id: 'a/task/thread', uid: 'thread', inheritedProjectDir: { path: '/srv/thread', from: 'work' } })
    dock.open(page); dock.setActionCard(thread)
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValueOnce(response({ reason: 'arm_refused', needs: 'project_dir', host: 'owner' }, 422))
      .mockResolvedValueOnce(response({ dispatched: true }))
    session('Start').click(); await settle()
    expect(band.el.querySelector<HTMLInputElement>('.kbn-start-prompt-input')?.value).toBe('/srv/thread')
    band.el.querySelector<HTMLButtonElement>('.kbn-start-prompt .kbn-ctl-send')!.click(); await settle()
    expect(writes()[1]).toMatchObject({ fiber_id: 'a/task/thread', project_dir: '/srv/thread' })
    dock.setActionCard(page)
    expect(band.el.querySelector('.kbn-start-prompt')).toBeNull()
  })

  it('shows any other refused start as its reason, with no prompt', async () => {
    const message = 'cannot arm: agent claude-retired is not in the registry (shuttle set-agent to pick a current one)'
    dock.open(task())
    vi.mocked(fetch).mockResolvedValueOnce(response({ reason: 'arm_refused', host: 'owner-host', message }, 422))
    session('Start').click()
    await settle()
    expect(band.el.querySelector('.kbn-start-prompt')).toBeNull()
    expect(band.el.querySelector('.kbn-detail-error')?.textContent).toBe(`On owner-host: ${message}`)
  })

  it('opens on a refused start with its prompt showing, retrying as a fresh start', async () => {
    const refused = { reason: 'arm_refused', needs: 'project_dir', host: 'owner', message: 'No directory' } as const
    dock.openStartPrompt(task({ inheritedProjectDir: { path: '/srv/checkout', from: 'work' } }), refused)
    expect(band.el.querySelector('.kbn-start-prompt-reason')?.textContent).toBe('On owner: No directory')
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValue(response({ tmux_session: 'worker' }))
    band.el.querySelector<HTMLButtonElement>('.kbn-start-prompt .kbn-ctl-send')!.click()
    await settle()
    expect(writes()[0]).toMatchObject({ resume_mode: 'fresh', project_dir: '/srv/checkout' })
  })

  it('offers the prompt again after a failed retry', async () => {
    dock.open(task({ sessionUuid: 'previous-session' }))
    vi.mocked(fetch).mockClear()
    vi.mocked(fetch).mockResolvedValueOnce(response({ reason: 'arm_refused', needs: 'project_dir', host: 'owner' }, 422))
      .mockResolvedValueOnce(response({ error: 'booting', ready: false }, 503))
    session('Resume').click()
    await settle()
    const dir = band.el.querySelector<HTMLInputElement>('.kbn-start-prompt-input')!
    dir.value = '/srv/project'; dir.dispatchEvent(new Event('input'))
    band.el.querySelector<HTMLButtonElement>('.kbn-start-prompt .kbn-ctl-send')!.click()
    await settle()
    expect(band.el.textContent).toContain('The daemon is starting. Nothing was launched; try again shortly.')
    expect(session('Resume').disabled).toBe(false)
    expect(session('New session').disabled).toBe(false)
    expect(writes()).toHaveLength(2)
    expect(writes()[1]).toMatchObject({ resume_mode: 'previous', user_message: '', project_dir: '/srv/project', origin: 'owner' })
    expect(saved).not.toHaveBeenCalled()
  })
})

describe('Dock settings queue', () => {
  it('serializes agent, shape and due writes and keeps the last selected values', async () => {
    // A standing card, so One-shot is a real shape write.
    dock.open(task({ id: 'a/standing', uid: 'standing-uid', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *', shuttleTz: 'UTC' }))
    await settle()
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
    await settle()
    expect(writes()).toHaveLength(1)
    for (let i = 0; i < 5; i++) {
      pending[i].resolve(response())
      await settle()
      expect(writes()).toHaveLength(Math.min(i + 2, 5))
    }
    expect(writes().map(write => write.effort ?? write.kind ?? write.due)).toEqual([
      'low', 'oneshot', 'high', '2026-10-15', '2026-10-16',
    ])
    expect(select('Effort').value).toBe('high')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('One-shot')
    expect(due.value).toBe('2026-10-16')
  })

  it('cancels unstarted writes when the band moves to another card', async () => {
    const first = deferred<Response>()
    vi.mocked(fetch).mockImplementation(async (url, options) => {
      if (String(url).endsWith('/agents')) return response(agents)
      return JSON.parse(String(options?.body)).fiber === 'a/task' ? first.promise : response()
    })
    change('Effort', 'low')
    change('Effort', 'high')
    await settle()
    expect(writes()).toHaveLength(1)
    dock.open(task({ id: 'a/other', uid: 'other-uid' }))
    await settle()
    change('Effort', 'high')
    await settle()
    expect(writes()).toHaveLength(2)
    expect(writes()[1]).toMatchObject({ fiber: 'a/other', effort: 'high' })
    first.resolve(response())
    await settle()
    expect(writes()).toHaveLength(2)
    expect(writes().some(write => write.fiber === 'a/task' && write.effort === 'high')).toBe(false)
  })

  it('queues a rapid agent reversal and does not roll back newer intent when an earlier write fails', async () => {
    const first = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(first.promise).mockResolvedValue(response())
    change('Agent', 'codex-luna')
    change('Agent', 'codex-sol')
    await settle()
    expect(writes()).toHaveLength(1)
    first.resolve(response({ error: 'refused' }, 422))
    await settle()
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
    await settle()
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
    await settle()
    expect(dropdown.childElementCount).toBe(1)
    expect([dropdown.dataset.side, dropdown.style.top]).toEqual(['below', '724px'])
    search.value = ''; search.dispatchEvent(new Event('focus'))
    await settle()
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
      await settle()
      const option = [...band.el.querySelectorAll<HTMLButtonElement>('.kbn-detail-parent-option')]
        .find(option => option.querySelector('.kbn-detail-parent-option-id')?.textContent === id)!
      option.click()
    }
    await pick('a/b')
    const due = band.el.querySelector<HTMLInputElement>('input[type="date"]')!
    due.value = '2026-10-16'; due.dispatchEvent(new Event('change'))
    await pick('a')
    await settle()
    expect(writes()).toHaveLength(1)
    first.resolve(response())
    await settle()
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
    select('Effort').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    change('Effort', 'low')
    select('Effort').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    change('Effort', 'high')
    expect(writes()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes().at(-1)).toEqual({ action: 'set-agent', origin: 'owner', fiber: 'a/task', effort: 'high' })
    // Through a staged Standing and back: an abandoned promotion writes nothing.
    step('Kind', 'ArrowLeft'); step('Kind', 'ArrowRight')
    expect(writes()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(writes()).toHaveLength(1)
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
    // The session list waits in the band's drawer, opened from Settings.
    expect(toggle().closest('.ws-band-drawer')).not.toBeNull()
    toggle().focus(); toggle().click()
    await settle()
    expect(historyReads()).toBe(1)
    expect(band.el.querySelectorAll('.kbn-ctl-session')).toHaveLength(1)
    toggle().click()
    sessions.push('new-session')
    toggle().focus(); toggle().click()
    await settle()
    expect(historyReads()).toBe(2)
    expect(document.activeElement).toBe(toggle())
    expect(band.el.querySelectorAll('.kbn-ctl-session')).toHaveLength(2)
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker-one' }))
    await settle()
    expect(historyReads()).toBe(3)
    const row = (): HTMLElement => band.el.querySelector('[data-session="new-session"]')!
    expect(row().textContent).toContain('attach')
    row().querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    expect(writes().at(-1)).toEqual({ tmux_session: 'worker-one', session: 'new-session', shuttle_host: 'owner' })
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker-two' }))
    await settle()
    expect(historyReads()).toBe(4)
    row().querySelector<HTMLButtonElement>('button')!.click()
    await settle()
    expect(writes().at(-1)).toEqual({ tmux_session: 'worker-two', session: 'new-session', shuttle_host: 'owner' })
    dock.syncRuntime(task({ workerState: 'running', sessionUuid: 'new-session', tmuxSession: 'worker-two' }))
    expect(historyReads()).toBe(4)
    toggle().click()
    dock.syncRuntime(task({ workerState: undefined, sessionUuid: 'new-session', tmuxSession: undefined }))
    expect(historyReads()).toBe(4)
  })
})

describe('Dock poll reconciliation', () => {
  it('re-seeds settings from polls and writes only the edited agent axis', async () => {
    dock.syncRuntime(task({ id: 'b/task', shuttleAgent: 'codex-luna', shuttleEffort: 'low',
      shuttleKind: 'standing', shuttleSchedule: '0 9 * * *', shuttleTz: 'UTC', due: '2026-10-12' }))
    expect(select('Agent').value).toBe('codex-luna')
    expect(select('Effort').value).toBe('low')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('Standing')
    expect(band.el.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe('2026-10-12')
    expect(band.el.querySelector('.kbn-ctl-parent')?.textContent).toBe('b')
    expect(band.el.querySelector('.kbn-ctl-strip')?.textContent).toContain('codex-luna')
    change('Effort', 'high')
    await settle()
    expect(writes()).toEqual([{ action: 'set-agent', origin: 'owner', fiber: 'b/task', effort: 'high' }])
    button('One-shot').click()
    await settle()
    expect(writes().at(-1)).toEqual({ action: 'reshape', origin: 'owner', fiber: 'b/task', kind: 'oneshot' })
  })

  it('preserves focused settings until a later unfocused poll', async () => {
    const cron = band.el.querySelector<HTMLInputElement>('[aria-label="Cron"]')!
    button('Standing').click()
    cron.value = 'my half typed expression'
    dock.syncRuntime(task({ shuttleAgent: 'codex-luna', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *' }))
    expect(cron.value).toBe('my half typed expression')
    expect(select('Agent').value).toBe('codex-sol')
    band.el.querySelector<HTMLButtonElement>('.ws-band-settings')!.focus()
    await settle()
    dock.syncRuntime(task({ shuttleAgent: 'codex-luna', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *' }))
    expect(select('Agent').value).toBe('codex-luna')
    expect(band.el.querySelector('[aria-label="Kind"] [aria-checked="true"]')?.textContent).toBe('Standing')
  })
})

describe('Settings says who and where once', () => {
  it('names agent, office and host, leaving out an office that repeats the name', () => {
    expect(bandFacts(card({ id: 'x', name: 'cmbx chair', shuttleRole: 'cmbx-chair', shuttleAgent: 'claude-opus', shuttleHost: 'cineca' }))).toBe('claude-opus · cineca')
    expect(bandFacts(card({ id: 'x', name: 'Noise closure', shuttleRole: 'data-expert', shuttleAgent: 'codex-sol', shuttleHost: 'cineca' }))).toBe('codex-sol · data-expert · cineca')
  })
})

describe('pulse cadence in the workspace strip', () => {
  it('shows the configured window and owner-computed next tick', () => {
    const facts = stripFacts(card({
      id: 'x',
      shuttlePulse: { every: '59m', window: { start: '08:00', end: '20:00', tz: 'Europe/Paris' } },
      shuttlePulseRuntime: { nextTick: '2026-11-02T12:31:00Z', lastTick: '2026-11-02T11:32:00Z', state: 'scheduled' },
    }))
    expect(facts.cadence?.text).toContain('every 59m · 08:00–20:00 Europe/Paris · next')
    expect(facts.cadence?.title).toContain('last tick')
  })

  it('shows paused state without inventing a next tick', () => {
    const facts = stripFacts(card({
      id: 'x', shuttlePulse: { every: '59m' },
      shuttlePulseRuntime: { state: 'paused' },
    }))
    expect(facts.cadence?.text).toBe('every 59m · paused')
  })
})

describe('session usage', () => {
  const id = '11111111-2222-3333-4444-555555555555'
  const resting = (patch: Partial<KanbanCard> = {}): KanbanCard => task({ status: 'closed', sessionUuid: id, shuttleAgent: 'claude-opus', shuttleHost: 'candide', ...patch })
  const part = (name: string): HTMLElement => band.el.querySelector<HTMLElement>(`[data-part="${name}"]`)!
  const usageReads = (): string[] => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter(url => url.includes('/transcript/usage'))
  const answering = (usage: (url: string) => object | null): void => {
    vi.mocked(fetch).mockImplementation(async input => {
      if (!String(input).includes('/transcript/usage')) return response()
      const body = usage(String(input))
      return body ? response(body) : response({ availability: 'transcript_missing' }, 404)
    })
  }

  beforeEach(() => {
    dock.reset()
    vi.mocked(fetch).mockClear()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.parse('2026-10-09T20:00:00Z') })
  })

  const left = (): number => Number(part('cache').style.getPropertyValue('--ws-cache-left'))

  it('draws the figure and the cache dot beside the title, with no live worker', async () => {
    const until = Date.parse('2026-10-09T20:30:00Z')
    answering(() => ({ context: 182_340, cache_warm_until: until, cache_ttl: 3_600_000, hit_share: 0.94 }))
    dock.open(resting())
    await settle()
    const said = `warm until ${clockTime(until)}`
    expect(part('context').textContent).toBe('182k')
    expect(part('context').title).toBe('Context: 182,340 tokens of a 1,000,000-token window (18% full)')
    expect(part('context').style.color).toBe('color-mix(in oklch, var(--kbn-alarm) 18%, var(--kbn-tempered))')
    expect(part('context-meter').previousElementSibling).toBe(part('fiber-title'))
    expect(part('cache').dataset.cache).toBe('warm')
    expect(part('cache').textContent).toBe('')
    expect(left()).toBe(0.5)
    expect(part('cache').title).toBe(`Cache ${said} (estimated from Claude cache usage)`)
    expect(session('Resume').title).toBe(`Resume a/task (Enter) · cache ${said}`)
    expect(band.el.querySelector('.ws-header-facts')!.textContent).toContain('94% cached')
    expect(usageReads()).toEqual([`/api/v1/transcript/usage?session=${id}&host=candide`])
  })

  it('follows a highlighted thread: its name after the band\'s, its figures and its cache', async () => {
    const thread = '99999999-2222-3333-4444-555555555555'
    answering(url => ({ context: url.includes(thread) ? 40_000 : 182_340 }))
    const root = resting({ name: 'Unions' })
    dock.open(root)
    await settle()
    expect(part('context').textContent).toBe('182k')
    dock.setActionCard(task({ id: 'a/task/sub', uid: 'sub', name: 'Sub', status: 'closed', sessionUuid: thread, shuttleHost: 'cineca' }))
    await settle()
    expect(part('fiber-title').textContent).toBe('Unions / Sub')
    expect(part('context').textContent).toBe('40k')
    expect(usageReads().at(-1)).toBe(`/api/v1/transcript/usage?session=${thread}&host=cineca`)
    dock.setActionCard(root)
    await settle()
    expect(part('fiber-title').textContent).toBe('Unions')
    expect(part('context').textContent).toBe('182k')
  })

  it('reads a recorded window against the figure', async () => {
    answering(() => ({ context: 129_500, window: 259_000 }))
    dock.open(resting({ shuttleAgent: 'codex-sol' }))
    await settle()
    expect(part('context').title).toBe('Context: 129,500 tokens of a 259,000-token window (50% full)')
    expect(part('cache').hidden).toBe(true)
  })

  it('shows nothing of an unavailable read and asks nothing without a session', async () => {
    answering(() => null)
    dock.open(resting())
    await settle()
    expect(usageReads()).toHaveLength(1)
    expect(part('context-meter').hidden).toBe(true)
    expect(session('Resume').title).not.toContain('cache')
    expect(band.el.querySelector('.ws-header-facts')!.textContent).not.toContain('cached')
    dock.reset()
    dock.open(resting({ sessionUuid: undefined }))
    await settle()
    expect(usageReads()).toHaveLength(1)
  })

  it('keeps the figure and draws a cold ring once the estimate has passed', async () => {
    const until = Date.now() - 1
    answering(() => ({ context: 900, cache_warm_until: until }))
    dock.open(resting())
    await settle()
    expect(part('context').textContent).toBe('900')
    expect(part('cache').dataset.cache).toBe('cold')
    expect(left()).toBe(0)
    expect(part('cache').getAttribute('aria-label')).toBe(`Cache cold since ${clockTime(until)}`)
    expect(session('Resume').title).not.toContain('cache')
  })

  it('drains the dot to the cold ring without another answer', async () => {
    vi.mocked(fetch).mockClear()
    let up = true
    vi.mocked(fetch).mockImplementation(async input => {
      if (!String(input).includes('/transcript/usage')) return response()
      if (!up) throw new Error('offline')
      return response({ context: 1000, cache_warm_until: Date.now() + 300_000, cache_ttl: 300_000 })
    })
    dock.open(resting())
    await settle()
    expect(left()).toBe(1)
    up = false
    vi.advanceTimersByTime(150_000)
    await settle()
    expect(left()).toBe(0.5)
    expect(part('context').textContent).toBe('1k')
    vi.advanceTimersByTime(150_000)
    await settle()
    expect(part('cache').dataset.cache).toBe('cold')
    expect(part('context').textContent).toBe('1k')
  })

  it('refreshes every fifteen seconds while visible, on a new session, and never after clearing', async () => {
    answering(url => ({ context: url.includes(id) ? 1000 : 2000 }))
    dock.open(resting())
    await settle()
    expect(part('context').textContent).toBe('1k')
    vi.advanceTimersByTime(14_999)
    expect(usageReads()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(usageReads()).toHaveLength(2)
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    vi.advanceTimersByTime(30_000)
    expect(usageReads()).toHaveLength(2)
    hidden.mockRestore()

    dock.syncRuntime(resting({ sessionUuid: 'aaaaaaaa-2222-3333-4444-555555555555' }))
    expect(part('context').hidden).toBe(true)
    expect(usageReads()).toHaveLength(3)
    await settle()
    expect(part('context').textContent).toBe('2k')

    dock.reset()
    vi.advanceTimersByTime(90_000)
    expect(usageReads()).toHaveLength(3)
  })

  it('drops a read that outlives its session', async () => {
    const answer = deferred<Response>()
    vi.mocked(fetch).mockImplementation(() => answer.promise)
    dock.open(resting())
    dock.syncRuntime(resting({ sessionUuid: undefined }))
    answer.resolve(response({ context: 1000 }))
    await settle()
    expect(part('context').hidden).toBe(true)
  })
})
