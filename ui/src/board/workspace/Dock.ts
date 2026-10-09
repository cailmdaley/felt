import { workerVariant, appConversationTarget, canOpenDesktopApp, appWorkerLink, atDesktop, terminalWorkerPill } from '../appConversation.js'
import { confirmWorkerStop, markVerdictHost, type Verdict } from './Verdicts.js'
import { CONVERSATION_OPENING_CHANGED } from '../conversationOpening.js'
import { hasLiveWorker, hasWorkerToStop, type ColumnKind, type KanbanCard, type ShuttleKind } from '../KanbanTypes.js'
import { agentGroups } from '../../forms/agents.js'
import { MEETING_MODES, type MeetingMode } from '../../forms/meetingApi.js'
import { meetingActions, meetingHostCard, meetingStateWord, paintTranscript, type MeetingRecord } from '../meeting.js'
import { defaultSurface, isCodexAgent, persistedSurface, type ExecutionSurface } from '../../forms/executionSurface.js'
import { dispatchFailureMessage, isAgentCard, needsProjectDir, postDaemonJson, postForceDispatch, type DispatchFailureBody } from '../KanbanModalShared.js'
import { buildProjectDirPrompt } from '../projectDirPrompt.js'
import { fetchFiberIndex, filterParentCandidates, type FiberSearchResult } from '../fiberSearch.js'
import { buildSessionHistory } from '../sessionHistory.js'
import { TranscriptBand, type TranscriptTarget } from '../transcript/TranscriptBand.js'
import { coarsePointer } from '../mobile.js'
import { humanizeCron } from '../KanbanRules.js'
import { formatDue } from '../KanbanSurfaces.js'
import { dueCivilDay, formatSpanMinutes, instantMs, isoDayLocal } from '../civilDay.js'
import { PastedImages, buildImageStrip, composeDirective, filesFromTransfer, pastedImageFiles, transferHasFiles, uploadPastedImages } from '../pastedImages.js'
import { fiberPageColumn, verdictReachable } from './fiberPageState.js'
import { workerPlate } from './workerPlate.js'
import { anchorPopover, type Release } from './anchoredPopover.js'
import { anchorSelect, dismissSelectPicker } from './selectPicker.js'
import './tokens.css'
import './dock.css'

type Directive = string | (() => Promise<string>)
interface AgentAxes { agent: string; effort: string; chrome: boolean; surface: ExecutionSurface }
interface ComposerSend {
  draftKey(): string
  compose(unlessUnchanged?: string): Promise<string>
  busy(): boolean
  setBusy(on: boolean, except?: HTMLButtonElement): void
  sent(): void
}
function workerIdentity(card: KanbanCard): string {
  return JSON.stringify([card.workerState, card.workerSurface, card.sessionUuid, card.tmuxSession, card.runtimePhase])
}
function latestTarget(card: KanbanCard): TranscriptTarget | null {
  return card.sessionUuid ? {
    session: card.sessionUuid,
    host: card.shuttleHost,
    agent: card.workerAgent ?? card.shuttleAgent,
    live: hasLiveWorker(card),
    at: instantMs(card.dispatchedAt),
  } : null
}

function clockTime(ms: number): string {
  // 24-hour regardless of locale: the line is a mono strip where two times sit
  // side by side, and `11:59 AM · 03:35 PM` is both wider and harder to subtract
  // than `11:59 · 15:35`. The full localized stamp is on the hover.
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** A calendar day in front of a clock time — `Aug 4 12:01`. Used only when the
 *  bare time would lie about which day it names. */
function dayStamp(ms: number): string {
  const day = new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${day} ${clockTime(ms)}`
}

/** How a meeting join ended: the error to show beside the control (null once
 *  recording began), and whether the constitution's worker received it. */
export interface MeetingJoinResult {
  error: string | null
  delivered: boolean
}

/** The board's meeting control, lent to the dock. */
export interface MeetingJoinControl {
  /** hark is available on this machine and nothing is recording. */
  canJoin(): boolean
  /** Record a meeting and join it to the card's constitution with the note
   *  `note` resolves to — it may upload images first, and rejects with their
   *  failure. Called inside the pick's gesture; Phone opens audio before
   *  awaiting `note`. Resolves to the error to show (null once recording
   *  began) and whether the worker received the meeting. */
  join(card: KanbanCard, mode: MeetingMode, note: () => Promise<string>): Promise<MeetingJoinResult>
  /** The meeting the board last observed, if any. */
  current(): MeetingRecord | null
  /** Stop (or dismiss, once failed) the recording: the board's one stop path. */
  stop?(meeting: MeetingRecord): void | Promise<void>
  /** Whether a stop for `meeting` has been asked and not yet observed. */
  stopRequested?(meeting: MeetingRecord): boolean
}

export interface SessionWindow {
  text: string
  /** `clean`: the run ended on the worker's own handoff stamp (the verdigris
   *  ✓). `unclean`: it stopped without one. `running`: a worker is still up. */
  state: 'running' | 'clean' | 'unclean'
  /** Full localized instants for the hover. */
  title: string
}

/**
 * The session window: when the last worker launched, when it handed off, and
 * how long it held the fiber — the right-hand reading on the settings strip.
 *
 *   14:02 → 17:38 · 3h 36m            — a clean, concluded run (✓ beside it)
 *   Aug 4 14:02 → 17:38 · 3h 36m      — the same run, days ago
 *   since 14:02                       — a worker still running
 *   14:02 · no handoff                — it stopped without stamping one
 *
 * A DAY appears in front of a time exactly when the bare time would mislead:
 * on the dispatch when the run didn't start today, and on the handoff when it
 * concluded on a later day than it started (a run over midnight). Otherwise the
 * times stand alone — most runs are today's, and "Aug 8" on every one of them
 * would be noise you learn to skip, which is how the one that matters gets
 * skipped too.
 *
 * Both instants ride the composite feed inside felt's `shuttle` map
 * (`shuttle.runtime.dispatched_at` / `handed_off_at`), so this needs nothing
 * from the daemon. Returns null with no `dispatched_at` — a fiber that has
 * never run has no window to show.
 *
 * A `handed_off_at` EARLIER than `dispatched_at` is the previous run's stamp,
 * not this one's (the daemon's own `last_serviced` guard turns on the same
 * comparison). Reading it as this run's handoff would print a negative
 * duration and a ✓ on a run that never finished, so it reads as no handoff.
 *
 * Pure, and exported for the tests: everything here is a formatting decision
 * over two instants and the clock.
 */
export function sessionWindow(
  card: Pick<KanbanCard, 'dispatchedAt' | 'handedOffAt' | 'workerState'>,
  nowMs: number = Date.now(),
): SessionWindow | null {
  const dispatched = instantMs(card.dispatchedAt)
  if (dispatched === undefined) return null
  const handedOff = instantMs(card.handedOffAt)
  const concluded = handedOff !== undefined && handedOff >= dispatched

  const startedToday = isoDayLocal(dispatched) === isoDayLocal(nowMs)
  const start = startedToday ? clockTime(dispatched) : dayStamp(dispatched)

  if (hasLiveWorker(card)) {
    return {
      text: `since ${start}`,
      state: 'running',
      title: `Worker launched ${new Date(dispatched).toLocaleString()} and is still running.`,
    }
  }
  if (concluded && handedOff !== undefined) {
    const spannedMidnight = isoDayLocal(handedOff) !== isoDayLocal(dispatched)
    const end = spannedMidnight ? dayStamp(handedOff) : clockTime(handedOff)
    // Sub-minute runs read `0m` rather than seconds: the pair of clock times
    // already tells that story, and this figure is for scale.
    const span = formatSpanMinutes(Math.max(0, Math.round((handedOff - dispatched) / 60_000)))
    return {
      text: `${start} → ${end} · ${span}`,
      state: 'clean',
      title:
        `Launched ${new Date(dispatched).toLocaleString()}; ` +
        `handed off ${new Date(handedOff).toLocaleString()}.`,
    }
  }
  return {
    text: `${start} · no handoff`,
    state: 'unclean',
    title:
      `Launched ${new Date(dispatched).toLocaleString()}. The worker never stamped a ` +
      'handoff for this run — it was killed, crashed, or is still being reconciled.',
  }
}

/**
 * Whether the board places this card by its `due:` day. A standing
 * constitution is placed by its cron and is never sorted by due, so it
 * neither shows nor edits one.
 */
function placedByDue(card: Pick<KanbanCard, 'shuttleKind'>): boolean {
  return card.shuttleKind !== 'standing'
}

/**
 * What the folded settings strip says about a card, as data — the strip is a
 * reading of the fiber, not a label for the controls under it.
 *
 *   claude-fable medium · weekdays 9:00 · ada-workstation:~/dev/felt   Sep 26 01:38 → 02:40 · 1h 2m ✓
 *
 * `actor` is the agent id (cobalt) on a shuttle card and `me` (cinnabar) on a
 * human one, the same word the board card prints. `seat` names the role a
 * seat belongs to (`seat of vizier`). `cadence` is said only when
 * it isn't the default: a standing constitution speaks its cron, a one-shot
 * says nothing. `place` is `host:dir` with the home directory
 * folded to `~`. `due` is dropped where the board never reads it
 * ({@link placedByDue}).
 */
export interface StripFacts {
  actor: { text: string; agent: boolean }
  effort?: string
  chrome: boolean
  seat?: { text: string; title: string }
  cadence?: { text: string; title?: string }
  place?: { text: string; title: string }
  due?: string
  run: SessionWindow | null
}

export function stripFacts(card: KanbanCard, nowMs: number = Date.now()): StripFacts {
  const agent = isAgentCard(card)
  let cadence: StripFacts['cadence']
  if (card.shuttleKind === 'standing' && card.shuttleSchedule) {
    const spoken = humanizeCron(card.shuttleSchedule)
    cadence = spoken
      ? { text: spoken, title: `cron: ${card.shuttleSchedule}${card.shuttleTz ? ` (${card.shuttleTz})` : ''}` }
      : { text: card.shuttleSchedule }
  }
  const dir = card.shuttleProjectDir?.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
  const placeText = [card.shuttleHost, dir].filter(Boolean).join(':')
  const place = placeText
    ? { text: placeText, title: [card.shuttleHost, card.shuttleProjectDir].filter(Boolean).join(':') }
    : undefined
  return {
    actor: { text: agent ? (card.shuttleAgent ?? 'agent') : 'me', agent },
    effort: agent ? card.shuttleEffort : undefined,
    chrome: agent && card.shuttleChrome === true,
    seat: card.shuttleSeat
      ? { text: `seat of ${card.shuttleSeat}`, title: `A seat of roles/${card.shuttleSeat}: a worker here sits in that office.` }
      : undefined,
    cadence,
    place,
    due: card.due && placedByDue(card) ? formatDue(card.due) : undefined,
    run: sessionWindow(card, nowMs),
  }
}

/** {@link stripFacts} drawn: the facts on the left, the run window on the
 *  right — or on a line of its own where the dock is too narrow for both. */
function buildStrip(card: KanbanCard): HTMLElement {
  const facts = stripFacts(card)
  const strip = document.createElement('span')
  strip.className = 'kbn-ctl-strip'
  const line = document.createElement('span')
  line.className = 'kbn-ctl-facts'
  strip.append(line)
  const put = (cls: string, text: string, title?: string, into: HTMLElement = line): HTMLElement => {
    const el = document.createElement('span')
    el.className = cls
    el.textContent = text
    if (title) el.title = title
    into.append(el)
    return el
  }
  const who = document.createElement('span')
  who.className = 'kbn-ctl-who'
  const actor = document.createElement('span')
  actor.className = facts.actor.agent ? 'kbn-ctl-agent' : 'kbn-ctl-you'
  actor.textContent = facts.actor.text
  who.append(actor)
  for (const extra of [facts.effort, facts.chrome ? 'chrome' : undefined]) {
    if (!extra) continue
    const el = document.createElement('span')
    el.className = 'kbn-ctl-effort'
    el.textContent = extra
    who.append(el)
  }
  line.append(who)
  if (facts.seat) put('kbn-ctl-cadence kbn-ctl-seat', facts.seat.text, facts.seat.title)
  if (facts.cadence) put('kbn-ctl-cadence', facts.cadence.text, facts.cadence.title)
  if (facts.place) put('kbn-ctl-place', facts.place.text, facts.place.title)
  if (facts.due) put('kbn-ctl-due', `due ${facts.due}`)
  if (facts.run) {
    const run = put('kbn-ctl-run', facts.run.text, facts.run.title, strip)
    if (facts.run.state === 'clean') {
      const mark = document.createElement('span')
      mark.className = 'kbn-ctl-run-clean'
      mark.textContent = '✓'
      run.append(mark)
    } else if (facts.run.state === 'unclean') {
      run.classList.add('kbn-ctl-run-dirty')
    }
  }
  return strip
}

/** The meeting kind last picked, offered first by every composer this session. */
let lastMeetingMode: MeetingMode = MEETING_MODES[0].value

function ctlButton(label: string, cls: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `kbn-ctl-btn ${cls}`
  btn.textContent = label
  return btn
}

/** An on/off chip over a real checkbox: the checkbox keeps the keyboard and
 *  `.checked`, the chip is its face. */
function ctlToggle(label: string, cls: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const el = document.createElement('label')
  el.className = `kbn-ctl-toggle ${cls}`
  const input = document.createElement('input')
  input.type = 'checkbox'
  const text = document.createElement('span')
  text.textContent = label
  el.append(input, text)
  return { label: el, input }
}

/** A row of mutually exclusive choices, all visible at once. */
interface Segmented<T extends string> {
  el: HTMLElement
  buttons: HTMLButtonElement[]
  readonly value: T
  /** Select without firing `onPick` — for programmatic changes. */
  set(value: T): void
  setDisabled(disabled: boolean): void
  /** Called after the user picks a DIFFERENT value. */
  onPick(fn: (value: T, keyboard: boolean) => void): void
}

function segmented<T extends string>(
  name: string,
  options: ReadonlyArray<readonly [T, string]>,
  initial: T,
): Segmented<T> {
  const el = document.createElement('div')
  el.className = 'kbn-ctl-segmented'
  el.setAttribute('role', 'radiogroup')
  el.setAttribute('aria-label', name)
  let value = initial
  const listeners: Array<(value: T, keyboard: boolean) => void> = []
  let keyboardPick = false
  const buttons = options.map(([v, label]) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'kbn-ctl-segment'
    btn.setAttribute('role', 'radio')
    btn.dataset.value = v
    btn.textContent = label
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (value === v) return
      paint(v)
      for (const fn of listeners) fn(v, keyboardPick)
    })
    return btn
  })
  function paint(v: T): void {
    value = v
    for (const btn of buttons) {
      const on = btn.dataset.value === v
      btn.setAttribute('aria-checked', String(on))
      btn.tabIndex = on ? 0 : -1
    }
  }
  paint(initial)
  // One Tab stop; arrows move the choice, as in any radio group.
  el.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const at = buttons.findIndex((b) => b.dataset.value === value)
    const next = buttons[(at + step + buttons.length) % buttons.length]
    if (next.disabled) return
    next.focus()
    keyboardPick = true
    try { next.click() } finally { keyboardPick = false }
  })
  el.append(...buttons)
  return {
    el,
    buttons,
    get value() {
      return value
    },
    set: paint,
    setDisabled(disabled) {
      for (const btn of buttons) btn.disabled = disabled
    },
    onPick(fn) {
      listeners.push(fn)
    },
  }
}

/** One ledger line: a label, then its controls. */
function field(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'kbn-ctl-field'
  const name = document.createElement('span')
  name.className = 'kbn-ctl-label'
  name.textContent = label
  const value = document.createElement('div')
  value.className = 'kbn-ctl-value'
  value.append(...controls)
  row.append(name, value)
  return row
}

interface AgentRecord {
  id: string
  cli?: string
  model?: string
  default?: boolean
  effort_levels?: string[]
  default_effort?: string | null
  chrome_capable?: boolean
  alias_of?: string | null
}

export interface DockOptions {
  meeting?: MeetingJoinControl
  /** Whether the Desk draws this card's worker phase (it does in flight). */
  workerPhase?: (card: KanbanCard) => boolean
}

/**
 * The fiber page's act zone: state-shaped verdicts, composer, meeting,
 * folded settings and session history. The navbar owns the worker control.
 */
export class Dock {
  private readonly bands = new Map<string, Dock>()
  private root: HTMLElement | null = null
  private headRoot: HTMLElement | null = null
  private headWorkerKey: string | null = null
  private card: KanbanCard | null = null
  private searchDebounce: number | null = null
  private fiberIndex: Promise<Array<{ id: string; name: string }>> | null = null
  private searchRenderToken = 0
  private pendingStartPrompt: { cardId: string; body: DispatchFailureBody } | null = null
  private transcriptCard: KanbanCard | null = null
  private transcriptPane: HTMLElement | null = null
  private transcriptBand: TranscriptBand | null = null
  private verdictMenu: HTMLDetailsElement | null = null
  private meetingPaint: (() => void) | null = null
  private composerBusy: ((on: boolean, except?: HTMLButtonElement) => void) | null = null
  private composerDisposers: (() => void)[] = []
  private workerPillCard: KanbanCard | null = null
  private guidance: HTMLElement | null = null
  private meetingArmed: () => boolean = () => false
  private meetingStart: (() => void) | null = null
  private dismissParent: (() => boolean) | null = null
  private dismissConversation: (() => boolean) | null = null
  private composerSend: ComposerSend | null = null
  private composerError: HTMLElement | null = null
  private composerPaint: (() => void) | null = null
  private actPaint: (() => void) | null = null
  private freshButton: HTMLButtonElement | null = null
  private settingsSync: ((view: KanbanCard) => void) | null = null
  private historySync: (() => void) | null = null
  private savesPending = 0
  private saveTail: Promise<void> = Promise.resolve()
  private settingStep: { key: string; run: () => void; timer: number } | null = null
  private readonly blockedDispatches = new Map<HTMLButtonElement, { worker: string; label: string; error: HTMLElement }>()
  private epoch = 0
  private readonly timers = new Set<number>()
  private readonly shuttleBase: string
  private readonly onSaved: () => void
  private readonly onTransition: (card: KanbanCard, target: ColumnKind) => void
  private queueVerdict?: (card: KanbanCard, target: Verdict) => void
  private readonly onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly meeting: MeetingJoinControl | null
  private readonly workerPhase: (card: KanbanCard) => boolean

  constructor(
    shuttleBase: string,
    onChanged: () => void,
    onTransition?: (card: KanbanCard, target: ColumnKind) => void,
    onWorkerOpen?: (tmuxSessionName: string, shuttleHost?: string) => void,
    opts: DockOptions = {},
  ) {
    this.shuttleBase = shuttleBase
    this.onSaved = onChanged
    this.onTransition = onTransition ?? (() => {})
    this.onOpenWorker = onWorkerOpen
    this.meeting = opts.meeting ?? null
    this.workerPhase = opts.workerPhase ?? (() => true)
  }

  /** The dock's element, built on first use so controls can be exercised without a page. */
  get el(): HTMLElement {
    if (!this.root) {
      this.root = document.createElement('div')
      this.root.className = 'ws-dock'
      this.root.dataset.part = 'act'
      this.root.dataset.act = 'composer'
      this.root.tabIndex = -1
      this.root.addEventListener('click', event => event.stopPropagation())
    }
    return this.root
  }

  /**
   * The acts the fiber page's status line carries: the worker pill, then
   * Temper and Discard. Built once per band, so a prose repaint re-seats the
   * same controls under the pointer and the focus.
   */
  get head(): HTMLElement {
    if (!this.headRoot) {
      this.headRoot = document.createElement('div')
      this.headRoot.className = 'ws-fiber-acts'
      this.headRoot.dataset.part = 'act'
      this.headRoot.dataset.act = 'verdict'
      this.headRoot.addEventListener('click', event => event.stopPropagation())
    }
    return this.headRoot
  }

  private later(fn: () => void, ms: number): number {
    const timer = window.setTimeout(() => { this.timers.delete(timer); fn() }, ms)
    this.timers.add(timer)
    return timer
  }

  /** Keyboard stepping settles before writing; direct edits commit immediately. */
  private deferSetting(key: string, run: () => void, keyboard: boolean): void {
    const pending = this.settingStep
    if (pending) {
      window.clearTimeout(pending.timer)
      this.timers.delete(pending.timer)
      this.settingStep = null
      if (pending.key !== key) pending.run()
    }
    if (!keyboard) { run(); return }
    const timer = this.later(() => { this.settingStep = null; run() }, 150)
    this.settingStep = { key, run, timer }
  }

  get isOpen(): boolean { return this.card !== null }
  get openCardId(): string | null { return this.card?.id ?? null }

  open(card: KanbanCard): void {
    // A plain note has no composer to preserve when it becomes Shuttle-managed.
    const promoted = this.card !== null && !isAgentCard(this.card) && isAgentCard(card)
    if (this.card && (this.card.uid ?? this.card.id) === (card.uid ?? card.id) && this.card.originId === card.originId && !promoted) {
      this.syncRuntime(card)
      return
    }
    this.clear()
    // Controls share this copy, so a runtime poll updates confirmation and
    // opening targets without replacing the textarea or settings fields.
    this.card = { ...card }
    const view = this.card
    this.guidance = document.createElement('p')
    this.guidance.className = 'kbn-detail-app-guide'
    this.el.append(this.guidance)
    this.el.append(this.buildControls(view, isAgentCard(view)))
    this.syncRuntime(view)
  }

  /** Identity-keyed bands preserve drafts and folded controls across channels. */
  bandFor(card: KanbanCard): Dock {
    const key = JSON.stringify([card.originId, card.uid ?? card.id])
    let band = this.bands.get(key)
    if (!band) {
      band = new Dock(this.shuttleBase, this.onSaved, this.onTransition, this.onOpenWorker,
        { meeting: this.meeting ?? undefined, workerPhase: this.workerPhase })
      band.setVerdictQueue(this.queueVerdict)
      this.bands.set(key, band)
    }
    band.open(card)
    return band
  }

  /** Forget the cards and their controls. */
  reset(): void {
    for (const band of this.bands.values()) band.reset()
    this.bands.clear()
    this.clear()
  }

  private dismissPopovers(): void {
    this.dismissConversation?.()
    this.dismissParent?.()
  }

  private clear(): void {
    this.epoch++
    this.dismissPopovers()
    this.dismissConversation = this.dismissParent = null
    this.meetingArmed = () => false
    this.meetingStart = null
    for (const dispose of this.composerDisposers.splice(0)) dispose()
    if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
    this.searchDebounce = null
    this.searchRenderToken++
    this.fiberIndex = null
    this.card = this.workerPillCard = this.transcriptCard = null
    this.transcriptBand?.dispose()
    this.transcriptBand = null
    this.verdictMenu = null
    this.transcriptPane = this.guidance = null
    this.meetingPaint = this.composerBusy = null
    for (const timer of this.timers) window.clearTimeout(timer)
    this.timers.clear()
    this.composerSend = null
    this.composerError = null
    this.composerPaint = this.actPaint = null
    this.freshButton = null
    this.settingsSync = null
    this.historySync = null
    this.settingStep = null
    this.savesPending = 0
    this.blockedDispatches.clear()
    this.root?.replaceChildren()
    this.headRoot?.replaceChildren()
    this.headWorkerKey = null
  }

  /**
   * Focus the composer without moving the page under it. Only a field out of
   * view scrolls its page, and then to the page's top when the field fits on
   * the first screen, so the kicker and title stay whole.
   */
  focusComposer(): boolean {
    const field = this.root?.querySelector<HTMLTextAreaElement>('.kbn-detail-directive')
    if (!field) return false
    field.focus({ preventScroll: true })
    let scroller = field.parentElement
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement
    if (!scroller) return true
    const view = scroller.getBoundingClientRect()
    const box = field.getBoundingClientRect()
    if (box.top >= view.top && box.bottom <= view.bottom) return true
    const fromTop = box.bottom - view.top + scroller.scrollTop
    scroller.scrollTop = fromTop <= scroller.clientHeight ? 0 : scroller.scrollTop + box.top - view.top - box.height
    return true
  }

  /** The page re-seated this Dock's element in a fresh prose page. */
  reseated(): void {
    this.transcriptBand?.reseated()
  }

  handleEscape(): boolean {
    if (dismissSelectPicker()) return true
    if (this.verdictMenu?.open) { this.verdictMenu.open = false; return true }
    if (this.transcriptBand?.closeFull()) return true
    return Boolean(this.dismissConversation?.() || this.dismissParent?.())
  }


  private paintGuidance(card: KanbanCard): void {
    if (!this.guidance) return
    const coarse = coarsePointer()
    const target = appConversationTarget(card, canOpenDesktopApp(navigator.userAgent, coarse), navigator.userAgent, coarse)
    this.guidance.hidden = !((card.workerSurface ?? card.shuttleSurface) === 'app' && card.sessionUuid && !target.conversationSpecific)
    this.guidance.textContent = target.guidance
  }

  private buildTranscriptPane(card: KanbanCard): HTMLElement {
    const pane = document.createElement('section')
    pane.className = 'kbn-detail-transcript'
    pane.hidden = true
    const meta = document.createElement('div')
    meta.className = 'kbn-detail-transcript-meta'
    const dot = document.createElement('span')
    dot.className = 'kbn-detail-transcript-dot'
    dot.setAttribute('aria-hidden', 'true')
    const state = document.createElement('span')
    state.className = 'kbn-detail-transcript-state'
    const title = document.createElement('span')
    title.className = 'kbn-detail-transcript-title'
    const stop = document.createElement('button')
    stop.type = 'button'
    stop.className = 'kbn-detail-transcript-stop'
    stop.addEventListener('click', (e) => {
      e.stopPropagation()
      const current = this.meeting?.current()
      if (!current || this.meeting?.stopRequested?.(current)) return
      void this.meeting?.stop?.(current)
    })
    meta.append(dot, state, title, stop)
    const list = document.createElement('ol')
    list.className = 'kbn-detail-transcript-lines'
    list.setAttribute('aria-label', 'Transcript')
    list.setAttribute('aria-live', 'polite')
    list.tabIndex = 0
    pane.append(meta, list)
    this.transcriptCard = card
    this.transcriptPane = pane
    this.syncMeeting()
    return pane
  }

  /** Repaint the open card's transcript and Meeting verb from the board's
   *  current meeting. */
  syncMeeting(): void {
    for (const band of this.bands.values()) band.syncMeeting()
    this.meetingPaint?.()
    const pane = this.transcriptPane
    const card = this.transcriptCard
    if (!pane || !card) return
    const meeting = this.meeting?.current() ?? null
    const hosted = meetingHostCard(meeting, [card]) !== null
    pane.hidden = !hosted || meeting === null
    if (!meeting || !hosted) return
    const actions = this.meeting?.stop ? meetingActions(meeting, this.meeting.stopRequested?.(meeting) ?? false) : null
    const stop = pane.querySelector<HTMLButtonElement>('.kbn-detail-transcript-stop')!
    stop.hidden = !actions
    if (actions) {
      stop.textContent = actions.dismiss ? 'Dismiss' : 'Stop'
      stop.disabled = actions.stopDisabled
    }
    pane.querySelector<HTMLElement>('.kbn-detail-transcript-lines')!.hidden = meeting.tail.length === 0
    for (const st of ['starting', 'loading', 'live', 'stopping', 'failed']) {
      pane.classList.toggle(`kbn-detail-transcript-${st}`, meeting.state === st)
    }
    pane.querySelector<HTMLElement>('.kbn-detail-transcript-state')!.textContent =
      meetingStateWord(meeting.state)
    pane.querySelector<HTMLElement>('.kbn-detail-transcript-title')!.textContent =
      meeting.title?.trim() ?? ''
    paintTranscript(pane.querySelector<HTMLOListElement>('.kbn-detail-transcript-lines')!, meeting.tail)
  }

  /**
   * The Aloft control is the Desk card's own pill: same label, same states,
   * same destination under a mouse or a finger (see `terminalWorkerPill`).
   * An app worker's destination follows the conversation backend.
   */
  workerPillFor(card: KanbanCard): HTMLElement | null {
    if ((card.workerSurface ?? card.shuttleSurface) === 'app' && card.sessionUuid) {
      const state = workerVariant(card)
      return appWorkerLink(card, state === 'aloft' ? '' : `kbn-card-worker-${state}`)
    }
    return card.tmuxSession ? terminalWorkerPill(card, {
      phase: this.workerPhase(card), openWorker: this.onOpenWorker,
    }) : null
  }

  /** The status line's pill, rebuilt only when what it says or opens changes, keeping its focus. */
  private paintHeadWorker(card: KanbanCard, slot: HTMLElement): void {
    const pill = this.workerPillFor(card)
    const plate = pill ? workerPlate(card, pill, this.workerPhase(card)) : null
    const key = plate ? JSON.stringify([plate.outerHTML, card.tmuxSession, card.sessionLink, card.sessionUuid]) : null
    if (key === this.headWorkerKey) return
    this.headWorkerKey = key
    const focused = slot.contains(document.activeElement)
    slot.replaceChildren(...(plate ? [plate] : []))
    slot.hidden = !plate
    if (focused) plate?.focus({ preventScroll: true })
  }

  /** Keyboard opening activates the exact destination used by the worker pill. */
  openConversation(card: KanbanCard): boolean {
    const pill = this.workerPillFor(card)
    if (!pill?.matches('a[href],button')) return false
    pill.click()
    return true
  }

  /** All control bands share the workspace's identity-keyed undo queue. */
  setVerdictQueue(queue?: (card: KanbanCard, target: Verdict) => void): void {
    this.queueVerdict = queue
    for (const band of this.bands.values()) band.setVerdictQueue(queue)
  }

  verdict(card: KanbanCard, target: Verdict): void {
    if (this.queueVerdict) this.queueVerdict(card, target)
    else if (confirmWorkerStop(card, target)) this.commitVerdict(card, target)
  }

  /** Only the expired undo queue calls this in the workspace. */
  commitVerdict(card: KanbanCard, target: Verdict): void {
    this.onTransition(card, target)
  }

  verdictControlsFor(card: KanbanCard): HTMLElement {
    const row = document.createElement('div')
    row.className = 'kbn-ctl-verdict'
    markVerdictHost(row, card)
    for (const [label, cls, target] of [
      ['Temper', 'kbn-ctl-temper', 'tempered'],
      ['Discard', 'kbn-ctl-discard', 'composted'],
    ] as const) {
      const control = ctlButton(label, cls)
      control.addEventListener('click', () => this.verdict(card, target))
      row.append(control)
    }
    return row
  }

  /** Refresh controls without replacing drafts or folded fields. */
  syncRuntime(card: KanbanCard | null): void {
    for (const band of this.bands.values()) band.syncRuntime(card)
    if (!card || !this.card ||
      (this.card.uid ?? this.card.id) !== (card.uid ?? card.id) || this.card.originId !== card.originId) return
    const incoming = card
    if (this.card) {
      for (const key of ['id', 'uid', 'path', 'fiberDir', 'feltStore', 'shuttleHost', 'shuttleProjectDir', 'workerSurface', 'sessionUuid', 'tmuxSession', 'sessionLink', 'desktopLink', 'runtimePhase', 'lastActivityAt', 'launchError', 'workerState', 'workerAgent', 'dispatchedAt', 'handedOffAt', 'status', 'tempered', 'effectiveHorizon'] as const) {
        Object.assign(this.card, { [key]: card[key] })
      }
      card = this.card
    }
    this.settingsSync?.(incoming)
    this.historySync?.()
    this.composerPaint?.()
    this.actPaint?.()
    for (const [button, blocked] of this.blockedDispatches) {
      if (blocked.worker === workerIdentity(card)) continue
      button.disabled = false
      button.textContent = blocked.label
      if (blocked.error.textContent === 'A worker is already running for this fiber.') {
        blocked.error.textContent = ''
        blocked.error.style.display = 'none'
      }
      this.blockedDispatches.delete(button)
      this.composerPaint?.()
    }
    this.workerPillCard = card
    this.transcriptBand?.follow(latestTarget(card))
    this.paintGuidance(card)
  }

  refreshConversationOpening(): void {
    for (const band of this.bands.values()) band.refreshConversationOpening()
    this.syncRuntime(this.workerPillCard)
    this.root?.querySelectorAll('.kbn-ctl-history').forEach((history) => {
      history.dispatchEvent(new Event(CONVERSATION_OPENING_CHANGED))
    })
  }

  private buildControls(card: KanbanCard, shuttleManaged: boolean): HTMLElement {
    const body = document.createElement('div')
    body.className = 'ws-dock-body'
    this.buildControlsBody(body, card, shuttleManaged)
    return body
  }

  private buildControlsBody(body: HTMLElement, card: KanbanCard, shuttleManaged: boolean): void {
    const statusEl = document.createElement('span')
    statusEl.className = 'kbn-detail-save-status'
    statusEl.setAttribute('aria-live', 'polite')
    const errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.setAttribute('role', 'alert')
    errorEl.style.display = 'none'
    if (shuttleManaged) {
      this.transcriptBand = new TranscriptBand({ shuttleBase: this.shuttleBase })
      body.append(this.buildComposer(card))
    }
    body.append(this.buildTranscriptPane(card))

    const settings = document.createElement('div')
    settings.className = 'kbn-detail-controls'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'kbn-detail-controls-toggle'
    toggle.setAttribute('aria-expanded', 'false')
    const name = document.createElement('span')
    name.className = 'kbn-ctl-sr'
    name.textContent = 'Settings'
    const chevron = document.createElement('span')
    chevron.className = 'kbn-detail-controls-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    let strip = buildStrip(card)
    toggle.append(chevron, name, strip)
    const ledger = document.createElement('div')
    ledger.className = 'kbn-detail-controls-body kbn-ctl-ledger'
    ledger.hidden = true
    const watchers: Array<(view: KanbanCard) => void> = []
    const reflect = (patch: Partial<KanbanCard>): void => {
      Object.assign(card, patch)
      if (this.card !== card) return
      const next = buildStrip(card)
      strip.replaceWith(next)
      strip = next
      for (const watch of watchers) watch(card)
    }
    const reseeders: Array<() => void> = []
    const reseed = (fn: () => void): void => { reseeders.push(fn) }
    this.settingsSync = (view) => {
      if (ledger.contains(document.activeElement) || this.savesPending || this.settingStep) return
      for (const key of ['name', 'due', 'storedHorizon', 'isCycle', 'shuttleAgent', 'shuttleEffort', 'shuttleChrome', 'shuttleSurface', 'shuttleKind', 'shuttleSchedule', 'shuttleTz', 'inheritedProjectDir'] as const) {
        Object.assign(card, { [key]: view[key] })
      }
      for (const sync of reseeders) sync()
      reflect({})
    }
    ledger.append(
      this.buildWorkerFields(card, shuttleManaged, statusEl, errorEl, reflect, reseed),
      this.buildCardFields(card, statusEl, errorEl, reflect, fn => watchers.push(fn), reseed),
    )
    toggle.addEventListener('click', () => {
      ledger.hidden = !ledger.hidden
      toggle.setAttribute('aria-expanded', String(!ledger.hidden))
      settings.classList.toggle('kbn-detail-controls-open', !ledger.hidden)
      if (ledger.hidden) this.dismissParent?.()
    })
    settings.append(toggle, ledger)
    let history: HTMLElement | null = null
    const historyKey = (): string => JSON.stringify([card.uid, card.shuttleHost, hasLiveWorker(card), card.sessionUuid, card.tmuxSession])
    let historyRevision = historyKey()
    const refreshHistory = (open: boolean): void => {
      if (!card.uid) return
      const focusToggle = document.activeElement === history?.querySelector('.kbn-ctl-history-toggle')
      const next = buildSessionHistory({
        shuttleBase: this.shuttleBase, uid: card.uid, fiberHost: card.shuttleHost,
        liveSession: hasLiveWorker(card) ? card.sessionUuid : undefined, liveTmux: card.tmuxSession,
        desktop: atDesktop(navigator.userAgent, coarsePointer()),
        onRead: this.transcriptBand ? record => {
          const transcript = this.transcriptBand
          if (!transcript) return
          transcript.read({
            session: record.session,
            host: record.host ?? undefined,
            agent: record.agent ?? record.harness ?? undefined,
            live: record.session === (hasLiveWorker(card) ? card.sessionUuid : undefined),
            at: record.at,
          })
          transcript.el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        } : undefined,
        onError: message => { errorEl.textContent = message; errorEl.style.display = '' },
      })
      history?.replaceWith(next)
      history = next
      const unfold = next.querySelector<HTMLButtonElement>('.kbn-ctl-history-toggle')!
      if (open) unfold.click()
      if (focusToggle) unfold.focus({ preventScroll: true })
      // Every unfold gets a fresh ledger and current attach/resume targets.
      unfold.addEventListener('click', event => {
        if (unfold.getAttribute('aria-expanded') === 'true') return
        event.stopImmediatePropagation()
        refreshHistory(true)
      }, true)
    }
    refreshHistory(false)
    this.historySync = () => {
      const revision = historyKey()
      if (revision === historyRevision) return
      historyRevision = revision
      refreshHistory(history?.classList.contains('kbn-ctl-history-open') ?? false)
    }
    const foot = document.createElement('div')
    foot.className = 'kbn-ctl-foot'
    const verdict = this.verdictControlsFor(card)
    verdict.setAttribute('role', 'group')
    verdict.setAttribute('aria-label', 'Verdict')
    const worker = document.createElement('span')
    worker.className = 'ws-fiber-worker'
    this.head.replaceChildren(worker, verdict)
    const temper = verdict.querySelector<HTMLButtonElement>('.kbn-ctl-temper')!
    const discard = verdict.querySelector<HTMLButtonElement>('.kbn-ctl-discard')!
    const menu = document.createElement('details')
    menu.className = 'kbn-ctl-verdict-menu'
    const more = document.createElement('summary')
    more.textContent = '⋯'; more.setAttribute('aria-label', 'Fiber actions')
    const choices = document.createElement('div'); choices.className = 'kbn-ctl-menu'
    menu.append(more, choices)
    let release: Release | null = null
    menu.addEventListener('toggle', () => {
      release?.(); release = null
      if (menu.open && menu.isConnected) release = anchorPopover(choices, more, { placement: 'below-end' })
    })
    this.composerDisposers.push(() => { release?.(); release = null })
    this.verdictMenu = menu
    foot.append(errorEl, statusEl)
    // The transcript reads below every control, so the composer and its
    // verbs stay at the top of the dock however long the worker has talked.
    body.append(settings, ...(history ? [history as HTMLElement] : []), foot, ...(this.transcriptBand ? [this.transcriptBand.el] : []))
    // Review and live verdicts sit on the status line. Drafts and resting
    // constitutions keep their verdicts in a menu on the controls row.
    this.actPaint = () => {
      const column = fiberPageColumn(card)
      this.el.dataset.column = column
      this.head.dataset.column = column
      const reachable = verdictReachable(card)
      verdict.hidden = !reachable
      this.paintHeadWorker(card, worker)
      if (reachable && column !== 'inFlight' && column !== 'awaitingReview') {
        verdict.remove()
        if (temper.parentElement !== choices) choices.append(temper, discard)
        if (menu.parentElement !== foot) foot.append(menu)
      } else {
        if (verdict.parentElement !== this.head) this.head.append(verdict)
        if (temper.parentElement !== verdict) verdict.append(temper, discard)
        menu.remove()
      }
    }
    this.actPaint()
  }

  private buildComposer(card: KanbanCard): HTMLElement {
    const epoch = this.epoch
    const wrap = document.createElement('div')
    wrap.className = 'kbn-ctl-compose'

    const box = document.createElement('div')
    box.className = 'kbn-ctl-composer'
    const message = document.createElement('textarea')
    message.className = 'kbn-detail-directive'
    message.rows = 1
    message.placeholder = ''
    message.setAttribute('aria-label', 'Message for the next worker')
    // The field is one line, focused or not; only text that wraps grows it.
    // The text always has the field's whole width: while it fits beside the
    // verbs they ride its line, and once it would reach them (or holds a line
    // break) they drop to a row of their own inside the field's foot. The
    // decision measures the text against the room beside the verbs, so it is
    // the same on either side of the switch and never flickers.
    let ruler: CanvasRenderingContext2D | null = null
    const stack = (): void => {
      if (!box.isConnected || !box.clientWidth) return
      ruler ??= document.createElement('canvas').getContext?.('2d') ?? null
      if (!ruler) return
      const text = getComputedStyle(message), field = getComputedStyle(box)
      ruler.font = `${text.fontStyle} ${text.fontWeight} ${text.fontSize} ${text.fontFamily}`
      const room = box.clientWidth - parseFloat(field.paddingLeft) - parseFloat(field.paddingRight)
        - foot.offsetWidth - (parseFloat(field.columnGap) || 0) - parseFloat(text.paddingLeft) - parseFloat(text.paddingRight)
      const longest = Math.max(0, ...message.value.split('\n').map(line => ruler!.measureText(line).width))
      box.classList.toggle('kbn-ctl-composer-stacked', message.value.includes('\n') || longest > room)
    }
    const fit = (): void => {
      stack()
      message.style.height = ''
      if (message.value && message.scrollHeight > message.clientHeight) message.style.height = `${message.scrollHeight}px`
    }
    message.addEventListener('input', fit)
    // The draft belongs to its constitution and outlives a reload in this
    // browser; a send that lands empties the field and so drops it.
    const draftStore = `shuttle:composer-draft:${JSON.stringify([card.originId, card.uid ?? card.id])}`
    try { message.value = localStorage.getItem(draftStore) ?? '' } catch { /* storage unavailable */ }
    if (message.value) requestAnimationFrame(fit)
    message.addEventListener('input', () => {
      try { if (message.value) localStorage.setItem(draftStore, message.value); else localStorage.removeItem(draftStore) } catch { /* storage unavailable */ }
    })
    window.addEventListener('resize', fit)
    this.composerDisposers.push(() => window.removeEventListener('resize', fit))

    // Two lines under the box: a send's outcome (and the project-directory
    // prompt a refused start raises), and the images turned away. Neither
    // writes over the other.
    const err = document.createElement('div')
    err.className = 'kbn-detail-error'
    err.style.display = 'none'
    const imageErr = document.createElement('div')
    imageErr.className = 'kbn-detail-error kbn-ctl-images-error'
    imageErr.style.display = 'none'
    const showImageError = (text: string | null): void => {
      imageErr.textContent = text ?? ''
      imageErr.style.display = text ? '' : 'none'
    }

    const images = new PastedImages()
    const strip = buildImageStrip(images)
    this.composerDisposers.push(strip.dispose)

    // While a send is in flight every verb is held and the chips are frozen,
    // so what is sent is what was shown.
    let busy = false
    const fresh = ctlButton('Start ↵', 'kbn-ctl-send')
    const resume = ctlButton('Resume', 'kbn-ctl-send kbn-ctl-resume')
    this.composerPaint = () => {
      const draft = fiberPageColumn(card) === 'drafts'
      const resumable = !draft && Boolean(card.sessionUuid)
      // A fresh session is always the default verb (↵); a resumable session
      // adds Resume beside it as the secondary verb (⌥↵).
      if (!this.blockedDispatches.has(fresh)) fresh.textContent = draft ? 'Launch ↵' : resumable ? 'New session ↵' : 'Start ↵'
      resume.classList.toggle('kbn-ctl-secondary', resumable)
      resume.title = resumable ? 'Resume the previous session (⌥↵)' : ''
      resume.hidden = !resumable
      // A live worker is resumed only to hand it a message; attaching to it
      // is the terminal action's.
      const idle = hasLiveWorker(card) && message.value.trim() === '' && images.list.length === 0
      if (!busy && !this.blockedDispatches.has(resume)) resume.disabled = idle
      message.placeholder = this.meetingArmed() ? 'A note for the meeting (optional)'
        : ''
    }
    this.composerPaint()
    message.addEventListener('input', () => this.composerPaint?.())
    const setBusy = (on: boolean, except?: HTMLButtonElement): void => {
      busy = on
      for (const verb of [fresh, resume]) if (verb !== except) verb.disabled = on
      if (!on) this.composerPaint?.()
      for (const control of err.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.kbn-start-prompt input, .kbn-start-prompt button')) control.disabled = on
      strip.setFrozen(on)
      if (epoch === this.epoch) this.meetingPaint?.()
    }
    this.composerBusy = setBusy

    const admit = (files: File[]): void => {
      if (busy) showImageError('Wait for the send to finish before adding images.')
      else showImageError(images.add(files))
      strip.paint(); this.composerPaint?.()
    }
    message.addEventListener('paste', (e) => {
      const files = pastedImageFiles(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      admit(files)
    })
    box.addEventListener('dragover', (e) => {
      if (!transferHasFiles(e.dataTransfer)) return
      e.preventDefault()
      box.classList.add('kbn-ctl-composer-drop')
    })
    box.addEventListener('dragleave', (e) => {
      if (!box.contains(e.relatedTarget as Node | null)) box.classList.remove('kbn-ctl-composer-drop')
    })
    box.addEventListener('drop', (e) => {
      box.classList.remove('kbn-ctl-composer-drop')
      const files = filesFromTransfer(e.dataTransfer)
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation()
      admit(files)
    })

    // What the last compose took, so a send that lands clears exactly that.
    let composed: { text: string; ids: number[] } | null = null
    const draftKey = (): string => JSON.stringify([message.value, images.list.map(image => image.id)])
    const send: ComposerSend = {
      draftKey,
      compose: (unlessUnchanged) => {
        if (unlessUnchanged === draftKey()) {
          composed = null
          return Promise.resolve('')
        }
        composed = { text: message.value, ids: images.list.map((image) => image.id) }
        return this.composeWithImages(card, images, message.value)
      },
      busy: () => busy,
      setBusy,
      sent: () => {
        if (!composed) return
        for (const id of composed.ids) images.remove(id)
        strip.paint()
        showImageError(null)
        if (message.value === composed.text) {
          message.value = ''
          message.dispatchEvent(new Event('input'))
        }
      },
    }

    // The verbs that take the message and act at once, side by side: a
    // meeting (its note), a fresh worker, or the same worker resumed.
    const foot = document.createElement('div')
    foot.className = 'kbn-ctl-composer-foot'
    const sends = document.createElement('span')
    sends.className = 'kbn-ctl-sends'
    // With Meeting on, its own verb stands in for New session and Resume.
    const meeting = this.meeting ? this.buildMeeting(card, err, send, armed => {
      sends.hidden = armed
      this.composerPaint?.()
      fit()
    }) : null
    sends.append(fresh, resume)
    foot.append(...(meeting ? [meeting] : []), sends)

    this.composerSend = send
    this.composerError = err
    this.freshButton = fresh
    const pending = this.pendingStartPrompt
    if (pending?.cardId === card.id) {
      this.pendingStartPrompt = null
      const parked = send.draftKey()
      this.showStartPrompt(err, card, pending.body, () => send.compose(parked), 'fresh', fresh)
    }
    fresh.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.runRequeue(card, send.compose, 'fresh', fresh, err).then((ok) => ok && send.sent())
    })
    resume.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.runRequeue(card, send.compose, 'previous', resume, err).then((ok) => ok && send.sent())
    })

    message.addEventListener('keydown', event => {
      // Escape steps out of the field and hands the keys back to the reader;
      // the draft stays.
      if (event.key === 'Escape' && !event.isComposing && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation()
        message.blur()
        return
      }
      if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey || event.isComposing || event.keyCode === 229) return
      event.preventDefault(); event.stopPropagation()
      if (event.repeat || busy) return
      if (this.meetingArmed()) { this.meetingStart?.(); return }
      const resumeSession = event.altKey && Boolean(card.sessionUuid) && fiberPageColumn(card) !== 'drafts'
      void this.runRequeue(card, send.compose, resumeSession ? 'previous' : 'fresh', resumeSession ? resume : fresh, err).then(ok => ok && send.sent())
    })
    box.append(message, strip.el, foot)
    wrap.append(box, imageErr, err)
    return wrap
  }

  /**
   * The text a composer send carries: `text`, then the paths of `images` once
   * they are stored on the daemon owning `card`. Throws the upload's reason
   * when it failed; the send then sends nothing.
   */
  private async composeWithImages(card: KanbanCard, images: PastedImages, text: string): Promise<string> {
    if (!images.size) return text.trim()
    return composeDirective(text, await uploadPastedImages(this.shuttleBase, card, images.list))
  }

  /**
   * Meeting, for this constitution: a switch in the composer's control row.
   * Off by default. On, it shows the meeting's kind (Call, Room, Phone) and
   * the composer's verbs become one, Start meeting, which records on the
   * daemon — nothing records before that press; Phone opens this tab's mic in
   * the press's gesture and keeps its controls on the board. The composer's
   * message, with its images' lines, becomes the meeting's note, and the
   * worker — live or not — receives the meeting as a joined constitution.
   *
   * One meeting records at a time. While any does, the switch stays in its
   * place, off and inert, naming the recording on hover; it is absent only
   * where hark is not available. It follows the board's meeting poll.
   * `onArm` hears the switch so the composer can trade its verbs.
   */
  private buildMeeting(card: KanbanCard, err: HTMLElement, send: ComposerSend, onArm: (armed: boolean) => void = () => {}): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'kbn-ctl-meet'
    const toggle = document.createElement('label')
    toggle.className = 'kbn-ctl-meet-switch'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('role', 'switch')
    const track = document.createElement('span')
    track.className = 'kbn-ctl-meet-track'
    track.setAttribute('aria-hidden', 'true')
    const word = document.createElement('span')
    word.textContent = 'Meeting'
    toggle.append(input, track, word)
    const modes = segmented<MeetingMode>('Meeting kind', MEETING_MODES.map(({ value, label }) => [value, label] as const), lastMeetingMode)
    modes.el.classList.add('kbn-ctl-meet-modes')
    modes.onPick(mode => { lastMeetingMode = mode })
    const verb = ctlButton('', 'kbn-ctl-send kbn-ctl-meet-start')
    verb.setAttribute('aria-label', 'Start meeting')
    // The phone's narrow row drops the noun the switch beside it already says.
    const verbFace = (busy: boolean): void => {
      if (busy) { verb.textContent = 'Starting…'; return }
      const noun = document.createElement('span')
      noun.className = 'kbn-ctl-meet-noun'
      noun.textContent = ' meeting'
      verb.replaceChildren('Start', noun, ' ↵')
    }
    verbFace(false)

    let starting = false
    const arm = (on: boolean): void => {
      input.checked = on
      wrap.classList.toggle('kbn-ctl-meet-on', on)
      modes.el.hidden = verb.hidden = !on
      onArm(on)
    }
    arm(false)
    input.addEventListener('change', () => arm(input.checked))
    this.meetingArmed = () => input.checked && !input.disabled


    const paint = (): void => {
      const control = this.meeting
      if (!control) return
      const current = control.current()
      const recording = current !== null && current.state !== 'failed'
      wrap.hidden = !control.canJoin() && !recording
      const held = starting || send.busy() || !control.canJoin()
      input.disabled = held
      modes.setDisabled(held)
      verb.disabled = held
      toggle.title = recording ? `Recording: ${current.title?.trim() || 'a meeting'}` : ''
      if (!control.canJoin() && input.checked && !starting) arm(false)
    }
    this.meetingPaint = paint

    const start = (): void => {
      if (!input.checked || starting || send.busy() || !this.meeting?.canJoin()) return
      starting = true
      send.setBusy(true)
      verbFace(true)
      err.style.display = 'none'
      // The join is called inside the press's gesture, so Phone can open the
      // mic; it resolves the note (uploading any images) after that.
      const epoch = this.epoch
      let joined: Promise<MeetingJoinResult>
      try { joined = this.meeting!.join(card, modes.value, send.compose) }
      catch (error) { joined = Promise.reject(error) }
      let began = false
      void joined.then(({ error, delivered }) => {
        if (epoch !== this.epoch) return
        if (error) {
          err.textContent = error
          err.style.display = ''
        } else {
          began = true
          // A recording whose worker never received the note keeps it, and
          // its images, for another try.
          if (delivered) send.sent()
        }
      }).catch((error: unknown) => {
        if (epoch !== this.epoch) return
        err.textContent = (error as { message?: string })?.message ?? String(error)
        err.style.display = ''
      }).finally(() => {
        starting = false
        verbFace(false)
        if (began && epoch === this.epoch) arm(false)
        send.setBusy(false)
      })
    }
    this.meetingStart = start
    verb.addEventListener('click', (e) => {
      e.stopPropagation()
      start()
    })

    wrap.append(toggle, modes.el, verb)
    paint()
    return wrap
  }

  /**
   * The worker half of the ledger — what the next launch reads. Agent axes
   * (base × effort × chrome × session) commit through `commitAxes` → the
   * daemon's `set-agent` action, which preserves session identity and review
   * history. Kind and schedule go through `livePatch` → `reshape`, which
   * rewrites the shape keys alone and leaves agent, status and outcome where
   * they are. None of it touches a running worker; a live session keeps the
   * settings it launched with.
   *
   * A card with no shuttle block shows only the agent it would be promoted
   * with, and the Promote verb.
   */
  private buildWorkerFields(
    card: KanbanCard,
    shuttleManaged: boolean,
    statusEl: HTMLElement,
    errorEl: HTMLElement,
    reflect: (patch: Partial<KanbanCard>) => void,
    reseed: (fn: () => void) => void,
  ): HTMLElement {
    const col = document.createElement('div')
    col.className = 'kbn-ctl-fields'

    const agentSelect = document.createElement('select')
    agentSelect.id = 'kbn-detail-agent'
    agentSelect.className = 'kbn-ctl-select kbn-ctl-agent-select'
    agentSelect.setAttribute('aria-label', 'Agent')
    // Until the registry answers, the select holds the card's own agent — the
    // value it will show once it does, so nothing flickers.
    agentSelect.append(new Option(card.shuttleAgent || '…', card.shuttleAgent ?? ''))

    // Effort options are the selected agent's concrete `effort_levels`. There
    // is deliberately no synthetic "default": an omitted fiber value resolves
    // to the registry's `default_effort`, so the control always names the
    // level dispatch will actually use.
    const effortSelect = document.createElement('select')
    effortSelect.id = 'kbn-detail-effort'
    effortSelect.className = 'kbn-ctl-select kbn-ctl-effort-select'
    effortSelect.setAttribute('aria-label', 'Effort')
    if (card.shuttleEffort) effortSelect.append(new Option(card.shuttleEffort, card.shuttleEffort))
    this.composerDisposers.push(anchorSelect(agentSelect), anchorSelect(effortSelect))

    const chrome = ctlToggle('Chrome', 'kbn-ctl-chrome')
    chrome.input.id = 'kbn-detail-chrome'
    chrome.input.checked = card.shuttleChrome === true
    // Until the registry says which agents take it, show Chrome where it is on.
    chrome.label.hidden = !chrome.input.checked

    const surface = segmented<ExecutionSurface>(
      'Session',
      [['cli', 'Terminal'], ['app', 'App']],
      persistedSurface(card.shuttleSurface),
    )
    const surfaceRow = field('Session', surface.el)
    // Revealed once the registry confirms a Codex agent — the only harness
    // with a choice to make — and inert until then.
    surfaceRow.hidden = persistedSurface(card.shuttleSurface) !== 'app'
    surface.setDisabled(true)

    if (!shuttleManaged) {
      const promote = ctlButton('Promote', 'kbn-ctl-send')
      promote.addEventListener('click', (e) => {
        e.stopPropagation()
        const agent = agentSelect.value.trim()
        if (!agent) {
          errorEl.textContent = 'Choose an agent first.'
          errorEl.style.display = ''
          return
        }
        promote.disabled = true
        promote.textContent = 'Promoting…'
        errorEl.style.display = 'none'
        void this.promoteToShuttle(card, agent, promote, errorEl)
      })
      col.append(field('Agent', agentSelect, promote))
      // The picker only fills the select the promotion reads; there is no
      // block to write to yet.
      void this.loadAgentPicker(
        { agentSelect, effortSelect, chromeToggle: chrome.input, surface, surfaceRow: null },
        { agent: '', effort: '', chrome: false, surface: 'cli' },
        async () => true,
      )
      return col
    }

    col.append(field('Agent', agentSelect, effortSelect, chrome.label), surfaceRow)
    void this.loadAgentPicker(
      { agentSelect, effortSelect, chromeToggle: chrome.input, surface, surfaceRow },
      {
        agent: card.shuttleAgent ?? '',
        effort: card.shuttleEffort ?? '',
        chrome: card.shuttleChrome ?? false,
        surface: persistedSurface(card.shuttleSurface),
      },
      async (axes) => {
        const ok = await this.commitAxes(card, axes, statusEl, errorEl)
        if (ok) {
          const patch: Partial<KanbanCard> = {}
          if ('agent' in axes) patch.shuttleAgent = axes.agent
          if ('effort' in axes) patch.shuttleEffort = axes.effort || undefined
          if ('chrome' in axes) patch.shuttleChrome = axes.chrome
          if ('surface' in axes) patch.shuttleSurface = axes.surface
          reflect(patch)
        }
        return ok
      },
    ).then(sync => {
      if (!sync) return
      const reset = (): void => sync({ agent: card.shuttleAgent ?? '', effort: card.shuttleEffort ?? '',
        chrome: card.shuttleChrome ?? false, surface: persistedSurface(card.shuttleSurface) })
      reseed(reset)
      reset()
      if (!card.shuttleEffort && effortSelect.value) reflect({ shuttleEffort: effortSelect.value })
    })

    // ── Kind + cron ──────────────────────────────────────────────────────
    // The card's kind is read straight through — an absent block reads as
    // one-shot.
    const baseline = {
      kind: (card.shuttleKind ?? 'oneshot') as ShuttleKind,
      schedule: card.shuttleSchedule ?? '',
      tz: card.shuttleTz ?? 'Europe/Paris',
    }
    const kind = segmented<ShuttleKind>(
      'Kind',
      [['oneshot', 'One-shot'], ['standing', 'Standing']],
      baseline.kind,
    )

    const cronInput = document.createElement('input')
    cronInput.type = 'text'
    cronInput.id = 'kbn-detail-schedule'
    cronInput.className = 'kbn-ctl-input kbn-ctl-cron'
    cronInput.placeholder = '0 9 * * 1-5'
    cronInput.value = baseline.schedule
    cronInput.spellcheck = false
    cronInput.setAttribute('aria-label', 'Cron')

    const tzInput = document.createElement('input')
    tzInput.type = 'text'
    tzInput.className = 'kbn-ctl-input kbn-ctl-tz'
    tzInput.placeholder = 'Europe/Paris'
    tzInput.value = baseline.tz
    tzInput.spellcheck = false
    tzInput.setAttribute('aria-label', 'Timezone')

    // The cron said the way a person would, beside the expression.
    const spoken = document.createElement('span')
    spoken.className = 'kbn-ctl-spoken'
    const paintSpoken = (): void => {
      spoken.textContent = humanizeCron(cronInput.value.trim()) ?? ''
    }
    paintSpoken()
    cronInput.addEventListener('input', paintSpoken)

    const cronRow = field('Cron', cronInput, tzInput, spoken)
    cronRow.hidden = baseline.kind !== 'standing'
    col.append(field('Kind', kind.el), cronRow)
    reseed(() => {
      baseline.kind = card.shuttleKind ?? 'oneshot'
      baseline.schedule = card.shuttleSchedule ?? ''
      baseline.tz = card.shuttleTz ?? 'Europe/Paris'
      kind.set(baseline.kind)
      cronInput.value = baseline.schedule
      tzInput.value = baseline.tz
      cronRow.hidden = baseline.kind !== 'standing'
      paintSpoken()
    })

    const livePatch = (
      changes: { shuttleKind?: ShuttleKind; shuttleSchedule?: string; shuttleTz?: string },
      onCommitted: () => void,
      onFailed?: () => void,
    ): void => {
      void this.livePatch(card, changes, statusEl, errorEl).then((ok) => {
        if (ok) onCommitted()
        else onFailed?.()
      })
    }

    // One-shot commits on the click: it needs nothing the user hasn't given,
    // and throws away nothing a re-toggle can't restore.
    //
    // PROMOTING to Standing does NOT commit on the click. The toggle reveals
    // and seeds the cron (`0 9 * * 1-5`, Europe/Paris) — seeding is not
    // choosing — and the promotion is written when the cron is confirmed, on
    // blur or Enter (`commitSchedule`). A promotion abandoned mid-toggle stays
    // one-shot on the wire: a schedule is something you state, never
    // something you're given.
    let kindRevision = 0
    const commitKind = (value: ShuttleKind, revision: number): void => {
      if (value === baseline.kind && !this.savesPending) return
      if (value === 'standing') {
        errorEl.style.display = 'none'
        statusEl.textContent = '↵ to save'
        return
      }
      statusEl.textContent = ''
      livePatch(
        { shuttleKind: value },
        () => {
          baseline.kind = value
          reflect({ shuttleKind: value })
        },
        // A refused write puts the control back on what the wire says, so
        // the next click on the same choice retries it.
        () => {
          if (revision !== kindRevision) return
          kind.set(baseline.kind)
          cronRow.hidden = baseline.kind !== 'standing'
        },
      )
    }

    /** Set on mousedown over a non-Standing segment while a promotion is
     *  staged but uncommitted, so the cron field's blur doesn't commit on the
     *  way out. */
    let abandoningPromotion = false
    kind.onPick((value, keyboard) => {
      const revision = ++kindRevision
      cronRow.hidden = value !== 'standing'
      if (value === 'standing') {
        if (!cronInput.value.trim()) cronInput.value = '0 9 * * 1-5'
        if (!tzInput.value.trim()) tzInput.value = 'Europe/Paris'
        paintSpoken()
        cronInput.focus()
        cronInput.select()
      }
      this.deferSetting('kind', () => commitKind(value, revision), keyboard)
    })
    for (const btn of kind.buttons) {
      // Backing OUT of an uncommitted promotion must write nothing, and the
      // hazard is the BLUR the click causes: picking Standing focuses the cron
      // field, and clicking away blurs it, which is what commits. mousedown
      // runs before blur, so this is where the intent is knowable.
      btn.addEventListener('mousedown', () => {
        if (btn.dataset.value !== 'standing' && baseline.kind !== 'standing') {
          abandoningPromotion = true
        }
      })
      btn.addEventListener('click', () => {
        abandoningPromotion = false
      })
    }
    // The keyboard twin of that mousedown: an arrow off a staged Standing
    // moves focus to the next segment before it picks it, and that focus move
    // is the cron field's blur. Captured ahead of the group's own handler.
    kind.el.addEventListener('keydown', (e) => {
      const arrow = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp'
      if (arrow && kind.value === 'standing' && baseline.kind !== 'standing') abandoningPromotion = true
    }, true)

    // Schedule + tz commit on blur and Enter — `input` would patch mid-typed
    // cron fragments. This is ALSO where a promotion to Standing lands, which
    // is why the guard reads the kind chosen in the dock rather than the
    // wire's: confirming the cron IS the act of promoting.
    const commitSchedule = (): void => {
      if (abandoningPromotion) {
        abandoningPromotion = false
        statusEl.textContent = ''
        return
      }
      if (kind.value !== 'standing') return
      const schedule = cronInput.value.trim()
      const tz = tzInput.value.trim() || 'UTC'
      const promoting = baseline.kind !== 'standing'
      if (!promoting && schedule === baseline.schedule && tz === baseline.tz) return
      if (!schedule) {
        errorEl.textContent = 'A standing constitution needs a cron expression.'
        errorEl.style.display = ''
        return
      }
      livePatch({ shuttleKind: 'standing', shuttleSchedule: schedule, shuttleTz: tz }, () => {
        baseline.kind = 'standing'
        baseline.schedule = schedule
        baseline.tz = tz
        statusEl.textContent = ''
        reflect({ shuttleKind: 'standing', shuttleSchedule: schedule, shuttleTz: tz })
      })
    }
    for (const input of [cronInput, tzInput]) {
      input.addEventListener('blur', commitSchedule)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          input.blur()
        }
      })
    }

    return col
  }

  /**
   * The card half of the ledger: its due day and its parent.
   *
   * Due is the one way to name a date the hand cannot reach — the drag-reveal
   * timeline renders `DRAG_HORIZON_DAYS` (14) ahead — and the way a resting
   * card gets a day to come back on, so on a resting card the field is named
   * for that: Returns. A cycle's due is its band's closing edge: Ends. A
   * standing constitution (placed by its cron) is never sorted by `due:`, so
   * the field is absent on one.
   */
  private buildCardFields(
    card: KanbanCard,
    statusEl: HTMLElement,
    errorEl: HTMLElement,
    reflect: (patch: Partial<KanbanCard>) => void,
    watch: (fn: (view: KanbanCard) => void) => void,
    reseed: (fn: () => void) => void,
  ): HTMLElement {
    const col = document.createElement('div')
    col.className = 'kbn-ctl-fields'
    const livePatch = (changes: { parentId?: string | null; due?: string | null }, onCommitted: () => void, onFailed?: () => void): void => {
      void this.livePatch(card, changes, statusEl, errorEl).then((ok) => {
        if (ok) onCommitted()
        else onFailed?.()
      })
    }

    // Seeded through `dueCivilDay`, NEVER `new Date(card.due)`: felt stores a
    // civil day as UTC midnight, and the Date round trip names the day BEFORE
    // in every negative-offset zone (see civilDay.ts). The bare `YYYY-MM-DD`
    // the input wants is also what goes back on the wire.
    let current = dueCivilDay(card.due) ?? null
    let intended = current
    let revision = 0
    const input = document.createElement('input')
    input.type = 'date'
    input.className = 'kbn-ctl-input kbn-ctl-date'
    const label = card.isCycle ? 'Ends' : card.storedHorizon === 'stashed' ? 'Returns' : 'Due'
    input.setAttribute('aria-label', card.isCycle ? 'Cycle end date' : label === 'Returns' ? 'Return date' : 'Due date')
    input.value = current ?? ''
    const clear = ctlButton('×', 'kbn-ctl-clear')
    clear.setAttribute('aria-label', 'Clear date')
    const paint = (): void => {
      clear.hidden = !input.value
      input.classList.toggle('kbn-ctl-empty', !input.value)
    }
    paint()

    const commit = (next: string | null): void => {
      if ((next ?? '') === (intended ?? '')) return
      intended = next
      const request = ++revision
      livePatch({ due: next }, () => {
        current = next
        if (request === revision) { input.value = next ?? ''; paint() }
        reflect({ due: next ?? undefined })
      }, () => {
        if (request !== revision) return
        intended = current
        input.value = current ?? ''
        paint()
      })
    }
    // `change`, not `input`: a native picker fires `input` per keystroke of a
    // half-typed year. Emptying the field is itself the clear; × is its
    // visible spelling.
    input.addEventListener('change', () => commit(input.value || null))
    clear.addEventListener('click', (e) => {
      e.stopPropagation()
      commit(null)
    })
    const dueRow = field(label, input, clear)
    // Present only while the board places the card by due — it follows a
    // kind changed in these settings.
    dueRow.hidden = !placedByDue(card)
    watch((view) => {
      dueRow.hidden = !placedByDue(view)
    })
    col.append(dueRow)
    reseed(() => {
      current = intended = dueCivilDay(card.due) ?? null
      input.value = current ?? ''
      paint()
    })

    col.append(field('Parent', this.buildParentPicker(card, livePatch, reseed)))
    return col
  }

  /**
   * The parent: its id, standing as the value, and a search in its place the
   * moment it is clicked. One pick commits; Escape or a click away puts the
   * id back.
   */
  private buildParentPicker(
    card: KanbanCard,
    livePatch: (changes: { parentId: string | null }, onCommitted: () => void, onFailed?: () => void) => void,
    reseed: (fn: () => void) => void,
  ): HTMLElement {
    const segments = card.id.split('/')
    let parentId: string | null = segments.length > 1 ? segments.slice(0, -1).join('/') : null
    let intended = parentId
    let revision = 0

    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-parent-wrap'

    const shown = document.createElement('button')
    shown.type = 'button'
    shown.className = 'kbn-ctl-parent'
    const paint = (): void => {
      shown.textContent = parentId ?? '—'
      shown.title = parentId ? `Parent: ${parentId}` : 'Top level'
    }
    reseed(() => { intended = parentId = card.id.includes('/') ? card.id.slice(0, card.id.lastIndexOf('/')) : null; paint() })
    paint()

    const search = document.createElement('input')
    search.type = 'text'
    search.className = 'kbn-ctl-input kbn-detail-parent-input'
    search.placeholder = 'Search fibers…'
    search.hidden = true
    search.setAttribute('aria-label', 'Search parent fiber')
    search.setAttribute('autocomplete', 'off')
    search.setAttribute('role', 'combobox')
    search.setAttribute('aria-expanded', 'false')
    search.setAttribute('aria-haspopup', 'listbox')

    const dropdown = document.createElement('div')
    dropdown.className = 'kbn-detail-parent-dropdown'
    dropdown.style.display = 'none'
    dropdown.setAttribute('role', 'listbox')

    let release: Release | null = null
    const hideDropdown = (): void => {
      release?.(); release = null
      dropdown.style.display = 'none'
      search.setAttribute('aria-expanded', 'false')
    }
    /** Each render of the results places them again: their height, and so their side, may have changed. */
    const showDropdown = (): void => {
      dropdown.style.display = ''
      if (release) release.reposition()
      else release = anchorPopover(dropdown, search, { placement: 'below-start', matchWidth: true })
    }
    this.composerDisposers.push(() => { release?.(); release = null })
    const closeSearch = (): void => {
      this.searchRenderToken++
      if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
      this.searchDebounce = null
      hideDropdown()
      search.hidden = true
      shown.hidden = false
    }

    this.dismissParent = () => {
      if (search.hidden) return false
      closeSearch()
      if (shown.isConnected) shown.focus()
      return true
    }

    const onPick = (result: FiberSearchResult): void => {
      closeSearch()
      shown.focus()
      if (result.id === intended) return
      intended = result.id
      const request = ++revision
      livePatch({ parentId: result.id }, () => {
        parentId = result.id
        if (request === revision) paint()
      }, () => {
        if (request === revision) { intended = parentId; paint() }
      })
    }
    const openDropdown = (): void => {
      if (search.hidden) return
      void this.searchParents(search.value.trim(), card.id, dropdown, onPick, showDropdown).then(() => {
        if (dropdown.style.display !== 'none') search.setAttribute('aria-expanded', 'true')
      })
    }

    shown.addEventListener('click', (e) => {
      e.stopPropagation()
      shown.hidden = true
      search.hidden = false
      search.value = ''
      search.focus()
    })
    search.addEventListener('input', () => {
      if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
      this.searchDebounce = window.setTimeout(() => openDropdown(), 200)
    })
    search.addEventListener('focus', () => openDropdown())
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        const first = dropdown.querySelector<HTMLElement>('button')
        if (first) {
          e.preventDefault()
          first.focus()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeSearch()
        shown.focus()
      }
    })
    dropdown.addEventListener('keydown', (e) => {
      const opts = Array.from(dropdown.querySelectorAll<HTMLElement>('button:not(:disabled)'))
      const idx = opts.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown' && idx < opts.length - 1) {
        e.preventDefault()
        opts[idx + 1].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx > 0) opts[idx - 1].focus()
        else search.focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        // Focus first — hiding a container that holds the focused element
        // drops focus to <body> before it can be redirected.
        shown.hidden = false
        shown.focus()
        closeSearch()
      }
    })
    // A press on a result keeps focus where it is. WebKit gives a clicked
    // button no focus, so without this pressing a result blurs the search to
    // the body, the focusout below closes the list, and the result vanishes
    // from under the pointer before its click lands.
    dropdown.addEventListener('mousedown', (e) => e.preventDefault())
    // Focus settling outside the picker — Tab away, a press elsewhere —
    // closes it. Checked a tick later: switching windows fires focusout too,
    // but leaves the search as the document's active element.
    wrap.addEventListener('focusout', () => {
      this.later(() => {
        if (!wrap.contains(document.activeElement)) closeSearch()
      }, 0)
    })

    wrap.append(shown, search, dropdown)
    return wrap
  }

  private postJson(path: string, body: Record<string, unknown>, label = 'Save'): Promise<void> {
    return postDaemonJson(this.shuttleBase, path, body, label)
  }

  /**
   * Open the dock on a card whose start was refused for want of a project
   * directory, with the composer's inline prompt already showing.
   */
  openStartPrompt(card: KanbanCard, body: DispatchFailureBody): void {
    if (this.card?.id === card.id && this.card.originId === card.originId && this.composerSend && this.composerError && this.freshButton) {
      const send = this.composerSend
      const parked = send.draftKey()
      this.showStartPrompt(this.composerError, this.card, body, () => send.compose(parked), 'fresh', this.freshButton)
      return
    }
    this.pendingStartPrompt = { cardId: card.id, body }
    this.open(card)
  }

  /**
   * Manual requeue: one force dispatch ({@link postForceDispatch}) carrying the
   * message and the resume intent inline. The daemon resolves the session to
   * resume from the fiber's `shuttle.session_uuid`, falling back to fresh when
   * there is nothing to resume. `projectDir` is a directory the human confirmed
   * in the prompt a refused start raised ({@link showStartPrompt}).
   *
   * `directive` is the message, or the composer's function that resolves it
   * (uploading pasted images first); it is resolved after any cut is
   * confirmed, and a rejection is shown and sends nothing. Resolves true once
   * a worker runs for the card.
   */
  private async runRequeue(
    card: KanbanCard,
    directive: Directive,
    mode: 'fresh' | 'previous',
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
    projectDir?: string,
  ): Promise<boolean> {
    if (this.composerSend?.busy()) return false
    // A "New session" over a LIVE worker is a CUT: the daemon stamps the
    // clean-exit marker, kills the running session, and starts fresh — which
    // discards whatever in-flight context that worker was holding. Confirm
    // before doing that. A dormant card (no live worker) cuts nothing, so it's
    // silent; Resume never cuts, so it never confirms.
    if (mode === 'fresh' && hasWorkerToStop(card)) {
      const working = card.runtimePhase === 'working' ? ' (actively working)' : ''
      const ok = window.confirm(
        `A worker is still running for “${card.name}”${working}.\n\n` +
          `Start a new session? This cuts the open session and discards its ` +
          `in-flight context. Use Resume instead to continue that worker.`,
      )
      if (!ok) return false
    }

    // Every composer verb is held until this send lands or fails.
    const busy = this.composerBusy
    busy?.(true, btn)
    try {
      return await this.sendRequeue(card, directive, mode, btn, errorEl, projectDir)
    } finally {
      busy?.(false, btn)
    }
  }

  /** {@link runRequeue} past its confirmation: compose, dispatch, report. */
  private async sendRequeue(
    card: KanbanCard,
    directive: Directive,
    mode: 'fresh' | 'previous',
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
    projectDir?: string,
  ): Promise<boolean> {
    const epoch = this.epoch
    const original = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = mode === 'fresh' ? 'Starting…' : 'Resuming…'
    errorEl.style.display = 'none'

    let text: string
    try {
      text = typeof directive === 'string' ? directive : await directive()
    } catch (err: unknown) {
      const detail = (err as { message?: string })?.message ?? String(err)
      this.showDispatchError(errorEl, btn, original, detail)
      return false
    }

    if (epoch !== this.epoch) return false
    let res: Response
    try {
      res = await postForceDispatch(this.shuttleBase, card, {
        user_message: text,
        resume_mode: mode,
        ...(projectDir ? { project_dir: projectDir } : {}),
      })
    } catch (err: unknown) {
      const detail = (err as { message?: string })?.message ?? String(err)
      this.showDispatchError(errorEl, btn, original, `Couldn't reach Shuttle: ${detail}`)
      return false
    }

    const body = (await res.json().catch(() => ({}))) as DispatchFailureBody & { tmux_session?: string }
    if (epoch !== this.epoch) {
      if (res.ok || (res.status === 409 && body.tmux_session)) this.onSaved()
      return false
    }

    if (res.status === 409) {
      // A message the worker did not take stays in the composer.
      if (body.tmux_session && text.trim() === '') {
        btn.textContent = original
        this.finishRequeue(card, body.tmux_session)
        return true
      }

      this.blockedDispatches.set(btn, { worker: workerIdentity(card), label: original, error: errorEl })
      btn.textContent = 'Already running'
      btn.disabled = true
      errorEl.textContent = 'A worker is already running for this fiber.'
      errorEl.style.display = ''
      return false
    }

    if (!res.ok) {
      btn.disabled = false
      btn.textContent = original
      if (needsProjectDir(body)) {
        this.showStartPrompt(errorEl, card, body, directive, mode, btn)
        return false
      }
      const msg = dispatchFailureMessage(body, `Requeue failed (${res.status})`, res.status)
      this.showDispatchError(errorEl, btn, original, msg)
      return false
    }

    btn.disabled = false
    btn.textContent = original
    // A message resumed into a live terminal worker was typed into its
    // conversation; the human stays here rather than being sent to the tab.
    const typedIntoLive = mode === 'previous' && text.trim() !== '' && hasLiveWorker(card)
    this.finishRequeue(card, typedIntoLive ? undefined : body.tmux_session)
    return true
  }

  /**
   * Answer a start refused for want of a project directory in place: the
   * owning host's reason and a directory field, prefilled from the nearest
   * ancestor's `project_dir` when the card has one. Start composes the visible
   * message again and retries the launch mode with the confirmed directory.
   * A Desk drag carries no message unless the parked draft was edited.
   */
  private showStartPrompt(
    errorEl: HTMLElement,
    card: KanbanCard,
    body: DispatchFailureBody,
    directive: Directive,
    mode: 'fresh' | 'previous',
    btn: HTMLButtonElement,
  ): void {
    const prompt = buildProjectDirPrompt({
      reason: dispatchFailureMessage(body, 'The start was refused.'),
      host: body.host ?? card.shuttleHost,
      suggestion: card.inheritedProjectDir,
      onStart: (dir) => {
        const send = this.composerSend
        const epoch = this.epoch
        void this.runRequeue(card, directive, mode, btn, errorEl, dir).then(ok => {
          if (ok) send?.sent()
          else if (epoch === this.epoch && errorEl.contains(prompt)) {
            const retry = prompt.querySelector<HTMLButtonElement>('button')
            if (retry) retry.disabled = false
          }
        })
      },
    })
    errorEl.replaceChildren(prompt)
    errorEl.style.display = ''
  }

  /**
   * Refresh worker metadata after dispatch and open a terminal on desktop.
   * On a phone the real worker anchor remains the opening gesture.
   */
  private finishRequeue(card: KanbanCard, tmuxSession?: string): void {
    this.onSaved()
    if (tmuxSession && !coarsePointer()) {
      this.onOpenWorker?.(tmuxSession, card.originId)
    }
  }

  private showDispatchError(
    errorEl: HTMLElement,
    btn: HTMLButtonElement,
    originalBtnText: string,
    message: string,
  ): void {
    errorEl.textContent = message
    errorEl.style.display = ''
    btn.disabled = false
    btn.textContent = originalBtnText
  }

  /**
   * Load the agent registry and wire the composing picker: base agent select
   * (aliases filtered out, grouped by harness, each named by its id — the
   * word the board card prints), an effort select whose options come from the
   * selected agent's `effort_levels`, a chrome toggle gated on
   * `chrome_capable`, and the session choice, which only a Codex agent has.
   * An axis the selected agent lacks is hidden rather than shown disabled.
   * An agent change repopulates dependent controls and writes the changed
   * axes together; an effort, chrome or session edit writes only that axis.
   * A refused write restores the last composition that landed. Polls re-seed
   * the controls while settings are unfocused and no save is pending.
   *
   * When the registry can't be read, the controls keep showing the card's own
   * values, frozen: the fact stays legible even where it can't be edited.
   */
  private async loadAgentPicker(
    controls: {
      agentSelect: HTMLSelectElement
      effortSelect: HTMLSelectElement
      chromeToggle: HTMLInputElement
      surface: Segmented<ExecutionSurface>
      /** The session row; null where there is no block to carry the choice. */
      surfaceRow: HTMLElement | null
    },
    current: AgentAxes,
    onCommit: (axes: Partial<AgentAxes>) => Promise<boolean>,
  ): Promise<((axes: AgentAxes) => void) | undefined> {
    const { agentSelect, effortSelect, chromeToggle, surface, surfaceRow } = controls
    const chromeChip = chromeToggle.parentElement
    const freeze = (why: string): void => {
      for (const el of [agentSelect, effortSelect, chromeToggle]) el.disabled = true
      surface.setDisabled(true)
      effortSelect.hidden = effortSelect.options.length === 0
      agentSelect.title = why
    }
    let records: AgentRecord[]
    try {
      // The daemon's registry is a bare array (`shuttle agents --json`,
      // degrading to `[]` when Shuttle is unavailable). A non-array body is
      // malformed — treat it as empty rather than trusting it.
      const res = await fetch(`${this.shuttleBase}/api/v1/agents`)
      if (!res.ok) throw new Error(`${res.status}`)
      const raw = (await res.json()) as AgentRecord[]
      records = Array.isArray(raw) ? raw : []
    } catch {
      freeze('Agent registry unavailable')
      return
    }

    // Base agents only — alias records are a convenience that the composing
    // picker supersedes; resolving one to its base + axes belongs to the
    // registry, not this list.
    const base = records.filter((a) => !a.alias_of)
    if (base.length === 0) {
      freeze('No agents in the registry')
      return
    }

    const defaultAgent = current.agent ? undefined : base.find((a) => a.default)?.id
    agentSelect.replaceChildren()
    for (const group of agentGroups(base)) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = group.label
      for (const agent of group.agents) {
        const opt = new Option(agent.id, agent.id)
        if (agent.model) opt.title = agent.model
        if (agent.id === current.agent || (!current.agent && agent.id === defaultAgent)) {
          opt.selected = true
        }
        optgroup.append(opt)
      }
      agentSelect.append(optgroup)
    }
    // A current agent absent from the registry stays selectable as a custom
    // entry so an unknown id isn't silently rewritten on the next edit.
    if (current.agent && !base.some((a) => a.id === current.agent)) {
      const opt = new Option(`${current.agent} (custom)`, current.agent, true, true)
      agentSelect.prepend(opt)
    }

    const recordFor = (id: string): AgentRecord | undefined => records.find((a) => a.id === id)
    const selectedAgent = (): string => agentSelect.value

    // Repopulate effort, chrome and session from an agent's metadata. The
    // selected effort is always concrete: an omitted/invalid fiber value
    // resolves to the agent's registry default, so an agent change writes the
    // new agent's explicit effective effort.
    const syncDependents = (agentId: string, effort: string): void => {
      const rec = recordFor(agentId)
      const levels = rec?.effort_levels ?? []
      effortSelect.replaceChildren(...levels.map((lvl) => new Option(lvl, lvl)))
      effortSelect.disabled = levels.length === 0
      effortSelect.hidden = levels.length === 0
      effortSelect.value = levels.includes(effort)
        ? effort
        : rec?.default_effort && levels.includes(rec.default_effort)
          ? rec.default_effort
          : ''

      const chromeOk = rec?.chrome_capable ?? false
      chromeToggle.disabled = !chromeOk
      if (!chromeOk) chromeToggle.checked = false
      if (chromeChip) chromeChip.hidden = !chromeOk

      const supportsApp = isCodexAgent(rec)
      if (rec && !supportsApp) surface.set('cli')
      surface.setDisabled(!supportsApp)
      if (surfaceRow) surfaceRow.hidden = !supportsApp
    }

    syncDependents(selectedAgent() || current.agent, current.effort)
    chromeToggle.checked = current.chrome && !chromeToggle.disabled
    if (isCodexAgent(recordFor(selectedAgent()))) surface.set(current.surface)

    let landed = {
      agent: selectedAgent(),
      effort: effortSelect.value,
      chrome: chromeToggle.checked,
      surface: surface.value,
    }
    let intended = { ...landed }
    let revision = 0
    const axisRequests: Partial<Record<keyof AgentAxes, number>> = {}
    const paint = (axes: AgentAxes): AgentAxes => {
      if (axes.agent && ![...agentSelect.options].some(option => option.value === axes.agent)) {
        agentSelect.prepend(new Option(`${axes.agent} (custom)`, axes.agent))
      }
      agentSelect.value = axes.agent || defaultAgent || ''
      syncDependents(selectedAgent(), axes.effort)
      chromeToggle.checked = axes.chrome && !chromeToggle.disabled
      surface.set(isCodexAgent(recordFor(selectedAgent())) ? axes.surface : 'cli')
      return { agent: selectedAgent(), effort: effortSelect.value, chrome: chromeToggle.checked, surface: surface.value }
    }
    const sync = (axes: AgentAxes): void => {
      landed = paint(axes)
      intended = { ...landed }
    }
    const commit = (axis: keyof AgentAxes): void => {
      const axes: AgentAxes = { agent: selectedAgent(), effort: effortSelect.value, chrome: chromeToggle.checked, surface: surface.value }
      const patch: Partial<AgentAxes> = axis === 'agent'
        ? Object.fromEntries(Object.entries(axes).filter(([key, value]) => value !== intended[key as keyof AgentAxes]))
        : { [axis]: axes[axis] }
      if (!Object.keys(patch).length) return
      intended = axes
      const request = ++revision
      const keys = Object.keys(patch) as Array<keyof AgentAxes>
      for (const key of keys) axisRequests[key] = request
      void onCommit(patch).then((ok) => {
        if (ok) landed = { ...landed, ...patch }
        else {
          // Restore only refused axes that have no newer intent behind them.
          for (const key of keys) if (axisRequests[key] === request) Object.assign(intended, { [key]: landed[key] })
          intended = paint(intended)
        }
      })
    }

    let keyboardChange = false
    for (const select of [agentSelect, effortSelect]) {
      select.addEventListener('keydown', event => {
        keyboardChange = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      })
      select.addEventListener('pointerdown', () => { keyboardChange = false })
      select.addEventListener('blur', () => { keyboardChange = false })
    }
    const scheduleCommit = (axis: keyof AgentAxes, keyboard = keyboardChange): void => {
      keyboardChange = false
      this.deferSetting(axis, () => commit(axis), keyboard)
    }
    agentSelect.addEventListener('change', () => {
      // New agent: select and persist its concrete default effort, re-gate
      // chrome, and pick the session a fresh task on that agent would get —
      // unless the card was already Codex, whose choice carries over.
      syncDependents(selectedAgent(), '')
      chromeToggle.checked = chromeToggle.checked && !chromeToggle.disabled
      const rec = recordFor(selectedAgent())
      if (!isCodexAgent(rec)) surface.set('cli')
      else if (!isCodexAgent(recordFor(intended.agent))) surface.set(defaultSurface(rec))
      scheduleCommit('agent')
    })
    effortSelect.addEventListener('change', () => scheduleCommit('effort'))
    chromeToggle.addEventListener('change', () => scheduleCommit('chrome', false))
    surface.onPick((_, keyboard) => scheduleCommit('surface', keyboard))
    return sync
  }

  /**
   * Write only the changed agent axes through `set-agent`. Coupled changes
   * from picking a new agent travel in one validated write; independent axes
   * leave the daemon's other settings untouched.
   */
  private async commitAxes(
    card: KanbanCard,
    axes: Partial<AgentAxes>,
    statusEl: HTMLElement,
    errorEl: HTMLElement,
  ): Promise<boolean> {
    if ('agent' in axes && !axes.agent) return false
    return this.withSaveStatus(statusEl, errorEl, () =>
      this.postJson('/api/v1/lifecycle', {
        action: 'set-agent',
        origin: card.originId,
        fiber: card.id,
        ...axes,
      }),
    )
  }

  /**
   * One write queue per band serializes all settings mutations. Each write
   * clears the error, shows "Saving…", then fades "Saved" or surfaces its
   * failure verbatim in `errorEl`. The dock stays open through
   * every outcome — live edits don't close the dock. Returns true on
   * success so the caller can advance its local baseline.
   */
  private withSaveStatus(
    statusEl: HTMLElement,
    errorEl: HTMLElement,
    write: () => Promise<void>,
  ): Promise<boolean> {
    const epoch = this.epoch
    this.savesPending++
    const result = this.saveTail.then(async () => {
      if (epoch !== this.epoch) return false
      errorEl.style.display = 'none'
      statusEl.textContent = 'Saving…'
      statusEl.classList.remove('kbn-detail-save-status-saved')
      statusEl.classList.add('kbn-detail-save-status-saving')
      try {
        await write()
        this.onSaved()
        if (epoch !== this.epoch) return false
        statusEl.textContent = 'Saved'
        statusEl.classList.remove('kbn-detail-save-status-saving')
        statusEl.classList.add('kbn-detail-save-status-saved')
        this.later(() => {
          if (statusEl.textContent === 'Saved') {
            statusEl.textContent = ''
            statusEl.classList.remove('kbn-detail-save-status-saved')
          }
        }, 1500)
        return true
      } catch (err: unknown) {
        if (epoch !== this.epoch) return false
        const msg = (err as { message?: string })?.message ?? String(err)
        errorEl.textContent = msg
        errorEl.style.display = ''
        statusEl.textContent = ''
        statusEl.classList.remove('kbn-detail-save-status-saving')
        return false
      }
    }).finally(() => { if (epoch === this.epoch) this.savesPending-- })
    this.saveTail = result.then(() => {})
    return result
  }

  /**
   * Fetch the daemon's full fiber index once per dock opening (`GET
   * /api/v1/fibers`, ids + names only). The parent picker filters it
   * client-side per keystroke — the index is a few hundred rows, so one
   * fetch plus pure filtering replaces a per-keystroke round trip.
   */
  private loadFiberIndex(): Promise<Array<{ id: string; name: string }>> {
    this.fiberIndex ??= fetchFiberIndex(this.shuttleBase).catch((err: unknown) => {
      // Don't cache a failure — the next keystroke retries.
      this.fiberIndex = null
      throw err
    })
    return this.fiberIndex
  }

  /**
   * Parent-picker search: one daemon index fetch per dock opening, then the
   * shared `filterParentCandidates` rule per keystroke.
   */
  private async searchParents(
    q: string,
    excludeId: string,
    dropdown: HTMLElement,
    onSelect: (result: FiberSearchResult) => void,
    reveal: () => void,
  ): Promise<void> {
    // Concurrent triggers (focus + debounced input) can resolve the shared
    // index promise in the same microtask batch — without a token the two
    // renders interleave (clear, clear, append, append) and every option
    // doubles. Only the latest call may render.
    const token = ++this.searchRenderToken
    try {
      const allFibers = await this.loadFiberIndex()
      if (token !== this.searchRenderToken) return
      const candidates = filterParentCandidates(allFibers, q, excludeId)

      dropdown.innerHTML = ''
      if (candidates.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'kbn-detail-parent-option kbn-detail-parent-empty'
        empty.textContent = q ? 'No matches' : 'No fibers available'
        dropdown.append(empty)
        reveal()
        return
      }

      for (const fiber of candidates) {
        const opt = document.createElement('button')
        opt.type = 'button'
        opt.className = 'kbn-detail-parent-option'
        opt.dataset.depth = String(fiber.depth)

        const nameSpan = document.createElement('span')
        nameSpan.className = 'kbn-detail-parent-option-name'
        nameSpan.textContent = fiber.name

        const idSpan = document.createElement('span')
        idSpan.className = 'kbn-detail-parent-option-id'
        idSpan.textContent = fiber.id

        opt.append(nameSpan, idSpan)
        opt.addEventListener('click', (e) => {
          e.stopPropagation()
          onSelect(fiber)
        })
        dropdown.append(opt)
      }
      reveal()
    } catch {
      dropdown.innerHTML = '<div class="kbn-detail-parent-option kbn-detail-parent-empty">Search failed</div>'
      reveal()
    }
  }

  /**
   * Promote a human card to a paused shuttle draft: `:4000/api/v1/lifecycle`
   * `install --disabled`, owner-routed by `origin`. `project_dir` (the
   * worker's cwd) comes from the card's own shuttle block; a card without
   * one installs without it, which a paused draft permits — arming it later
   * supplies the dir or fails loudly.
   */
  private async promoteToShuttle(
    card: KanbanCard,
    agent: string,
    saveBtn: HTMLButtonElement,
    errorEl: HTMLElement,
  ): Promise<void> {
    try {
      await this.postJson('/api/v1/lifecycle', {
        action: 'install',
        origin: card.originId,
        fiber: card.id,
        model: agent,
        project_dir: card.shuttleProjectDir,
        disabled: true,
      }, 'Promote')
      this.onSaved()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      saveBtn.disabled = false
      saveBtn.textContent = 'Promote'
    }
  }

  /**
   * Apply a single-field (or coupled-field) change to the fiber's shuttle
   * block / parent immediately on event. {@link withSaveStatus} owns the
   * status-pill choreography and the boolean this returns.
   */
  private async livePatch(
    card: KanbanCard,
    changes: {
      shuttleKind?: ShuttleKind
      shuttleSchedule?: string
      shuttleTz?: string
      parentId?: string | null
      due?: string | null
    },
    statusEl: HTMLElement,
    errorEl: HTMLElement,
  ): Promise<boolean> {
    return this.withSaveStatus(statusEl, errorEl, async () => {
        const origin = card.originId
        const fiberId = card.id

        const wantsReshape =
          changes.shuttleKind !== undefined ||
          typeof changes.shuttleSchedule === 'string' ||
          typeof changes.shuttleTz === 'string'

        if (wantsReshape) {
          // Changing the SHAPE of an existing block is its own surgical verb.
          // `reshape` rewrites kind + schedule and nothing else — no model, no
          // project_dir, no host, and above all no status: that is what lets a
          // role sitting in Awaiting review (status: closed) be switched
          // standing → oneshot. The agent is NOT carried here; every axis
          // change commits separately through `commitAxes` → `set-agent`.
          //
          // A card with no block yet has nothing to reshape (the verb errors on
          // one), so it takes the create path — `install`/`repeat`, no reshape
          // flag. Current block state comes from the card.
          // The fallback PRESERVES the card's current kind — a schedule/tz-only
          // patch must never quietly change the kind on its way past.
          const targetKind: ShuttleKind = changes.shuttleKind ?? card.shuttleKind ?? 'oneshot'

          const schedule =
            (typeof changes.shuttleSchedule === 'string' && changes.shuttleSchedule.trim()) ||
            card.shuttleSchedule
          const tz =
            (typeof changes.shuttleTz === 'string' && changes.shuttleTz.trim()) ||
            card.shuttleTz || 'UTC'
          if (targetKind === 'standing' && !schedule) {
            throw new Error('standing-kind shuttle blocks require a schedule (cron expression)')
          }

          if (isAgentCard(card)) {
            // A non-standing target DROPS the schedule key server-side, and
            // sending `--schedule` alongside it is an error — so the schedule
            // rides only when the target kind actually carries one.
            await this.postJson(
              '/api/v1/lifecycle',
              targetKind === 'standing'
                ? { action: 'reshape', origin, fiber: fiberId, kind: 'standing', schedule, tz }
                : { action: 'reshape', origin, fiber: fiberId, kind: targetKind },
            )
          } else if (targetKind === 'standing') {
            // Below here the card has NO block yet, so there is nothing to
            // reshape and the create verbs take over.
            await this.postJson('/api/v1/lifecycle', {
              action: 'repeat', origin, fiber: fiberId,
              // Undefined when the block carries none, which a paused install
              // permits; an arming install without one fails loudly.
              schedule, tz, model: card.shuttleAgent, project_dir: card.shuttleProjectDir,
            })
          } else {
            await this.postJson('/api/v1/lifecycle', {
              action: 'install', origin, fiber: fiberId,
              model: card.shuttleAgent, project_dir: card.shuttleProjectDir,
              // A paused draft must stay paused across the install (install
              // defaults to armed; status `open` means draft).
              disabled: card.status === 'open',
            })
          }
        }

        // Reparent: the daemon's `/felt-nest` shells `felt nest`/`felt unnest`
        // on the owning host. The grid refetch reconciles the changed id.
        if ('parentId' in changes) {
          await this.postJson('/api/v1/felt-nest', {
            fiber_id: fiberId,
            origin,
            parent: changes.parentId ?? null,
          })
          // The successful nest confirms this address before the next queued write.
          // Polls reconcile the remaining path metadata without replacing the band.
          const slug = fiberId.split('/').at(-1)!
          card.id = changes.parentId ? `${changes.parentId}/${slug}` : slug
        }

        // `due:` — the same door every other due write on the board knocks on:
        // `/felt-edit`, owner-routed by `origin` (a timeline drop through
        // `setSurface`, the Chronicle's edge drag through `writeDue`). A fiber's
        // due has exactly one write path and this is not a second one. The key's
        // presence is the whole protocol server-side: absent leaves the date,
        // `null` clears it, a string sets it — so the branch tests for the key,
        // not for a truthy value.
        if ('due' in changes) {
          await this.postJson('/api/v1/felt-edit', {
            fiber_id: fiberId,
            origin,
            due: changes.due ?? null,
          })
        }
    })
  }
}
