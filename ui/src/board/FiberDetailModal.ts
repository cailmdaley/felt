import { workerVariant, appConversationTarget, canOpenDesktopApp, appWorkerLink, atDesktop, terminalWorkerPill } from './appConversation.js'
import {
  basename,
  cacheBustUrl,
  fiberDocUrl,
  fileBytesUrl,
  fileInfoUrl,
  humanizeIdleAge,
  renderMarkdown,
  resolveAbs,
  showToast,
} from './utils.js'
import {
  PREVIEW_BYTES,
  attachmentGlyph,
  extractEmbeds,
  fileKind,
  fileTapAction,
  formatBytes,
  previewText,
  type Attachment,
} from './attachments.js'
import { hasLiveWorker, hasWorkerToStop, type ColumnKind, type KanbanCard, type ShuttleKind } from './KanbanTypes.js'
import { agentGroups } from '../forms/agents.js'
import { MEETING_MODES, type MeetingMode } from '../forms/meetingApi'
import { meetingHostCard, meetingStateWord, paintTranscript, type MeetingRecord } from './meeting.js'
import { defaultSurface, isCodexAgent, persistedSurface, type ExecutionSurface } from '../forms/executionSurface.js'
import { dispatchFailureMessage, isAgentCard, needsProjectDir, postDaemonJson, postForceDispatch, type DispatchFailureBody } from './KanbanModalShared.js'
import { buildProjectDirPrompt } from './projectDirPrompt.js'
import { fetchFiberIndex, filterParentCandidates, type FiberSearchResult } from './fiberSearch.js'
import { installWikilinks } from './wikilinks.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
import {
  attachPanelDrag,
  attachPanelResize,
  readPanelGeometry,
  animatePanelGeometry,
  applyPanelGeometry as applyGeometryTo,
  bringPanelToFront as bringToFront,
  raiseOnFrameFocus,
  fittedGeometry as fitted,
  halfAndHalf,
  inSomeOpenPanel,
  isTopPanel,
  registerPanel,
  unregisterPanel,
  type PanelGeometry,
} from './FloatingPanelChrome.js'
import { LinkedFiberPanel } from './LinkedFiberPanel.js'
import { buildSessionHistory } from './sessionHistory.js'
import { suppressNextClick } from './dismissGesture.js'
import {
  buildFileViewer,
  disposeFileViewer,
  htmlWithBase,
  isScrollableFile,
  resumeFileViewer,
  suspendFileViewer,
} from './FileViewerPanel.js'
import { refreshLiveFile, watchLiveFile } from './LiveFileRefresh.js'
import { isMobileViewport, coarsePointer, onMobileChange, onReaderChange, readerFillsScreen } from './mobile.js'
import { holdSheet, swapSheet, SHEET_CARD, SHEET_VIEWER } from './sheetHistory.js'
import {
  disambiguateBasenames,
  normalizeSentFiles,
  sentFilesRevision,
  type SentFile,
} from './sentFiles.js'
import { buildReaderWindow, buildTabButton, buildViewCell, buildZoomBar, showCell } from './ReaderChrome.js'
import { closeTab, openTab } from './ReaderTabs.js'
import { installTouchZoom, setZoomTarget, zoomOnWheel, type ZoomableTab } from './ReaderZoom.js'
import { humanizeCron } from './KanbanRules.js'
import { formatDue } from './KanbanSurfaces.js'
import {
  dueCivilDay,
  formatSpanMinutes,
  instantMs,
  isoDayLocal,
} from './civilDay.js'
import { shouldRunVisiblePoll } from '../runtime/PageAttention'
import './FiberDetailModal.css'

/**
 * Panel geometry remembered across opens within a session — the reader who
 * dragged the page to the right edge to watch a fiber while working the
 * board gets the same placement on the next card. Cleared on reload.
 */
let lastGeometry: PanelGeometry | null = null

/** Single-column reading width (≤950px, or 92vw on a narrower window). The
 *  card panel opens here and keeps it — the file viewer is its own floating
 *  window, so the card never grows. */
const SINGLE_COL_WIDTH = 950

/** Wall-clock time of an INSTANT, in the reader's zone. `dispatched_at` and
 *  `handed_off_at` are real points on the timeline, not civil days — a run
 *  launched at 14:02 in Paris happened at 14:02 for the person who launched it,
 *  and the panel shows the reader's own clock. */
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

/** The board's meeting control, lent to the detail panel. */
export interface MeetingJoinControl {
  /** hark is available on this machine and nothing is recording. */
  canJoin(): boolean
  /** Record a meeting and join it to the card's constitution with `note`;
   *  resolves to the error to show, or null once recording began. */
  join(card: KanbanCard, mode: MeetingMode, note: string): Promise<string | null>
  /** The meeting the board last observed, if any. */
  current(): MeetingRecord | null
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
 * how long it held the fiber — the right-hand reading on the drawer's strip.
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
 * Whether the board places this card by its `due:` day. A standing role is
 * placed by its cron and an active pinned role rests on the Pinned strip —
 * neither is ever sorted by due, so neither shows or edits one.
 */
function placedByDue(card: Pick<KanbanCard, 'shuttleKind' | 'status'>): boolean {
  return !(card.shuttleKind === 'standing' || (card.shuttleKind === 'pinned' && card.status === 'active'))
}

/**
 * What the drawer's folded strip says about a card, as data — the strip is a
 * reading of the fiber, not a label for the controls under it.
 *
 *   claude-fable medium · pinned · ada-workstation:~/dev/felt   Sep 26 01:38 → 02:40 · 1h 2m ✓
 *
 * `actor` is the agent id (cobalt) on a shuttle card and `me` (cinnabar) on a
 * human one, the same word the board card prints. `cadence` is said only when
 * it isn't the default: a pinned role says so, a standing one speaks its cron,
 * a one-shot says nothing. `place` is `host:dir` with the home directory
 * folded to `~`. `due` is dropped where the board never reads it
 * ({@link placedByDue}).
 */
export interface StripFacts {
  actor: { text: string; agent: boolean }
  effort?: string
  chrome: boolean
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
  } else if (card.shuttleKind === 'pinned') {
    cadence = { text: 'pinned' }
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
    cadence,
    place,
    due: card.due && placedByDue(card) ? formatDue(card.due) : undefined,
    run: sessionWindow(card, nowMs),
  }
}

/** {@link stripFacts} drawn: the facts on the left, the run window on the
 *  right — or on a line of its own where the panel is too narrow for both. */
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
  onPick(fn: (value: T) => void): void
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
  const listeners: Array<(value: T) => void> = []
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
      for (const fn of listeners) fn(v)
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
    next.click()
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

/**
 * Per-card file-viewer UI state, persisted to localStorage under
 * `shuttle:detail:<uid>`. The `open` array is the stable tab order. Each entry
 * carries its per-file scroll offset + zoom to restore on rehydrate.
 */
interface DetailPersist {
  /** Full path of the active (front-most) tab — restored on reopen. */
  active?: string
  /** Remembered geometry of the two windows, so reopening a card restores the
   *  exact arrangement the reader left (not the half-and-half default). */
  cardGeom?: PanelGeometry
  viewerGeom?: PanelGeometry
  /**
   * `basename` is the file's display label as the trail provided it — which can
   * differ from the path tail in the disambiguation case (two distinct files
   * both literally named `report.html`, distinguished as
   * `standalone-kanban-report.html` vs `morning-post-report.html`). Persisting
   * it keeps the tab label stable across reload; a record without it falls
   * back to `basename(path)`. `zoom` is the per-file Cmd-scroll magnification
   * (1 = native), `scroll` the last reading offset — both restored per tab.
   */
  open: Array<{ path: string; basename?: string; scroll: number; zoom?: number }>
}

/**
 * One open file in the right-column TABBED viewer. Owns its DOM: the `tab`
 * button in the tab strip and the full-bleed `cell` that renders the file
 * (only the active tab's cell is shown — the others stay built-but-hidden so
 * switching tabs preserves scroll, zoom, and iframe load state, browser-tab
 * style). Live state the persistence writer reads: `scroll` (last iframe/cell
 * reading offset) and `zoom` (Cmd-scroll magnification, 1 = native). The viewer
 * is built once, on first activation (`viewerBuilt`).
 */
interface OpenFileEntry extends ZoomableTab {
  /** The tab's identity, `file.fullPath` — named `path` so the shared
   *  tab-set arithmetic in ReaderTabs can operate on these entries. */
  path: string
  file: SentFile
  tab: HTMLElement
  scroll: number
  viewerBuilt: boolean
  viewer: HTMLElement | null
  frameScrollCleanup: (() => void) | null
}

/** The unchanged sentinel {@link FiberDetailModal.fetchSentFiles} returns on a
 *  304: distinct from `null` (the read FAILED — keep the last known trail) and
 *  from `[]` (the trail is genuinely empty). */
const SENT_FILES_UNCHANGED = Symbol('sent-files-unchanged')
/** How many chips a folded (phone) sent-files band shows. The stylesheet's
 *  `:nth-child(n + 4)` rule is this number + 1; `test/sentFold.test.ts` reads
 *  the CSS and fails if the two ever drift. */
export const SENT_FOLD_VISIBLE = 3

type RefreshableArtifact = HTMLImageElement | HTMLIFrameElement | HTMLAudioElement

const LIVE_REFRESH_INTERVAL_MS = 15_000
/** The CSS width an attachment card's HTML preview iframe is rendered at before
 *  being scaled into the face. A desktop-ish width so the document lays out
 *  like itself; the scale factor is measured per card. */
const ATTACH_FRAME_WIDTH = 800

/**
 * Run `fn` the first time `el` is scrolled into view, once and never again.
 *
 * The attachment strip scrolls sideways and a fiber can carry a dozen files;
 * fetching every preview on open would spend a dozen requests to draw two
 * cards. Where IntersectionObserver is missing (jsdom, an old engine) the
 * honest fallback is to run immediately — the feature degrades to eager, not
 * to absent.
 */
function whenVisible(el: Element, fn: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    fn()
    return () => {}
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      io.disconnect()
      fn()
      return
    }
  }, { rootMargin: '200px' })
  io.observe(el)
  return () => io.disconnect()
}
const PERSIST_PREFIX = 'shuttle:detail:'

function loadPersist(uid: string): DetailPersist {
  if (!uid) return { open: [] }
  try {
    const raw = window.localStorage.getItem(PERSIST_PREFIX + uid)
    if (!raw) return { open: [] }
    const parsed = JSON.parse(raw) as DetailPersist
    return {
      active: parsed.active,
      cardGeom: parsed.cardGeom,
      viewerGeom: parsed.viewerGeom,
      open: Array.isArray(parsed.open) ? parsed.open : [],
    }
  } catch {
    return { open: [] }
  }
}

function savePersist(uid: string, state: DetailPersist): void {
  if (!uid) return
  try {
    // Keep the record while there are open tabs OR remembered window geometry
    // (so a card with no files still reopens its windows where the user left
    // them); drop it only when there's nothing to remember.
    if (state.open.length === 0 && !state.cardGeom && !state.viewerGeom) {
      window.localStorage.removeItem(PERSIST_PREFIX + uid)
    } else {
      window.localStorage.setItem(PERSIST_PREFIX + uid, JSON.stringify(state))
    }
  } catch {
    /* storage full / disabled — persistence is best-effort */
  }
}

/**
 * One entry of the daemon's `GET /api/v1/agents` registry. The axis metadata
 * (`effort_levels`, `default_effort`, `chrome_capable`) populates the agent
 * picker's effort options and chrome toggle without any hardcoded option list
 * in the frontend — the registry is the single source of truth. `alias_of` is
 * set on alias records that the base-agent select filters out.
 */
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

/**
 * FiberDetailModal — one click on a kanban card opens the fiber itself.
 *
 * A floating, draggable, edge-and-corner-resizable panel whose body is a
 * single-column page: outcome lede, then the markdown body, rendered by the
 * lean `marked` renderer (`utils.renderMarkdown`) and styled as a page
 * (`.kbn-detail-prose` in FiberDetailModal.css). The markdown comes from the
 * daemon's `GET /api/v1/fibers/<id>?body=true`, owner-routed by the card's
 * origin; a fiber that can't be read degrades to its outcome, which the
 * composite feed always carries. `:::{embed}` files become the attachment
 * strip, and relative images render through the daemon's owner-routed `/file`
 * route, anchored on the fiber's own dir.
 *
 * Every card action lives in one drawer directly under the title, folded by
 * default: the message box with its meeting and New session / Resume, the
 * next launch's settings, due and parent, and Temper / Discard (see
 * `buildControls`).
 *
 * Deliberately NOT a Radix AppDialog and NOT background-locked: the panel
 * is non-modal by design — "drag it aside to keep an eye on one fiber
 * while working the board" requires the kanban behind it to stay
 * interactive, so there is no scrim, no focus trap, no body-inert. Escape
 * still closes; only one instance is open at a time.
 *
 * Lifecycle: `open(card)` mounts the panel; `close()` tears it down.
 */
export class FiberDetailModal {
  private overlay: HTMLElement | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private outsideHandler: ((e: PointerEvent) => void) | null = null
  private resizeHandler: (() => void) | null = null
  private searchDebounce: number | null = null
  /** The band the attachment strip mounts into — above the sent-files trail,
   *  under the head. Held so re-reading the body replaces the strip rather
   *  than stacking a second one under it. */
  private attachHost: HTMLElement | null = null
  private readonly attachmentWatches: Array<() => void> = []
  private readonly attachmentLiveUrls = new Set<string>()
  /** Shuttle daemon base (`:4000`). Every verb routes here — dispatch
   *  (carrying user_message + resume_mode inline), lifecycle, felt-nest,
   *  felt-edit — owner-routed by the card's `originId` carried as `origin` in
   *  the body. Reads (agent registry, parent-picker fiber index) hit the
   *  daemon's GET routes. */
  private readonly shuttleBase: string
  /** Parent-picker index: one `GET /api/v1/fibers` per panel-open, filtered
   *  client-side per keystroke. Cleared on close. */
  private fiberIndex: Promise<Array<{ id: string; name: string }>> | null = null
  /** Monotonic guard so only the latest searchParents call renders the
   *  dropdown — see the comment inside searchParents. */
  private searchRenderToken = 0
  private readonly onSaved: () => void
  /** Focus an already-running worker's kitty tab. Wired from the parent
   *  kanban's onOpenWorker; drives the status pill's double-click. */
  private readonly onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  /**
   * Terminal-move delegate. Temper / Discard close the panel immediately and
   * hand the move to the parent kanban's optimistic transition path (instant
   * card relocation + background commit + banner on failure). The product
   * always wires it; the no-op default exists only for the offline harness
   * fixture, which mounts the panel with no board behind it.
   */
  private readonly onTransition: (card: KanbanCard, target: ColumnKind) => void
  // ── File viewer state (the separate viewer window) ──────────────────────
  /** The card the panel is currently showing — every viewer action
   *  (open/close/scroll/zoom) keys its persistence off `card.uid`. */
  private card: KanbanCard | null = null
  /** A start refused before the panel opened (a drag onto In flight) that
   *  waits on a project directory: the composer opens with its prompt. */
  private pendingStartPrompt: { cardId: string; body: DispatchFailureBody } | null = null
  /** The full sent-files trail (newest-first), kept current while the panel is
   *  open. The launcher renders from this. */
  private sentFiles: SentFile[] = []
  /** Open files in stable open-order (the tab order — tabs don't reorder on
   *  click, browser-style). Each entry owns its tab + view cell + live
   *  scroll/zoom state; this is the authority the persistence writer
   *  serializes. The active tab is tracked separately by `activePath`. */
  private openFiles: OpenFileEntry[] = []
  /** Full path of the active (shown) file, or null. The active tab's cell is
   *  visible; every other open cell stays built-but-hidden. */
  private activePath: string | null = null
  /** The viewer window's views host (holds every open file's cell; only the
   *  active one is shown). Null while no file is open. */
  private rightCol: HTMLElement | null = null
  /** The viewer window's tab strip (one tab per open file). Null while closed. */
  private tabStrip: HTMLElement | null = null
  /** The separate floating file-viewer window (its own document.body overlay,
   *  draggable + resizable independently of the card). Null until the first
   *  file opens; nulled when the last tab closes or its ✕ is clicked. */
  private viewerWindow: HTMLElement | null = null
  /** Withdraws the viewer from {@link raiseOnFrameFocus} when it closes. */
  private stopViewerFrameRaise: (() => void) | null = null
  /** Unsubscribes the open viewer from READER_MEDIA changes. */
  private stopViewerMediaWatch: (() => void) | null = null
  /** Remembered viewer-window geometry for THIS card: loaded from persistence
   *  on open, updated on the window's drag/resize settle, captured before the
   *  window closes. Drives "reopen where you left it" vs the half-and-half
   *  default. Null = no remembered placement yet (use the default). */
  private viewerGeom: PanelGeometry | null = null
  /** Remembered CARD-window geometry for this card (mirror of viewerGeom):
   *  the INTENDED geometry (default / restored / half-and-half / dragged), never
   *  a mid-animation read, so the persisted arrangement is exact. */
  private cardGeom: PanelGeometry | null = null
  /** Debounce handle for scroll-position persistence writes. */
  private scrollWriteTimer: number | null = null
  /** The page and prose nodes stay stable while live content is refreshed. */
  private bodyPage: HTMLElement | null = null
  private proseEl: HTMLElement | null = null
  /** The sent-files strip is refreshed in place so open tabs survive. */
  private sentWrap: HTMLElement | null = null
  private sentList: HTMLElement | null = null
  /** One live poll per open card, paused while the document is hidden and
   *  slowed while it is visible but unfocused (see {@link shouldRunVisiblePoll}). */
  private liveRefreshTimer: number | null = null
  private liveRefreshBusy = false
  private liveRefreshLastRunAt: number | null = null
  /** Guards the un-awaited initial `renderFiberBody` against a later tick's
   *  render landing first on the SAME overlay — overlay identity can't see
   *  that race, so the token stays. */
  private bodyRequestToken = 0
  /** The fiber's last-seen `modified_at`; a change re-renders the body. */
  private bodyRevision: string | undefined
  private sentCount: HTMLElement | null = null
  private sentMore: HTMLButtonElement | null = null
  private sentFilesRevision = ''
  private sentFilesEtag: string | null = null
  /** Change baselines for artifact bytes, keyed by BARE absolute path — one
   *  path is one file whether it is reached as an open tab, an inline embed,
   *  or both. */
  private readonly resourceRevisions = new Map<string, string>()
  private readonly visibilityHandler = (): void => {
    if (!document.hidden) void this.refreshLiveContent()
  }

  /**
   * A LINKED card — one reached by following a [[wikilink]] out of a body,
   * rather than by clicking a card on the board. It lives as a TAB in the
   * {@link LinkedFiberPanel} beside the origin card, never as a window of its
   * own, and differs from an origin card in exactly the ways that follow from
   * "this is a reference you followed, not a fiber you went to work on":
   *
   *   · its drawer appears only if the fiber actually carries a
   *     shuttle block — a plain note has nothing to dispatch, and offering
   *     Temper/Discard/New session on it is noise; a real constitution keeps
   *     its actions;
   *   · it has no frame of its own: no geometry, no drag, no resize, no
   *     click-away, and it never writes the session's default placement or its
   *     own persisted arrangement — the panel it sits in owns all of that;
   *   · it closes with its tab.
   *
   * This field IS that fact: non-null iff the card is linked, holding the
   * element it renders into (its tab's cell). Null for a card opened from the
   * board, which builds its own floating window.
   */
  private readonly host: HTMLElement | null
  /** Ask the panel to close this card's tab (the header ×, for a linked card). */
  private readonly onCloseRequest: (() => void) | null
  /**
   * The one panel this card's followed references open into, created on the
   * first link followed and dying with its last tab. An origin card owns it; a
   * linked card is given its owner's, so a reference followed from a TAB lands
   * as another tab in the same panel rather than starting a second one.
   */
  private linkPanel: LinkedFiberPanel | null = null
  /** Joins a meeting to the card's constitution; absent where the board has
   *  no meeting control (a panel opened outside the Desk). */
  private readonly meeting: MeetingJoinControl | null
  /** Unsubscribe from the mobile-threshold watch, live while the panel is open.
   *  Crossing 700px re-frames the panel between window and sheet in place. */
  private mobileWatch: (() => void) | null = null
  /** The open card and its transcript pane, repainted by {@link syncMeeting}. */
  private transcriptCard: KanbanCard | null = null
  private transcriptPane: HTMLElement | null = null
  /** Repaints the drawer's Meeting verb from the board's meeting status. */
  private meetingPaint: (() => void) | null = null
  /** Whether the open card's worker pill shows its waiting/attention phase.
   *  The Desk draws phase only on In flight cards, and the board answers the
   *  same way here; absent, the phase always shows. */
  private readonly workerPhase: (card: KanbanCard) => boolean
  /** The header's worker pill, the status pill it sits before, and the runtime
   *  state it was drawn from — repainted by {@link syncRuntime}. */
  private workerPill: HTMLElement | null = null
  private statusPill: HTMLElement | null = null
  private workerPillKey = ''

  constructor(
    shuttleBase: string,
    onSaved: () => void,
    onTransition?: (card: KanbanCard, target: ColumnKind) => void,
    onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void,
    opts?: {
      host?: HTMLElement
      panel?: LinkedFiberPanel
      onCloseRequest?: () => void
      meeting?: MeetingJoinControl
      workerPhase?: (card: KanbanCard) => boolean
    },
  ) {
    this.shuttleBase = shuttleBase
    this.onSaved = onSaved
    this.onTransition = onTransition ?? (() => {})
    this.onOpenWorker = onOpenWorker
    this.host = opts?.host ?? null
    this.linkPanel = opts?.panel ?? null
    this.onCloseRequest = opts?.onCloseRequest ?? null
    this.meeting = opts?.meeting ?? null
    this.workerPhase = opts?.workerPhase ?? (() => true)
  }

  /**
   * @param card the card the user clicked
   */
  open(card: KanbanCard): void {
    // ONE LAYER, SWAPPED CONTENT. This is a single reused instance whose open
    // begins by tearing down whatever it was showing — so opening card B over
    // card A reads as close-then-open. Released and re-pushed, that is a
    // `history.back()` racing a `pushState`, and the queued pop takes the new
    // panel straight back down: the "open a second card and nothing appears"
    // bug. Inside a swap the layer simply keeps the entry it already holds.
    if (!this.host) {
      swapSheet(SHEET_CARD, () => this.openInner(card))
      return
    }
    this.openInner(card)
  }

  private openInner(card: KanbanCard): void {
    // Tear down any existing open panel first (rapid re-click).
    this.close()

    // ── Panel root ──────────────────────────────────────────────────────────
    // Non-modal floating panel (see class docstring). role="dialog" without
    // aria-modal: the board behind stays in the a11y tree on purpose. A HOSTED
    // card is not a window at all — it fills the tab cell it was given, and the
    // panel around it owns the frame.
    const overlay = document.createElement('div')
    overlay.className = 'kbn-detail-overlay'
    if (this.host) overlay.classList.add('kbn-detail-tabbed')
    overlay.setAttribute('role', this.host ? 'tabpanel' : 'dialog')
    overlay.setAttribute('aria-label', `Fiber: ${card.name}`)
    // A SHEET has no geometry. Below the mobile threshold the panel stops
    // being a window — it fills the viewport, so every inline left/top/width/
    // height would be a lie the CSS then has to fight. The frame is applied
    // (or not) here, and the same decision gates drag, resize and the
    // persisted placement below.
    if (!this.host) this.applyFrame(overlay)

    // ── Header (drag handle) ────────────────────────────────────────────────
    const header = document.createElement('div')
    header.className = 'kbn-detail-header'

    // The title is plain identification text + the drag handle: the panel IS
    // the fiber view, so there is nowhere else for a title click to go.
    const title = document.createElement('div')
    title.className = 'kbn-detail-title'
    title.textContent = card.name

    // Bind the card + load its persisted viewer state. The launcher and tabbed
    // viewer read these; the persistence writer keys off `card.uid`.
    this.card = card
    const persist = loadPersist(typeof card.uid === 'string' ? card.uid : '')
    // Restore this card's remembered window arrangement: the card to its saved
    // spot (overriding the session default applyGeometry just set), and stash
    // the viewer geometry for openViewerWindow to restore instead of the
    // half-and-half default.
    this.viewerGeom = persist.viewerGeom ?? null
    if (this.isSheet()) {
      // A sheet neither applies nor earns a placement — but it must CARRY the
      // one this card already has, or the next writePersist would stamp the
      // previous card's geometry onto this one and the desktop would reopen
      // the wrong window.
      this.cardGeom = persist.cardGeom ?? null
    } else if (persist.cardGeom && !this.host) {
      const geom = fitted(persist.cardGeom)
      applyGeometryTo(overlay, geom)
      this.cardGeom = geom
    }

    const pill = document.createElement('span')
    pill.className = `kbn-pill kbn-pill-${card.status === 'closed' ? 'closed' : card.status === 'active' ? 'active' : 'open'}`
    pill.textContent = card.status || 'open'

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'kbn-detail-refresh'
    refreshBtn.setAttribute('aria-label', 'Refresh fiber content')
    refreshBtn.title = 'Refresh constitution, embedded content, and sent files'
    refreshBtn.textContent = '↻'
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.forceReload()
    })

    const coarse = coarsePointer()
    const appTarget = appConversationTarget(card, canOpenDesktopApp(navigator.userAgent, coarse), navigator.userAgent, coarse)
    const aloftPill = this.buildWorkerPill(card)
    this.workerPill = aloftPill
    this.statusPill = pill
    this.workerPillKey = this.workerPillState(card)

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'kbn-detail-close'
    closeBtn.setAttribute('aria-label', 'Close fiber detail')
    closeBtn.textContent = '×'
    // A tabbed card's × closes ITS TAB — the panel takes the card down with it,
    // so the close travels through the panel rather than around it.
    closeBtn.addEventListener('click', () =>
      this.onCloseRequest ? this.onCloseRequest() : this.close(),
    )

    // ID breadcrumb under the title — plain identification text.
    const idEl = document.createElement('div')
    idEl.className = 'kbn-detail-id'
    idEl.textContent = card.id

    const titleStack = document.createElement('div')
    titleStack.className = 'kbn-detail-title-stack'
    titleStack.append(title, idEl)
    header.append(titleStack, ...(aloftPill ? [aloftPill] : []), pill, refreshBtn, closeBtn)
    // The header is a drag handle only for a window. In a tab it is just the
    // card's title strip — the panel's own bar is what moves.
    // A sheet's header is a title bar, not a handle — there is nowhere to drag
    // it to, and a pointer drag on it would fight the body's scroll.
    if (!this.host && !this.isSheet()) {
      attachPanelDrag(overlay, header, { onSettle: () => this.rememberGeometry(overlay) })
    }

    // ── Drawer ──────────────────────────────────────────────────────────────
    // Directly under the title, folded by default (see `buildControls`).
    //
    // A LINKED card shows it only when the fiber carries a shuttle block. A
    // reference followed out of a body is usually a note or a decision — there
    // is nothing to dispatch, and a drawer offering to run it is noise on what
    // you opened to read. A real constitution keeps its actions.
    const shuttleManaged = isAgentCard(card)
    const controls =
      this.host && !shuttleManaged ? null : this.buildControls(card, shuttleManaged)

    // ── Fiber body pane ─────────────────────────────────────────────────────
    // The fiber itself: outcome lede, then the markdown body, rendered by the
    // lean `marked` renderer and styled to read like a vellum page (see the
    // class docstring). Fetched async so the grid path pays nothing until a
    // card is opened; a remote fiber (whose body the local daemon can't read)
    // degrades to its outcome.
    const page = document.createElement('div')
    page.className = 'kbn-detail-page'
    const prose = document.createElement('article')
    prose.className = 'kbn-detail-prose'
    prose.innerHTML = '<p class="kbn-detail-prose-loading">Loading…</p>'
    if ((card.workerSurface ?? card.shuttleSurface) === 'app' && card.sessionUuid && !appTarget.conversationSpecific) {
      const guidance = document.createElement('p')
      guidance.className = 'kbn-detail-app-guide'
      guidance.textContent = appTarget.guidance
      page.append(guidance)
    }
    page.append(prose)
    this.bodyPage = page
    this.proseEl = prose
    void this.renderFiberBody(prose, card, overlay)

    // ── Sent-files launcher ──────────────────────────────────────────────────
    // The deliverable trail: files the card's worker sessions pushed via
    // SendUserFile, newest first. Mounts empty and self-populates from the
    // daemon's /sent-files. Clicking an entry opens it in the separate
    // file-viewer window (creating that window on first open). Empty trail →
    // the launcher never reveals itself.
    const launcher = this.buildSentFilesLauncher(card)

    // ── Files band: attachments, then the sent-files trail ──────────────────
    // One band holds both groups. Attachments lead, because an attachment is
    // what the fiber is about and a sent file is a delivery it made along the
    // way; the body read fills them (renderFiberBody → renderAttachments). A
    // fiber rarely has more than a few attachments, and a row of their cards
    // is tall enough for several rows of sent-file chips, so on a wide card
    // the trail sits to the RIGHT of the cards and scrolls within their
    // height rather than stacking a second band under them. The stylesheet
    // owns that choice (a container query on the card's width), and either
    // group alone takes the whole band.
    const attachHost = document.createElement('div')
    attachHost.className = 'kbn-detail-attach-host'
    this.attachHost = attachHost
    const files = document.createElement('div')
    files.className = 'kbn-detail-files'
    files.append(attachHost, launcher)

    // ── Assemble: a single reading column ────────────────────────────────────
    // The card panel is one flex column — header, controls, files, body. The
    // file viewer is a SEPARATE floating window (openViewerWindow), so the
    // card keeps its own size and never grows.
    const transcript = this.buildTranscriptPane(card)
    overlay.append(header, ...(controls ? [controls] : []), transcript, files, page)
    if (this.host) {
      // A tab's card: no frame of its own, no z-order, no registration — it is
      // inside the panel's window, which carries all three for it.
      this.host.append(overlay)
    } else {
      if (!this.isSheet()) {
        attachPanelResize(overlay, { onSettle: () => this.rememberGeometry(overlay) })
      }
      // Clicking anywhere on the card raises it above the viewer window. Capture
      // phase so a click on an inner control still bumps z-order first.
      overlay.addEventListener('pointerdown', () => bringToFront(overlay), true)
      bringToFront(overlay)
      document.body.append(overlay)
      registerPanel(overlay)
    }
    this.overlay = overlay

    // Rehydrate the viewer window from persisted state, once the launcher's
    // trail is known. The launcher fetch resolves it async; rehydration that
    // needs a basename falls back to deriving it from the path.
    this.rehydrateOpenFiles(card, persist)

    // Escape to close the panel. When the parent-fiber dropdown is open and
    // focus is inside it, yield to the dropdown's own keydown listener so it
    // can close just the dropdown (not the whole panel). A tabbed card has no
    // Escape of its own — the panel closes the tab being read.
    if (!this.host) {
      this.escapeHandler = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return
        if (document.activeElement?.closest('.kbn-detail-parent-input, .kbn-detail-parent-dropdown, .kbn-ctl-meet-open')) return
        // The wikilink panel, opened after the card, takes Escape first — a
        // reading unwinds one followed reference per press before the card it
        // was read from closes.
        if (!isTopPanel(overlay)) return
        this.close()
      }
      document.addEventListener('keydown', this.escapeHandler, true)
    }

    // Click-away closes the panel. pointerdown (not click) so the gesture
    // that opened the panel — whose pointerdown happened before this
    // listener existed — can never self-close it. The pointer events are left
    // to PROPAGATE, because the board under the panel has to keep scrolling
    // and dragging; what does not propagate is the CLICK at the end of the
    // gesture. A tap that puts the panel away means "put this away" and
    // nothing more — it must not also open the card it happened to land on.
    // The second tap, made once the panel is gone, opens that card normally.
    //
    // A LINKED card has no click-away at all: it was opened by following a
    // reference, and the next thing you click is very often the card you came
    // from. It closes by its ×, by Escape, or with the card that opened it.
    if (!this.host) {
      this.outsideHandler = (e: PointerEvent) => {
        const target = e.target as Node | null
        // The panel holding followed references counts as inside — clicking the
        // fiber you walked to is navigation within one reading, not leaving it.
        if (inSomeOpenPanel(target)) return
        // The file-viewer window is a sibling floating window, not "outside" the
        // card in the user's mental model — clicking it focuses it (raises it),
        // it must NOT close the card. Both windows coexist; only a click truly
        // away from both closes the card (which then closes its viewer too).
        if (target instanceof Element && target.closest('.kbn-fileview-window')) return
        // The move menu is a document.body child (the panel is a size container
        // and would clip it), so by DOM position it is "outside" the card while
        // being, to the reader, part of it. Clicking it must not close the card
        // out from under the choice being made.
        // Same for its SCRIM: a tap there is a dismissal of the menu, and one
        // tap dismisses one thing. Closing the card underneath at the same
        // time would take away the reading as well as the menu it raised.
        if (target instanceof Element && target.closest('.kbn-move-menu, .kbn-move-scrim')) return
        suppressNextClick(window)
        this.close()
      }
      document.addEventListener('pointerdown', this.outsideHandler, true)
    }

    // A window that shrinks under an open panel strands it exactly the way a
    // geometry saved on a bigger display does — the lower edge, and the page
    // pane's scrollport with it, ends up below the screen. Refit both windows
    // in place so the body stays readable to its end.
    this.resizeHandler = () => {
      // A sheet has nothing to refit; the viewport IS its geometry.
      if (this.overlay && this.isSheet()) return
      if (this.overlay && !this.host) {
        const geom = fitted(readPanelGeometry(this.overlay))
        applyGeometryTo(this.overlay, geom)
        this.cardGeom = geom
        lastGeometry = geom
      }
      if (this.viewerWindow && !this.viewerWindow.classList.contains('kbn-detail-sheet')) {
        this.viewerGeom = fitted(readPanelGeometry(this.viewerWindow))
        applyGeometryTo(this.viewerWindow, this.viewerGeom)
      }
      this.writePersist()
    }
    window.addEventListener('resize', this.resizeHandler)

    if (!this.host) {
      // THE PHONE'S BACK GESTURE, and only the phone's: a desktop window is
      // dismissed by its × or Escape, and pushing an entry there would make the
      // browser's Back button close a panel the user did not navigate to.
      this.syncSheetHistory()

      // Crossing 700px with the panel open re-frames it in place — window to
      // sheet and back — rather than leaving a phone-sized window stranded
      // mid-viewport (a rotation, or a desktop window dragged narrow). The
      // history claim moves with the frame: a window holds no entry, a sheet
      // does.
      this.mobileWatch = onMobileChange(() => {
        if (!this.overlay) return
        this.applyFrame(this.overlay)
        this.syncSheetHistory()
      })
    }

    this.startLiveRefresh()
  }

  /**
   * The meeting this card hosts, as a scrolling transcript under the controls.
   * Hidden until the board's meeting record names this card; repainted by
   * {@link syncMeeting} on every meeting poll, following the newest line.
   */
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
    meta.append(dot, state, title)
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
    this.meetingPaint?.()
    const pane = this.transcriptPane
    const card = this.transcriptCard
    if (!pane || !card) return
    const meeting = this.meeting?.current() ?? null
    const hosted = meetingHostCard(meeting, [card]) !== null
    pane.hidden = !hosted || meeting === null || meeting.tail.length === 0
    if (!meeting || !hosted) return
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
  private buildWorkerPill(card: KanbanCard): HTMLElement | null {
    if ((card.workerSurface ?? card.shuttleSurface) === 'app' && card.sessionUuid) {
      const workerState = workerVariant(card)
      return appWorkerLink(card, `kbn-detail-aloft${workerState === 'aloft' ? '' : ` kbn-card-worker-${workerState}`}`)
    }
    if (card.tmuxSession) {
      return terminalWorkerPill(card, {
        classes: 'kbn-detail-aloft',
        phase: this.workerPhase(card),
        openWorker: this.onOpenWorker,
      })
    }
    return null
  }

  /** The id of the card the panel is showing, or null when closed. */
  get openCardId(): string | null {
    return this.overlay ? this.card?.id ?? null : null
  }

  /** Everything the worker pill is drawn from, as one comparable string. */
  private workerPillState(card: KanbanCard): string {
    return JSON.stringify([
      card.workerSurface ?? card.shuttleSurface ?? null,
      card.sessionUuid ?? null,
      card.tmuxSession ?? null,
      card.sessionLink ?? null,
      card.runtimePhase ?? null,
      card.lastActivityAt ?? null,
      card.launchError ?? null,
      this.workerPhase(card),
      workerVariant(card),
    ])
  }

  /**
   * Repaint the header's worker pill from a fresher copy of the open card —
   * the board calls this after every poll, so the pill follows the worker
   * between Waiting, Aloft and Blocked while the panel stays open. A card
   * other than the open one is ignored.
   */
  syncRuntime(card: KanbanCard | null): void {
    if (!card || !this.overlay || !this.statusPill || this.card?.id !== card.id) return
    const key = this.workerPillState(card)
    if (key === this.workerPillKey) return
    this.workerPillKey = key
    const next = this.buildWorkerPill(card)
    if (this.workerPill && next) this.workerPill.replaceWith(next)
    else if (next) this.statusPill.before(next)
    else this.workerPill?.remove()
    this.workerPill = next
  }

  close(): void {
    this.workerPill = null
    this.statusPill = null
    this.workerPillKey = ''
    this.transcriptCard = null
    this.transcriptPane = null
    this.meetingPaint = null
    this.stopLiveRefresh()
    this.bodyRequestToken += 1
    if (this.mobileWatch) {
      this.mobileWatch()
      this.mobileWatch = null
    }
    // An origin card closing takes its followed references with it: the panel
    // is that card's reading, and leaving it open would strand tabs behind a
    // card that no longer exists. A TAB'S card owns no panel (it was handed its
    // owner's), so this only ever fires on the card that made it.
    if (!this.host) {
      const panel = this.linkPanel
      this.linkPanel = null
      panel?.close()
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler)
      this.resizeHandler = null
    }
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler, true)
      this.escapeHandler = null
    }
    if (this.outsideHandler) {
      document.removeEventListener('pointerdown', this.outsideHandler, true)
      this.outsideHandler = null
    }
    if (this.searchDebounce !== null) {
      window.clearTimeout(this.searchDebounce)
      this.searchDebounce = null
    }
    // Flush any pending debounced scroll write before tearing down — the
    // user's last reading position must persist even on a quick close.
    if (this.scrollWriteTimer !== null) {
      window.clearTimeout(this.scrollWriteTimer)
      this.scrollWriteTimer = null
      this.writePersist()
    }
    this.fiberIndex = null
    this.attachHost = null
    // Closing the card closes its file-viewer window too — the two windows are
    // a pair bound to one card. (closeViewerWindow nulls the viewer refs.)
    this.closeViewerWindow()
    this.disposeAttachmentPreviews()
    // The card's own claim goes LAST. The sheet stack is LIFO, and only its top
    // can give an entry back — releasing the card before the viewer and the
    // followed-reference panel above it would leave both stranded.
    if (!this.host) holdSheet(SHEET_CARD, false)
    if (this.overlay && !this.host) unregisterPanel(this.overlay)
    this.overlay?.remove()
    this.overlay = null
    // Viewer state is durable (localStorage) — clear only the live DOM refs so
    // a re-open rebuilds cleanly.
    this.card = null
    this.sentFiles = []
    this.openFiles = []
    this.activePath = null
    this.rightCol = null
    this.tabStrip = null
    this.bodyPage = null
    this.proseEl = null
    this.attachHost = null
    this.sentWrap = null
    this.sentList = null
    this.sentCount = null
    this.sentMore = null
    this.bodyRevision = undefined
    this.sentFilesRevision = ''
    this.sentFilesEtag = null
    this.resourceRevisions.clear()
    this.attachmentLiveUrls.clear()
  }

  /**
   * Fetch the fiber's markdown body from the daemon and render it into the
   * page pane. The body endpoint (`GET /api/v1/fibers/<id>?body=true`) is
   * owner-routed by the card's origin; it degrades to the outcome when the
   * fiber can't be found there or genuinely has no body. `:::{embed}` files
   * become the attachment strip, and relative images resolve through the
   * daemon's `/file` route, anchored on the fiber's dir (`card.fiberDir`).
   */
  private async renderFiberBody(
    prose: HTMLElement,
    card: KanbanCard,
    overlay: HTMLElement,
    opts: { preserveContent?: boolean } = {},
  ): Promise<void> {
    const preserveContent = opts.preserveContent === true
    const requestToken = ++this.bodyRequestToken
    const pageScroll = this.bodyScroller()?.scrollTop ?? 0

    if (!preserveContent) {
      // Render the outcome (the card already carries it) IMMEDIATELY, so the
      // panel is never blank: the daemon's body read (`?body=true`) can take
      // several seconds under poll-load, and a bare "Loading…" reads as broken.
      // The body then fills in below the lede, or degrades to a clear note.
      prose.innerHTML = ledeHtml((card.outcome ?? '').trim()) + '<p class="kbn-detail-body-status">loading body…</p>'
    }

    let body = ''
    let outcomeFromDaemon: string | undefined
    let modifiedAt: string | undefined
    let found = false
    let reached = false
    let timer: number | null = null
    try {
      // Carry the owning origin so the daemon owner-routes the read to the host
      // that can actually read the fiber (over the SSH tunnel), exactly like
      // every write and the /file bytes route. A remote fiber's body is fetched
      // FROM the remote, never from a git mirror — git sync is never relied on.
      const origin = encodeURIComponent(card.originId ?? '')
      const ctrl = new AbortController()
      timer = window.setTimeout(() => ctrl.abort(), 25000)
      const res = await fetch(
        `${fiberDocUrl(this.shuttleBase, card.id)}?body=true&origin=${origin}`,
        { signal: ctrl.signal, cache: 'no-store' },
      )
      if (res.ok) {
        const data = (await res.json()) as {
          fibers?: Array<{ fiber?: { body?: unknown; outcome?: unknown; modified_at?: unknown } }>
        }
        // An empty `fibers` array means the daemon answered but has no fiber by
        // that id (vs. found-but-bodyless); the note below distinguishes them.
        const fiber = data.fibers?.[0]?.fiber
        found = (data.fibers?.length ?? 0) > 0
        body = typeof fiber?.body === 'string' ? fiber.body.trim() : ''
        outcomeFromDaemon = typeof fiber?.outcome === 'string' ? fiber.outcome.trim() : undefined
        modifiedAt = typeof fiber?.modified_at === 'string' ? fiber.modified_at : undefined
        reached = true
      }
    } catch {
      // abort / timeout / network — `reached` stays false.
    } finally {
      if (timer !== null) window.clearTimeout(timer)
    }
    // The panel may have closed (or been replaced) while we awaited.
    if (this.overlay !== overlay || requestToken !== this.bodyRequestToken) return
    // A live refresh must never erase readable content because a transient
    // tunnel failure happened. The explicit retry button remains available on
    // the initial-load path, while the refresh control leaves the old page in
    // place and can try again on its next tick.
    if (!reached && preserveContent) return

    const outcome = outcomeFromDaemon ?? (card.outcome ?? '').trim()
    // Seed/advance the body's change baseline off the read that is about to
    // paint, so the first live tick compares against what the reader sees.
    if (reached) this.bodyRevision = modifiedAt
    const lede = ledeHtml(outcome)

    prose.classList.remove('kbn-detail-prose-empty')
    this.disposeAttachmentPreviews()
    this.attachHost?.replaceChildren()
    if (body) {
      // Resolve a relative `:::{embed}` / image against the fiber's own dir
      // (carried on the card from the composite feed) and route the bytes
      // through `/file`. A fiber whose dir didn't resolve degrades to embed
      // placeholders + un-rewritten images, but the prose still reads.
      const bodyOpts = {
        basePath: card.fiberDir,
        originId: card.originId,
        projectDir: card.shuttleProjectDir,
        // The reading surface resolves [[…]] (installWikilinkNavigation below);
        // it is the one surface that may render them as links.
        wikilinks: true,
      }
      // The body's `:::{embed}` directives are DECLARATIONS, not placements:
      // each names a file the fiber keeps current, they leave the prose
      // entirely, and every one of them is drawn as a card in the strip above
      // (renderAttachments). See attachments.ts for why inline rendering went.
      const { body: prose_md, attachments } = extractEmbeds(body)
      prose.innerHTML = lede + renderMarkdown(prose_md, bodyOpts)
      this.renderAttachments(attachments, card)
      this.installBodyFileLinks(prose, card)
      void this.installWikilinkNavigation(prose, overlay)
      this.restoreBodyScroll(pageScroll, overlay)
      return
    }
    if (!outcome && reached && found) {
      prose.classList.add('kbn-detail-prose-empty')
      prose.textContent = 'No body or outcome yet.'
      this.restoreBodyScroll(pageScroll, overlay)
      return
    }
    // No body. Three honest cases:
    //   reached + found      → the fiber simply has no markdown body.
    //   reached + not found  → the daemon has no fiber by this id.
    //   not reached          → the read failed/timed out; offer a retry.
    const note = !reached
      ? 'Couldn’t load the body — the daemon was slow to respond. <button type="button" class="kbn-detail-body-retry">retry</button>'
      : found
        ? 'No body yet — the outcome above is the headline.'
        : 'This fiber isn’t in the local mirror yet (not synced here) — the outcome above is the headline. <button type="button" class="kbn-detail-body-retry">retry</button>'
    prose.innerHTML = lede + `<p class="kbn-detail-prose-note">${note}</p>`
    // The outcome lede cites fibers too — a bodyless card is still navigable.
    void this.installWikilinkNavigation(prose, overlay)
    prose.querySelector('.kbn-detail-body-retry')?.addEventListener('click', () => {
      void this.renderFiberBody(prose, card, overlay)
    })
    this.restoreBodyScroll(pageScroll, overlay)
  }

  // ── Attachments: the strip above the prose ──────────────────────────────

  /**
   * Draw one card per `:::{embed}` in the body, in body order, as a strip
   * ABOVE the prose.
   *
   * Not inline: that would put a scrolling document inside the scrolling
   * constitution — tolerable on a desktop, and on a phone an embedded PDF
   * whose page 2 is simply unreachable. A card is the honest shape — it says
   * what is attached and hands the file to the surface that can actually
   * read it.
   *
   * The strip is NOT the sent-files trail and never merges with it. An
   * attachment is evergreen and central to the fiber; a sent file is a one-off
   * delivery. They share one band and wear the same card idiom so they read
   * as one family, and they stay two groups because they are two things.
   */
  private renderAttachments(attachments: readonly Attachment[], card: KanbanCard): void {
    this.disposeAttachmentPreviews()
    const host = this.attachHost
    if (!host) return
    host.replaceChildren()
    if (attachments.length === 0) return

    const wrap = document.createElement('section')
    wrap.className = 'kbn-detail-attach'

    const heading = document.createElement('div')
    heading.className = 'kbn-detail-attach-heading'
    heading.textContent = attachments.length === 1 ? 'Attachment' : 'Attachments'

    const strip = document.createElement('div')
    strip.className = 'kbn-detail-attach-strip'
    strip.setAttribute('role', 'list')
    for (const att of attachments) strip.append(this.buildAttachmentCard(att, card))

    wrap.append(heading, strip)
    host.append(wrap)
  }

  private disposeAttachmentPreviews(): void {
    this.attachmentWatches.splice(0).forEach((stop) => stop())
    this.attachmentLiveUrls.clear()
  }

  /** One attachment card: a face (image thumbnail, else the extension glyph),
   *  the filename, the author's `:title:` when given, and the size once the
   *  daemon's `/file-info` answers. A path that can't be resolved to an
   *  absolute file (no fiber dir) still draws — inert, saying so. */
  private buildAttachmentCard(att: Attachment, card: KanbanCard): HTMLElement {
    const opts = { basePath: card.fiberDir, originId: card.originId }
    const abs = resolveAbs(att.path, opts)
    const name = basename(att.path)

    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'kbn-detail-attach-card'
    el.setAttribute('role', 'listitem')
    el.title = att.title ? `${att.title}\n${abs ?? att.path}` : (abs ?? att.path)

    const face = this.buildAttachmentFace(att, abs, card)

    const nameEl = document.createElement('span')
    nameEl.className = 'kbn-detail-attach-name'
    nameEl.textContent = name

    const meta = document.createElement('span')
    meta.className = 'kbn-detail-attach-meta'
    meta.textContent = abs ? '' : 'path unresolved'

    el.append(face, nameEl)
    if (att.title) {
      const titleEl = document.createElement('span')
      titleEl.className = 'kbn-detail-attach-title'
      titleEl.textContent = att.title
      el.append(titleEl)
    }
    el.append(meta)

    if (!abs) {
      el.disabled = true
      return el
    }
    void readFileInfo(this.shuttleBase, abs, card.originId).then((info) => {
      // Best-effort and silent: no answer simply leaves the size blank.
      if (info && meta.isConnected) meta.textContent = info.exists ? formatBytes(info.size) : 'missing'
    })
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      this.openArtifact({ fullPath: abs, basename: basename(abs), timestamp: Date.now() }, card)
    })
    return el
  }

  /**
   * The card's face — a glimpse of the file, not a symbol standing in for it.
   *
   * A strip of identical extension glyphs tells you nothing you couldn't read
   * off the filenames beneath them, and an attachment strip is exactly where
   * you want to recognize the report you're after at a glance. So each kind
   * shows whatever the browser can give for free from the bytes the daemon
   * already serves: an image its thumbnail, an HTML report a scaled-down live
   * render, a markdown/text file its opening lines. A PDF and anything opaque
   * keep the glyph — there is nothing cheap to show, and pretending otherwise
   * would mean rendering daemon-side, which this strip deliberately doesn't.
   *
   * Everything beyond the image thumbnail is LAZY and idle: nothing is fetched
   * until the card is actually scrolled into view, so a fiber with a dozen
   * attachments costs one request, not a dozen.
   */
  private buildAttachmentFace(
    att: Attachment,
    abs: string | null,
    card: KanbanCard,
  ): HTMLElement {
    const face = document.createElement('span')
    face.className = 'kbn-detail-attach-face'
    const glyph = document.createElement('span')
    glyph.className = 'kbn-detail-attach-ext'
    glyph.textContent = attachmentGlyph(att.path)
    face.append(glyph)
    if (!abs) return face

    const src = fileBytesUrl(this.shuttleBase, abs, card.originId ?? '')
    const kind = fileKind(att.path)

    if (kind === 'image') {
      const img = document.createElement('img')
      img.className = 'kbn-detail-attach-thumb'
      img.src = src
      img.alt = ''
      img.loading = 'lazy'
      // The glyph stays as the fallback: a broken or slow image leaves the
      // suffix showing rather than an empty rectangle.
      img.addEventListener('load', () => glyph.remove())
      face.append(img)
      return face
    }

    if (kind === 'html') {
      this.attachmentLiveUrls.add(src)
      this.attachmentWatches.push(whenVisible(face, () => {
        let frame: HTMLIFrameElement | null = null
        let stagingFrame: HTMLIFrameElement | null = null
        let generation = 0
        // Render at a desktop width, then shrink the whole thing into the
        // face — a report laid out at 148px would reflow into a column of
        // single words and look nothing like itself.
        const scale = (preview: HTMLIFrameElement): void => {
          preview.className = 'kbn-detail-attach-frame'
          preview.setAttribute('sandbox', '')
          preview.setAttribute('tabindex', '-1')
          preview.setAttribute('aria-hidden', 'true')
          preview.style.setProperty('--attach-frame-scale', String((face.clientWidth || 128) / ATTACH_FRAME_WIDTH))
        }
        this.attachmentWatches.push(watchLiveFile(src, (html) => {
          stagingFrame?.remove()
          const next = document.createElement('iframe')
          scale(next)
          next.style.visibility = 'hidden'
          stagingFrame = next
          const token = ++generation
          let loaded = false
          next.addEventListener('load', () => {
            if (loaded || token !== generation || stagingFrame !== next) return
            loaded = true
            frame?.replaceWith(next)
            frame = next
            stagingFrame = null
            next.style.visibility = ''
            glyph.remove()
          })
          face.append(next)
          next.srcdoc = htmlWithBase(html, src)
        }))
      }))
      return face
    }

    if (kind === 'markdown' || kind === 'text') {
      this.attachmentLiveUrls.add(src)
      this.attachmentWatches.push(whenVisible(face, () => {
        let previewEl: HTMLElement | null = null
        this.attachmentWatches.push(watchLiveFile(src, (text) => {
          const preview = previewText(text.slice(0, PREVIEW_BYTES))
          if (!preview) {
            previewEl?.remove()
            previewEl = null
            return
          }
          if (!previewEl) {
            previewEl = document.createElement('span')
            previewEl.className = 'kbn-detail-attach-peek'
            glyph.remove()
            face.append(previewEl)
          }
          previewEl.textContent = preview
        }))
      }))
    }

    return face
  }

  /**
   * Open one file path, by pointer.
   *
   * Under a MOUSE it goes to the Reader, where the tab strip, the zoom and the
   * ⤓ live. Under a FINGER it goes to the Reader too, for every kind the
   * browser can lay out — and downloads straight away for a PDF or an opaque
   * file, because on iOS the download is what hands those to the native
   * viewer, the one surface that can page a PDF properly. The rule itself is
   * `fileTapAction`'s; an attachment card and a sent-file chip both land here.
   */
  private openArtifact(file: SentFile, card: KanbanCard): void {
    if (fileTapAction(coarsePointer(), file.fullPath) === 'download') {
      void this.downloadFile(file.fullPath, card.originId ?? '')
      return
    }
    this.activateFile(file, card)
  }

  /** What scrolls the body: the page pane in a window, the whole sheet on a phone. */
  private bodyScroller(): HTMLElement | null {
    return this.isSheet() ? this.overlay : this.bodyPage
  }

  private restoreBodyScroll(scrollTop: number, overlay: HTMLElement): void {
    const page = this.bodyScroller()
    if (!page) return
    page.scrollTop = scrollTop
    window.requestAnimationFrame(() => {
      if (this.overlay === overlay) page.scrollTop = scrollTop
    })
  }

  private startLiveRefresh(): void {
    this.stopLiveRefresh()
    this.liveRefreshLastRunAt = null
    // The panel keeps its OWN timer rather than riding the kanban's poll: a
    // linked-fiber tab (`mountLinkedCard`) is mounted from the single-fiber
    // feed and may not be a board card at all, so nothing on the board would
    // drive it.
    this.liveRefreshTimer = window.setInterval(() => {
      // Hidden tabs stop polling; visible but unfocused windows slow to the
      // shared page-attention cadence.
      if (!shouldRunVisiblePoll(this.liveRefreshLastRunAt, Date.now(), LIVE_REFRESH_INTERVAL_MS)) {
        return
      }
      void this.refreshLiveContent()
    }, LIVE_REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', this.visibilityHandler)
  }

  private stopLiveRefresh(): void {
    if (this.liveRefreshTimer !== null) {
      window.clearInterval(this.liveRefreshTimer)
      this.liveRefreshTimer = null
    }
    document.removeEventListener('visibilitychange', this.visibilityHandler)
    this.liveRefreshBusy = false
  }

  /**
   * Keep the open reading surface current without rebuilding its windows.
   *
   * One tick: probe the fiber's `modified_at` and re-render the body if it
   * moved, ask `/sent-files` conditionally (the `If-None-Match` rarely helps
   * — see the fetch site), then re-baseline every artifact the panel is
   * showing. Bytes
   * are fetched only when something actually changed, and the reader's scroll,
   * zoom, and active tabs survive every tick.
   *
   * Best-effort throughout: a fiber or a probe that momentarily can't be
   * read leaves the readable page exactly as it is.
   */
  private async refreshLiveContent(): Promise<void> {
    const card = this.card
    const overlay = this.overlay
    const prose = this.proseEl
    if (!card || !overlay || !prose || this.liveRefreshBusy) return

    this.liveRefreshBusy = true
    this.liveRefreshLastRunAt = Date.now()
    try {
      const revision = await this.readFiberRevision(card)
      if (this.overlay !== overlay) return
      if (revision !== undefined && revision !== this.bodyRevision) {
        await this.renderFiberBody(prose, card, overlay, { preserveContent: true })
        if (this.overlay !== overlay) return
      }

      const files = await this.fetchSentFiles(card)
      if (this.overlay !== overlay) return
      if (files !== null && files !== SENT_FILES_UNCHANGED) this.applySentFiles(files, card)

      await this.refreshArtifacts(card)
      if (this.overlay !== overlay) return
    } catch {
      // A live tick is best-effort. Keep the readable page and let the next
      // tick or the explicit button try again rather than replacing it with an
      // outage message.
    } finally {
      if (this.overlay === overlay) this.liveRefreshBusy = false
    }
  }

  /**
   * The ↻ control: reload EVERYTHING unconditionally, no probes consulted.
   * The reader clicked because they believe the panel is stale, so the honest
   * answer is to refetch rather than to re-derive whether a refetch is owed —
   * which is also why a tick already in flight does not block it.
   */
  private async forceReload(): Promise<void> {
    const card = this.card
    const overlay = this.overlay
    const prose = this.proseEl
    if (!card || !overlay || !prose) return

    await this.renderFiberBody(prose, card, overlay, { preserveContent: true })
    if (this.overlay !== overlay) return

    // Bypass every cache so the trail and the launcher are rebuilt from bytes.
    this.sentFilesEtag = null
    this.sentFilesRevision = ''
    const files = await this.fetchSentFiles(card)
    if (this.overlay !== overlay) return
    if (files !== null && files !== SENT_FILES_UNCHANGED) this.applySentFiles(files, card)

    await Promise.all([
      ...this.openFiles.map((entry) => refreshLiveFile(
        fileBytesUrl(this.shuttleBase, entry.file.fullPath, card.originId ?? ''),
      )),
      ...[...this.attachmentLiveUrls].map((url) => refreshLiveFile(url)),
    ])

    for (const [, nodes] of this.artifactNodesByPath()) {
      nodes.forEach((node) => this.reloadArtifactNode(node))
    }
  }

  /**
   * The fiber's own change revision — its `modified_at`, read from the SAME
   * owner-routed endpoint the body read uses, minus `body=true`. `undefined`
   * means "no answer" (fiber absent from the response, or the read failed) and
   * the caller skips rather than wiping a readable page.
   */
  private async readFiberRevision(card: KanbanCard): Promise<string | undefined> {
    try {
      const origin = encodeURIComponent(card.originId ?? '')
      const res = await fetch(
        `${fiberDocUrl(this.shuttleBase, card.id)}?origin=${origin}`,
        { cache: 'no-store' },
      )
      if (!res.ok) return undefined
      const data = (await res.json()) as {
        fibers?: Array<{ fiber?: { modified_at?: unknown } }>
      }
      const modifiedAt = data.fibers?.[0]?.fiber?.modified_at
      return typeof modifiedAt === 'string' ? modifiedAt : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Every artifact the panel is showing, as one path → nodes map: the viewers
   * built for open sent-file tabs and the inline `img`/`iframe`/`audio` a body
   * renders. ONE baseline per path — the same report reached through a tab and
   * through an embed is one file, and probing it twice under two keys is how
   * the two views drifted apart.
   */
  private artifactNodesByPath(): Map<string, RefreshableArtifact[]> {
    const byPath = new Map<string, RefreshableArtifact[]>()
    const add = (path: string | null, node: RefreshableArtifact | null): void => {
      if (!path || !node) return
      const nodes = byPath.get(path) ?? []
      nodes.push(node)
      byPath.set(path, nodes)
    }

    for (const entry of this.openFiles) {
      if (!entry.viewerBuilt) continue
      add(
        entry.path,
        entry.cell.querySelector<RefreshableArtifact>(
          'img.kbn-fileview-image, iframe.kbn-fileview-frame, audio',
        ),
      )
    }
    this.proseEl
      ?.querySelectorAll<RefreshableArtifact>('img[src], iframe[src], audio[src]')
      .forEach((node) => add(artifactPath(node), node))

    return byPath
  }

  /**
   * Re-baseline every artifact path once and reload the nodes behind any that
   * moved. A path in the sent-files trail falls back to its send timestamp
   * when `/file-info` gives no answer, so a re-sent file still reloads.
   */
  private async refreshArtifacts(card: KanbanCard): Promise<void> {
    const byPath = this.artifactNodesByPath()
    if (byPath.size === 0) return
    const overlay = this.overlay
    const sentByPath = new Map(this.sentFiles.map((file) => [file.fullPath, file]))

    const paths = [...byPath.keys()]
    const stats = await Promise.all(
      paths.map((path) => readFileRevision(this.shuttleBase, path, card.originId)),
    )
    if (!overlay || this.overlay !== overlay) return

    paths.forEach((path, index) => {
      const sent = sentByPath.get(path)
      const revision = stats[index] ?? (sent ? `trail:${sent.timestamp}` : undefined)
      if (revision === undefined) return
      const previous = this.resourceRevisions.get(path)
      this.resourceRevisions.set(path, revision)
      if (previous !== undefined && previous !== revision) {
        ;(byPath.get(path) ?? []).forEach((node) => this.reloadArtifactNode(node))
      }
    })
  }

  /** Make one artifact node re-navigate to the same path with a fresh marker. */
  private reloadArtifactNode(node: RefreshableArtifact): void {
    const src = node.getAttribute('src')
    if (src) node.setAttribute('src', cacheBustUrl(src))
  }

  /**
   * Adopt a freshly read sent-files trail: relabel open tabs onto their latest
   * record, re-render the launcher when the trail actually moved, and reconcile
   * disambiguated basenames. It does NOT reload any bytes — `refreshArtifacts`
   * owns that, and its `trail:` fallback covers a re-sent file whose
   * `/file-info` gives no answer.
   */
  private applySentFiles(files: SentFile[], card: KanbanCard): void {
    const next = disambiguateBasenames(files)
    const nextByPath = new Map(next.map((file) => [file.fullPath, file]))
    const revision = sentFilesRevision(next)
    const changed = revision !== this.sentFilesRevision

    this.sentFiles = next
    this.sentFilesRevision = revision
    if (this.sentList && this.sentWrap && changed) {
      this.renderLauncher(this.sentList, card)
      this.sentWrap.classList.toggle('kbn-detail-sent-empty', next.length === 0)
      this.syncSentFold()
    }
    if (!changed) {
      this.syncLauncherActiveState()
      return
    }

    for (const entry of this.openFiles) {
      const latest = nextByPath.get(entry.path)
      if (latest) {
        entry.file = latest
        this.updateOpenFileLabel(entry)
      }
    }
    if (this.openFiles.length > 0) this.writePersist()
    this.syncLauncherActiveState()
  }

  private updateOpenFileLabel(entry: OpenFileEntry): void {
    const name = entry.tab.querySelector('.kbn-detail-tab-name')
    if (name) name.textContent = entry.file.basename
    entry.tab.title = entry.file.fullPath
    entry.tab.querySelector('.kbn-detail-tab-close')?.setAttribute(
      'aria-label',
      `Close ${entry.file.basename}`,
    )
  }

  /**
   * Route a body's relative links into this panel's own file viewer.
   *
   * `renderMarkdown` already resolved them to working `/api/v1/file` URLs, so
   * the href alone is correct and middle-click / cmd-click still open a tab.
   * But a sibling `AGENTS.md` belongs in the viewer beside the fiber, not in a
   * new tab — the same place the sent-files strip opens things, reached the
   * same way. Only paths the resolver understood carry `data-file-path`, so an
   * external link never reaches this handler.
   */
  private installBodyFileLinks(prose: HTMLElement, card: KanbanCard): void {
    for (const link of prose.querySelectorAll<HTMLAnchorElement>('a[data-file-path]')) {
      const fullPath = link.dataset.filePath
      if (!fullPath) continue
      link.title = `Open ${basename(fullPath)} in the viewer`
      link.addEventListener('click', (e) => {
        // Leave the modified clicks to the browser — a cmd-click means "new
        // tab" everywhere else and should here too.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const target = link.dataset.filePath ?? fullPath
        this.activateFile(
          { fullPath: target, basename: basename(target), timestamp: Date.now() },
          card,
        )
      })
      void this.settleLinkAnchor(link)
    }
  }

  /**
   * Make the body's `[[wikilinks]]` navigable: each one that names a real
   * fiber opens that fiber as another card beside this one.
   *
   * Resolution and the inert-when-unresolvable rule live in wikilinks.ts; this
   * only supplies the daemon base and what a click should do.
   */
  private async installWikilinkNavigation(
    prose: HTMLElement,
    overlay: HTMLElement,
  ): Promise<void> {
    await installWikilinks(prose, {
      shuttleBase: this.shuttleBase,
      stillCurrent: () => this.overlay === overlay,
      onOpen: (fiberId) => void this.openLinkedFiber(fiberId),
    })
  }

  /**
   * Follow a reference: the fiber it names opens as a TAB in the one panel
   * beside the origin card.
   *
   * Every followed link in a reading lands in the same panel — a link clicked
   * in a tab included, because a linked card is handed its owner's panel rather
   * than making one. So a reading is two panes however far it is walked: the
   * card you started from, and the references you followed, tabbed.
   *
   * Routing (`linkedTabs.routeWikilink`) settles the two cases that need no
   * fetch at all: a link back to the origin card raises that card, and a link
   * to a fiber already open focuses its tab. The panel does the rest.
   */
  private openLinkedFiber(fiberId: string): void {
    this.linkPanelForReading()?.open(fiberId)
  }

  /**
   * The panel this card's followed references belong in — its owner's if this
   * card IS a tab, otherwise its own, created on the first link followed.
   */
  private linkPanelForReading(): LinkedFiberPanel | null {
    if (this.linkPanel) return this.linkPanel
    if (this.host) return null // a tab always receives its owner's panel
    const overlay = this.overlay
    if (!overlay) return null
    const panel: LinkedFiberPanel = new LinkedFiberPanel({
      originFiberId: () => this.card?.id ?? null,
      focusOrigin: () => bringToFront(overlay),
      placeOrigin: (g) => {
        // The card glides to the left half the way it does when the file viewer
        // opens — same arrangement, so a reading and a deliverable split the
        // screen the same way.
        animatePanelGeometry(overlay, g)
        lastGeometry = g
        this.cardGeom = g
        this.writePersist()
      },
      mount: (id, host, requestClose) => this.mountLinkedCard(panel, id, host, requestClose),
      onClosed: () => {
        this.linkPanel = null
      },
    })
    this.linkPanel = panel
    return panel
  }

  /**
   * Build one followed fiber's card inside its tab cell.
   *
   * The fiber arrives from the SINGLE-fiber feed rather than the board's, so
   * fibers the board never shows — a closed note, a decision, an idea — open
   * exactly like the ones it does. A fiber the daemon cannot serve mounts
   * nothing and says so: the panel withdraws the tab it opened, and better a
   * toast than a tab with no fiber in it.
   */
  private async mountLinkedCard(
    panel: LinkedFiberPanel,
    fiberId: string,
    host: HTMLElement,
    requestClose: () => void,
  ): Promise<{ label: string; close: () => void } | null> {
    let card: KanbanCard | null = null
    try {
      const res = await fetch(`${fiberDocUrl(this.shuttleBase, fiberId)}?body=true`)
      if (res.ok) {
        const entry = parseCompositeFeed(await res.json()).entries[0]
        if (entry) card = cardFromCompositeEntry(entry)
      }
    } catch {
      // Network/abort — handled by the null card below.
    }
    if (!card) {
      showToast(`Couldn’t open ${fiberId}`, 'error')
      return null
    }
    const tabbed = new FiberDetailModal(
      this.shuttleBase,
      this.onSaved,
      this.onTransition,
      this.onOpenWorker,
      { host, panel, onCloseRequest: requestClose, meeting: this.meeting ?? undefined, workerPhase: this.workerPhase },
    )
    tabbed.open(card)
    return { label: card.name || fiberId, close: () => tabbed.close() }
  }

  /**
   * Decide which of a body link's two candidate directories actually holds the
   * file, by asking.
   *
   * A relative link is ambiguous: `[AGENTS.md](AGENTS.md)` is either a file
   * beside the fiber or a file at the root of the repo the worker was dispatched
   * into. Both are plausible and the markdown does not say. So the renderer
   * emits both and this probes the primary with a HEAD; on anything but a
   * success it swaps the anchor over to the project-dir candidate. One extra
   * HEAD per relative link, and only for links that carry an alternate.
   *
   * Deliberately not a race: the swap only happens when the FIRST candidate is
   * confirmed missing, so a slow probe can never overwrite a good anchor. On a
   * network failure the primary stands — an unverified guess beats swapping to
   * a second unverified guess.
   */
  private async settleLinkAnchor(link: HTMLAnchorElement): Promise<void> {
    const altUrl = link.dataset.fileUrlAlt
    const altPath = link.dataset.filePathAlt
    if (!altUrl || !altPath) return
    const primary = link.getAttribute('href')
    if (!primary) return
    try {
      // Relative, like the images the same renderer emits — the bundle is served
      // by the daemon, so a relative `/api/v1/file` reaches it without CORS.
      const res = await fetch(primary, { method: 'HEAD' })
      if (res.ok) return
    } catch {
      return
    }
    link.setAttribute('href', altUrl)
    link.dataset.filePath = altPath
    link.title = `Open ${basename(altPath)} in the viewer`
  }

  // ── Panel geometry: default + remembered, drag, resize ────────────────────

  /**
   * Is this panel a SHEET rather than a window?
   *
   * One question, asked in one place, because three separate behaviours turn
   * on it — geometry, drag, resize — and a panel that is half-sheet is worse
   * than either. A hosted (tabbed) card is never a sheet: it has no frame of
   * its own in any viewport.
   */
  private isSheet(): boolean {
    return !this.host && isMobileViewport()
  }

  /**
   * Give the panel its frame: a window gets geometry, a sheet gets a class and
   * nothing else. Re-runnable — crossing the mobile threshold with the panel
   * open calls it again, and it strips the inline geometry the window left
   * behind so the sheet's CSS `inset` is not outranked by a stale style
   * attribute.
   */
  private applyFrame(overlay: HTMLElement): void {
    if (this.isSheet()) {
      overlay.classList.add('kbn-detail-sheet')
      for (const prop of ['left', 'top', 'width', 'height']) {
        overlay.style.removeProperty(prop)
      }
      return
    }
    overlay.classList.remove('kbn-detail-sheet')
    this.applyGeometry(overlay)
  }

  /**
   * Claim (or give up) this card's back-entry to match its current frame. A
   * sheet holds one; a window does not. Called on open and again whenever the
   * viewport crosses the mobile threshold, so a rotation moves the claim
   * rather than stranding it.
   */
  private syncSheetHistory(): void {
    holdSheet(SHEET_CARD, this.isSheet(), () => this.close())
  }

  /** Default size: a reading column at nearly full viewport height — the
   *  page wants vertical room; width stays a comfortable measure. The card
   *  panel opens at this width and keeps it (the file viewer is its own
   *  window); remembered geometry wins when it still fits the viewport. */
  private applyGeometry(overlay: HTMLElement): void {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(SINGLE_COL_WIDTH, Math.round(vw * 0.92))
    const height = vh - 24
    const geom = lastGeometry
      ? fitted(lastGeometry)
      : {
          left: Math.max(0, Math.round((vw - width) / 2)),
          top: Math.max(0, Math.round((vh - height) / 2)),
          width,
          height,
        }
    applyGeometryTo(overlay, geom)
    // Track the intended geometry (not a mid-animation offset read) so the
    // persisted card placement is exact.
    this.cardGeom = geom
  }

  private rememberGeometry(overlay: HTMLElement): void {
    // A linked card's placement belongs to the chain that opened it — it must
    // not become where the NEXT card opened from the board appears.
    const geom = readPanelGeometry(overlay)
    if (!this.host) lastGeometry = geom
    this.cardGeom = geom
    // Persist the card window's placement for this card so reopening restores
    // it (alongside the viewer geometry written on the viewer's settle).
    this.writePersist()
  }

  // ── The file-viewer window: open / close ─────────────────────────────────

  /**
   * Create the separate floating file-viewer window the first time a file is
   * opened. Idempotent — a second file opening into the already-open window
   * just adds a tab. The window is a sibling to the card (its own document.body
   * overlay), independently draggable + resizable, and can overlap the card.
   * It reuses the card's vellum frame (`.kbn-detail-overlay`) with a modifier
   * (`.kbn-fileview-window`) that lays it out as a flex column: a slim
   * manuscript drag bar, the tab strip, then the full-bleed views.
   */
  private openViewerWindow(): void {
    if (this.viewerWindow || !this.overlay) return

    const { win, bar, tabs, closeBtn: winClose, views } = buildReaderWindow({
      ariaLabel: 'Sent files',
      closeLabel: 'Close file viewer',
      closeTitle: 'Close all files',
    })
    this.tabStrip = tabs
    this.rightCol = views
    winClose.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeViewerWindow()
      this.writePersist()
    })

    // Download the active file to ~/Downloads (⤓). Pinned right of the tabs,
    // left of the close-all ✕; acts on whichever tab is active.
    const winDownload = document.createElement('button')
    winDownload.type = 'button'
    winDownload.className = 'kbn-fileview-win-download'
    winDownload.setAttribute('aria-label', 'Download file')
    winDownload.title = 'Download to ~/Downloads'
    winDownload.textContent = '⤓'
    winDownload.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.downloadActiveFile()
    })

    bar.insertBefore(winDownload, winClose)

    // Cmd/Ctrl + wheel zooms the active file (images, HTML, PDF — everything).
    views.addEventListener('wheel', (e) => this.handleZoomWheel(e), { passive: false })
    // Under a finger there is no Cmd-wheel, so the − / FIT / + cluster is the
    // only way back from a PDF that fills the sheet. Mounted left of the
    // download glyph, so the two trailing buttons stay where they were.
    installTouchZoom({
      bar,
      views,
      before: winDownload,
      coarse: coarsePointer(),
      buildBar: buildZoomBar,
      active: () => this.openFiles.find((x) => x.file.fullPath === this.activePath),
      onChange: () => this.queueScrollWrite(),
    })

    // ── Geometry ──
    // Remembered placement for this card wins; otherwise the default is
    // half-and-half — the card glides to the left half, the viewer takes the
    // right half. Once placed, the viewer geometry is remembered (settle +
    // close) so the next open restores it instead of re-splitting.
    //
    // UNDER A FINGER, or on a phone-sized screen, there are no halves. The
    // viewer opens as its own sheet OVER the card — one full-screen thing at a
    // time, which is how a hand reads — and the card is left exactly where it
    // was, scroll and all, to be read again when the viewer's ✕ (or the back
    // gesture) takes this sheet away. A tablet lands here too, though the card
    // itself stays a window: see READER_MEDIA in mobile.ts. No geometry is
    // written in this mode, so the sheet's CSS `inset` is not outranked by a
    // stale style attribute; no remembered placement is consulted or saved,
    // because a sheet has no placement to remember.
    const rememberViewer = () => {
      this.viewerGeom = readPanelGeometry(win)
      this.writePersist()
    }
    // Drag (header bar) + resize (eight edge/corner zones) — independent of
    // the card, reusing the same chrome helpers + handle CSS. Both remember
    // the window's new geometry for this card, and both stand down while the
    // viewer is a sheet.
    attachPanelDrag(win, bar, { onSettle: rememberViewer })
    attachPanelResize(win, {
      onSettle: rememberViewer,
    })
    // Clicking anywhere on the viewer raises it above the card — its chrome
    // by `pointerdown`, the file inside it (a frame, whose clicks never reach
    // this document) by the focus move.
    win.addEventListener('pointerdown', () => bringToFront(win), true)
    this.stopViewerFrameRaise = raiseOnFrameFocus(win)

    this.viewerWindow = win
    document.body.append(win)
    this.frameViewer(readerFillsScreen())
    this.stopViewerMediaWatch = onReaderChange((fills) => this.frameViewer(fills))
    bringToFront(win)
  }

  /**
   * Frame the open viewer as a sheet or a placed window, and keep it so. Runs
   * at open and again whenever READER_MEDIA changes under an open viewer (a
   * window widened past a phone's width, a tablet's pointer switched), so its
   * class, inline geometry and back-entry always agree with what the
   * stylesheet draws.
   *
   * A sheet gets its own back-entry, above the card's. Without one, the back
   * gesture over an open viewer skipped straight past it and closed the card
   * underneath — the reader loses the fiber they were reading to dismiss a
   * file.
   */
  private frameViewer(sheet: boolean): void {
    const win = this.viewerWindow
    if (!win) return
    const wasSheet = win.classList.contains('kbn-detail-sheet')
    if (sheet) {
      // The window's placement is kept for when it is a window again.
      if (!wasSheet && Boolean(win.style.width)) this.viewerGeom = readPanelGeometry(win)
      win.classList.add('kbn-detail-sheet')
      for (const prop of ['left', 'top', 'width', 'height']) win.style.removeProperty(prop)
      holdSheet(SHEET_VIEWER, true, () => this.closeViewerWindow())
      return
    }
    if (wasSheet) holdSheet(SHEET_VIEWER, false)
    win.classList.remove('kbn-detail-sheet')
    if (this.viewerGeom) {
      this.viewerGeom = fitted(this.viewerGeom)
      applyGeometryTo(win, this.viewerGeom)
    } else {
      const { card: cardG, other: viewerG } = halfAndHalf()
      // A TABBED card has no frame to move — it fills its cell inside the
      // wikilink panel, so only the viewer takes its half. A card that is
      // itself a sheet keeps its frame too.
      if (!this.host && this.overlay && !this.isSheet()) {
        animatePanelGeometry(this.overlay, cardG)
        lastGeometry = cardG
        this.cardGeom = cardG
      }
      applyGeometryTo(win, viewerG)
      this.viewerGeom = viewerG
    }
    // Persist the new arrangement (half-and-half or restored) immediately.
    this.writePersist()
  }

  /** Tear down the file-viewer window: all tabs/cells die with it, the card
   *  stays open. Fires when the last tab closes OR the window's ✕ is clicked
   *  (the ✕ closes every open file at once). */
  private closeViewerWindow(): void {
    // Remember where the window sat so reopening this card restores it (not the
    // half-and-half default).
    // A sheet has no geometry worth remembering — reading one would persist
    // the phone's viewport as this card's desktop arrangement.
    if (this.viewerWindow && !this.viewerWindow.classList.contains('kbn-detail-sheet')) {
      this.viewerGeom = readPanelGeometry(this.viewerWindow)
    }
    if (this.viewerWindow) holdSheet(SHEET_VIEWER, false)
    this.openFiles.forEach((entry) => {
      entry.frameScrollCleanup?.()
      disposeFileViewer(entry.viewer)
      entry.viewer = null
    })
    this.stopViewerFrameRaise?.()
    this.stopViewerFrameRaise = null
    this.stopViewerMediaWatch?.()
    this.stopViewerMediaWatch = null
    this.viewerWindow?.remove()
    this.viewerWindow = null
    this.rightCol = null
    this.tabStrip = null
    // The tabs + cells lived inside the window; the live open-file set dies
    // with it. (Persisted state is durable — written by callers.)
    this.openFiles = []
    this.activePath = null
    this.syncLauncherActiveState()
  }

  /** Download the active tab's file to the browser's download folder
   *  (`~/Downloads` by default). The daemon's `/api/v1/file` route serves bytes
   *  inline (no `Content-Disposition`), so we fetch them as a blob and trigger a
   *  same-origin object-URL download — that way the chosen filename is always
   *  honoured whether the bundle is daemon-served (same-origin) or dev-served
   *  (cross-origin against `:4000`). Owner-routed by the card's `originId`, so a
   *  remote-owned deliverable downloads through the same proxy the viewer uses. */
  private async downloadActiveFile(): Promise<void> {
    const entry = this.openFiles.find((e) => e.file.fullPath === this.activePath)
    if (!entry || !this.card) return
    await this.downloadFile(entry.file.fullPath, this.card.originId)
  }

  /** Download one path. The ⤓ button and a tap on a card both land here, so
   *  the finger gets exactly the gesture the button always performed. */
  private async downloadFile(fullPath: string, originId: string): Promise<void> {
    const filename = basename(fullPath)
    const url = fileBytesUrl(this.shuttleBase, fullPath, originId)
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = filename
      document.body.append(a)
      a.click()
      a.remove()
      // Defer the revoke past this tick: `a.click()` only *initiates* the
      // download — the browser reads the blob from the object URL after the
      // handler returns, so revoking synchronously races (and can zero-byte) a
      // large download. Same "let the browser finish first" setTimeout(0)
      // deferral used elsewhere on the board.
      window.setTimeout(() => URL.revokeObjectURL(objUrl), 0)
    } catch {
      showToast(`Couldn't download ${filename}`, 'error')
    }
  }

  // ── Controls drawer ─────────────────────────────────────────────────────

  /**
   * The card's drawer — every action and setting the card takes, folded under
   * one strip directly beneath the title.
   *
   * Folded, the strip is a reading of the fiber ({@link stripFacts}): who works
   * it, how it recurs, where it runs, when it is due, how its last run went.
   * Unfolded, four things in the order they are reached for: the composer (a
   * message and the dispatch verbs that carry it), the ledger (what the next
   * launch reads, beside the card's own due day and parent), the history
   * (folded: the fiber's sessions, each row opening a terminal on it — see
   * `sessionHistory.ts`), and the verdict that closes the card — Temper or
   * Discard, `tempered` true or false.
   *
   * Type carries the grammar, so no line of it needs a caption: mono for
   * machine values (ids, effort, cron, paths, times), serif for human words
   * (verbs, choices, the message), tracked caps for field labels and nothing
   * else. Pigments keep the board's meanings — cobalt for the machine, gold
   * for what is owed, verdigris for the verdict.
   */
  private buildControls(card: KanbanCard, shuttleManaged: boolean): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-controls'

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'kbn-detail-controls-toggle'
    toggle.setAttribute('aria-expanded', 'false')
    const chevron = document.createElement('span')
    chevron.className = 'kbn-detail-controls-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    // The strip is the toggle's visible face; its name leads with the word.
    const name = document.createElement('span')
    name.className = 'kbn-ctl-sr'
    name.textContent = 'Actions'
    // The strip follows the drawer's edits: every committed setting is
    // reflected into a local copy of the card and the strip redrawn from it.
    let view = card
    let strip = buildStrip(view)
    const watchers: Array<(view: KanbanCard) => void> = []
    const reflect = (patch: Partial<KanbanCard>): void => {
      view = { ...view, ...patch }
      const next = buildStrip(view)
      strip.replaceWith(next)
      strip = next
      for (const watch of watchers) watch(view)
    }
    toggle.append(chevron, name, strip)

    const body = document.createElement('div')
    body.className = 'kbn-detail-controls-body'
    body.hidden = true

    const setOpen = (opening: boolean): void => {
      body.hidden = !opening
      toggle.setAttribute('aria-expanded', String(opening))
      wrap.classList.toggle('kbn-detail-controls-open', opening)
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const opening = body.hidden
      setOpen(opening)
      // On a phone sheet the unfolded drawer leaves the bottom edge for the
      // flow at the page's end; bring its strip up under the title bar, so the
      // drawer opens where the thumb is and the page stays one scroll above.
      const sheet = wrap.closest<HTMLElement>('.kbn-detail-sheet')
      if (opening && sheet) {
        const head = sheet.querySelector('.kbn-detail-header')
        const edge = (head ?? sheet).getBoundingClientRect()
        sheet.scrollTop += wrap.getBoundingClientRect().top - (head ? edge.bottom : edge.top)
      }
    })

    // A start prompt waiting for this card lives in the composer, inside the
    // drawer: the drawer opens with it, or the question would be hidden.
    const presentsStartPrompt = this.pendingStartPrompt?.cardId === card.id
    wrap.append(toggle, body)
    this.buildControlsBody(body, card, shuttleManaged, reflect, (watch) => watchers.push(watch))
    if (presentsStartPrompt) setOpen(true)
    return wrap
  }

  private buildControlsBody(
    body: HTMLElement,
    card: KanbanCard,
    shuttleManaged: boolean,
    reflect: (patch: Partial<KanbanCard>) => void,
    watch: (fn: (view: KanbanCard) => void) => void,
  ): void {
    // A drag or click inside a field is the field's own — it must not reach the
    // header's drag or the panel's click-away.
    const swallow = (el: HTMLElement): void => {
      for (const type of ['mousedown', 'click'] as const) {
        el.addEventListener(type, (e) => e.stopPropagation())
      }
    }

    // Every setting commits on its own event — there is no Save button. One
    // quiet status line and one error line serve the whole drawer.
    const statusEl = document.createElement('span')
    statusEl.className = 'kbn-detail-save-status'
    statusEl.setAttribute('aria-live', 'polite')
    const errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.style.display = 'none'

    if (shuttleManaged) body.append(this.buildComposer(card, swallow))

    const ledger = document.createElement('div')
    ledger.className = 'kbn-ctl-ledger'
    ledger.append(
      this.buildWorkerFields(card, shuttleManaged, statusEl, errorEl, swallow, reflect),
      this.buildCardFields(card, statusEl, errorEl, swallow, reflect, watch),
    )

    // The verdict — `tempered` true or false — mirrors the send verbs above
    // it: Discard under New session, Temper under Resume.
    const foot = document.createElement('div')
    foot.className = 'kbn-ctl-foot'
    const discard = ctlButton('Discard', 'kbn-ctl-discard')
    const temper = ctlButton('Temper', 'kbn-ctl-temper')
    for (const [btn, target] of [[discard, 'composted'], [temper, 'tempered']] as const) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.close()
        this.onTransition(card, target)
      })
    }
    foot.append(errorEl, statusEl, discard, temper)

    // The fiber's sessions, each opening its own terminal as Aloft does —
    // folded, and read only when first unfolded.
    const history = card.uid
      ? buildSessionHistory({
          shuttleBase: this.shuttleBase,
          uid: card.uid,
          fiberHost: card.shuttleHost,
          liveSession: hasLiveWorker(card) ? card.sessionUuid : undefined,
          liveTmux: card.tmuxSession,
          desktop: atDesktop(navigator.userAgent, coarsePointer()),
          onError: (message) => {
            errorEl.textContent = message
            errorEl.style.display = ''
          },
        })
      : null
    if (history) swallow(history)

    body.append(...[ledger, history, foot].filter((el): el is HTMLElement => el !== null))
  }

  /**
   * The composer: a message, and the verbs that carry it to a worker. The
   * message is optional — blank, the worker follows the constitution and its
   * handoff — and rides the dispatch inline (`user_message`).
   *
   * Resume is always offered, never gated on a card-visible session id: the
   * session to resume lives in the fiber's `shuttle.session_uuid`, which the
   * daemon reads at dispatch (resume_mode='previous') and answers with a
   * precise error when there is genuinely nothing to resume. The card rarely
   * carries that id, so a gate on it would gray Resume out almost
   * everywhere.
   */
  private buildComposer(card: KanbanCard, swallow: (el: HTMLElement) => void): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-ctl-compose'

    const box = document.createElement('div')
    box.className = 'kbn-ctl-composer'
    const message = document.createElement('textarea')
    message.className = 'kbn-detail-directive'
    message.rows = 2
    message.placeholder = 'What should the worker do next?'
    message.setAttribute('aria-label', 'Message for the next worker')
    swallow(message)
    // The box grows with what is written rather than wearing a resize grip.
    const fit = (): void => {
      message.style.height = 'auto'
      message.style.height = `${message.scrollHeight}px`
    }
    message.addEventListener('input', fit)

    const err = document.createElement('div')
    err.className = 'kbn-detail-error'
    err.style.display = 'none'

    // The verbs that take the message and act at once, side by side: a
    // meeting (its note), a fresh worker, or the same worker resumed.
    const foot = document.createElement('div')
    foot.className = 'kbn-ctl-composer-foot'
    const fresh = ctlButton('New session', 'kbn-ctl-send')
    const resume = ctlButton('Resume', 'kbn-ctl-send kbn-ctl-resume')
    const sends = document.createElement('span')
    sends.className = 'kbn-ctl-sends'
    if (this.meeting) sends.append(this.buildMeeting(card, message, err))
    sends.append(fresh, resume)
    foot.append(sends)

    const directive = (): string => message.value.trim()
    const pending = this.pendingStartPrompt
    if (pending?.cardId === card.id) {
      this.pendingStartPrompt = null
      this.showStartPrompt(err, card, pending.body, directive, 'fresh', fresh)
    }
    fresh.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.runRequeue(card, directive(), 'fresh', fresh, err)
    })
    resume.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.runRequeue(card, directive(), 'previous', resume, err)
    })

    box.append(message, foot)
    wrap.append(box, err)
    return wrap
  }

  /**
   * Meeting, for this constitution: a verb that asks one question first.
   * Meeting opens a menu, Call, Room or Phone, and picking one starts the
   * recording on the daemon — nothing records before that pick; Phone opens
   * this tab's mic in the pick's gesture and keeps its controls on the board. The
   * composer's message becomes the meeting's note, and the worker — live or
   * not — receives the meeting as a joined constitution.
   *
   * One meeting records at a time. While any does, the verb stays in its
   * place, inert, naming the recording on hover; it is absent only where
   * hark is not available. It follows the board's meeting poll.
   */
  private buildMeeting(card: KanbanCard, note: HTMLTextAreaElement, err: HTMLElement): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'kbn-ctl-meet'
    const opener = ctlButton('Meeting', 'kbn-ctl-meet-btn')
    opener.setAttribute('aria-haspopup', 'menu')
    opener.setAttribute('aria-expanded', 'false')
    const menu = document.createElement('div')
    menu.className = 'kbn-ctl-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Meeting kind')
    menu.hidden = true

    const onOutside = (e: PointerEvent): void => {
      if (!wrap.contains(e.target as Node)) setOpen(false)
    }
    function setOpen(open: boolean): void {
      menu.hidden = !open
      opener.setAttribute('aria-expanded', String(open))
      // Marked so the card's own Escape steps aside while the menu is open.
      wrap.classList.toggle('kbn-ctl-meet-open', open)
      if (open) document.addEventListener('pointerdown', onOutside, true)
      else document.removeEventListener('pointerdown', onOutside, true)
    }

    let starting = false
    const paint = (): void => {
      const control = this.meeting
      if (!control) return
      const current = control.current()
      const recording = current !== null && current.state !== 'failed'
      wrap.hidden = !control.canJoin() && !recording
      opener.disabled = starting || !control.canJoin()
      opener.title = recording ? `Recording: ${current.title?.trim() || 'a meeting'}` : ''
      if (opener.disabled) setOpen(false)
    }
    this.meetingPaint = paint

    const start = (mode: MeetingMode): void => {
      setOpen(false)
      starting = true
      paint()
      opener.textContent = 'Starting…'
      err.style.display = 'none'
      void this.meeting!.join(card, mode, note.value).then((error) => {
        starting = false
        opener.textContent = 'Meeting'
        if (error) {
          err.textContent = error
          err.style.display = ''
        } else {
          note.value = ''
          note.dispatchEvent(new Event('input'))
        }
        paint()
      })
    }
    const items = MEETING_MODES.map(({ value, label }) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'kbn-ctl-menu-item'
      item.setAttribute('role', 'menuitem')
      item.textContent = label
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        start(value)
      })
      return item
    })
    menu.append(...items)

    opener.addEventListener('click', (e) => {
      e.stopPropagation()
      const opening = menu.hidden
      setOpen(opening)
      if (opening) items[0].focus()
    })
    menu.addEventListener('keydown', (e) => {
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        items[(at + step + items.length) % items.length].focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        opener.focus()
      }
    })
    // Focus moving to another control (Tab away) closes the menu; focus
    // dropping to nothing does not. WebKit gives a clicked button no focus, so
    // pressing Room blurs Call to the body before Room's click lands — closing
    // then would hide Room under the pointer and swallow the pick. Presses
    // outside are `onOutside`'s.
    menu.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null
      if (to && !wrap.contains(to)) setOpen(false)
    })

    wrap.append(opener, menu)
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
    swallow: (el: HTMLElement) => void,
    reflect: (patch: Partial<KanbanCard>) => void,
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
    swallow(agentSelect)

    // Effort options are the selected agent's concrete `effort_levels`. There
    // is deliberately no synthetic "default": an omitted fiber value resolves
    // to the registry's `default_effort`, so the control always names the
    // level dispatch will actually use.
    const effortSelect = document.createElement('select')
    effortSelect.id = 'kbn-detail-effort'
    effortSelect.className = 'kbn-ctl-select kbn-ctl-effort-select'
    effortSelect.setAttribute('aria-label', 'Effort')
    if (card.shuttleEffort) effortSelect.append(new Option(card.shuttleEffort, card.shuttleEffort))
    swallow(effortSelect)

    const chrome = ctlToggle('Chrome', 'kbn-ctl-chrome')
    chrome.input.id = 'kbn-detail-chrome'
    chrome.input.checked = card.shuttleChrome === true
    // Until the registry says which agents take it, show Chrome where it is on.
    chrome.label.hidden = !chrome.input.checked
    swallow(chrome.label)

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
          reflect({
            shuttleAgent: axes.agent,
            shuttleEffort: axes.effort || undefined,
            shuttleChrome: axes.chrome,
            shuttleSurface: axes.surface,
          })
        }
        return ok
      },
    ).then(() => {
      // An omitted effort resolves to the registry default; once the picker
      // knows it, the strip names it too.
      if (!card.shuttleEffort && effortSelect.value) reflect({ shuttleEffort: effortSelect.value })
    })

    // ── Kind + cron ──────────────────────────────────────────────────────
    // The card's kind is read straight through — an absent block reads as
    // one-shot — so a pinned card shows Pinned and One-shot unpins it.
    const baseline = {
      kind: (card.shuttleKind ?? 'oneshot') as ShuttleKind,
      schedule: card.shuttleSchedule ?? '',
      tz: card.shuttleTz ?? 'Europe/Paris',
    }
    const kind = segmented<ShuttleKind>(
      'Kind',
      [['oneshot', 'One-shot'], ['standing', 'Standing'], ['pinned', 'Pinned']],
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
    swallow(cronInput)

    const tzInput = document.createElement('input')
    tzInput.type = 'text'
    tzInput.className = 'kbn-ctl-input kbn-ctl-tz'
    tzInput.placeholder = 'Europe/Paris'
    tzInput.value = baseline.tz
    tzInput.spellcheck = false
    tzInput.setAttribute('aria-label', 'Timezone')
    swallow(tzInput)

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

    // One-shot and Pinned commit on the click: neither needs anything the
    // user hasn't given, and neither throws away what a re-toggle can't
    // restore.
    //
    // PROMOTING to Standing does NOT commit on the click. The toggle reveals
    // and seeds the cron (`0 9 * * 1-5`, Europe/Paris) — seeding is not
    // choosing — and the promotion is written when the cron is confirmed, on
    // blur or Enter (`commitSchedule`). A promotion abandoned mid-toggle stays
    // one-shot on the wire: a schedule is something you state, never
    // something you're given.
    //
    // PINNING HERE IS SHAPE-ONLY, unlike the board's drag onto the Pinned
    // strip, which kills a live worker, reshapes, then pauses. The drag
    // targets a surface where things are at rest; this control edits a field
    // and says nothing about now. So it posts the reshape alone, and the read
    // model places the card.
    const commitKind = (value: ShuttleKind): void => {
      if (value === baseline.kind) return
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
          kind.set(baseline.kind)
          cronRow.hidden = baseline.kind !== 'standing'
        },
      )
    }

    /** Set on mousedown over a non-Standing segment while a promotion is
     *  staged but uncommitted, so the cron field's blur doesn't commit on the
     *  way out. */
    let abandoningPromotion = false
    kind.onPick((value) => {
      cronRow.hidden = value !== 'standing'
      if (value === 'standing') {
        if (!cronInput.value.trim()) cronInput.value = '0 9 * * 1-5'
        if (!tzInput.value.trim()) tzInput.value = 'Europe/Paris'
        paintSpoken()
        cronInput.focus()
        cronInput.select()
      }
      commitKind(value)
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

    // Schedule + tz commit on blur and Enter — `input` would patch mid-typed
    // cron fragments. This is ALSO where a promotion to Standing lands, which
    // is why the guard reads the kind chosen in the panel rather than the
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
        errorEl.textContent = 'A standing role needs a cron expression.'
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
   * standing role (placed by its cron) and a resting pinned role (on the
   * Pinned strip) are never sorted by `due:`, so the field is absent while
   * the card is either.
   */
  private buildCardFields(
    card: KanbanCard,
    statusEl: HTMLElement,
    errorEl: HTMLElement,
    swallow: (el: HTMLElement) => void,
    reflect: (patch: Partial<KanbanCard>) => void,
    watch: (fn: (view: KanbanCard) => void) => void,
  ): HTMLElement {
    const col = document.createElement('div')
    col.className = 'kbn-ctl-fields'
    const livePatch = (changes: { parentId?: string | null; due?: string | null }, onCommitted: () => void): void => {
      void this.livePatch(card, changes, statusEl, errorEl).then((ok) => {
        if (ok) onCommitted()
      })
    }

    // Seeded through `dueCivilDay`, NEVER `new Date(card.due)`: felt stores a
    // civil day as UTC midnight, and the Date round trip names the day BEFORE
    // in every negative-offset zone (see civilDay.ts). The bare `YYYY-MM-DD`
    // the input wants is also what goes back on the wire.
    let current = dueCivilDay(card.due) ?? null
    const input = document.createElement('input')
    input.type = 'date'
    input.className = 'kbn-ctl-input kbn-ctl-date'
    const label = card.isCycle ? 'Ends' : card.storedHorizon === 'stashed' ? 'Returns' : 'Due'
    input.setAttribute('aria-label', card.isCycle ? 'Cycle end date' : label === 'Returns' ? 'Return date' : 'Due date')
    input.value = current ?? ''
    swallow(input)
    const clear = ctlButton('×', 'kbn-ctl-clear')
    clear.setAttribute('aria-label', 'Clear date')
    const paint = (): void => {
      clear.hidden = !input.value
      input.classList.toggle('kbn-ctl-empty', !input.value)
    }
    paint()

    const commit = (next: string | null): void => {
      if ((next ?? '') === (current ?? '')) return
      livePatch({ due: next }, () => {
        current = next
        input.value = next ?? ''
        paint()
        reflect({ due: next ?? undefined })
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
    // kind changed in this drawer.
    dueRow.hidden = !placedByDue(card)
    watch((view) => {
      dueRow.hidden = !placedByDue(view)
    })
    col.append(dueRow)

    col.append(field('Parent', this.buildParentPicker(card, livePatch, swallow)))
    return col
  }

  /**
   * The parent: its id, standing as the value, and a search in its place the
   * moment it is clicked. One pick commits; Escape or a click away puts the
   * id back.
   */
  private buildParentPicker(
    card: KanbanCard,
    livePatch: (changes: { parentId: string | null }, onCommitted: () => void) => void,
    swallow: (el: HTMLElement) => void,
  ): HTMLElement {
    const segments = card.id.split('/')
    let parentId: string | null = segments.length > 1 ? segments.slice(0, -1).join('/') : null

    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-parent-wrap'

    const shown = document.createElement('button')
    shown.type = 'button'
    shown.className = 'kbn-ctl-parent'
    const paint = (): void => {
      shown.textContent = parentId ?? '—'
      shown.title = parentId ? `Parent: ${parentId}` : 'Top level'
    }
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
    swallow(search)

    const dropdown = document.createElement('div')
    dropdown.className = 'kbn-detail-parent-dropdown'
    dropdown.style.display = 'none'
    dropdown.setAttribute('role', 'listbox')

    const hideDropdown = (): void => {
      dropdown.style.display = 'none'
      search.setAttribute('aria-expanded', 'false')
    }
    const closeSearch = (): void => {
      hideDropdown()
      search.hidden = true
      shown.hidden = false
    }

    const onPick = (result: FiberSearchResult): void => {
      closeSearch()
      shown.focus()
      if (result.id === parentId) return
      livePatch({ parentId: result.id }, () => {
        parentId = result.id
        paint()
      })
    }
    const openDropdown = (): void => {
      void this.searchParents(search.value.trim(), card.id, dropdown, onPick).then(() => {
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
      window.setTimeout(() => {
        if (!wrap.contains(document.activeElement)) closeSearch()
      }, 0)
    })

    wrap.append(shown, search, dropdown)
    return wrap
  }

  // ── Sent files: the launcher ─────────────────────────────────────────────

  /**
   * The sent-files launcher. Mounts empty (hidden) and self-populates from
   * {@link fetchSentFiles}: the daemon's `/api/v1/sent-files` endpoint. The
   * live refresh loop re-renders it when a worker sends another file, while
   * cards without deliverables pay zero visual cost. Each entry is a button
   * that opens (or re-activates) the file in the viewer window.
   */
  private buildSentFilesLauncher(card: KanbanCard): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-sent kbn-detail-sent-empty'

    const heading = document.createElement('div')
    heading.className = 'kbn-detail-sent-heading'
    const label = document.createElement('span')
    label.textContent = 'Sent files'
    // The count earns its place only where the trail is folded — a phone sees
    // three chips and needs to know three of how many.
    const count = document.createElement('span')
    count.className = 'kbn-detail-sent-count'
    heading.append(label, count)
    this.sentCount = count

    const list = document.createElement('div')
    list.className = 'kbn-detail-sent-list'
    list.setAttribute('role', 'list')

    // The fold. On a phone the list is clipped to its three most recent chips,
    // so a long trail can't fill the screen before anything else on the card
    // comes into view; this opens the rest. Which chips are hidden is a
    // CSS rule keyed off the viewport, not a JS branch, so a rotated phone or
    // a resized window can never leave the button and the list disagreeing.
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'kbn-detail-sent-more'
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      const open = wrap.classList.toggle('kbn-detail-sent-expanded')
      this.syncSentFold(open)
    })
    this.sentMore = more

    wrap.append(heading, list, more)
    this.sentWrap = wrap
    this.sentList = list

    void this.fetchSentFiles(card).then((files) => {
      // Panel may have closed/reopened while the fetch was in flight.
      if (!this.overlay?.contains(wrap)) return
      if (files !== null && files !== SENT_FILES_UNCHANGED) this.applySentFiles(files, card)
      // A rehydration that arrived before the trail did can now mark which
      // launcher entries are open.
      this.syncLauncherActiveState()
    })

    return wrap
  }

  /** (Re)render the launcher rows from `this.sentFiles`, newest-first. */
  private renderLauncher(list: HTMLElement, card: KanbanCard): void {
    list.replaceChildren()
    for (const file of this.sentFiles) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'kbn-detail-sent-file'
      row.setAttribute('role', 'listitem')
      row.title = file.fullPath
      row.dataset.fullPath = file.fullPath

      const name = document.createElement('span')
      name.className = 'kbn-detail-sent-name'
      name.textContent = file.basename

      const when = document.createElement('span')
      when.className = 'kbn-detail-sent-when'
      when.textContent = relativeTime(file.timestamp)

      row.append(name, when)
      row.addEventListener('click', (e) => {
        e.stopPropagation()
        this.openArtifact(file, card)
      })
      list.append(row)
    }
  }

  /** Label the fold from the trail's own length. Called on every re-render and
   *  on every toggle, so the button always says what it will actually do. */
  private syncSentFold(expanded = this.sentWrap?.classList.contains('kbn-detail-sent-expanded') ?? false): void {
    const total = this.sentFiles.length
    if (this.sentCount) this.sentCount.textContent = String(total)
    const more = this.sentMore
    if (!more) return
    // Below the fold's own size there is nothing to unfold.
    more.hidden = total <= SENT_FOLD_VISIBLE
    more.textContent = expanded ? 'show fewer' : `show all ${total}`
    more.setAttribute('aria-expanded', String(expanded))
  }

  /** Mark launcher entries whose file is currently open in the viewer. */
  private syncLauncherActiveState(): void {
    const openPaths = new Set(this.openFiles.map((e) => e.file.fullPath))
    this.overlay
      ?.querySelectorAll<HTMLElement>('.kbn-detail-sent-file')
      .forEach((row) => {
        const open = !!row.dataset.fullPath && openPaths.has(row.dataset.fullPath)
        row.classList.toggle('kbn-detail-sent-file-open', open)
      })
  }

  // ── The tabbed full-view ────────────────────────────────────────────────

  /**
   * Open `file` in the viewer window and make it the active (shown) tab. If it's
   * already open, just switch to its tab — tabs keep a stable open-order
   * (browser-style; they don't reorder on click). This is the single entry the
   * launcher and rehydration both funnel through, so the tab set + persistence
   * stay consistent.
   */
  private activateFile(file: SentFile, card: KanbanCard, opts?: { scroll?: number; zoom?: number; persist?: boolean }): void {
    // The never-a-second-tab rule lives in ReaderTabs, shared with the Shelf's
    // Reader: `addOpenFile` is called only on a genuine miss.
    const { state, entry } = openTab(
      { tabs: this.openFiles, active: this.activePath },
      file.fullPath,
      () => this.addOpenFile(file, card, opts?.scroll ?? 0, opts?.zoom ?? 1),
    )
    this.openFiles = [...state.tabs]
    this.setActive(entry, card)
    // Asking for a file means wanting to see it. The click that asked landed
    // on the card, which raised the card over the viewer on its way in, so the
    // viewer comes back up here — whether the file was new or already open.
    if (this.viewerWindow) bringToFront(this.viewerWindow)
    this.syncLauncherActiveState()
    if (opts?.persist !== false) this.writePersist()
  }

  /**
   * Build a new tab + its (empty) view cell and append both in stable
   * open-order. Opens the viewer window on the first open. Does NOT activate
   * or build the viewer — `setActive` does that lazily on first view, so
   * background tabs cost nothing until clicked.
   */
  private addOpenFile(file: SentFile, card: KanbanCard, scroll: number, zoom: number): OpenFileEntry {
    this.openViewerWindow()

    const { tab, closeBtn } = buildTabButton(file.basename, file.fullPath)
    const cell = buildViewCell()

    const entry: OpenFileEntry = {
      path: file.fullPath,
      file,
      tab,
      cell,
      scroll,
      zoom,
      viewerBuilt: false,
      viewer: null,
      frameScrollCleanup: null,
      zoomTarget: null,
      baseW: 0,
    }

    tab.addEventListener('click', () => {
      this.setActive(entry, card)
      this.syncLauncherActiveState()
      this.writePersist()
    })
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeFile(entry)
    })

    // The entry is added to `openFiles` by `activateFile`'s openTab — this
    // builder only mounts the DOM.
    this.tabStrip?.append(tab)
    this.rightCol?.append(cell)
    return entry
  }

  /** Make `entry` the active tab: show its cell (build its viewer on first
   *  view), hide the rest, highlight its tab. Preserves every other open
   *  cell's DOM (scroll + zoom survive the switch). */
  private setActive(entry: OpenFileEntry, card: KanbanCard): void {
    this.activePath = entry.file.fullPath
    // Show the active cell BEFORE building its viewer so a freshly-built image
    // can measure the (now visible) cell width for its fit-to-width base.
    for (const e of this.openFiles) {
      const on = e === entry
      showCell(e.cell, on)
      e.tab.classList.toggle('kbn-detail-tab-active', on)
      e.tab.setAttribute('aria-selected', String(on))
      if (on) resumeFileViewer(e.viewer)
      else suspendFileViewer(e.viewer)
    }
    if (!entry.viewerBuilt) this.buildEntryViewer(entry, card)
  }

  /** Build the viewer for an entry (idempotent — once per entry). Wires
   *  scroll-restore + a debounced scroll-position writer for iframe files, and
   *  records the element Cmd-scroll zoom scales. */
  private buildEntryViewer(entry: OpenFileEntry, card: KanbanCard): void {
    if (entry.viewerBuilt) return
    entry.viewerBuilt = true
    const scrollable = isScrollableFile(entry.file.fullPath)
    const viewer = buildFileViewer(
      this.shuttleBase,
      entry.file.fullPath,
      card.originId,
      scrollable
        ? (iframe, refreshed) => {
            entry.frameScrollCleanup?.()
            try {
              const win = iframe.contentWindow
              if (!refreshed) win?.scrollTo(0, entry.scroll)
              else if (win) entry.scroll = win.scrollY
              const onScroll = (): void => {
                entry.scroll = win?.scrollY ?? entry.scroll
                this.queueScrollWrite()
              }
              win?.addEventListener('scroll', onScroll, { passive: true })
              entry.frameScrollCleanup = () => win?.removeEventListener('scroll', onScroll)
            } catch {
              entry.frameScrollCleanup = null
            }
          }
        : undefined,
      scrollable
        ? (pane) => {
            // The text pane's twin of the iframe restore above: no document,
            // so the element itself is the scroller.
            pane.scrollTop = entry.scroll
            pane.addEventListener('scroll', () => {
              entry.scroll = pane.scrollTop
              this.queueScrollWrite()
            }, { passive: true })
          }
        : undefined,
    )
    entry.viewer = viewer
    entry.cell.append(viewer)
    // Zoom target: the <img> for images (sized in px so it magnifies PAST the
    // column width), else the viewer wrap (CSS `zoom` for iframes). The cell
    // (overflow:auto) is the pan surface. Apply persisted zoom now that the
    // cell is visible — its width is the image's fit base.
    setZoomTarget(entry, viewer, entry.file.fullPath)
  }

  /** Cmd/Ctrl + wheel over the active file zooms it, anchored on the cursor.
   *  The gesture is `ReaderZoom`'s, shared with the Shelf's Reader; all this
   *  side knows is which tab is under the pointer and that a zoom is worth
   *  persisting. */
  private handleZoomWheel(e: WheelEvent): void {
    const entry = this.openFiles.find((x) => x.file.fullPath === this.activePath)
    if (zoomOnWheel(e, entry)) this.queueScrollWrite()
  }

  /** Close one open file. Switches to the nearest remaining tab if it was
   *  active; closes the viewer window if it was the last. */
  private closeFile(entry: OpenFileEntry): void {
    const { state, closed } = closeTab(
      { tabs: this.openFiles, active: this.activePath },
      entry.path,
    )
    if (!closed) return
    entry.frameScrollCleanup?.()
    disposeFileViewer(entry.viewer)
    entry.viewer = null
    entry.tab.remove()
    entry.cell.remove()
    this.openFiles = [...state.tabs]
    this.activePath = state.active
    const next = state.active ? this.openFiles.find((e) => e.path === state.active) : null
    if (next && this.card) this.setActive(next, this.card)
    this.syncLauncherActiveState()
    if (this.openFiles.length === 0) this.closeViewerWindow()
    this.writePersist()
  }

  /** Debounced scroll-position persistence. Open/close/activate write
   *  immediately; scroll is debounced so a flick of the wheel doesn't hammer
   *  localStorage. */
  private queueScrollWrite(): void {
    if (this.scrollWriteTimer !== null) window.clearTimeout(this.scrollWriteTimer)
    this.scrollWriteTimer = window.setTimeout(() => {
      this.scrollWriteTimer = null
      this.writePersist()
    }, 400)
  }

  /** Serialize the current viewer and window state to localStorage. */
  private writePersist(): void {
    // A linked card is a stop on a path, not a workspace: it must not overwrite
    // the arrangement the reader chose for this fiber's own card.
    if (this.host) return
    const uid = typeof this.card?.uid === 'string' ? this.card.uid : ''
    if (!uid) return
    savePersist(uid, {
      active: this.activePath ?? undefined,
      cardGeom: this.cardGeom ?? undefined,
      viewerGeom: this.viewerGeom ?? undefined,
      open: this.openFiles.map((e) => ({
        path: e.file.fullPath,
        basename: e.file.basename,
        scroll: e.scroll,
        zoom: e.zoom,
      })),
    })
  }

  /**
   * Rebuild the viewer window from persisted state on panel-open. Tabs are
   * added in the saved (stable) order with scroll and zoom carried through,
   * and the persisted active tab is shown. The rehydrate runs immediately off
   * the persisted paths, so the viewer is there before the trail fetch
   * resolves.
   */
  private rehydrateOpenFiles(card: KanbanCard, persist: DetailPersist): void {
    if (persist.open.length === 0) return
    // Add every tab in the saved (stable) order without activating — building
    // each viewer lazily would load every iframe up front.
    for (const saved of persist.open) {
      const file: SentFile = {
        fullPath: saved.path,
        // Prefer the persisted display label (preserves the disambiguated
        // basename); fall back to the path tail.
        basename: saved.basename ?? basename(saved.path),
        timestamp: 0,
      }
      // Through openTab, like every other open: a store that somehow holds the
      // same path twice rehydrates as one tab, not two.
      const { state } = openTab({ tabs: this.openFiles, active: this.activePath }, file.fullPath, () =>
        this.addOpenFile(file, card, saved.scroll, saved.zoom ?? 1),
      )
      this.openFiles = [...state.tabs]
    }
    // Restore the active tab (persisted, else the last opened) — this builds
    // only that one viewer; the others build on first click.
    const active =
      this.openFiles.find((e) => e.path === persist.active) ??
      this.openFiles[this.openFiles.length - 1]
    if (active) this.setActive(active, card)
    this.syncLauncherActiveState()
  }

  /**
   * The card's sent-files trail, from the daemon's `GET /api/v1/sent-files`.
   * A `null` result means the read failed; refreshes preserve the last known
   * trail in that case rather than making a transient outage erase the
   * launcher.
   */
  private async fetchSentFiles(
    card: KanbanCard,
  ): Promise<SentFile[] | null | typeof SENT_FILES_UNCHANGED> {
    // The route is keyed by uid alone; a card without one has no trail.
    const uid = typeof card.uid === 'string' ? card.uid.trim() : ''
    if (!uid) return []

    // Conditional, but do not count on it. The local leg's weak ETag is over
    // the events file's {mtime,size}, and that file is the live hook stream for
    // every session on the host — so on any host with a live session it moves
    // every few seconds and the 304 almost never fires. A remote-owned fiber's
    // leg is relayed and header-less, so it ALWAYS answers 200 (see the
    // controller's moduledoc). Either way this 15s poll costs the owning daemon
    // a full re-read of that file; the fix is an incremental reader there, not
    // a validator here.
    const params = new URLSearchParams({ uid })
    if (card.originId) params.set('origin', card.originId)
    try {
      const headers: Record<string, string> = {}
      if (this.sentFilesEtag) headers['If-None-Match'] = this.sentFilesEtag
      const res = await fetch(`${this.shuttleBase}/api/v1/sent-files?${params.toString()}`, {
        cache: 'no-store',
        headers,
      })
      if (res.status === 304) return SENT_FILES_UNCHANGED
      if (res.ok) {
        this.sentFilesEtag = res.headers.get('etag')
        const data = (await res.json()) as { files?: unknown }
        if (Array.isArray(data.files)) return normalizeSentFiles(data.files)
      }
    } catch {
      // Network error — the caller keeps the last known trail.
    }
    return null
  }

  /** {@link postDaemonJson} against this panel's daemon. */
  private postJson(path: string, body: Record<string, unknown>, label = 'Save'): Promise<void> {
    return postDaemonJson(this.shuttleBase, path, body, label)
  }

  /**
   * Open the panel on a card whose start was refused for want of a project
   * directory, with the composer's inline prompt already showing.
   */
  openStartPrompt(card: KanbanCard, body: DispatchFailureBody): void {
    this.pendingStartPrompt = { cardId: card.id, body }
    this.open(card)
  }

  /**
   * Manual requeue: one force dispatch ({@link postForceDispatch}) carrying the
   * message and the resume intent inline. The daemon resolves the session to
   * resume from the fiber's `shuttle.session_uuid`, falling back to fresh when
   * there is nothing to resume. `projectDir` is a directory the human confirmed
   * in the prompt a refused start raised ({@link showStartPrompt}).
   */
  private async runRequeue(
    card: KanbanCard,
    directive: string,
    mode: 'fresh' | 'previous',
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
    projectDir?: string,
  ): Promise<void> {
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
      if (!ok) return
    }

    const original = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = mode === 'fresh' ? 'Starting…' : 'Resuming…'
    errorEl.style.display = 'none'

    let res: Response
    try {
      res = await postForceDispatch(this.shuttleBase, card, {
        user_message: directive,
        resume_mode: mode,
        ...(projectDir ? { project_dir: projectDir } : {}),
      })
    } catch (err: unknown) {
      const detail = (err as { message?: string })?.message ?? String(err)
      this.showDispatchError(errorEl, btn, original, `Couldn't reach Shuttle: ${detail}`)
      return
    }

    const body = (await res.json().catch(() => ({}))) as DispatchFailureBody & { tmux_session?: string }

    if (res.status === 409) {
      if (body.tmux_session) {
        this.finishRequeue(card, body.tmux_session)
        return
      }

      btn.textContent = 'Already running'
      btn.disabled = true
      errorEl.textContent = 'A worker is already running for this fiber.'
      errorEl.style.display = ''
      return
    }

    if (!res.ok) {
      btn.disabled = false
      btn.textContent = original
      if (needsProjectDir(body)) {
        this.showStartPrompt(errorEl, card, body, () => directive, mode, btn)
        return
      }
      const msg = dispatchFailureMessage(body, `Requeue failed (${res.status})`)
      this.showDispatchError(errorEl, btn, original, msg)
      return
    }

    this.finishRequeue(card, body.tmux_session)
  }

  /**
   * Answer a start refused for want of a project directory in place: the
   * owning host's reason and a directory field, prefilled from the nearest
   * ancestor's `project_dir` when the card has one. Start retries the same
   * launch (`mode`, the composer's message) with the confirmed directory.
   */
  private showStartPrompt(
    errorEl: HTMLElement,
    card: KanbanCard,
    body: DispatchFailureBody,
    directive: () => string,
    mode: 'fresh' | 'previous',
    btn: HTMLButtonElement,
  ): void {
    const prompt = buildProjectDirPrompt({
      reason: dispatchFailureMessage(body, 'The start was refused.'),
      host: body.host ?? card.shuttleHost,
      suggestion: card.inheritedProjectDir,
      onStart: (dir) => void this.runRequeue(card, directive(), mode, btn, errorEl, dir),
    })
    errorEl.replaceChildren(prompt)
    errorEl.style.display = ''
  }

  /**
   * Return to the refreshed board after dispatch. A phone gets the same
   * session anchor the board renders for any other live worker; opening it
   * from here would bypass that real anchor tap and race the refresh.
   */
  private finishRequeue(card: KanbanCard, tmuxSession?: string): void {
    this.close()
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
   * Any change repopulates the dependent controls (a new agent resets effort
   * to its default and may drop chrome) and fires `onCommit` with the current
   * composition — which `commitAxes` writes through `set-agent`. A refused
   * write puts every control back on the last composition that landed.
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
    current: { agent: string; effort: string; chrome: boolean; surface: ExecutionSurface },
    onCommit: (axes: { agent: string; effort: string; chrome: boolean; surface: ExecutionSurface }) => Promise<boolean>,
  ): Promise<void> {
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
    const commit = (): void => {
      const axes = {
        agent: selectedAgent(),
        effort: effortSelect.value,
        chrome: chromeToggle.checked,
        surface: surface.value,
      }
      void onCommit(axes).then((ok) => {
        if (ok) {
          landed = axes
          return
        }
        agentSelect.value = landed.agent
        syncDependents(landed.agent, landed.effort)
        chromeToggle.checked = landed.chrome && !chromeToggle.disabled
        surface.set(landed.surface)
      })
    }

    agentSelect.addEventListener('change', () => {
      // New agent: select and persist its concrete default effort, re-gate
      // chrome, and pick the session a fresh task on that agent would get —
      // unless the card was already Codex, whose choice carries over.
      syncDependents(selectedAgent(), '')
      chromeToggle.checked = chromeToggle.checked && !chromeToggle.disabled
      const rec = recordFor(selectedAgent())
      if (!isCodexAgent(rec)) surface.set('cli')
      else if (!isCodexAgent(recordFor(current.agent))) surface.set(defaultSurface(rec))
      commit()
    })
    effortSelect.addEventListener('change', () => commit())
    chromeToggle.addEventListener('change', () => commit())
    surface.onPick(() => commit())
  }

  /**
   * Write the composed agent axes through the daemon's `set-agent` lifecycle
   * action — one validated write that sees base agent × effort × chrome
   * together. Effort is always a concrete registry token when the agent
   * supports that axis; chrome is always sent explicitly so a toggle-off is
   * unambiguous.
   */
  private async commitAxes(
    card: KanbanCard,
    axes: { agent: string; effort: string; chrome: boolean; surface: ExecutionSurface },
    statusEl: HTMLElement,
    errorEl: HTMLElement,
  ): Promise<boolean> {
    if (!axes.agent) return false
    return this.withSaveStatus(statusEl, errorEl, () =>
      this.postJson('/api/v1/lifecycle', {
        action: 'set-agent',
        origin: card.originId,
        fiber: card.id,
        agent: axes.agent,
        effort: axes.effort,
        chrome: axes.chrome,
        surface: axes.surface,
      }),
    )
  }

  /**
   * The save choreography every live edit shares: clear the error, show
   * "Saving…", run the write, then either fade a "Saved" pill after a beat or
   * surface the failure verbatim in `errorEl`. The panel stays open through
   * every outcome — live edits don't close the inspector. Returns true on
   * success so the caller can advance its local baseline.
   */
  private async withSaveStatus(
    statusEl: HTMLElement,
    errorEl: HTMLElement,
    write: () => Promise<void>,
  ): Promise<boolean> {
    errorEl.style.display = 'none'
    statusEl.textContent = 'Saving…'
    statusEl.classList.remove('kbn-detail-save-status-saved')
    statusEl.classList.add('kbn-detail-save-status-saving')
    try {
      await write()
      // Refresh the kanban so the change shows up on the board. The panel
      // stays open — the user may want to keep editing.
      this.onSaved()
      statusEl.textContent = 'Saved'
      statusEl.classList.remove('kbn-detail-save-status-saving')
      statusEl.classList.add('kbn-detail-save-status-saved')
      window.setTimeout(() => {
        // Fade the "Saved" indicator after a beat if nothing else has
        // overwritten it in the meantime.
        if (statusEl.textContent === 'Saved') {
          statusEl.textContent = ''
          statusEl.classList.remove('kbn-detail-save-status-saved')
        }
      }, 1500)
      return true
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      errorEl.textContent = msg
      errorEl.style.display = ''
      statusEl.textContent = ''
      statusEl.classList.remove('kbn-detail-save-status-saving')
      return false
    }
  }

  /**
   * Fetch the daemon's full fiber index once per panel-open (`GET
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
   * Parent-picker search: one daemon index fetch per panel-open, then the
   * shared `filterParentCandidates` rule per keystroke.
   */
  private async searchParents(
    q: string,
    excludeId: string,
    dropdown: HTMLElement,
    onSelect: (result: FiberSearchResult) => void,
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
        dropdown.style.display = ''
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
      dropdown.style.display = ''
    } catch {
      dropdown.innerHTML = '<div class="kbn-detail-parent-option kbn-detail-parent-empty">Search failed</div>'
      dropdown.style.display = ''
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
      this.close()
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
          // patch must never quietly unpin a pinned role on its way past.
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
            // reshape and the create verbs take over. `pinned` never reaches
            // this arm: the kind control is hidden until the card is
            // shuttle-managed, and pinning a block-less card is refused on the
            // board too (`pinRole` banners "promote it first").
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

/** The outcome as the page's lede callout, or nothing for an empty one. */
function ledeHtml(outcome: string): string {
  return outcome
    ? `<div class="kbn-detail-lede">${renderMarkdown(outcome, { wikilinks: true })}</div>`
    : ''
}

interface FileInfo {
  exists: boolean
  size?: number
  modifiedAt?: number
}

/** What the daemon's `/file-info` says about one path, or `null` when it
 *  can't say (a failed or refused request). Metadata only — no bytes. */
async function readFileInfo(
  shuttleBase: string,
  path: string,
  originId: string | undefined,
): Promise<FileInfo | null> {
  try {
    const res = await fetch(fileInfoUrl(shuttleBase, path, originId ?? ''), { cache: 'no-store' })
    if (!res.ok) return null
    const data = (await res.json()) as { exists?: unknown; size?: unknown; modified_at?: unknown }
    return {
      exists: data.exists === true,
      size: typeof data.size === 'number' ? data.size : undefined,
      modifiedAt: typeof data.modified_at === 'number' ? data.modified_at : undefined,
    }
  } catch {
    return null
  }
}

/**
 * One path's change revision from {@link readFileInfo}. `undefined` means no
 * usable answer; `missing` is a real revision, so a file created after the
 * constitution opens is noticed on the next tick.
 */
async function readFileRevision(
  shuttleBase: string,
  path: string,
  originId: string | undefined,
): Promise<string | undefined> {
  const info = await readFileInfo(shuttleBase, path, originId)
  if (!info) return undefined
  if (!info.exists) return 'missing'
  if (info.modifiedAt === undefined || info.size === undefined) return undefined
  return `present:${info.modifiedAt}:${info.size}`
}

/** Return the artifact path behind one inline `/file` iframe. */
function artifactPath(artifact: RefreshableArtifact): string | null {
  const src = artifact.getAttribute('src')
  if (!src) return null
  try {
    const url = new URL(src, window.location.href)
    const path = url.searchParams.get('path')
    if (!path) return null
    if (url.pathname.endsWith('/file')) return path
  } catch {
    // An external or malformed source is not ours to refresh.
  }
  return null
}

/** Compact "2m / 3h / 5d ago" stamp for the sent-files launcher. A zero/absent
 *  timestamp (a rehydrated entry whose trail hasn't loaded) renders blank. */
function relativeTime(timestamp: number): string {
  if (!timestamp) return ''
  const deltaMs = Date.now() - timestamp
  if (deltaMs < 60_000) return 'just now'
  return `${humanizeIdleAge(deltaMs)} ago`
}
