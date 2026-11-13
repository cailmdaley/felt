import '@ui-sdk/web/segmented-control'
import { paintAncestry, type Ancestor } from './ancestryTrail.js'
import { headerIcon } from './headerIcon.js'
import { attachConversationPicker, openActionMenu } from '../conversationMenu.js'
import { canOpenDesktopApp } from '../conversationLinks.js'
import { confirmWorkerStop, markVerdictHost, type Verdict } from './Verdicts.js'
import { CONVERSATION_OPENING_CHANGED, conversationDestinations, conversationDevice, conversationOpening, linkDestination, resolveDestination, openDestination, type ConversationDestination, type WorkerOpener } from '../conversationOpening.js'
import { hasLiveWorker, hasWorkerToStop, type ColumnKind, type KanbanCard, type ShuttleKind } from '../KanbanTypes.js'
import { agentGroups } from '../../forms/agents.js'
import { dispatchFailureMessage, isAgentCard, needsProjectDir, postForceDispatch, type DispatchFailureBody, type PastedImage } from '../KanbanModalShared.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import { buildProjectDirPrompt } from '../projectDirPrompt.js'
import { fetchFiberIndex, filterParentCandidates, type FiberSearchResult } from '../fiberSearch.js'
import { attachConversation, buildSessionHistory } from '../sessionHistory.js'
import { showToast } from '../utils.js'
import { coarsePointer } from '../mobile.js'
import { formatDue } from '../KanbanSurfaces.js'
import { clockTime, dayClock, dueCivilDay, formatSpanMinutes, instantMs, instantStamp, isoDayLocal } from '../civilDay.js'
import { dressVerb, labelVerb, leadVerb, lifecycleVerbsFor, verbSpec, VERB_KEY, type LifecycleVerb } from './lifecycleVerbs.js'
import { WorkerActions } from './workerActions.js'
import { VoiceStrip, voiceLine, type FiberSlug } from './voiceStrip.js'
import { fetchTranscriptUsage, paintUsage, warmUntil, type TranscriptUsage } from './transcriptUsage.js'
import { slug } from '../threadOutline.js'
import { anchorPopover, type Release } from './anchoredPopover.js'
import { anchorSelect, dismissSelectPicker } from './selectPicker.js'
import { ListenControl } from './ListenControl.js'
import type { PhoneListening } from '../phoneListening.js'
import './tokens.css'
import './dock.css'

interface AgentAxes { agent: string; effort: string; chrome: boolean }
export type SessionMode = 'fresh' | 'previous'

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
  const start = startedToday ? clockTime(dispatched) : dayClock(dispatched)

  if (hasLiveWorker(card)) {
    return {
      text: `since ${start}`,
      state: 'running',
      title: `Worker launched ${instantStamp(dispatched)} and is still running.`,
    }
  }
  if (concluded && handedOff !== undefined) {
    const spannedMidnight = isoDayLocal(handedOff) !== isoDayLocal(dispatched)
    const end = spannedMidnight ? dayClock(handedOff) : clockTime(handedOff)
    // Sub-minute runs read `0m` rather than seconds: the pair of clock times
    // already tells that story, and this figure is for scale.
    const span = formatSpanMinutes(Math.max(0, Math.round((handedOff - dispatched) / 60_000)))
    return {
      text: `${start} → ${end} · ${span}`,
      state: 'clean',
      title:
        `Launched ${instantStamp(dispatched)}; ` +
        `handed off ${instantStamp(handedOff)}.`,
    }
  }
  return {
    text: `${start} · no handoff`,
    state: 'unclean',
    title:
      `Launched ${instantStamp(dispatched)}. The worker never stamped a ` +
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
  if (card.shuttlePulse) {
    const window = card.shuttlePulse.window
      ? ` · ${card.shuttlePulse.window.start}–${card.shuttlePulse.window.end} ${card.shuttlePulse.window.tz}`
      : ''
    const pulse = card.shuttlePulseRuntime
    const next = pulse?.nextTick ? pulseTime(pulse.nextTick) : undefined
    const state = pulse?.state === 'scheduled' && next
      ? ` · next ${next}`
      : pulse?.state && pulse.state !== 'scheduled'
        ? ` · ${pulse.state}`
        : ''
    cadence = {
      text: `every ${card.shuttlePulse.every}${window}${state}`,
      title: pulse?.lastTick
        ? `Seat pulse; last tick ${pulseTime(pulse.lastTick)}${pulse.state ? `; ${pulse.state}` : ''}`
        : `Seat pulse${pulse?.state ? `; ${pulse.state}` : ''}`,
    }
  } else if (card.shuttleKind === 'standing' && card.shuttleSchedule) {
    const spoken = card.scheduleText
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
    seat: card.shuttleSeat === true && card.shuttleRole
      ? { text: `seat of ${card.shuttleRole}`, title: `A seat of roles/${card.shuttleRole}: a worker here sits in that office.` }
      : undefined,
    cadence,
    place,
    due: card.due && placedByDue(card) ? formatDue(card.due) : undefined,
    run: sessionWindow(card, nowMs),
  }
}

function pulseTime(value: string): string {
  const instant = instantMs(value)
  return instant === undefined ? value : dayClock(instant)
}

/** {@link stripFacts} drawn: the facts on the left, the run window on the
 *  right — or on a line of its own where the dock is too narrow for both. */
function buildStrip(card: KanbanCard): HTMLElement {
  const facts = stripFacts(card)
  const strip = document.createElement('span')
  strip.className = 'kbn-ctl-strip'
  if (card.shuttlePulse) strip.classList.add('kbn-ctl-strip-pulse')
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
  if (facts.cadence) put(`kbn-ctl-cadence${card.shuttlePulse ? ' kbn-ctl-pulse' : ''}`, facts.cadence.text, facts.cadence.title)
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

/** A row of mutually exclusive choices, all visible at once: one Tab stop,
 *  arrows move the choice. Setting `value` repaints without `valuechange`. */
function segmented(
  name: string,
  options: ReadonlyArray<readonly [string, string]>,
  initial: string,
): HTMLElementTagNameMap['ui-segmented-control'] {
  const el = document.createElement('ui-segmented-control')
  el.className = 'kbn-ctl-segmented'
  el.setAttribute('default-value', initial)
  el.setAttribute('aria-label', name)
  for (const [value, label] of options) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'kbn-ctl-segment'
    btn.dataset.value = value
    btn.textContent = label
    const item = document.createElement('ui-segmented-control-item')
    item.setAttribute('value', value)
    item.setAttribute('as-child', '')
    item.append(btn)
    el.append(item)
  }
  return el
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

/** The band's links: settings holds the thread's ancestry, the family's head first. */
export interface BandNav {
  ancestry?: readonly Ancestor[]
  desk?: () => void
  /** Back where the reader was opened from; `nameBack` names it. */
  back?: () => void
  /** Opens the constitution's own page: the band's acts carry it where no row's constitution segment does. */
  constitution?: () => void
}

/** A fiber's own acts, drawn wherever a row stands for it: its lifecycle verbs, its conversation and its settings. */
export interface FiberActs {
  readonly el: HTMLElement
  /** Follow the fiber's state: which verbs it offers, and in what words. */
  paint(): void
  dispose(): void
}

/** What each lifecycle verb but Rest asks of the undo queue. */
const VERB_VERDICT = { review: 'awaitingReview', temper: 'tempered', discard: 'composted' } as const

/** Settings provenance: agent, office and host, with no office repeating the name. */
export function bandFacts(card: KanbanCard): string {
  const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const role = card.shuttleRole && slug(card.shuttleRole) !== slug(card.name) ? card.shuttleRole : undefined
  return [card.workerAgent ?? card.shuttleAgent, role, card.shuttleHost ?? card.originId].filter(Boolean).join(' · ')
}

export interface DockOptions {
  voice?: { controller: import('../voice.js').Voice }
  phone?: PhoneListening
  /** Opens the Rest popover on the button that asked for it. */
  onRest?: (card: KanbanCard, anchor: HTMLElement) => void
}

/** A warm cache dot drains on this cadence, and the figures follow the session's turns. */
const USAGE_REFRESH_MS = 15_000

/**
 * The band above a constitution's pages, two lines that stay in place while
 * the pages beneath change. The first is identity and navigation: back, the
 * name (with the highlighted thread's after it), the context meter, and ×.
 * The second is the message box, with Listen, Send and New session inside it.
 * A fiber's verbs live on its row ({@link actsFor}); only where no row stands
 * for the fiber (a page other than its family's) does the band draw them.
 */
export class Dock {
  private root: HTMLElement | null = null
  /** The band's × returns directly to the Desk, never a lifecycle write. */
  private leave: HTMLButtonElement | null = null
  private back: HTMLButtonElement | null = null
  private backLabel = ''
  private ancestry: HTMLElement | null = null
  private drawerClose: (() => boolean) | null = null
  private card: KanbanCard | null = null
  private actionCard: KanbanCard | null = null
  private searchDebounce: number | null = null
  private fiberIndex: Promise<Array<{ id: string; name: string }>> | null = null
  private searchRenderToken = 0
  /** Opens a file in the reader's viewer; the workspace seats it. */
  openFile?: (path: string, title?: string, owner?: string) => void
  /** The family page draws a row for the band's fiber, so the band leaves the verbs to it. */
  private rows = false
  /** Opens the band's fiber's own page, from the constitution button its acts carry. */
  private openConstitution: (() => void) | null = null
  /** The band stands over the page, so its settings sheet can open; the reader seats it. */
  private seated = true
  /** Every fiber's acts drawn now, by its repaint: the band's and each row's. */
  private readonly liveActs = new Set<() => void>()
  /** Opens the settings sheet for a fiber, under the control that asked; null while no band is built, and the acts draw no ⚙. */
  private settingsFor: ((card: KanbanCard, opener: HTMLElement) => void) | null = null
  private listen: ListenControl | null = null
  private voiceStrip: VoiceStrip | null = null
  private disposers: (() => void)[] = []
  private dismissParent: (() => boolean) | null = null
  private dismissConversation: (() => boolean) | null = null
  private errorEl: HTMLElement | null = null
  /** A session verb is in flight; every verb holds until it lands. */
  private starting = false
  private actPaint: (() => void) | null = null
  private settingsSync: ((view: KanbanCard) => void) | null = null
  private historySync: (() => void) | null = null
  private usage: TranscriptUsage | null = null
  private usageSession: string | undefined
  private savesPending = 0
  private saveTail: Promise<void> = Promise.resolve()
  private settingStep: { key: string; run: () => void; timer: number } | null = null
  private epoch = 0
  private readonly timers = new Set<number>()
  private readonly shuttleBase: string
  private readonly onSaved: () => void
  private readonly onTransition: (card: KanbanCard, target: ColumnKind) => void
  private queueVerdict?: (card: KanbanCard, target: Verdict) => void
  private readonly onOpenWorker?: WorkerOpener
  private readonly phone: PhoneListening | undefined
  private readonly voice: DockOptions['voice']
  private readonly onRest?: (card: KanbanCard, anchor: HTMLElement) => void
  private fiberSlug?: FiberSlug

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
    this.phone = opts.phone
    this.voice = opts.voice
    this.onRest = opts.onRest
  }

  setFiberSlug(fiberSlug: FiberSlug): void { this.fiberSlug = fiberSlug }

  /** The band's element, built on first use so controls can be exercised without a page. */
  get el(): HTMLElement {
    if (!this.root) {
      this.root = document.createElement('div')
      this.root.className = 'ws-dock'
      this.root.dataset.part = 'act'
      this.root.dataset.act = 'band'
      this.root.tabIndex = -1
      this.root.addEventListener('click', event => event.stopPropagation())
    }
    return this.root
  }

  openSettings?: (content: HTMLElement, opener: HTMLElement) => void
  closeSettings?: (after: () => void) => void

  /** Names where the band's back goes, as the visited path changes under it. */
  nameBack(label: string): void {
    this.backLabel = label
    if (!this.back) return
    this.back.title = `Back to ${label}`
    this.back.setAttribute('aria-label', this.back.title)
  }
  setNav(nav: BandNav): void {
    if (!this.ancestry) return
    paintAncestry(this.ancestry, nav.ancestry ?? [])
    this.openConstitution = nav.constitution ?? null
    this.actPaint?.()
    if (this.back) {
      this.back.hidden = !nav.back
      this.back.onclick = nav.back ?? null
      this.nameBack(this.backLabel)
    }
    if (this.leave) {
      this.leave.hidden = !nav.desk
      this.leave.onclick = nav.desk ?? null
      this.leave.title = 'Return to Desk'; this.leave.setAttribute('aria-label', 'Return to Desk')
    }
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
    const promoted = this.card !== null && !isAgentCard(this.card) && isAgentCard(card)
    if (this.card && (this.card.uid ?? this.card.id) === (card.uid ?? card.id) && this.card.originId === card.originId && !promoted) {
      this.syncRuntime(card)
      return
    }
    this.clear()
    // Controls share this copy, so a runtime poll updates confirmation and
    // opening targets without replacing the settings fields.
    this.card = { ...card }
    const view = this.card
    this.el.append(this.buildControls(view, isAgentCard(view)))
    this.syncRuntime(view)
  }

  /** Forget the card and its controls. */
  reset(): void { this.clear() }

  private clear(): void {
    this.epoch++
    this.dismissConversation?.()
    this.dismissParent?.()
    this.dismissConversation = this.dismissParent = null
    this.listen?.dispose()
    this.listen = null
    this.voiceStrip = null
    for (const dispose of this.disposers.splice(0)) dispose()
    if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
    this.searchDebounce = null
    this.searchRenderToken++
    this.fiberIndex = null
    this.card = this.actionCard = null
    this.settingsFor = this.openConstitution = null
    this.repaintActs()
    for (const timer of this.timers) window.clearTimeout(timer)
    this.timers.clear()
    this.starting = false
    this.errorEl = null
    this.actPaint = null
    this.settingsSync = null
    this.historySync = null
    this.usage = null
    this.usageSession = undefined
    this.settingStep = null
    this.savesPending = 0
    this.saveTail = Promise.resolve()
    this.root?.replaceChildren()
    this.ancestry = this.leave = this.back = null
    this.drawerClose = null
  }

  handleEscape(): boolean {
    if (this.listen?.dismiss()) return true
    if (dismissSelectPicker()) return true
    if (this.dismissConversation?.() || this.dismissParent?.()) return true
    return this.drawerClose?.() ?? false
  }

  /** Repaint the destination beside Listen. */
  private paintVoice(): void {
    this.voiceStrip?.paint(voiceLine(this.voice?.controller.status ?? null, (fiber, origin) => this.fiberSlug?.(fiber, origin)))
  }

  /**
   * Where the conversation is for this card: the remembered destination or the
   * best usable one, or, on a desktop with no worker up, the past session
   * reopened in a terminal on its host. A link the human chose still wins over
   * reopening. Null when there is nowhere to go.
   */
  private conversationRoute(card: KanbanCard): { reopen: false; destination: ConversationDestination } | { reopen: true } | null {
    const destination = resolveDestination(conversationDestinations(card, conversationDevice(), this.onOpenWorker))
    if (conversationDevice().desktop && card.sessionUuid && !hasLiveWorker(card) && destination?.id !== conversationOpening()) return { reopen: true }
    return destination ? { reopen: false, destination } : null
  }

  /** Whether `c` and the band's console have somewhere to take the human. */
  canOpenConversation(card: KanbanCard): boolean { return this.conversationRoute(card) !== null }

  /**
   * Take the human to the conversation ({@link conversationRoute}). A reopening
   * sends nothing and starts no turn, and it leaves the card's lifecycle alone,
   * so it holds in every column. This is the explicit act (`c`, the band's
   * console, a Desk row's menu); a click on a row calls `Workspace.reach` instead.
   */
  openConversation(card: KanbanCard): boolean {
    const route = this.conversationRoute(card)
    if (!route) return false
    if (route.reopen) void attachConversation(this.shuttleBase, { session: card.sessionUuid!, shuttle_host: card.shuttleHost ?? null }, message => showToast(message, 'error'))
    else openDestination(route.destination)
    return true
  }

  /**
   * The band's console: opens the highlighted card's conversation as `c` does.
   * A destination with an address is a native link, so app schemes and web
   * links keep their gesture semantics; long-press or right-click picks
   * another destination.
   */
  private buildConsole(target: () => KanbanCard): { el: HTMLAnchorElement; paint: () => void; dispose: () => void } {
    const el = document.createElement('a')
    el.className = 'ws-header-icon ws-acts-console'
    el.dataset.part = 'console'
    el.tabIndex = 0
    el.innerHTML = headerIcon('console')
    el.addEventListener('click', event => {
      event.stopPropagation()
      if (el.hasAttribute('href')) return
      event.preventDefault()
      this.openConversation(target())
    })
    el.addEventListener('keydown', event => {
      if (el.hasAttribute('href') || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault(); el.click()
    })
    const dispose = attachConversationPicker(el, () => conversationDestinations(target(), conversationDevice(), this.onOpenWorker))
    const paint = (): void => {
      const card = target(), route = this.conversationRoute(card)
      el.hidden = !route
      const href = route && !route.reopen ? route.destination.href : undefined
      // One anchor serves every destination, so each paint starts from a bare link.
      el.removeAttribute('href'); el.removeAttribute('target'); el.removeAttribute('rel')
      if (href) { linkDestination(el, href); el.removeAttribute('role') }
      else el.setAttribute('role', 'button')
      if (!route) return
      const who = slug(card)
      const label = route.reopen
        ? `Reopen ${who}'s last session${card.shuttleHost ? ` on ${card.shuttleHost}` : ''}`
        : `Open ${who}'s conversation in ${route.destination.label}`
      el.setAttribute('aria-label', `${label} (c)`)
      el.title = route.reopen ? `${label} (c)` : `${label} (c)\nLong-press or right-click to choose where to open.`
    }
    return { el, paint, dispose }
  }

  /**
   * A fiber's acts, for whatever draws a row for it: its lifecycle verbs as one
   * button ({@link verbButton}), then its session pair, its conversation (as `c`
   * opens it) and its settings sheet. The whole strip is the fiber's verdict
   * host, so an undo window takes its place.
   */
  actsFor(target: () => KanbanCard, constitution?: () => (() => void) | null): FiberActs {
    const el = document.createElement('span')
    el.className = 'ws-fiber-acts'
    el.dataset.part = 'acts'
    el.setAttribute('role', 'group')
    const verbs = this.verbButton(target)
    const conversation = this.buildConsole(target)
    const settings = document.createElement('button')
    settings.type = 'button'
    settings.className = 'ws-header-icon ws-acts-settings'
    settings.dataset.part = 'settings'
    settings.innerHTML = headerIcon('settings')
    settings.setAttribute('aria-haspopup', 'true')
    settings.setAttribute('aria-expanded', 'false')
    settings.addEventListener('click', () => this.settingsFor?.(target(), settings))
    const session = document.createElement('span')
    session.className = 'ws-acts-session'
    session.append(conversation.el)
    // A row's own constitution segment unfolds it; the band's acts open the page instead.
    const page = constitution && document.createElement('button')
    if (page) {
      page.type = 'button'
      page.className = 'ws-header-icon ws-band-constitution'
      page.innerHTML = headerIcon('constitution')
      page.title = 'Constitution'; page.setAttribute('aria-label', 'Constitution')
      page.addEventListener('click', () => constitution!()?.())
      session.append(page)
    }
    session.append(settings)
    el.append(verbs.el, session)
    const paint = (): void => {
      const card = target(), who = slug(card)
      markVerdictHost(el, card)
      el.setAttribute('aria-label', `${who}'s acts`)
      verbs.paint(card, who)
      conversation.paint()
      if (page) page.hidden = !constitution!()
      settings.hidden = !this.seated || !this.settingsFor
      settings.title = `Settings for ${who}`
      settings.setAttribute('aria-label', settings.title)
    }
    paint()
    this.liveActs.add(paint)
    return { el, paint, dispose: () => { this.liveActs.delete(paint); conversation.dispose() } }
  }

  /**
   * A fiber's lifecycle verbs as one button: its face is the verb that fits
   * the fiber's state ({@link leadVerb}), and a caret on the same pill opens a
   * menu of the rest, each with its key. The set is the lifecycle model's
   * ({@link lifecycleVerbsFor}); Discard and Retire only ever sit in the menu.
   */
  private verbButton(target: () => KanbanCard): { el: HTMLElement; paint(card: KanbanCard, who: string): void } {
    const el = document.createElement('span')
    el.className = 'ws-acts-verbs'
    el.setAttribute('role', 'group')
    const face = document.createElement('button')
    face.type = 'button'
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'ws-verb-more'
    more.innerHTML = headerIcon('more')
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', 'false')
    el.append(face, more)
    let offered: LifecycleVerb[] = [], lead: LifecycleVerb | undefined, drawn = ''
    const act = (verb: LifecycleVerb, anchor: HTMLElement): void => {
      const card = target()
      if (verb === 'rest') this.onRest?.(card, anchor)
      else this.verdict(card, VERB_VERDICT[verb])
    }
    face.addEventListener('click', () => { if (lead) act(lead, face) })
    more.addEventListener('click', () => {
      const card = target(), box = el.getBoundingClientRect()
      openActionMenu(more, offered.filter(verb => verb !== lead).map(verb => ({
        label: verbSpec(verb, card).label,
        dress: (item: HTMLButtonElement) => { dressVerb(item, verb, card) },
        run: () => act(verb, el),
      })), `${slug(card)}'s other verbs`, { x: box.left, y: box.bottom + 4 })
    })
    const paint = (card: KanbanCard, who: string): void => {
      offered = lifecycleVerbsFor(card, !!this.onRest)
      lead = leadVerb(card, offered)
      const rest = offered.filter(verb => verb !== lead)
      el.hidden = !offered.length
      el.setAttribute('aria-label', `${who}'s verbs`)
      face.hidden = !lead
      more.hidden = !rest.length
      const words = rest.map(verb => `${verbSpec(verb, card).label} (${VERB_KEY[verb]})`).join(', ')
      more.title = `More: ${words}`
      more.setAttribute('aria-label', `More verbs for ${who}: ${words}`)
      if (!lead) return
      const spec = verbSpec(lead, card)
      face.className = `ws-verb-face ${spec.cls}`
      labelVerb(face, lead, card, who)
      if (drawn === `${spec.icon}:${spec.label}`) return
      drawn = `${spec.icon}:${spec.label}`
      face.innerHTML = headerIcon(spec.icon)
      const word = document.createElement('span'); word.className = 'ws-verb-word'; word.textContent = spec.label
      face.append(word)
    }
    return { el, paint }
  }

  /** A worker's own line for an opening message, Resume and New session, for a page to seat beside that worker. */
  workerActionsFor(card: KanbanCard): WorkerActions {
    return new WorkerActions(card, (target, mode, message, word, images) => this.startSession(target, mode, word, undefined, message, images))
  }

  /**
   * Retarget the band's figures and message box without changing its identity
   * or settings. `rows` says a family page beneath draws the fiber's row, and
   * with it the fiber's acts.
   */
  setActionCard(card: KanbanCard, rows = false): void {
    this.rows = rows
    const previous = this.actionCard ?? this.card
    if (previous && ((previous.uid ?? previous.id) !== (card.uid ?? card.id) || previous.originId !== card.originId) && this.errorEl) {
      this.errorEl.replaceChildren()
      this.errorEl.style.display = 'none'
    }
    this.actionCard = card
    this.followUsage()
    this.actPaint?.()
  }

  /** The band shares the workspace's identity-keyed undo queue. */
  setVerdictQueue(queue?: (card: KanbanCard, target: Verdict) => void): void {
    this.queueVerdict = queue
  }

  verdict(card: KanbanCard, target: Verdict): void {
    if (this.queueVerdict) this.queueVerdict(card, target)
    else if (confirmWorkerStop(card, target)) this.commitVerdict(card, target)
  }

  /** Only the expired undo queue calls this in the workspace. */
  commitVerdict(card: KanbanCard, target: Verdict): void {
    this.onTransition(card, target)
  }

  /** Refresh the band without replacing folded fields. */
  syncRuntime(card: KanbanCard | null): void {
    if (!card || !this.card ||
      (this.card.uid ?? this.card.id) !== (card.uid ?? card.id) || this.card.originId !== card.originId) return
    const incoming = card
    for (const key of ['id', 'uid', 'path', 'fiberDir', 'feltStore', 'shuttleHost', 'shuttleProjectDir', 'sessionUuid', 'tmuxSession', 'terminalBackend', 'rexSession', 'sessionLink', 'runtimePhase', 'lastActivityAt', 'launchError', 'workerState', 'workerAgent', 'dispatchedAt', 'handedOffAt', 'status', 'tempered', 'column', 'turn', 'effectiveHorizon', 'outcome', 'ask', 'workerStartedAt', 'originStale', 'tags'] as const) {
      Object.assign(this.card, { [key]: card[key] })
    }
    card = this.card
    this.settingsSync?.(incoming)
    this.historySync?.()
    this.followUsage()
    this.actPaint?.()
  }

  /** The figures follow the highlighted card's session, as the verbs do. */
  private followUsage(): void {
    const card = this.actionCard ?? this.card
    if (!card || card.sessionUuid === this.usageSession) return
    this.usageSession = card.sessionUuid
    this.usage = null
    void this.readUsage(card)
  }

  /** Read the card's session usage and repaint; a failed read keeps the last figures, and one that outlives its session or band is dropped. */
  private async readUsage(card: KanbanCard): Promise<void> {
    const session = card.sessionUuid
    if (!session) return
    const epoch = this.epoch
    const usage = await fetchTranscriptUsage(this.shuttleBase, session, card.shuttleHost)
    if (this.epoch !== epoch || this.usageSession !== session) return
    this.usage = usage ?? this.usage
    this.actPaint?.()
  }

  /** Whether the band stands over the page; without it the acts draw no ⚙. */
  setSeated(seated: boolean): void {
    if (this.seated === seated) return
    this.seated = seated
    this.repaintActs()
  }

  /** Repaint every fiber's acts drawn now, as the band they reach comes and goes. */
  private repaintActs(): void { for (const paint of this.liveActs) paint() }

  refreshConversationOpening(): void {
    this.repaintActs()
    this.actPaint?.()
    this.root?.querySelectorAll('.kbn-ctl-history').forEach((history) => {
      history.dispatchEvent(new Event(CONVERSATION_OPENING_CHANGED))
    })
  }

  private buildControls(card: KanbanCard, shuttleManaged: boolean): HTMLElement {
    const body = document.createElement('div')
    body.className = 'ws-dock-body'
    const statusEl = document.createElement('span')
    statusEl.className = 'kbn-detail-save-status'
    statusEl.setAttribute('aria-live', 'polite')
    const errorEl = this.errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.setAttribute('role', 'alert')
    errorEl.style.display = 'none'
    const showError = (message: string | null): void => {
      errorEl.textContent = message ?? ''
      errorEl.style.display = message ? '' : 'none'
    }

    /**
     * The settings sheet for one card: its agent and card fields, then its
     * sessions. The band's own card keeps its sheet in step with runtime polls;
     * a thread's sheet is drawn fresh each time the gear opens it.
     */
    const sheetFor = (card: KanbanCard, shuttleManaged: boolean, own: boolean) => {
      const settings = document.createElement('div')
      settings.className = 'kbn-detail-controls'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'kbn-detail-controls-toggle'
      if (card.shuttlePulse) toggle.classList.add('kbn-detail-controls-toggle-pulse')
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
      if (own) this.settingsSync = (view) => {
        if (ledger.contains(document.activeElement) || this.savesPending || this.settingStep) return
        for (const key of ['name', 'due', 'storedHorizon', 'isCycle', 'shuttleAgent', 'shuttleEffort', 'shuttleChrome', 'shuttleKind', 'shuttleSchedule', 'shuttleTz', 'scheduleText', 'nextLaunchAt', 'inheritedProjectDir'] as const) {
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
      const historyKey = (): string => JSON.stringify([card.uid, card.shuttleHost, hasLiveWorker(card), card.sessionUuid, card.tmuxSession, card.terminalBackend])
      let historyRevision = historyKey()
      const refreshHistory = (open: boolean): void => {
        if (!card.uid) return
        const focusToggle = document.activeElement === history?.querySelector('.kbn-ctl-history-toggle')
        const next = buildSessionHistory({
          shuttleBase: this.shuttleBase, uid: card.uid, fiberHost: card.shuttleHost,
          liveSession: hasLiveWorker(card) ? card.sessionUuid : undefined, liveTmux: card.tmuxSession, terminalBackend: card.terminalBackend,
          desktop: canOpenDesktopApp(navigator.userAgent, coarsePointer()),
          onError: showError,
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
      if (own) this.historySync = () => {
        const revision = historyKey()
        if (revision === historyRevision) return
        historyRevision = revision
        refreshHistory(history?.classList.contains('kbn-ctl-history-open') ?? false)
      }
      return { settings, toggle, ledger, history: () => history }
    }
    let sheetCard = card
    let sheet = sheetFor(card, shuttleManaged, true)
    const foot = document.createElement('div')
    foot.className = 'kbn-ctl-foot ws-band-status'
    foot.append(errorEl, statusEl)
    const target = (): KanbanCard => this.actionCard ?? card
    const worker = this.workerActionsFor(card)
    this.disposers.push(() => worker.dispose())
    // Where no row stands for the fiber, the band draws its acts.
    const acts = this.actsFor(target, () => this.openConstitution)
    this.disposers.push(acts.dispose)

    // A single settings sheet owns configuration and history.
    const drawer = document.createElement('div')
    drawer.className = 'ws-band-drawer'
    drawer.hidden = true
    const settingsSection = document.createElement('section')
    settingsSection.className = 'ws-band-section'
    settingsSection.setAttribute('aria-label', 'Settings')
    const sheetName = document.createElement('p')
    sheetName.className = 'ws-band-sheet-name'
    sheetName.hidden = true
    settingsSection.append(sheetName, sheet.settings)
    const sessionsSection = document.createElement('section')
    sessionsSection.className = 'ws-band-section'
    sessionsSection.setAttribute('aria-label', 'Sessions')
    const firstHistory = sheet.history()
    if (firstHistory) sessionsSection.append(firstHistory)
    drawer.append(settingsSection, sessionsSection)
    let drawerOpener: HTMLElement | null = null
    // The sheet is drawn for the fiber whose ⚙ asked; the band's own card keeps its sheet in step with runtime polls.
    this.settingsFor = (act, opener) => {
      if ((act.uid ?? act.id) !== (sheetCard.uid ?? sheetCard.id) || act.originId !== sheetCard.originId) {
        const own = (act.uid ?? act.id) === (card.uid ?? card.id) && act.originId === card.originId
        sheetCard = act
        sheet = sheetFor(own ? card : { ...act }, own ? shuttleManaged : isAgentCard(act), own)
        sheetName.textContent = own ? '' : act.name
        sheetName.hidden = own
        // The band's own ancestry and facts stay with the band's card.
        drawer.toggleAttribute('data-thread', !own)
        settingsSection.replaceChildren(sheetName, sheet.settings)
        const history = sheet.history()
        sessionsSection.replaceChildren(...(history ? [history] : []))
      }
      sessionsSection.hidden = !act.uid
      if (sheet.ledger.hidden) sheet.toggle.click()
      const unfold = sessionsSection.querySelector<HTMLButtonElement>('.kbn-ctl-history-toggle')
      if (unfold?.getAttribute('aria-expanded') !== 'true') unfold?.click()
      if (this.openSettings) { this.openSettings(drawer, opener); return }
      drawerOpener = opener
      drawer.hidden = !drawer.hidden
    }
    this.drawerClose = () => {
      if (this.openSettings || drawer.hidden) return false
      drawer.hidden = true; drawerOpener?.focus({ preventScroll: true }); return true
    }
    const facts = document.createElement('p'); facts.className = 'ws-header-facts'
    drawer.append(facts)
    const header = document.createElement('header')
    header.className = 'ws-band-head'
    header.dataset.part = 'band-header'
    const title = document.createElement('h1')
    title.className = 'ws-band-title'
    title.dataset.part = 'fiber-title'
    // A highlighted thread follows the band's name, as a path: the figures beside it are the thread's.
    const titleRoot = document.createElement('span')
    const titleThread = document.createElement('span')
    titleThread.className = 'ws-band-thread'
    title.append(titleRoot, titleThread)
    const ancestry = this.ancestry = document.createElement('nav')
    ancestry.className = 'ws-settings-ancestry'
    ancestry.hidden = true
    drawer.prepend(ancestry)
    const contextFact = document.createElement('span')
    contextFact.dataset.part = 'context'
    const cacheFact = document.createElement('span')
    cacheFact.className = 'ws-band-cache'
    cacheFact.dataset.part = 'cache'
    const meter = document.createElement('span')
    meter.className = 'ws-band-meter'
    meter.dataset.part = 'context-meter'
    meter.append(contextFact, cacheFact)
    const usageRefresh = window.setInterval(() => { if (!document.hidden) void this.readUsage(target()) }, USAGE_REFRESH_MS)
    this.disposers.push(() => window.clearInterval(usageRefresh))
    const back = this.back = document.createElement('button')
    back.type = 'button'
    back.className = 'ws-header-icon ws-band-back'
    back.dataset.part = 'band-back'
    back.hidden = true
    back.innerHTML = headerIcon('back')
    const identity = document.createElement('div'); identity.className = 'ws-band-identity'
    identity.append(back, title, meter)
    const leave = this.leave = document.createElement('button')
    leave.type = 'button'
    leave.className = 'ws-header-icon ws-band-leave'
    leave.hidden = true
    leave.innerHTML = headerIcon('leave')
    if (this.voice && shuttleManaged) {
      this.listen = new ListenControl({
        card: () => this.actionCard ?? card, voice: this.voice.controller, phone: this.phone, shuttleBase: this.shuttleBase,
        fiberSlug: (fiber, origin) => this.fiberSlug?.(fiber, origin),
      })
    }
    // Listen keeps its own slot at the head of the box's tools; the strip beside it says where spoken words go.
    const voiceStrip = this.voiceStrip = new VoiceStrip()
    const unsubscribe = this.voice?.controller.subscribe(() => this.paintVoice())
    if (unsubscribe) this.disposers.push(unsubscribe)
    this.paintVoice()
    if (this.listen) worker.seat(this.listen.el, voiceStrip.el)
    header.append(identity, acts.el, leave)
    body.append(header, worker.el, drawer, foot)
    this.actPaint = () => {
      this.el.dataset.column = card.column
      const act = target()
      const same = (act.uid ?? act.id) === (card.uid ?? card.id) && act.originId === card.originId
      if (titleRoot.textContent !== card.name) titleRoot.textContent = card.name
      const thread = same ? '' : ` / ${act.name}`
      if (titleThread.textContent !== thread) titleThread.textContent = thread
      title.title = card.name + thread
      const usage = this.usage
      paintUsage(contextFact, cacheFact, usage, act.workerAgent ?? act.shuttleAgent)
      meter.hidden = contextFact.hidden && cacheFact.hidden
      const warm = warmUntil(usage)
      const hit = usage?.hit_share === undefined ? undefined : Math.round(usage.hit_share * 100)
      const saidFacts = [bandFacts(card), ...(hit === undefined ? [] : [`${hit}% cached`])].join(' · ')
      if (facts.textContent !== saidFacts) facts.textContent = saidFacts
      facts.title = hit === undefined ? '' : `The session's recent turns read ${hit}% of their context tokens from the prompt cache`
      facts.hidden = !facts.textContent
      worker.update(act, warm !== undefined ? `cache warm until ${clockTime(warm)}` : '')
      acts.el.hidden = this.rows
      if (!this.rows) acts.paint()
      header.toggleAttribute('data-acts', !this.rows)
    }
    this.actPaint()
    this.repaintActs()
    return body
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
    this.disposers.push(anchorSelect(agentSelect), anchorSelect(effortSelect))

    const chrome = ctlToggle('Chrome', 'kbn-ctl-chrome')
    chrome.input.id = 'kbn-detail-chrome'
    chrome.input.checked = card.shuttleChrome === true
    // Until the registry says which agents take it, show Chrome where it is on.
    chrome.label.hidden = !chrome.input.checked

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
        { agentSelect, effortSelect, chromeToggle: chrome.input },
        { agent: '', effort: '', chrome: false },
        async () => true,
      )
      return col
    }

    col.append(field('Agent', agentSelect, effortSelect, chrome.label))
    void this.loadAgentPicker(
      { agentSelect, effortSelect, chromeToggle: chrome.input },
      {
        agent: card.shuttleAgent ?? '',
        effort: card.shuttleEffort ?? '',
        chrome: card.shuttleChrome ?? false,
      },
      async (axes) => {
        const ok = await this.commitAxes(card, axes, statusEl, errorEl)
        if (ok) {
          const patch: Partial<KanbanCard> = {}
          if ('agent' in axes) patch.shuttleAgent = axes.agent
          if ('effort' in axes) patch.shuttleEffort = axes.effort || undefined
          if ('chrome' in axes) patch.shuttleChrome = axes.chrome
          reflect(patch)
        }
        return ok
      },
    ).then(sync => {
      if (!sync) return
      const reset = (): void => sync({ agent: card.shuttleAgent ?? '', effort: card.shuttleEffort ?? '',
        chrome: card.shuttleChrome ?? false })
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
    const kind = segmented(
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

    // The saved cron as Shuttle says it, beside the expression; an edit in
    // progress says nothing until Shuttle has read it.
    const spoken = document.createElement('span')
    spoken.className = 'kbn-ctl-spoken'
    const paintSpoken = (): void => {
      spoken.textContent = cronInput.value.trim() === card.shuttleSchedule ? card.scheduleText ?? '' : ''
    }
    paintSpoken()
    cronInput.addEventListener('input', paintSpoken)

    const cronRow = field('Cron', cronInput, tzInput, spoken)
    cronRow.hidden = baseline.kind !== 'standing'
    col.append(field('Kind', kind), cronRow)
    reseed(() => {
      baseline.kind = card.shuttleKind ?? 'oneshot'
      baseline.schedule = card.shuttleSchedule ?? ''
      baseline.tz = card.shuttleTz ?? 'Europe/Paris'
      kind.value = baseline.kind
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
          kind.value = baseline.kind
          cronRow.hidden = baseline.kind !== 'standing'
        },
      )
    }

    /** Set on mousedown over a non-Standing segment while a promotion is
     *  staged but uncommitted, so the cron field's blur doesn't commit on the
     *  way out. */
    let abandoningPromotion = false
    kind.addEventListener('valuechange', (event) => {
      const value = event.detail.value as ShuttleKind
      const revision = ++kindRevision
      cronRow.hidden = value !== 'standing'
      if (value === 'standing') {
        if (!cronInput.value.trim()) cronInput.value = '0 9 * * 1-5'
        if (!tzInput.value.trim()) tzInput.value = 'Europe/Paris'
        paintSpoken()
        cronInput.focus()
        cronInput.select()
      }
      this.deferSetting('kind', () => commitKind(value, revision), event.detail.reason === 'list-navigation')
    })
    for (const btn of kind.querySelectorAll('button')) {
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
    kind.addEventListener('keydown', (e) => {
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
    this.disposers.push(() => { release?.(); release = null })
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

  /** Open on a card whose start was refused for want of a project directory, with its prompt showing. */
  openStartPrompt(card: KanbanCard, body: DispatchFailureBody): void {
    this.open(card)
    if (this.card && this.errorEl) this.showStartPrompt(this.card, body, 'fresh')
  }

  /** A review goes to the live worker through the same force dispatch, without start authority. */
  async sendReview(card: KanbanCard, message: string): Promise<void> {
    if (!hasLiveWorker(card)) throw new Error('No live worker. Start or resume one before sending a review.')
    let res: Response
    try {
      res = await postForceDispatch(this.shuttleBase, card, { user_message: message, resume_mode: 'previous', existing_only: true })
    } catch (err: unknown) {
      throw new Error(`Shuttle did not answer (${(err as { message?: string })?.message ?? String(err)}), so this may still arrive. Check the worker's conversation before sending again.`)
    }
    if (res.ok) { this.onSaved(); return }
    const body = (await res.json().catch(() => ({}))) as DispatchFailureBody
    throw new Error(res.status === 409 ? 'A worker is already running for this fiber.' : dispatchFailureMessage(body, `Requeue failed (${res.status})`, res.status))
  }

  /**
   * One force dispatch ({@link postForceDispatch}) with the resume intent. The
   * daemon resolves the session to resume from the fiber's
   * `shuttle.session_uuid`, falling back to fresh when there is nothing to
   * resume. `projectDir` is a directory the human confirmed in the prompt a
   * refused start raised ({@link showStartPrompt}). A worker that starts opens
   * on the desktop, where the human talks to it.
   */
  private async startSession(card: KanbanCard, mode: SessionMode, word?: HTMLElement, projectDir?: string, message = '', images: PastedImage[] = []): Promise<boolean> {
    if (this.starting || (mode === 'fresh' && !this.confirmCut(card))) return false
    const epoch = this.epoch
    const original = word?.textContent ?? ''
    if (word) word.textContent = mode === 'fresh' ? 'Starting…' : message || images.length ? 'Sending…' : 'Resuming…'
    this.starting = true
    this.actPaint?.()
    const inBand = (): boolean => {
      const target = this.actionCard ?? this.card
      return !!target && (target.uid ?? target.id) === (card.uid ?? card.id) && target.originId === card.originId
    }
    const showError = (message: string): void => {
      if (!inBand()) { showToast(message, 'error'); return }
      if (epoch !== this.epoch || !this.errorEl) return
      this.errorEl.textContent = message
      this.errorEl.style.display = ''
    }
    if (inBand() && this.errorEl) this.errorEl.style.display = 'none'
    try {
      let res: Response
      try {
        res = await postForceDispatch(this.shuttleBase, card, { user_message: message, resume_mode: mode, ...(images.length ? { images } : {}), ...(projectDir ? { project_dir: projectDir } : {}) })
      } catch (err: unknown) {
        showError(`Shuttle did not answer (${(err as { message?: string })?.message ?? String(err)}). Check the board before trying again.`)
        return false
      }
      const body = (await res.json().catch(() => ({}))) as DispatchFailureBody & { tmux_session?: string, terminal?: string | null }
      // A 409 names the worker the daemon holds. With nothing to deliver, a
      // reachable one is where the human was going; anything said, or a
      // worker whose terminal the daemon cannot find, did not arrive.
      const said = !!message || images.length > 0
      const reachable = res.status === 409 && !!body.tmux_session && !!body.terminal
      if (res.ok || (reachable && !said)) {
        this.onSaved()
        if (body.tmux_session && !coarsePointer()) this.onOpenWorker?.(body.tmux_session, card.originId)
        return true
      }
      if (res.status === 409) showError(alreadyRunningMessage(body, said))
      else if (inBand() && needsProjectDir(body) && epoch === this.epoch) this.showStartPrompt(card, body, mode, message, images)
      else showError(dispatchFailureMessage(body, `Requeue failed (${res.status})`, res.status))
      return false
    } finally {
      if (word) word.textContent = original
      if (epoch === this.epoch) { this.starting = false; this.actPaint?.() }
    }
  }

  /**
   * A "New session" over a LIVE worker is a CUT: the daemon stamps the
   * clean-exit marker, kills the running session, and starts fresh, which
   * discards whatever in-flight context that worker was holding. A dormant
   * card cuts nothing, so it's silent; Resume never cuts.
   */
  private confirmCut(card: KanbanCard): boolean {
    if (!hasWorkerToStop(card)) return true
    const working = card.runtimePhase === 'working' ? ' (actively working)' : ''
    return window.confirm(
      `A worker is still running for “${card.name}”${working}.\n\n` +
        `Start a new session? This cuts the open session and discards its ` +
        `in-flight context.`,
    )
  }

  /**
   * Answer a start refused for want of a project directory in place: the
   * owning host's reason and a directory field, prefilled from the nearest
   * ancestor's `project_dir` when the card has one. Start retries the launch
   * mode with the confirmed directory.
   */
  private showStartPrompt(card: KanbanCard, body: DispatchFailureBody, mode: SessionMode, message = '', images: PastedImage[] = []): void {
    const errorEl = this.errorEl
    if (!errorEl) return
    const epoch = this.epoch
    const prompt = buildProjectDirPrompt({
      reason: dispatchFailureMessage(body, 'The start was refused.'),
      host: body.host ?? card.shuttleHost,
      suggestion: card.inheritedProjectDir,
      onStart: dir => {
        void this.startSession(card, mode, undefined, dir, message, images).then(ok => {
          if (ok || epoch !== this.epoch || !errorEl.contains(prompt)) return
          const retry = prompt.querySelector<HTMLButtonElement>('button')
          if (retry) retry.disabled = false
        })
      },
    })
    errorEl.replaceChildren(prompt)
    errorEl.style.display = ''
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
    },
    current: AgentAxes,
    onCommit: (axes: Partial<AgentAxes>) => Promise<boolean>,
  ): Promise<((axes: AgentAxes) => void) | undefined> {
    const { agentSelect, effortSelect, chromeToggle } = controls
    const chromeChip = chromeToggle.parentElement
    const freeze = (why: string): void => {
      for (const el of [agentSelect, effortSelect, chromeToggle]) el.disabled = true
      effortSelect.hidden = effortSelect.options.length === 0
      agentSelect.title = why
    }
    let records: AgentRecord[]
    try {
      // The daemon's registry is a bare array (`shuttle agents --json`,
      // degrading to `[]` when Shuttle is unavailable). A non-array body is
      // malformed — treat it as empty rather than trusting it.
      const raw = await getDaemonJson<AgentRecord[]>(`${this.shuttleBase}/api/v1/agents`)
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

    // Repopulate effort and chrome from an agent's metadata. The
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

    }

    syncDependents(selectedAgent() || current.agent, current.effort)
    chromeToggle.checked = current.chrome && !chromeToggle.disabled

    let landed = {
      agent: selectedAgent(),
      effort: effortSelect.value,
      chrome: chromeToggle.checked,
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
      return { agent: selectedAgent(), effort: effortSelect.value, chrome: chromeToggle.checked }
    }
    const sync = (axes: AgentAxes): void => {
      landed = paint(axes)
      intended = { ...landed }
    }
    const commit = (axis: keyof AgentAxes): void => {
      const axes: AgentAxes = { agent: selectedAgent(), effort: effortSelect.value, chrome: chromeToggle.checked }
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
      // New agent: select its concrete default effort and re-gate chrome.
      syncDependents(selectedAgent(), '')
      chromeToggle.checked = chromeToggle.checked && !chromeToggle.disabled
      scheduleCommit('agent')
    })
    effortSelect.addEventListener('change', () => scheduleCommit('effort'))
    chromeToggle.addEventListener('change', () => scheduleCommit('chrome', false))
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
      postDaemonJson(this.shuttleBase, '/api/v1/lifecycle', {
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
      await postDaemonJson(this.shuttleBase, '/api/v1/lifecycle', {
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
            await postDaemonJson(this.shuttleBase,
              '/api/v1/lifecycle',
              targetKind === 'standing'
                ? { action: 'reshape', origin, fiber: fiberId, kind: 'standing', schedule, tz }
                : { action: 'reshape', origin, fiber: fiberId, kind: targetKind },
            )
          } else if (targetKind === 'standing') {
            // Below here the card has NO block yet, so there is nothing to
            // reshape and the create verbs take over.
            await postDaemonJson(this.shuttleBase, '/api/v1/lifecycle', {
              action: 'repeat', origin, fiber: fiberId,
              // Undefined when the block carries none, which a paused install
              // permits; an arming install without one fails loudly.
              schedule, tz, model: card.shuttleAgent, project_dir: card.shuttleProjectDir,
            })
          } else {
            await postDaemonJson(this.shuttleBase, '/api/v1/lifecycle', {
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
          await postDaemonJson(this.shuttleBase, '/api/v1/felt-nest', {
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
          await postDaemonJson(this.shuttleBase, '/api/v1/felt-edit', {
            fiber_id: fiberId,
            origin,
            due: changes.due ?? null,
          })
        }
    })
  }
}

/** Why a start answered 409 delivered nothing, in the words the human acts on. */
export function alreadyRunningMessage(body: { tmux_session?: string, terminal?: string | null }, said: boolean): string {
  if (body.tmux_session && !body.terminal) return `Shuttle holds a worker for this fiber but cannot reach its terminal, so ${said ? 'the message was not sent' : 'nothing opened'}. Stop it, then resume.`
  return said ? 'A worker is already running for this fiber; the message was not sent.' : 'A worker is already running for this fiber.'
}
