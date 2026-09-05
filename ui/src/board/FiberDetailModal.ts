import {
  basename,
  cacheBustUrl,
  fileBytesUrl,
  fileInfoUrl,
  humanizeIdleAge,
  prepareIframeExternalLinks,
  renderEmbeds,
  renderMarkdown,
  showToast,
} from './utils.js'
import type { ColumnKind, KanbanCard, ShuttleKind } from './KanbanTypes.js'
import { dispatchIneligibleReason, isAgentCard } from './KanbanModalShared.js'
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
  fittedGeometry as fitted,
  halfAndHalf,
  inSomeOpenPanel,
  isTopPanel,
  registerPanel,
  unregisterPanel,
  type PanelGeometry,
} from './FloatingPanelChrome.js'
import { LinkedFiberPanel } from './LinkedFiberPanel.js'
import { buildFileViewer, isScrollableFile } from './FileViewerPanel.js'
import { installGestureLayer, type GestureLayer } from './gestures/GestureLayer.js'
import { isMobileViewport, coarsePointer, onMobileChange } from './mobile.js'
import { holdSheet, swapSheet, SHEET_CARD, SHEET_VIEWER } from './sheetHistory.js'
import type { MoveBroker } from './MoveDestinations.js'
import {
  disambiguateBasenames,
  normalizeSentFiles,
  sentFilesRevision,
  type SentFile,
} from './sentFiles.js'
import { buildReaderWindow, buildTabButton, buildViewCell } from './ReaderChrome.js'
import { closeTab, openTab } from './ReaderTabs.js'
import { applyZoom, zoomOnWheel, type ZoomableTab } from './ReaderZoom.js'
import { humanizeCron } from './KanbanRules.js'
import {
  civilDayToLocalDate,
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
let lastGeometry: { left: number; top: number; width: number; height: number } | null = null

/** Single-column reading width. The card panel opens here and keeps it — the
 *  file viewer is now its own floating window, so the card never grows.
 *  Mirrors the old default (≤950 / 92vw). */
const SINGLE_COL_WIDTH = 950

// The z-order stack, the open-window registry and the geometry helpers all
// live in FloatingPanelChrome now: three windows share them (the card, the file
// viewer, and the panel that holds followed wikilinks), and a registry that
// only one module could see was what made the third one awkward to add.

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

export interface SessionWindow {
  text: string
  /** The run ended on the worker's own handoff stamp — earns the teal ✓. */
  clean: boolean
  /** Full localized instants for the hover. */
  title: string
}

/**
 * The session window: one line saying when the last worker launched, when it
 * handed off, and how long it held the fiber.
 *
 *   dispatched 14:02 · handed off 17:38 · 3h 36m      — a clean, concluded run
 *   dispatched Aug 4 14:02 · handed off 17:38 · …     — the same run, days ago
 *   dispatched 14:02 · aloft                          — a worker still running
 *   dispatched 14:02 · no clean handoff               — it stopped without one
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
 * never run has no window to show, and an empty line would be worse than none.
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
  card: Pick<KanbanCard, 'dispatchedAt' | 'handedOffAt' | 'runningWorker'>,
  nowMs: number = Date.now(),
): SessionWindow | null {
  const dispatched = instantMs(card.dispatchedAt)
  if (dispatched === undefined) return null
  const handedOff = instantMs(card.handedOffAt)
  const concluded = handedOff !== undefined && handedOff >= dispatched

  const startedToday = isoDayLocal(dispatched) === isoDayLocal(nowMs)
  const parts = [`dispatched ${startedToday ? clockTime(dispatched) : dayStamp(dispatched)}`]

  if (card.runningWorker) {
    return {
      text: [...parts, 'aloft'].join(' · '),
      clean: false,
      title: `Worker launched ${new Date(dispatched).toLocaleString()} and is still running.`,
    }
  }
  if (concluded && handedOff !== undefined) {
    const spannedMidnight = isoDayLocal(handedOff) !== isoDayLocal(dispatched)
    parts.push(
      `handed off ${spannedMidnight ? dayStamp(handedOff) : clockTime(handedOff)}`,
      // Sub-minute runs read `0m` rather than seconds: the pair of clock times
      // above already tells that story, and this figure is for scale.
      formatSpanMinutes(Math.max(0, Math.round((handedOff - dispatched) / 60_000))),
    )
    return {
      text: parts.join(' · '),
      clean: true,
      title:
        `Launched ${new Date(dispatched).toLocaleString()}; ` +
        `handed off ${new Date(handedOff).toLocaleString()}.`,
    }
  }
  return {
    text: [...parts, 'no clean handoff'].join(' · '),
    clean: false,
    title:
      `Launched ${new Date(dispatched).toLocaleString()}. The worker never stamped a ` +
      'handoff for this run — it was killed, crashed, or is still being reconciled.',
  }
}

/** A live worker must be replaced before a changed Chrome axis can take effect. */
export function chromeRestartNeeded(
  card: Pick<KanbanCard, 'runningWorker'>,
  currentChrome: boolean,
  nextChrome: boolean,
): boolean {
  return Boolean(card.runningWorker) && currentChrome !== nextChrome
}

/** The short directive the replacement worker sees in its opening prompt. */
export function chromeRestartDirective(chrome: boolean): string {
  return chrome
    ? 'This session was resumed to give you Chrome.'
    : 'This session was restarted with Chrome disabled.'
}

/** {@link sessionWindow} as the one mono line the detail panel shows. */
function buildSessionWindow(card: KanbanCard): HTMLElement | null {
  const window_ = sessionWindow(card)
  if (!window_) return null

  const el = document.createElement('div')
  el.className = 'kbn-detail-session'
  el.title = window_.title

  const line = document.createElement('span')
  line.className = 'kbn-detail-session-line'
  line.textContent = window_.text
  el.append(line)

  if (window_.clean) {
    const mark = document.createElement('span')
    mark.className = 'kbn-detail-session-clean'
    mark.textContent = '✓'
    mark.title = 'Clean exit — the worker stamped its own handoff.'
    el.append(mark)
  }
  return el
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
   * it keeps the tab label stable across reload; legacy records without it fall
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
}

/** The unchanged sentinel {@link FiberDetailModal.fetchSentFiles} returns on a
 *  304: distinct from `null` (the read FAILED — keep the last known trail) and
 *  from `[]` (the trail is genuinely empty). */
const SENT_FILES_UNCHANGED = Symbol('sent-files-unchanged')

type RefreshableArtifact = HTMLImageElement | HTMLIFrameElement | HTMLAudioElement

const LIVE_REFRESH_INTERVAL_MS = 15_000
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
 * single-column page: outcome lede, then the markdown body. The standalone
 * UI emulates the vellum look in CSS rather than importing vellum's
 * `NarrativeView`/PretextProse stack — the body is rendered by the lean
 * `marked` renderer (`utils.renderMarkdown`) and styled to read like a
 * vellum page (`.kbn-detail-prose` in FiberDetailModal.css). The markdown
 * comes from the daemon's `GET /api/v1/fibers/<id>?body=true`, which reads the
 * daemon's stores including the git-synced `~/loom` mirror — so remote-host
 * fibers normally render here too; a fiber the local daemon can't read (not
 * synced to its mirror, or bodyless) degrades to its outcome, which the
 * composite feed always carries. `:::{embed}` artifacts and relative images render through the
 * daemon's owner-routed `/file` route, anchored on the fiber's own dir.
 *
 * Every card action lives in one dropdown directly under the title,
 * collapsed by default: directive box + "wait for me", New session /
 * Resume, Temper / Compost, agent / kind / schedule, and parent fiber.
 *
 * Deliberately NOT a Radix AppDialog and NOT background-locked: the panel
 * is non-modal by design — "drag it aside to keep an eye on one fiber
 * while working the board" requires the kanban behind it to stay
 * interactive, so there is no scrim, no focus trap, no body-inert. This is
 * the documented exception to the new-modal invariant. Escape still
 * closes; only one instance is open at a time. The root keeps the
 * `.kbn-detail-overlay` class so Camera's wheel-exemption `closest()`
 * list keeps routing wheel events to the panel instead of zooming the map.
 *
 * Lifecycle: `open(card)` mounts the panel; `close()` tears it down
 * (including the React root inside the page pane).
 */
/**
 * Put the desktop move popover next to its button — below by preference,
 * flipped above when the viewport's lower edge would clip it, and slid back
 * inside the right margin either way. `position: fixed`, because the panel is
 * a size container and would clip a descendant popover.
 */
function placeMoveMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const a = anchor.getBoundingClientRect()
  const m = menu.getBoundingClientRect()
  const gap = 6
  const below = a.bottom + gap
  const top = below + m.height > window.innerHeight - 8 ? Math.max(8, a.top - gap - m.height) : below
  const left = Math.max(8, Math.min(a.left, window.innerWidth - m.width - 8))
  menu.style.top = `${top}px`
  menu.style.left = `${left}px`
}

export class FiberDetailModal {
  private overlay: HTMLElement | null = null
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private outsideHandler: ((e: PointerEvent) => void) | null = null
  private resizeHandler: (() => void) | null = null
  private searchDebounce: number | null = null
  /** ResizeObservers watching full-length HTML embeds so they re-fit their
   *  height when the panel reflows their content (see autosizeEmbeds).
   *  Disconnected on close so a re-opened panel never leaks observers. */
  private embedObservers: ResizeObserver[] = []
  /** Gesture controllers belong to the current body DOM and are replaced when
   * the fiber body is rerendered. Their own file reloads keep their batches. */
  private gestureLayers: GestureLayer[] = []
  /** Shuttle daemon base (`:4000`). Every verb routes here — transition,
   *  dispatch (carrying user_message + resume_mode inline), lifecycle,
   *  felt-nest — owner-routed by the card's `originId` carried as
   *  `origin` in the body. Reads (agent registry, parent-picker fiber index)
   *  hit the daemon's GET routes. Portolan's `:4004` no longer serves the
   *  kanban at all. */
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
   * Terminal-move delegate. Temper / Compost close the panel immediately and
   * hand the move to the parent kanban's optimistic transition path (instant
   * card relocation + background commit + banner on failure). The product
   * always wires it; the no-op default exists only for the offline harness
   * fixture, which mounts the panel with no board behind it.
   */
  private readonly onTransition: (card: KanbanCard, target: ColumnKind) => void
  // ── Two-column file viewer state (the right column) ─────────────────────
  /** The card the panel is currently showing — every accordion action
   *  (open/close/expand/scroll) keys its persistence off `card.uid`. */
  private card: KanbanCard | null = null
  /** The full sent-files trail (newest-first), kept current while the panel is
   *  open. The left-column launcher renders from this. */
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
   *   · its actions dropdown appears only if the fiber actually carries a
   *     shuttle block — a plain note has nothing to dispatch, and offering
   *     Temper/Compost/New session on it is noise; a real constitution keeps
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
  /**
   * The board's move seam. Present when a board is behind the panel; absent in
   * the offline harness fixture and in the wire tests, where "Move ▾" simply
   * never appears rather than appearing and doing nothing.
   */
  private readonly moves: MoveBroker | null
  /** Teardown for the open move menu (a document.body child — the panel is a
   *  size container and clips its own fixed descendants). Non-null iff a menu
   *  is open. */
  private closeMoveMenu: (() => void) | null = null
  /** The head row's Move control, kept so a live tick can hide it when the
   *  board stops offering this card anywhere to go (and show it again when it
   *  does). Null when there is no board or no control. */
  private moveBtn: HTMLButtonElement | null = null
  /** Unsubscribe from the mobile-threshold watch, live while the panel is open.
   *  Crossing 700px re-frames the panel between window and sheet in place. */
  private mobileWatch: (() => void) | null = null

  constructor(
    shuttleBase: string,
    onSaved: () => void,
    onTransition?: (card: KanbanCard, target: ColumnKind) => void,
    onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void,
    opts?: {
      host?: HTMLElement
      panel?: LinkedFiberPanel
      onCloseRequest?: () => void
      moves?: MoveBroker
    },
  ) {
    this.shuttleBase = shuttleBase
    this.onSaved = onSaved
    this.onTransition = onTransition ?? (() => {})
    this.onOpenWorker = onOpenWorker
    this.host = opts?.host ?? null
    this.linkPanel = opts?.panel ?? null
    this.onCloseRequest = opts?.onCloseRequest ?? null
    this.moves = opts?.moves ?? null
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

    // The title is plain identification text + the drag handle. In the
    // standalone UI the panel *is* the fiber view, so there is no "drill out
    // to the full workspace" target — the click-to-open-elsewhere affordance
    // Portolan's title carried is dropped.
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

    // Worker aloft → the same teal ▸ aloft pill the grid card wears, same
    // class, same gesture: click opens the worker's tmux session in kitty.
    //
    // A TERMINAL IS NOT SOMETHING A PHONE HAS. On a coarse pointer the pill
    // is a LINK instead: the owning daemon stamps each live worker's claude.ai
    // bridge URL on the feed row (`sessionLink`), a universal link the Claude
    // app claims — so the tap opens this very session on the phone. A session
    // that was never bridged keeps the stamp and drops the promise: a plain
    // mark, not a link to nowhere.
    let aloftPill: HTMLElement | null = null
    if (card.runningWorker && coarsePointer()) {
      const mark = document.createElement(card.sessionLink ? 'a' : 'span')
      mark.className = 'kbn-card-worker kbn-detail-aloft'
      mark.textContent = '▸ aloft'
      if (mark instanceof HTMLAnchorElement && card.sessionLink) {
        mark.href = card.sessionLink
        mark.title = 'Worker aloft — open this session in the Claude app'
        mark.addEventListener('click', (e) => e.stopPropagation())
      } else {
        mark.classList.add('kbn-detail-aloft-static')
        mark.title = `Worker aloft — ${card.runningWorker}`
      }
      aloftPill = mark
    } else if (card.runningWorker && this.onOpenWorker) {
      const tmuxName = card.runningWorker
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-card-worker kbn-detail-aloft'
      btn.setAttribute('aria-label', `Open worker terminal: ${tmuxName}`)
      btn.title = `Worker aloft — click to open ${tmuxName} in kitty`
      btn.textContent = '▸ aloft'
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.onOpenWorker?.(tmuxName, card.shuttleHost)
      })
      aloftPill = btn
    }

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

    // ID breadcrumb under the title — plain identification text; the title
    // above carries the click-to-vellum affordance.
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
    if (!this.host && !this.isSheet()) this.attachDrag(overlay, header)

    // ── Controls dropdown ───────────────────────────────────────────────────
    // One cluster, directly under the title, collapsed by default. Expanded
    // it holds the directive entry and every action the card supports.
    //
    // A LINKED card shows it only when the fiber carries a shuttle block. A
    // reference followed out of a body is usually a note or a decision — there
    // is nothing to dispatch, and a dropdown offering to run it is noise on
    // what you opened to read. A real constitution keeps its actions.
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
    page.append(prose)
    this.bodyPage = page
    this.proseEl = prose
    void this.renderFiberBody(prose, card, overlay)

    // ── Sent-files launcher ──────────────────────────────────────────────────
    // The deliverable trail: files the card's worker sessions pushed via
    // SendUserFile, newest first. Mounts empty and self-populates from the
    // daemon's /sent-files (events.jsonl fallback for older daemons). Clicking
    // an entry opens it in the separate file-viewer window (creating that
    // window on first open). Empty trail → the launcher never reveals itself.
    const launcher = this.buildSentFilesLauncher(card)

    // ── Assemble: a single reading column ────────────────────────────────────
    // The card panel is one flex column again — header, controls, launcher,
    // body. The file viewer is a SEPARATE floating window (openViewerWindow),
    // so the card keeps its own size and never grows.
    overlay.append(header, ...(controls ? [controls] : []), launcher, page)
    if (this.host) {
      // A tab's card: no frame of its own, no z-order, no registration — it is
      // inside the panel's window, which carries all three for it.
      this.host.append(overlay)
    } else {
      if (!this.isSheet()) this.attachResizeHandles(overlay)
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
        // The move menu unwinds first — the nearest thing you are inside is
        // the thing Escape acts on, the same rule the wikilink panel follows.
        if (this.closeMoveMenu) return
        if (document.activeElement?.closest('.kbn-detail-parent-dropdown')) return
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
    // listener existed — can never self-close it. The event is left to
    // propagate, so the outside click still does its own work (open a
    // different card, drag on the board, …).
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
        if (target instanceof Element && target.closest('.kbn-move-menu')) return
        this.close()
      }
      document.addEventListener('pointerdown', this.outsideHandler, true)
    }

    // A window that shrinks under an open panel strands it exactly the way a
    // geometry saved on a bigger display does — the lower edge, and the page
    // pane's scrollport with it, ends up below the screen. Refit both windows
    // in place so the body stays readable to its end.
    this.resizeHandler = () => {
      if (this.overlay && !this.host && this.isSheet()) {
        // A sheet has nothing to refit; the viewport IS its geometry.
        return
      }
      if (this.overlay && !this.host) {
        const geom = fitted(readPanelGeometry(this.overlay))
        applyGeometryTo(this.overlay, geom)
        this.cardGeom = geom
        if (!this.host) lastGeometry = geom
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

  close(): void {
    this.stopLiveRefresh()
    this.bodyRequestToken += 1
    this.dismissMoveMenu()
    this.moveBtn = null
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
    this.disconnectEmbedObservers()
    this.disconnectGestureLayers()
    // Closing the card closes its file-viewer window too — the two windows are
    // a pair bound to one card. (closeViewerWindow nulls the viewer refs.)
    this.closeViewerWindow()
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
    this.sentWrap = null
    this.sentList = null
    this.bodyRevision = undefined
    this.sentFilesRevision = ''
    this.sentFilesEtag = null
    this.resourceRevisions.clear()
  }

  /**
   * Fetch the fiber's markdown body from the daemon and render it into the
   * page pane, styled to read like a vellum page. The body endpoint
   * (`GET /api/v1/fibers/<id>?body=true`) reads from THIS daemon's configured
   * felt stores — which include the git-synced `~/loom` mirror, so a remote
   * host's fibers normally resolve here too (the mirror carries every synced
   * project's body). It degrades to the outcome only when the fiber isn't in
   * this daemon's mirror (e.g. not synced yet) or genuinely has no body.
   * `:::{embed}` artifacts and relative images resolve through the daemon's
   * `/file` route, anchored on the fiber's dir (`card.fiberDir`); an
   * unresolvable path falls back to a placeholder.
   */
  private async renderFiberBody(
    prose: HTMLElement,
    card: KanbanCard,
    overlay: HTMLElement,
    opts: { preserveContent?: boolean } = {},
  ): Promise<void> {
    const preserveContent = opts.preserveContent === true
    const requestToken = ++this.bodyRequestToken
    const pageScroll = this.bodyPage?.scrollTop ?? 0

    if (!preserveContent) {
      // Render the outcome (the card already carries it) IMMEDIATELY, so the
      // panel is never blank: the daemon's body read (`?body=true`) can take
      // several seconds under poll-load, and a bare "Loading…" reads as broken.
      // The body then fills in below the lede, or degrades to a clear note.
      const outcome = (card.outcome ?? '').trim()
      const lede = outcome
        ? `<div class="kbn-detail-lede">${renderMarkdown(outcome, { wikilinks: true })}</div>`
        : ''
      prose.innerHTML = lede + '<p class="kbn-detail-body-status">loading body…</p>'
    }

    let body = ''
    let outcomeFromDaemon: string | undefined
    let modifiedAt: string | undefined
    let found = false
    let reached = false
    let timer: number | null = null
    try {
      const idPath = card.id.split('/').map(encodeURIComponent).join('/')
      // Carry the owning origin so the daemon owner-routes the read to the host
      // that can actually read the fiber (over the SSH tunnel), exactly like
      // every write and the /file bytes route. A remote fiber's body is fetched
      // FROM the remote, never from a git mirror — git sync is never relied on.
      const origin = encodeURIComponent(card.originId ?? '')
      const ctrl = new AbortController()
      timer = window.setTimeout(() => ctrl.abort(), 25000)
      const res = await fetch(
        `${this.shuttleBase}/api/v1/fibers/${idPath}?body=true&origin=${origin}`,
        { signal: ctrl.signal, cache: 'no-store' },
      )
      if (res.ok) {
        const data = (await res.json()) as {
          fibers?: Array<{ fiber?: { body?: unknown; outcome?: unknown; modified_at?: unknown } }>
        }
        // An empty `fibers` array means the daemon answered but the id isn't in
        // its mirror (vs. found-but-bodyless); the note below distinguishes them.
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
    const lede = outcome
      ? `<div class="kbn-detail-lede">${renderMarkdown(outcome, { wikilinks: true })}</div>`
      : ''

    this.disconnectEmbedObservers()
    this.disconnectGestureLayers()
    prose.classList.remove('kbn-detail-prose-empty')
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
      prose.innerHTML = lede + renderMarkdown(renderEmbeds(body, bodyOpts), bodyOpts)
      this.autosizeEmbeds(prose)
      this.installGestureFrames(prose, card)
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
    // No body. Three honest cases — remote bodies normally resolve here via the
    // owning daemon, so this is "nothing to show" or "not synced", never a
    // cross-host rendering gap:
    //   reached + found      → the fiber simply has no markdown body.
    //   reached + not found  → not in this daemon's mirror (e.g. not synced yet).
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

  private restoreBodyScroll(scrollTop: number, overlay: HTMLElement): void {
    const page = this.bodyPage
    if (!page) return
    page.scrollTop = scrollTop
    window.requestAnimationFrame(() => {
      if (this.overlay === overlay) page.scrollTop = scrollTop
    })
  }

  private disconnectEmbedObservers(): void {
    for (const ro of this.embedObservers) ro.disconnect()
    this.embedObservers = []
  }

  private disconnectGestureLayers(): void {
    for (const layer of this.gestureLayers) layer.destroy()
    this.gestureLayers = []
  }

  private installGestureFrames(prose: HTMLElement, card: KanbanCard): void {
    const fiberId = card.id
    for (const frame of prose.querySelectorAll<HTMLIFrameElement>('iframe[data-gesture-path]')) {
      const src = frame.getAttribute('src') ?? frame.src
      this.gestureLayers.push(installGestureLayer(frame, {
        shuttleBase: this.shuttleBase,
        fiberId,
        filePath: frame.dataset.gesturePath,
        sourceUrl: src,
      }))
    }
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
   * moved, ask `/sent-files` conditionally (an `If-None-Match` 304 is the
   * common case), then re-baseline every artifact the panel is showing. Bytes
   * are fetched only when something actually changed, and the reader's scroll,
   * zoom, and active tabs survive every tick.
   *
   * Best-effort throughout: a fiber that momentarily can't be read, or a
   * daemon too old for a probe, leaves the readable page exactly as it is.
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
      // The board moved underneath this sheet while it sat open — a worker
      // finished, someone tempered the card from another host. The Move control
      // is the one piece of chrome whose very PRESENCE is a claim about board
      // state, so it is re-asked here rather than left saying what was true
      // when the panel opened.
      this.syncMoveButton()
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
      const idPath = card.id.split('/').map(encodeURIComponent).join('/')
      const origin = encodeURIComponent(card.originId ?? '')
      const res = await fetch(
        `${this.shuttleBase}/api/v1/fibers/${idPath}?origin=${origin}`,
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
   * when `/file-info` is unavailable (an older daemon), so a re-sent file still
   * reloads there.
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
   * owns that, and its `trail:` fallback covers a re-sent file on a daemon with
   * no `/file-info`.
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
      const idPath = fiberId.split('/').map(encodeURIComponent).join('/')
      const res = await fetch(`${this.shuttleBase}/api/v1/fibers/${idPath}?body=true`)
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
      { host, panel, onCloseRequest: requestClose, moves: this.moves ?? undefined },
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

  /**
   * Size full-length HTML embeds (`iframe[data-autosize]`, emitted by
   * utils.embedHtml for an HTML `:::{embed}` with no pinned `:height:`) so they
   * read as part of the page — one scroll column, no nested scrollbar. The
   * iframe is same-origin (the daemon's `/file` route), so its document is
   * readable. Two regimes:
   *
   *   - **reveal.js deck** (a `slides.html` from the slides skill) — a deck has
   *     fixed NATIVE slide dimensions and scales to fill whatever box it's given,
   *     so content-height measurement collapses it to a stub. Instead size by the
   *     deck's own aspect ratio (`Reveal.getConfig()` width/height): height =
   *     container-width × (slideH / slideW). The deck then shows at native
   *     proportions and grows taller as the panel widens.
   *   - **ordinary HTML** (report.html and friends) — grow to the content's
   *     scrollHeight so the whole document reads inline.
   *
   * A ResizeObserver on both the container (width-driven, for the deck) and the
   * body (content-driven, for ordinary HTML) re-fits on any panel resize. A
   * cross-origin or unreadable doc silently keeps the CSS min-height.
   */
  private autosizeEmbeds(prose: HTMLElement): void {
    const frames = prose.querySelectorAll<HTMLIFrameElement>('iframe[data-autosize]')
    frames.forEach((iframe) => {
      // reveal.js deck → size by native slide aspect ratio. Returns false when
      // the frame isn't a (ready) reveal deck, so `fit` falls back to content
      // height. `getConfig` may not exist until the deck's async init runs —
      // hence the retries scheduled on load.
      const fitReveal = (): boolean => {
        const win = iframe.contentWindow as unknown as {
          Reveal?: { getConfig?: () => { width?: number; height?: number } }
        } | null
        const cfg = win?.Reveal?.getConfig?.()
        const sw = Number(cfg?.width)
        const sh = Number(cfg?.height)
        if (!(sw > 0) || !(sh > 0)) return false
        const w = (iframe.parentElement ?? iframe).clientWidth
        if (!(w > 0)) return false
        iframe.style.height = `${Math.round((w * sh) / sw)}px`
        return true
      }
      const fitContent = () => {
        const doc = iframe.contentDocument
        if (!doc) return
        const h = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0)
        if (h > 0) iframe.style.height = `${h}px`
      }
      const fit = () => {
        try {
          prepareIframeExternalLinks(iframe)
          if (!fitReveal()) fitContent()
        } catch {
          /* cross-origin / unreadable — leave the CSS min-height in place */
        }
      }
      iframe.addEventListener('load', () => {
        fit()
        // Late reveal init: getConfig can lag the load event; re-fit a few times.
        ;[120, 400, 1200].forEach((ms) => window.setTimeout(fit, ms))
        try {
          if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => fit())
            // Container width drives the deck; body size drives ordinary HTML.
            if (iframe.parentElement) ro.observe(iframe.parentElement)
            const body = iframe.contentDocument?.body
            if (body) ro.observe(body)
            this.embedObservers.push(ro)
          }
        } catch {
          /* ignore — observation is best-effort */
        }
      })
      // A cached doc may have finished loading before the listener attached.
      try {
        if (iframe.contentDocument?.readyState === 'complete') fit()
      } catch {
        /* ignore */
      }
    })
  }

  // ── Panel geometry: default + remembered, drag, resize ────────────────────

  /** Default size: a reading column at nearly full viewport height — the
   *  page wants vertical room; width stays a comfortable measure. The card
   *  panel opens at this width and keeps it (the file viewer is its own
   *  window); remembered geometry wins when it still fits the viewport. */
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
    const card = this.overlay

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

    // Download the active file to ~/Downloads — restores the save affordance the
    // retired Portolan `:4004` route carried (⤓). Pinned right of the tabs, left
    // of the close-all ✕; acts on whichever tab is active.
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

    // ── Geometry ──
    // Remembered placement for this card wins; otherwise the default is
    // half-and-half — the card glides to the left half, the viewer takes the
    // right half. Once placed, the viewer geometry is remembered (settle +
    // close) so the next open restores it instead of re-splitting.
    //
    // ON A PHONE there are no halves. The viewer opens as its own sheet OVER
    // the card — one full-viewport thing at a time, which is what a hand-held
    // screen can actually show — and the card is left exactly where it was, to
    // be read again when the viewer's ✕ takes this sheet away. No geometry is
    // written in this mode, so the sheet's CSS `inset` is not outranked by a
    // stale style attribute; no remembered placement is consulted or saved,
    // because a sheet has no placement to remember.
    const sheet = isMobileViewport()
    if (sheet) {
      win.classList.add('kbn-detail-sheet')
    } else if (this.viewerGeom) {
      this.viewerGeom = fitted(this.viewerGeom)
      applyGeometryTo(win, this.viewerGeom)
    } else {
      const { card: cardG, other: viewerG } = halfAndHalf()
      // A TABBED card has no frame to move — it fills its cell inside the
      // wikilink panel, so only the viewer takes its half.
      if (!this.host) {
        animatePanelGeometry(card, cardG)
        lastGeometry = cardG
        this.cardGeom = cardG
      }
      applyGeometryTo(win, viewerG)
      this.viewerGeom = viewerG
    }
    if (!sheet) {
      // Persist the new arrangement (half-and-half or restored) immediately.
      this.writePersist()

      const rememberViewer = () => {
        this.viewerGeom = readPanelGeometry(win)
        this.writePersist()
      }
      // Drag (header bar) + resize (eight edge/corner zones) — independent of
      // the card, reusing the same chrome helpers + handle CSS. Both remember
      // the window's new geometry for this card.
      attachPanelDrag(win, bar, { onSettle: rememberViewer })
      attachPanelResize(win, {
        onSettle: rememberViewer,
      })
    }
    // Clicking anywhere on the viewer raises it above the card.
    win.addEventListener('pointerdown', () => bringToFront(win), true)

    this.viewerWindow = win
    document.body.append(win)
    bringToFront(win)
    // A sheet gets its own entry, above the card's. Without one, the back
    // gesture over an open viewer skipped straight past it and closed the card
    // underneath — the reader loses the fiber they were reading to dismiss a
    // file.
    if (sheet) holdSheet(SHEET_VIEWER, true, () => this.closeViewerWindow())
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
    const fullPath = entry.file.fullPath
    const filename = basename(fullPath)
    const url = fileBytesUrl(this.shuttleBase, fullPath, this.card.originId)
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

  /** Header-strip drag. Plain pointer drag — the header is dedicated chrome,
   *  so no modifier gate is needed (the Cmd-gate lesson from the pin-card
   *  prototype applies to chrome-less surfaces where drag fights text
   *  selection; a title bar doesn't). Buttons and form fields opt out. */
  private attachDrag(overlay: HTMLElement, handle: HTMLElement): void {
    attachPanelDrag(overlay, handle, {
      onSettle: () => this.rememberGeometry(overlay),
    })
  }

  /** Eight invisible resize zones on the edges and corners. Pointer-based,
   *  same lifecycle as drag; min size keeps the header + dropdown usable. */
  private attachResizeHandles(overlay: HTMLElement): void {
    attachPanelResize(overlay, {
      onSettle: () => this.rememberGeometry(overlay),
    })
  }

  // ── Controls dropdown ───────────────────────────────────────────────────

  /**
   * The one cluster holding every card action. Collapsed: a slim toggle row
   * with at-a-glance worker chips. Expanded: directive + dispatch actions,
   * review moves, worker config (agent / kind / schedule), and parent.
   */
  private buildControls(
    card: KanbanCard,
    shuttleManaged: boolean,
  ): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-controls'

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'kbn-detail-controls-toggle'
    toggle.setAttribute('aria-expanded', 'false')

    const chevron = document.createElement('span')
    chevron.className = 'kbn-detail-controls-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '▸'

    const toggleLabel = document.createElement('span')
    toggleLabel.className = 'kbn-detail-controls-label'
    toggleLabel.textContent = 'Actions'

    const summary = document.createElement('span')
    summary.className = 'kbn-detail-controls-summary'
    const chips: string[] = []
    const hovers: string[] = []
    if (card.shuttleAgent) chips.push(card.shuttleAgent)
    if (card.shuttleKind === 'standing' && card.shuttleSchedule) {
      // Say the cadence the way a person would — "weekdays 9:00" — and keep the
      // raw cron on the hover. `0 9 * * 1-5` is a thing you decode, not a thing
      // you read, and the trail exists to be read at a glance. An expression the
      // humanizer can't say faithfully falls back to the raw string.
      const spoken = humanizeCron(card.shuttleSchedule)
      chips.push(spoken ?? card.shuttleSchedule)
      if (spoken) hovers.push(`cron: ${card.shuttleSchedule}`)
    } else if (card.shuttleKind) chips.push(card.shuttleKind)
    if (card.shuttleHost) chips.push(card.shuttleHost)
    const projectDir = card.shuttleProjectDir
    if (projectDir) {
      // Home-relativize for the chip (~/dev/shuttle); full path on hover.
      chips.push(projectDir.replace(/^\/(?:Users|home)\/[^/]+\//, '~/'))
      hovers.push(projectDir)
    }
    summary.textContent = chips.join(' · ')
    if (hovers.length > 0) summary.title = hovers.join('\n')

    toggle.append(chevron, toggleLabel, summary)

    // ── Move ▾ ────────────────────────────────────────────────────────────
    // Lives in the HEAD row, beside the Actions toggle, rather than down
    // inside the expanded cluster. Two reasons, and the second is the whole
    // point of the control: on a phone the head row is the sheet's bottom bar,
    // so Move is one thumb-reach away with nothing expanded; and on any
    // viewport moving a card is a placement, not a dispatch — it does not
    // belong in the row where you type a directive.
    const head = document.createElement('div')
    head.className = 'kbn-detail-controls-head'
    head.append(toggle)
    const moveBtn = this.buildMoveButton(card)
    this.moveBtn = moveBtn
    if (moveBtn) head.append(moveBtn)

    const body = document.createElement('div')
    body.className = 'kbn-detail-controls-body'
    body.hidden = true

    toggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const expanded = body.hidden
      body.hidden = !expanded
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      chevron.textContent = expanded ? '▾' : '▸'
      wrap.classList.toggle('kbn-detail-controls-open', expanded)
    })

    // The session window sits between the toggle row and the collapsible body:
    // visible while collapsed, because "when did this last run, and did it
    // finish cleanly?" is the question you open a card to answer.
    const sessionWindow = buildSessionWindow(card)
    wrap.append(head, ...(sessionWindow ? [sessionWindow] : []), body)
    this.buildControlsBody(body, card, shuttleManaged)
    return wrap
  }

  private buildControlsBody(
    body: HTMLElement,
    card: KanbanCard,
    shuttleManaged: boolean,
  ): void {
    // A drag or click inside a field is the field's own — it must not reach the
    // header's drag or the panel's click-away.
    const swallowDrag = (el: HTMLElement): void => {
      for (const type of ['mousedown', 'click'] as const) {
        el.addEventListener(type, (e) => e.stopPropagation())
      }
    }

    // ── Next dispatch (message + action buttons) ──────────────────────────
    // One canonical surface for "what happens when this fiber dispatches
    // next." The message textarea is the optional payload, carried inline on
    // the dispatch call (`user_message`); "talk to me first" intent rides the
    // directive text, prepended via the one-click "Wait for me" affordance.
    const actionsSec = this.buildSection(shuttleManaged ? 'Next dispatch' : 'Actions')
    const actionsErr = document.createElement('div')
    actionsErr.className = 'kbn-detail-error'
    actionsErr.style.display = 'none'

    const messageTa = document.createElement('textarea')
    messageTa.className = 'kbn-detail-directive'
    messageTa.placeholder = 'Message for the next worker (optional)…'
    messageTa.rows = 3
    messageTa.setAttribute('aria-label', 'Message for next worker')
    swallowDrag(messageTa)

    const WAIT_FOR_ME_LINE = "Wait for me before doing anything heavy — let's talk first.\n\n"
    const waitBtn = document.createElement('button')
    waitBtn.type = 'button'
    waitBtn.className = 'kbn-detail-wait-btn'
    waitBtn.textContent = '⏸ Wait for me'
    waitBtn.title = 'Prepend a "talk first" line to the message so the worker checks in before doing heavy work.'
    waitBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (!messageTa.value.startsWith(WAIT_FOR_ME_LINE)) {
        messageTa.value = WAIT_FOR_ME_LINE + messageTa.value
      }
      messageTa.focus()
    })

    const actionsRow = document.createElement('div')
    actionsRow.className = 'kbn-detail-actions-row'
    let freshDispatchBtn: HTMLButtonElement | null = null

    const temperBtn = this.buildActionBtn('Temper', 'tempered')
    temperBtn.title = 'Close as tempered (human-accepted)'

    const compostBtn = this.buildActionBtn('Compost', 'composted')
    compostBtn.title = 'Close as composted (human-rejected)'

    if (shuttleManaged) {
      const requeueBtn = this.buildActionBtn('New session ▸', 'primary')
      freshDispatchBtn = requeueBtn
      requeueBtn.title =
        'Cut any open session and dispatch a fresh worker reading ## Status; outcome preserved'

      const resumeBtn = this.buildActionBtn('Resume ▸', 'primary')
      resumeBtn.title = 'Resume the previous worker session (claude --resume); outcome preserved'
      // Resume is always offered for a shuttle-managed card — never gated on a
      // card-visible session id. The Claude session id lives in the fiber's
      // `shuttle.session_uuid` frontmatter field, stamped by the daemon at
      // dispatch; `card.sessionId` is always absent and the frontend cannot
      // see what to resume. The daemon resolves continuation from the
      // `shuttle:` block at dispatch time (resume_mode='previous' reads
      // `shuttle.session_uuid`) and surfaces a precise error if there is
      // genuinely nothing to resume. Gating on `card.sessionId` is exactly what grayed
      // Resume out for EVERY card — it had already grayed standing roles, which
      // never persisted one. See gotcha-standing-role-resume-button-grayed.

      actionsRow.append(requeueBtn, resumeBtn, temperBtn, compostBtn)

      requeueBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.runRequeue(card, messageTa.value.trim(), 'fresh', requeueBtn, actionsErr)
      })
      resumeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.runRequeue(card, messageTa.value.trim(), 'previous', resumeBtn, actionsErr)
      })
    } else {
      actionsRow.append(temperBtn, compostBtn)
    }

    temperBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
      this.onTransition(card, 'tempered')
    })
    compostBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
      this.onTransition(card, 'composted')
    })

    // One storyline row under the directive: set intent (⏸), dispatch
    // (New session / Resume), then the review verdicts pushed to the right
    // edge (Temper carries margin-left:auto in CSS) so the two families
    // read as distinct clusters without a second row.
    if (shuttleManaged) {
      actionsRow.prepend(waitBtn)
      actionsSec.append(messageTa, actionsRow, actionsErr)
    } else {
      actionsSec.append(actionsRow, actionsErr)
    }

    // ── Worker (shuttle options) ──────────────────────────────────────────
    // Console-style editor for the fiber's shuttle frontmatter block: agent,
    // kind, schedule cadence. Agent axes (base × effort × chrome) commit
    // through `commitAxes` → the daemon's `set-agent` action (preserves
    // session.id + review history); kind/schedule/tz changes go through
    // `livePatch` → the daemon's `reshape` action, which rewrites the shape
    // keys alone and leaves agent/status/outcome where they are.
    const originalAgent = card.shuttleAgent ?? ''
    // The kind editor is the full three-way: One-shot | Standing | Pinned. It
    // used to coerce `pinned` to `oneshot` for its baseline, which made a
    // pinned card display "One-shot" as selected and made One-shot a no-op
    // early-return — unpinning from the panel was impossible. The card's kind
    // is read straight through; an absent block reads as oneshot.
    const originalKind: ShuttleKind = card.shuttleKind ?? 'oneshot'
    const originalSchedule = card.shuttleSchedule ?? ''
    const originalTz = card.shuttleTz ?? 'Europe/Paris'

    let selectedKind: ShuttleKind = originalKind
    /** Set on mousedown over a NON-standing segment while a promotion is staged
     *  but uncommitted, so the cron field's blur doesn't commit on the way out. */
    let abandoningPromotion = false
    let selectedSchedule = originalSchedule
    let selectedTz = originalTz

    const dispatchSec = this.buildSection(shuttleManaged ? 'Worker' : 'Promote to shuttle')
    const promoteBtn = shuttleManaged ? null : this.buildActionBtn('Promote to shuttle', 'primary')
    const promoteErr = document.createElement('div')
    promoteErr.className = 'kbn-detail-error'
    promoteErr.style.display = 'none'

    // Row 1: agent — base agent select × effort select × chrome toggle. The
    // three orthogonal axes compose into one validated `set-agent` write; the
    // effort options and chrome availability are populated from the selected
    // agent's registry constraint metadata (no hardcoded lists here).
    const agentRow = document.createElement('div')
    agentRow.className = 'kbn-detail-field-row'

    const agentLabel = document.createElement('label')
    agentLabel.className = 'kbn-detail-label'
    agentLabel.textContent = 'Agent'

    const agentSelect = document.createElement('select')
    agentSelect.className = 'kbn-detail-select'

    const loadingOpt = document.createElement('option')
    loadingOpt.value = ''
    loadingOpt.textContent = 'Loading agents…'
    agentSelect.append(loadingOpt)

    agentLabel.setAttribute('for', 'kbn-detail-agent')
    agentSelect.id = 'kbn-detail-agent'

    // Effort select — its <option>s are the selected agent's concrete
    // `effort_levels`. There is deliberately no synthetic "default" option:
    // an omitted fiber value resolves to the registry's `default_effort`, so
    // the control always names the level dispatch will actually use.
    const effortSelect = document.createElement('select')
    effortSelect.className = 'kbn-detail-select kbn-detail-select-effort'
    effortSelect.id = 'kbn-detail-effort'
    effortSelect.setAttribute('aria-label', 'Reasoning effort')
    effortSelect.title = 'Reasoning effort used for this fiber'

    // Chrome toggle — enabled only for chrome-capable (claude) agents.
    const chromeWrap = document.createElement('label')
    chromeWrap.className = 'kbn-detail-chrome-toggle'
    chromeWrap.title = 'Run the worker with Claude --chrome (claude harness only)'
    const chromeToggle = document.createElement('input')
    chromeToggle.type = 'checkbox'
    chromeToggle.id = 'kbn-detail-chrome'
    const chromeText = document.createElement('span')
    chromeText.textContent = 'chrome'
    chromeWrap.append(chromeToggle, chromeText)

    // Effort + chrome compose onto an existing shuttle block via set-agent;
    // a not-yet-promoted human card has no block to mutate, so the axes only
    // appear once the card is shuttle-managed. (Promotion's install path takes
    // base model only; the axes are then editable on the installed block.)
    effortSelect.style.display = shuttleManaged ? '' : 'none'
    chromeWrap.style.display = shuttleManaged ? '' : 'none'

    agentRow.append(agentLabel, agentSelect, effortSelect, chromeWrap)
    dispatchSec.append(agentRow)
    // Data-load + listener wiring is deferred until livePatch/statusEl exist
    // (below), since the axis commit posts through them.

    // Row 2: kind segmented control
    const kindRow = document.createElement('div')
    kindRow.className = 'kbn-detail-field-row'

    const kindLabel = document.createElement('span')
    kindLabel.className = 'kbn-detail-label'
    kindLabel.textContent = 'Kind'

    const kindSegmented = document.createElement('div')
    kindSegmented.className = 'kbn-detail-segmented'
    kindSegmented.setAttribute('role', 'radiogroup')
    kindSegmented.setAttribute('aria-label', 'Dispatch kind')

    // Schedule row declared up here so the kind buttons can toggle its
    // visibility; populated below.
    const scheduleRow = document.createElement('div')
    scheduleRow.className = 'kbn-detail-field-row kbn-detail-field-row-schedule'

    const buildKindBtn = (
      value: ShuttleKind,
      label: string,
      hint: string,
    ): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-detail-segment'
      btn.setAttribute('role', 'radio')
      btn.setAttribute('aria-checked', value === selectedKind ? 'true' : 'false')
      btn.dataset.kind = value
      if (value === selectedKind) btn.classList.add('kbn-detail-segment-active')
      btn.title = hint

      const name = document.createElement('span')
      name.className = 'kbn-detail-segment-name'
      name.textContent = label
      btn.append(name)

      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (selectedKind === value) return
        selectedKind = value
        for (const sibling of kindSegmented.querySelectorAll<HTMLButtonElement>('button')) {
          const isActive = sibling.dataset.kind === value
          sibling.classList.toggle('kbn-detail-segment-active', isActive)
          sibling.setAttribute('aria-checked', isActive ? 'true' : 'false')
        }
        scheduleRow.style.display = shuttleManaged && value === 'standing' ? '' : 'none'
        // Seed a plausible cron + tz so the user edits rather than fighting an
        // empty input — but SEEDING IS NOT CHOOSING. Nothing is written until
        // the cron is confirmed (see `commitScheduleTz`); focus the field so
        // the thing left to do is the thing under the cursor.
        if (value === 'standing') {
          if (!selectedSchedule) {
            selectedSchedule = '0 9 * * 1-5'
            scheduleInput.value = selectedSchedule
          }
          if (!selectedTz) {
            selectedTz = 'Europe/Paris'
            tzInput.value = selectedTz
          }
          scheduleInput.focus()
          scheduleInput.select()
        }
      })
      return btn
    }

    const oneshotBtn = buildKindBtn('oneshot', 'One-shot', 'Single dispatch on enable')
    const standingBtn = buildKindBtn('standing', 'Standing', 'Recurring cron-scheduled role')
    const pinnedBtn = buildKindBtn(
      'pinned',
      'Pinned',
      'Standing interface that rests on the Pinned strip',
    )
    kindSegmented.append(oneshotBtn, standingBtn, pinnedBtn)
    kindRow.append(kindLabel, kindSegmented)
    kindRow.style.display = shuttleManaged ? '' : 'none'
    dispatchSec.append(kindRow)

    // Row 3: schedule + tz (visible only when kind=standing)
    const scheduleLabel = document.createElement('label')
    scheduleLabel.className = 'kbn-detail-label'
    scheduleLabel.textContent = 'Cron'
    scheduleLabel.setAttribute('for', 'kbn-detail-schedule')

    const scheduleInput = document.createElement('input')
    scheduleInput.type = 'text'
    scheduleInput.id = 'kbn-detail-schedule'
    scheduleInput.className = 'kbn-detail-input kbn-detail-input-mono'
    scheduleInput.placeholder = '0 9 * * 1-5'
    scheduleInput.value = selectedSchedule
    scheduleInput.title = '5-field cron · e.g. 0 9 * * 1-5 (weekdays 09:00)'
    scheduleInput.addEventListener('input', () => {
      selectedSchedule = scheduleInput.value
    })
    swallowDrag(scheduleInput)

    const tzInput = document.createElement('input')
    tzInput.type = 'text'
    tzInput.className = 'kbn-detail-input kbn-detail-input-tz'
    tzInput.placeholder = 'Europe/Paris'
    tzInput.value = selectedTz
    tzInput.title = 'IANA timezone name'
    tzInput.setAttribute('aria-label', 'Timezone (IANA name)')
    tzInput.addEventListener('input', () => {
      selectedTz = tzInput.value
    })
    swallowDrag(tzInput)

    scheduleRow.append(scheduleLabel, scheduleInput, tzInput)
    scheduleRow.style.display = shuttleManaged && selectedKind === 'standing' ? '' : 'none'
    dispatchSec.append(scheduleRow)
    if (promoteBtn) dispatchSec.append(promoteBtn, promoteErr)

    // ── Live-apply status pill ────────────────────────────────────────────
    // No Save button. Every field commits on its own event: agent on
    // `change`, kind on click, schedule/tz on `blur`/Enter, parent on
    // autocomplete pick. statusEl shows "Saving…" / "Saved"; errors surface
    // in errorEl. Originals advance after each successful PATCH.
    const statusEl = document.createElement('span')
    statusEl.className = 'kbn-detail-save-status'
    statusEl.setAttribute('aria-live', 'polite')

    const errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.style.display = 'none'

    // ── Parent fiber ──────────────────────────────────────────────────────
    const parentSec = this.buildSection('Parent fiber')

    const idSegments = card.id.split('/')
    const currentParentId = idSegments.length > 1
      ? idSegments.slice(0, -1).join('/')
      : null

    let selectedParentId: string | null = currentParentId

    const currentParentEl = document.createElement('div')
    currentParentEl.className = 'kbn-detail-current-parent'
    currentParentEl.textContent = currentParentId
      ? `↳ ${currentParentId}`
      : '↳ top-level (no parent)'

    const parentSearchWrap = document.createElement('div')
    parentSearchWrap.className = 'kbn-detail-parent-wrap'

    const parentInput = document.createElement('input')
    parentInput.type = 'text'
    parentInput.className = 'kbn-detail-parent-input'
    parentInput.placeholder = 'Search for a new parent…'
    parentInput.setAttribute('aria-label', 'Search parent fiber')
    parentInput.setAttribute('autocomplete', 'off')
    parentInput.setAttribute('role', 'combobox')
    parentInput.setAttribute('aria-expanded', 'false')
    parentInput.setAttribute('aria-haspopup', 'listbox')
    swallowDrag(parentInput)

    const parentDropdown = document.createElement('div')
    parentDropdown.className = 'kbn-detail-parent-dropdown'
    parentDropdown.style.display = 'none'
    parentDropdown.setAttribute('role', 'listbox')

    // The one pick-handler every caller (search debounce, keyboard Enter,
    // dropdown click) goes through: adopt the choice, then commit it. Its body
    // runs only on a user pick, long after `livePatch` and `baseline` below
    // are initialised.
    const onPickParent = (result: FiberSearchResult): void => {
      selectedParentId = result.id
      parentInput.value = result.name
      parentInput.setAttribute('aria-expanded', 'false')
      parentDropdown.style.display = 'none'
      const targetParentId = selectedParentId
      if (targetParentId === baseline.parentId) return
      livePatch({ parentId: targetParentId }, () => {
        baseline.parentId = targetParentId
        currentParentEl.textContent = targetParentId
          ? `↳ ${targetParentId}`
          : '↳ top-level (no parent)'
      })
    }

    const openDropdown = () => {
      void this.searchParents(
        parentInput.value.trim(),
        card.id,
        parentDropdown,
        onPickParent,
      ).then(() => {
        if (parentDropdown.style.display !== 'none') {
          parentInput.setAttribute('aria-expanded', 'true')
        }
      })
    }

    parentInput.addEventListener('input', () => {
      if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce)
      this.searchDebounce = window.setTimeout(() => openDropdown(), 200)
    })
    parentInput.addEventListener('focus', () => openDropdown())
    parentInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        const first = parentDropdown.querySelector<HTMLElement>('button')
        if (first) { e.preventDefault(); first.focus() }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        parentDropdown.style.display = 'none'
        parentInput.setAttribute('aria-expanded', 'false')
      }
    })

    parentDropdown.addEventListener('keydown', (e) => {
      const opts = Array.from(
        parentDropdown.querySelectorAll<HTMLElement>('button:not(:disabled)'),
      )
      const idx = opts.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown' && idx < opts.length - 1) {
        e.preventDefault()
        opts[idx + 1].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (idx > 0) opts[idx - 1].focus()
        else parentInput.focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        // Focus the input first — hiding a container that holds the focused
        // element drops focus to <body> before we can redirect it.
        parentInput.focus()
        parentDropdown.style.display = 'none'
        parentInput.setAttribute('aria-expanded', 'false')
      }
    })

    parentSearchWrap.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (!parentSearchWrap.contains(document.activeElement)) {
          parentDropdown.style.display = 'none'
          parentInput.setAttribute('aria-expanded', 'false')
        }
      }, 150)
    })

    parentSearchWrap.append(parentInput, parentDropdown)
    parentSec.append(currentParentEl, parentSearchWrap)

    // Track originals as a mutable closure so each successful PATCH can
    // advance the baseline.
    const baseline = {
      agent: originalAgent,
      kind: originalKind,
      schedule: originalSchedule,
      tz: originalTz,
      parentId: currentParentId,
      // The CIVIL DAY the card's `due:` names, never the raw stored value: the
      // comparison below decides whether an edit is a real change, and
      // `2026-10-01` vs `2026-10-01T00:00:00Z` are the same day written twice.
      due: dueCivilDay(card.due) ?? null,
    }

    const livePatch = (
      changes: {
        shuttleKind?: ShuttleKind
        shuttleSchedule?: string
        shuttleTz?: string
        parentId?: string | null
        due?: string | null
      },
      onCommitted?: () => void,
    ): void => {
      if (Object.keys(changes).length === 0) return
      void this.livePatch(card, changes, statusEl, errorEl).then((ok: boolean) => {
        if (ok && onCommitted) onCommitted()
      })
    }

    // Agent axes: base agent × effort × chrome compose into one validated
    // `set-agent` write (preserves session history, like the old set-model).
    // The picker repopulates effort options + chrome availability from the
    // selected agent's registry metadata and commits on any axis change.
    {
      let committedAxes = {
        agent: originalAgent,
        effort: card.shuttleEffort ?? '',
        chrome: card.shuttleChrome ?? false,
      }
      // For a shuttle-managed card every axis change commits via set-agent;
      // for a human card the picker only populates the base-agent select the
      // promote button reads (no block to mutate yet → no-op commit).
      void this.loadAgentPicker(
        { agentSelect, effortSelect, chromeToggle },
        {
          agent: originalAgent,
          effort: card.shuttleEffort ?? '',
          chrome: card.shuttleChrome ?? false,
        },
        shuttleManaged
          ? (axes) => {
              const restartForChrome = chromeRestartNeeded(card, committedAxes.chrome, axes.chrome)

              if (restartForChrome) {
                const setting = axes.chrome ? 'with Chrome enabled' : 'with Chrome disabled'
                const ok = window.confirm(
                  `Would you like to restart “${card.name}” ${setting}?\n\n` +
                    'The current session will close, and a fresh session will start with this setting.',
                )
                if (!ok) return false
              }

              void this.commitAxes(card, axes, statusEl, errorEl, () => {
                committedAxes = { ...axes }
                baseline.agent = axes.agent
                if (restartForChrome && freshDispatchBtn) {
                  void this.runRequeue(
                    card,
                    chromeRestartDirective(axes.chrome),
                    'fresh',
                    freshDispatchBtn,
                    actionsErr,
                    true,
                  )
                }
              })
              return true
            }
          : () => {},
      )
    }

    // Kind. One-shot and Pinned commit on the click: neither needs information
    // the user hasn't already given, and neither throws anything away that a
    // re-toggle can't restore.
    //
    // PROMOTING oneshot → standing does NOT commit. It used to, and it wrote a
    // cron the user had never seen: the button's own handler seeds `0 9 * * 1-5
    // / Europe/Paris` into the inputs, and this then read those inputs straight
    // back out and PATCHed them. One click on "Standing" and the fiber was a
    // weekday-09:00 role by our choice, not theirs. Now the toggle only reveals
    // and seeds the fields; `commitScheduleTz` writes the promotion when the
    // cron is confirmed on blur or Enter. A card abandoned mid-toggle stays
    // oneshot on the wire, which matches the Stash form's explicit-schedule
    // ethos — a schedule is something you state, never something you're given.
    //
    // PINNING FROM THE PANEL IS SHAPE-ONLY, and that is a deliberate divergence
    // from the board's drag-onto-the-Pinned-strip gesture (`commitPin`), which
    // kills a live worker, reshapes, and THEN pauses. The two gestures mean
    // different things: the drag targets a SURFACE, and the Pinned strip is
    // where things are at rest, so "come to rest" is half of what was asked.
    // This control edits a FIELD — the human said "be a pinned role", nothing
    // about now. So it posts the reshape alone: no kill, no pause. The read
    // model then places the card on its own — an `active` pinned role
    // classifies onto the strip, a running one stays In-flight via the
    // live-worker override, a closed one stays in Awaiting review.
    const commitKind = (value: ShuttleKind): void => {
      if (value === baseline.kind) return
      if (value === 'standing') {
        errorEl.style.display = 'none'
        statusEl.textContent = 'confirm the cron to save'
        return
      }
      statusEl.textContent = ''
      livePatch({ shuttleKind: value }, () => {
        baseline.kind = value
      })
    }
    for (const btn of kindSegmented.querySelectorAll<HTMLButtonElement>('button')) {
      // Backing OUT of an uncommitted promotion must write nothing, and the
      // hazard is not the click — it's the BLUR the click causes. Toggling to
      // Standing focuses the cron field; clicking One-shot blurs it, and blur is
      // what commits the schedule. Left alone, `mousedown → blur → click` fired
      // the promotion with the SEEDED cron a fraction of a second before the
      // click that meant "never mind". mousedown runs before blur, so this is
      // where the intent is knowable.
      btn.addEventListener('mousedown', () => {
        // Any segment that isn't Standing is a way OUT of a staged promotion —
        // Pinned as much as One-shot.
        if (btn.dataset.kind !== 'standing' && baseline.kind !== 'standing') {
          abandoningPromotion = true
        }
      })
      btn.addEventListener('click', () => {
        const value = btn.dataset.kind as ShuttleKind | undefined
        if (value) commitKind(value)
        abandoningPromotion = false
      })
    }

    // Schedule + tz: fire on `blur` and Enter — `input` would generate
    // noisy patches from mid-typing cron fragments. The reshape path
    // requires kind=standing alongside, so always send all three.
    //
    // This is ALSO where a oneshot → standing promotion lands, which is why the
    // guard reads `selectedKind` (what the user has chosen in the panel) rather
    // than `baseline.kind` (what the wire currently says). Confirming the cron
    // IS the act of promoting; until then the toggle is just a revealed form.
    const commitScheduleTz = (): void => {
      // The user is on their way out of an uncommitted promotion (see the
      // mousedown guard on the kind control) — this blur is the side effect of
      // backing out, not a confirmation.
      if (abandoningPromotion) {
        abandoningPromotion = false
        statusEl.textContent = ''
        return
      }
      if (selectedKind !== 'standing') return
      const newSchedule = scheduleInput.value.trim()
      const newTz = tzInput.value.trim() || 'UTC'
      const promoting = baseline.kind !== 'standing'
      if (!promoting && newSchedule === baseline.schedule && newTz === baseline.tz) return
      if (!newSchedule) {
        errorEl.textContent = 'A cron expression is required for standing roles.'
        errorEl.style.display = ''
        return
      }
      livePatch(
        {
          shuttleKind: 'standing',
          shuttleSchedule: newSchedule,
          shuttleTz: newTz,
        },
        () => {
          // The promotion lands here too, so the baseline kind advances with
          // the schedule that carried it.
          baseline.kind = 'standing'
          baseline.schedule = newSchedule
          baseline.tz = newTz
          statusEl.textContent = ''
        },
      )
    }
    scheduleInput.addEventListener('blur', commitScheduleTz)
    scheduleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        scheduleInput.blur()
      }
    })
    tzInput.addEventListener('blur', commitScheduleTz)
    tzInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        tzInput.blur()
      }
    })

    // ── Due ───────────────────────────────────────────────────────────────
    // The only way to name a date the hand cannot reach. Dropping a card on a
    // day IS the usual way to say "next Tuesday", but the drag-reveal timeline
    // renders `DRAG_HORIZON_DAYS` (14) days ahead, so a fiber
    // due in October is undatable from the board in August.
    //
    // It is also how a card gets out of the dead half of Resting. A rest with
    // no date is the half nothing ever surfaces again; a future date written
    // here turns it into a snooze — the due-drift override in
    // `effectiveHorizon` pulls the card onto the desk when the day arrives.
    // (Dragging into Resting preserves a future due nowadays, so it no longer
    // MAKES that dead rest — but a card can still reach it by being stashed
    // dateless, or by having an already-elapsed deadline dropped on the way in.)
    //
    // Built here, after `livePatch` exists, rather than up by the other
    // sections; `metaCol` below decides where it lands on the page.
    const dueSec = this.buildSection(card.isCycle ? 'Cycle end' : 'Due')

    // A standing role is placed by cron and a resting pinned role lives on the
    // Pinned strip — the read model never sorts either by `due:`, so a write
    // here would be dead frontmatter. `setSurface` refuses the same planning
    // gesture with an explanation rather than a silent no-op; refuse it in the
    // same voice, naming the gesture that DOES work.
    const dueRefusal =
      card.shuttleKind === 'standing'
        ? `“${card.name}” is a standing role — it runs on its schedule. Edit the schedule to change when it runs.`
        : card.shuttleKind === 'pinned' && card.status === 'active'
          ? `“${card.name}” is a pinned role — it rests on the Pinned strip. Unpin it to plan it.`
          : null

    if (dueRefusal) {
      const refusalEl = document.createElement('div')
      // The panel's muted small-text style; named for its first use, reused
      // here rather than minting a class for one more line of the same voice.
      refusalEl.className = 'kbn-detail-current-parent'
      refusalEl.textContent = dueRefusal
      dueSec.append(refusalEl)
    } else {
      // Blank is a STATE, not an absence of one — a oneshot with no due date is
      // an ordinary card, the way a fiber with no parent is an ordinary fiber.
      // So the section says which state it is in, in the same `↳` line the
      // parent section uses for `top-level (no parent)`, rather than leaving the
      // reader to infer it from an empty box. The year is spelled out because
      // this field exists for the dates the timeline cannot reach.
      const dueCurrentEl = document.createElement('div')
      dueCurrentEl.className = 'kbn-detail-current-parent'
      const paintCurrent = (due: string | null): void => {
        const date = civilDayToLocalDate(due ?? undefined)
        dueCurrentEl.textContent = date
          ? `↳ ${date.toLocaleDateString(undefined, {
              weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
            })}`
          : '↳ no due date'
      }
      paintCurrent(baseline.due)

      const dueRow = document.createElement('div')
      dueRow.className = 'kbn-detail-field-row'

      const dueInput = document.createElement('input')
      dueInput.type = 'date'
      dueInput.className = 'kbn-detail-input'
      dueInput.setAttribute('aria-label', card.isCycle ? 'Cycle closing date' : 'Due date')
      // Seeded through `dueCivilDay`, NEVER `new Date(card.due)`: felt stores a
      // civil day as UTC midnight, and the Date round trip names the day BEFORE
      // in every negative-offset zone — the exact defect civilDay.ts exists to
      // prevent. `dueCivilDay` hands back the bare `YYYY-MM-DD` the input wants,
      // and that same bare day is what goes back on the wire, so the value never
      // becomes an instant in either direction.
      dueInput.value = dueCivilDay(card.due) ?? ''
      swallowDrag(dueInput)

      const clearBtn = this.buildActionBtn('Clear', 'composted')
      clearBtn.title = card.isCycle
        ? 'Clear the closing edge — the band runs open-ended from its start'
        : 'Clear the due date'
      clearBtn.disabled = baseline.due === null

      const dueHint = document.createElement('div')
      dueHint.className = 'kbn-detail-current-parent'

      // What this field means for THIS card, said only where it isn't obvious:
      // a cycle's due is an edge rather than a deadline, and a resting card's
      // due is its return ticket — including the "no date" case, which is the
      // trap the editor repairs.
      const hintFor = (due: string | null): string => {
        if (card.isCycle) {
          return "A cycle's due is the band's closing edge, not a deadline — the Chronicle's edge drag moves it too."
        }
        if (card.storedHorizon !== 'stashed') return ''
        return due === null
          ? 'Resting with no date rests forever — nothing brings it back. A future date makes this a snooze that returns.'
          : 'Resting until this date, then back on the desk.'
      }
      const paintHint = (due: string | null): void => {
        dueHint.textContent = hintFor(due)
        dueHint.style.display = dueHint.textContent ? '' : 'none'
      }
      paintHint(baseline.due)

      dueRow.append(dueInput, clearBtn)
      dueSec.append(dueCurrentEl, dueRow, dueHint)

      const commitDue = (next: string | null): void => {
        if ((next ?? '') === (baseline.due ?? '')) return
        livePatch({ due: next }, () => {
          baseline.due = next
          dueInput.value = next ?? ''
          clearBtn.disabled = next === null
          paintCurrent(next)
          paintHint(next)
        })
      }
      // `change` rather than `input`: a native date picker fires `input` for
      // each keystroke of a half-typed year, and 0002-10-01 is not a date
      // anyone meant to save.
      //
      // EMPTYING THE FIELD IS ITSELF THE CLEAR. Deleting the date — by keyboard,
      // or through the browser's own ✕ on the picker — commits `due: null`, the
      // same write the button makes. The button is the visible spelling of a
      // state the field can always reach on its own, never the only way there.
      dueInput.addEventListener('change', () => {
        commitDue(dueInput.value || null)
      })
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        commitDue(null)
      })
    }

    if (promoteBtn) {
      promoteBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const agent = agentSelect.value.trim()
        if (!agent) {
          promoteErr.textContent = 'Choose an agent to promote this card.'
          promoteErr.style.display = ''
          return
        }
        promoteBtn.disabled = true
        promoteBtn.textContent = 'Promoting…'
        promoteErr.style.display = 'none'
        void this.promoteToShuttle(card, agent, promoteBtn, promoteErr)
      })
    }

    // ── Footer: live-save status ──────────────────────────────────────────
    const footer = document.createElement('div')
    footer.className = 'kbn-detail-footer'

    footer.append(errorEl, statusEl)

    // Worker config on the left, card metadata (due, parent fiber) on the
    // right — a shallow two-column cluster at comfortable widths, one
    // column on narrow panels (container query in FiberDetailModal.css).
    const grid = document.createElement('div')
    grid.className = 'kbn-detail-controls-grid'
    const metaCol = document.createElement('div')
    metaCol.className = 'kbn-detail-controls-grid-col'
    // Two sections stack in this column now. The grid's row-gap separates grid
    // cells, not the sections inside one, so the column carries its own.
    metaCol.style.display = 'flex'
    metaCol.style.flexDirection = 'column'
    metaCol.style.gap = '12px'
    metaCol.append(dueSec, parentSec)
    grid.append(dispatchSec, metaCol)

    body.append(actionsSec, this.buildRule(), grid, footer)
  }

  // ── Sent files: launcher + two-column accordion ─────────────────────────

  /**
   * The left-column sent-files launcher. Mounts empty (hidden) and self-
   * populates from {@link fetchSentFiles}: the daemon's `/api/v1/sent-files`
   * endpoint. The live refresh loop re-renders it when a worker
   * sends another file, while cards without deliverables pay zero visual cost.
   * Each entry is a button that opens (or re-activates) the file in the
   * right-column accordion.
   */
  private buildSentFilesLauncher(card: KanbanCard): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-detail-sent kbn-detail-sent-empty'

    const heading = document.createElement('div')
    heading.className = 'kbn-detail-sent-heading'
    heading.textContent = 'Sent files'

    const list = document.createElement('div')
    list.className = 'kbn-detail-sent-list'
    list.setAttribute('role', 'list')
    wrap.append(heading, list)
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
        this.activateFile(file, card)
      })
      list.append(row)
    }
  }

  /** Mark launcher entries whose file is currently open in the accordion. */
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
   * Open `file` in the right column and make it the active (shown) tab. If it's
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
    this.syncLauncherActiveState()
    if (opts?.persist !== false) this.writePersist()
  }

  /**
   * Build a new tab + its (empty) view cell and append both in stable
   * open-order. Reveals the right column on the first open. Does NOT activate
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
      e.cell.hidden = !on
      e.tab.classList.toggle('kbn-detail-tab-active', on)
      e.tab.setAttribute('aria-selected', String(on))
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
        ? (iframe) => {
            // Restore the persisted reading position once the doc has loaded
            // (same-origin: served from the app's own daemon).
            try {
              iframe.contentWindow?.scrollTo(0, entry.scroll)
              const win = iframe.contentWindow
              if (win) {
                win.addEventListener('scroll', () => {
                  entry.scroll = win.scrollY
                  this.queueScrollWrite()
                }, { passive: true })
              }
            } catch {
              /* cross-origin / unreadable — no scroll restore */
            }
          }
        : undefined,
      { fiberId: card.id },
    )
    entry.cell.append(viewer)
    // Zoom target: the <img> for images (sized in px so it magnifies PAST the
    // column width), else the viewer wrap (CSS `zoom` for iframes). The cell
    // (overflow:auto) is the pan surface. Apply persisted zoom now that the
    // cell is visible — its width is the image's fit base.
    entry.zoomTarget = viewer.querySelector<HTMLElement>('img.kbn-fileview-image') ?? viewer
    applyZoom(entry)
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
   *  active; dissolves the right column if it was the last. */
  private closeFile(entry: OpenFileEntry): void {
    const { state, closed } = closeTab(
      { tabs: this.openFiles, active: this.activePath },
      entry.path,
    )
    if (!closed) return
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

  /** Debounced scroll-position persistence. Open/close/expand write
   *  immediately; scroll is debounced so a flick of the wheel doesn't hammer
   *  localStorage. */
  private queueScrollWrite(): void {
    if (this.scrollWriteTimer !== null) window.clearTimeout(this.scrollWriteTimer)
    this.scrollWriteTimer = window.setTimeout(() => {
      this.scrollWriteTimer = null
      this.writePersist()
    }, 400)
  }

  /** Serialize the current right-column state to localStorage. */
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
   * Rebuild the right column from persisted state on panel-open. Files are
   * activated oldest-first so the saved recency order (index 0 = top) is
   * reproduced, with scroll/expanded carried through. Entries whose path is no
   * longer on the (eventually-loaded) trail are pruned silently — but the
   * rehydrate fires immediately off the persisted paths so the column is there
   * before the trail fetch resolves. A path the trail later disowns is dropped
   * on the next write.
   */
  private rehydrateOpenFiles(card: KanbanCard, persist: DetailPersist): void {
    if (persist.open.length === 0) return
    // Add every tab in the saved (stable) order without activating — building
    // each viewer lazily would load every iframe up front.
    for (const saved of persist.open) {
      const file: SentFile = {
        fullPath: saved.path,
        // Prefer the persisted display label (preserves the disambiguated
        // basename); fall back to the path tail for legacy records.
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
    const uid = typeof card.uid === 'string' ? card.uid.trim() : ''
    const sessionId = typeof card.sessionId === 'string' ? card.sessionId.trim() : ''
    if (!uid && !sessionId) return []

    // ── Primary: the daemon endpoint ──
    // Conditional: the local leg answers `304` from a weak ETag over the events
    // file's {mtime,size}, which is the common case on a 15s poll. (A remote-
    // owned fiber's leg is relayed and header-less, so it always answers 200 —
    // see the controller's moduledoc.)
    const params = new URLSearchParams()
    if (uid) params.set('uid', uid)
    if (card.originId) params.set('origin', card.originId)
    if (sessionId) params.set('sessionId', sessionId)
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

  private buildSection(label: string): HTMLElement {
    const sec = document.createElement('div')
    sec.className = 'kbn-detail-section'
    const heading = document.createElement('div')
    heading.className = 'kbn-detail-section-heading'
    heading.textContent = label
    sec.append(heading)
    return sec
  }

  /**
   * Hairline printer's rule used to separate clusters in the dropdown.
   * Pure presentational element — no semantic role.
   */
  private buildRule(): HTMLElement {
    const rule = document.createElement('div')
    rule.className = 'kbn-detail-rule'
    rule.setAttribute('aria-hidden', 'true')
    return rule
  }

  /**
   * Build a button for the action cluster. Variants tint the button to
   * match the kanban grid's `kbn-action-*` palette (gold for primary
   * requeue/resume, teal for tempered, muted gray for composted).
   */
  // ── Move ▾: the drag, said in words ──────────────────────────────────────
  //
  // Why this menu exists at all is written once, in `MoveDestinations.ts`.
  // Here it is only rendered: the legality comes from there, and each chosen
  // item goes back to the board's own wire calls through the `MoveBroker`.

  /** The head-row Move control, or null when there is no board behind the
   *  panel (the harness fixture) or nothing this card can legally do. */
  private buildMoveButton(card: KanbanCard): HTMLButtonElement | null {
    const broker = this.moves
    if (!broker) return null
    const btn = document.createElement('button')
    // Built even when the list is empty, and hidden instead. The board can
    // change under an open sheet in either direction, and a control that was
    // never created cannot come back when the card becomes movable again.
    btn.hidden = broker.destinations(card).length === 0
    btn.type = 'button'
    btn.className = 'kbn-detail-move-btn'
    btn.textContent = 'Move ▾'
    btn.setAttribute('aria-haspopup', 'menu')
    btn.setAttribute('aria-expanded', 'false')
    btn.title = 'Move this card — the destinations a drag would accept'
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.closeMoveMenu) {
        this.dismissMoveMenu()
        return
      }
      this.openMoveMenu(card, btn, broker)
    })
    return btn
  }

  /** The first pane: destinations. Choosing "Queue behind…" swaps the pane
   *  rather than opening a second menu — one surface, two depths. */
  private openMoveMenu(card: KanbanCard, anchor: HTMLElement, broker: MoveBroker): void {
    this.dismissMoveMenu()
    const sheet = isMobileViewport()

    const scrim = document.createElement('div')
    scrim.className = 'kbn-move-scrim'
    const menu = document.createElement('div')
    menu.className = sheet ? 'kbn-move-menu kbn-move-sheet' : 'kbn-move-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', `Move ${card.name}`)

    const dismiss = (): void => this.dismissMoveMenu()

    const renderRoot = (): void => {
      menu.replaceChildren()
      menu.append(this.buildMoveHeading(card.name, null))
      const list = document.createElement('div')
      list.className = 'kbn-move-list'
      for (const dest of broker.destinations(card)) {
        list.append(this.buildMoveItem(dest.label, dest.hint, () => {
          if (dest.action.kind === 'queue') {
            renderQueue()
            return
          }
          dismiss()
          broker.perform(card, dest.action)
        }))
      }
      menu.append(list)
      // Focus the first item for the keyboard, but NOT on a touch sheet: the
      // focus ring there reads as a pre-selected choice sitting under the
      // thumb, which is the last impression a destructive-adjacent menu should
      // give when nobody has chosen anything yet.
      if (!sheet) menu.querySelector<HTMLElement>('.kbn-move-item')?.focus()
    }

    const renderQueue = (): void => {
      const targets = broker.queueTargets(card)
      menu.replaceChildren()
      menu.append(this.buildMoveHeading('Queue behind', renderRoot))
      if (targets.length === 0) {
        const empty = document.createElement('p')
        empty.className = 'kbn-move-empty'
        // An empty list is a fact about the board, not a failure — say which.
        empty.textContent = 'Nothing on the board can take this one behind it.'
        menu.append(empty)
        return
      }
      // A search box only once the list is long enough that scanning it costs
      // more than typing. Below that it is chrome standing between the reader
      // and four names.
      const list = document.createElement('div')
      list.className = 'kbn-move-list'
      const draw = (filter: string): void => {
        const q = filter.trim().toLowerCase()
        list.replaceChildren()
        const shown = q
          ? targets.filter((t) => t.card.name.toLowerCase().includes(q) || t.card.id.toLowerCase().includes(q))
          : targets
        for (const t of shown) {
          // The hint names the TAIL when it differs from the card you picked:
          // joining a queue means joining its end, and the menu should not let
          // that happen behind your back.
          const hint = t.tail === t.card.id ? undefined : `joins the end of its queue`
          list.append(this.buildMoveItem(t.card.name, hint, () => {
            dismiss()
            broker.queueBehind(card, t.tail)
          }))
        }
        if (shown.length === 0) {
          const none = document.createElement('p')
          none.className = 'kbn-move-empty'
          none.textContent = 'No match.'
          list.append(none)
        }
      }
      if (targets.length > 7) {
        const search = document.createElement('input')
        search.type = 'search'
        search.className = 'kbn-move-search'
        search.placeholder = 'Find a card…'
        search.setAttribute('aria-label', 'Filter queue targets')
        search.addEventListener('input', () => draw(search.value))
        menu.append(search)
      }
      draw('')
      menu.append(list)
      if (!sheet) menu.querySelector<HTMLElement>('.kbn-move-search, .kbn-move-item')?.focus()
    }

    document.body.append(scrim, menu)
    anchor.setAttribute('aria-expanded', 'true')
    renderRoot()
    if (!sheet) placeMoveMenu(menu, anchor)

    scrim.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      dismiss()
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      dismiss()
    }
    document.addEventListener('keydown', onKey, true)

    // A MENU IS TRANSIENT, so any reflow under it takes it down rather than
    // being chased. The desktop popover is placed once against the button's
    // rectangle, and a resize moves that rectangle out from under it; crossing
    // 700px is worse still, since the menu would have to change shape as well
    // as place. Re-placing on every frame would be work spent on a surface the
    // reader is about to dismiss anyway — one tap re-opens it, correct.
    const onReflow = (): void => dismiss()
    window.addEventListener('resize', onReflow)
    const stopMobileWatch = onMobileChange(onReflow)

    this.closeMoveMenu = () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onReflow)
      stopMobileWatch()
      anchor.setAttribute('aria-expanded', 'false')
      scrim.remove()
      menu.remove()
    }
  }

  private buildMoveHeading(text: string, onBack: (() => void) | null): HTMLElement {
    const row = document.createElement('div')
    row.className = 'kbn-move-heading'
    if (onBack) {
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'kbn-move-back'
      back.setAttribute('aria-label', 'Back to destinations')
      back.textContent = '‹'
      back.addEventListener('click', (e) => {
        e.stopPropagation()
        onBack()
      })
      row.append(back)
    }
    const label = document.createElement('span')
    label.className = 'kbn-move-heading-text'
    label.textContent = text
    row.append(label)
    return row
  }

  private buildMoveItem(label: string, hint: string | undefined, onPick: () => void): HTMLElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'kbn-move-item'
    item.setAttribute('role', 'menuitem')
    const main = document.createElement('span')
    main.className = 'kbn-move-item-label'
    main.textContent = label
    item.append(main)
    if (hint) {
      const sub = document.createElement('span')
      sub.className = 'kbn-move-item-hint'
      sub.textContent = hint
      item.append(sub)
    }
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      onPick()
    })
    return item
  }

  /** Show or hide the Move control to match what the live board now offers.
   *  The destinations themselves are always computed at click time, so this is
   *  only about the control's presence. */
  private syncMoveButton(): void {
    const btn = this.moveBtn
    const card = this.card
    if (!btn || !card || !this.moves) return
    const none = this.moves.destinations(card).length === 0
    if (btn.hidden === none) return
    btn.hidden = none
    // An open menu over a card with nothing left to offer is a menu about to
    // lie; take it down with the button.
    if (none) this.dismissMoveMenu()
  }

  private dismissMoveMenu(): void {
    this.closeMoveMenu?.()
    this.closeMoveMenu = null
  }

  private buildActionBtn(
    label: string,
    variant: 'primary' | 'tempered' | 'composted',
  ): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `kbn-detail-action-btn kbn-detail-action-${variant}`
    btn.textContent = label
    return btn
  }

  /** POST one JSON body to a daemon route; the daemon answers plain text, so
   *  a !ok body is the error message verbatim. */
  private async postJson(
    path: string,
    body: Record<string, unknown>,
    label = 'Save',
  ): Promise<void> {
    const res = await fetch(`${this.shuttleBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => `${res.status}`)
      throw new Error(errText || `${label} failed: ${res.status}`)
    }
  }

  private async postLifecycle(body: Record<string, unknown>): Promise<void> {
    await this.postJson('/api/v1/lifecycle', body)
  }

  /**
   * Unified manual requeue: a single owner-routed `/api/v1/dispatch` carrying
   * the user's message and resume intent inline. `user_message` is the
   * directive text (the daemon inlines it into the prompt at launch);
   * `resume_mode` is `'fresh'` → start a new session, `'previous'` → resume the
   * prior session. The daemon resolves the session to resume from the fiber's
   * `shuttle.session_uuid` frontmatter field, falling back to fresh
   * when there's nothing to resume. `force`/`ad_hoc` launch the worker on the
   * owning host regardless of poll eligibility.
   *
   * Owner-routed by `card.originId` (`origin`), which carries the message and
   * resume_mode to the owning daemon intact cross-host.
   */
  private async runRequeue(
    card: KanbanCard,
    directive: string,
    mode: 'fresh' | 'previous',
    btn: HTMLButtonElement,
    errorEl: HTMLElement,
    skipCutConfirmation = false,
  ): Promise<void> {
    // A "New session" over a LIVE worker is a CUT: the daemon stamps the
    // clean-exit marker, kills the running session, and starts fresh — which
    // discards whatever in-flight context that worker was holding. Confirm
    // before doing that. A dormant card (no live worker) cuts nothing, so it's
    // silent; Resume never cuts, so it never confirms.
    if (mode === 'fresh' && card.runningWorker && !skipCutConfirmation) {
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

    // Single force/ad-hoc dispatch carrying the message + resume_mode inline.
    let res: Response
    try {
      // Owner-routed by `origin` in the body.
      res = await fetch(`${this.shuttleBase}/api/v1/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiber_id: card.id,
          origin: card.originId,
          force: true,
          ad_hoc: true,
          user_message: directive,
          resume_mode: mode,
        }),
      })
    } catch (err: unknown) {
      const detail = (err as { message?: string })?.message ?? String(err)
      this.showDispatchError(errorEl, btn, original, `Couldn't reach Shuttle: ${detail}`)
      return
    }

    const body = (await res.json().catch(() => ({}))) as {
      dispatched?: boolean
      reason?: string
      detail?: string
      message?: string
      error?: string
      tmux_session?: string
    }

    if (res.status === 409) {
      if (body.tmux_session) {
        this.close()
        this.onSaved()
        this.onOpenWorker?.(body.tmux_session, card.originId)
        return
      }

      btn.textContent = 'Already running'
      btn.disabled = true
      errorEl.textContent = 'A worker is already running for this fiber.'
      errorEl.style.display = ''
      return
    }

    if (!res.ok) {
      // Prefer the daemon's structured ineligibility copy (detail/message name
      // the actual host / project_dir); fall back to the generic error / status.
      const msg = (body.reason || body.detail || body.message)
        ? dispatchIneligibleReason(body)
        : (body.error ?? `Requeue failed (${res.status})`)
      this.showDispatchError(errorEl, btn, original, msg)
      return
    }

    this.close()
    this.onSaved()
    if (body.tmux_session) {
      this.onOpenWorker?.(body.tmux_session, card.originId)
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
   * (aliases filtered out), an effort select whose options come from the
   * selected agent's `effort_levels`, and a chrome toggle gated on
   * `chrome_capable`. Any axis change repopulates the dependent controls (a
   * new agent resets effort to its default and may disable chrome) and fires
   * `onCommit` with the current composition — which `commitAxes` writes
   * through the daemon's `set-agent` lifecycle action.
   */
  private async loadAgentPicker(
    controls: {
      agentSelect: HTMLSelectElement
      effortSelect: HTMLSelectElement
      chromeToggle: HTMLInputElement
    },
    current: { agent: string; effort: string; chrome: boolean },
    onCommit: (axes: { agent: string; effort: string; chrome: boolean }) => boolean | void,
  ): Promise<void> {
    const { agentSelect, effortSelect, chromeToggle } = controls
    let records: AgentRecord[]
    try {
      // The daemon's registry is a bare array (`felt shuttle agents --json`,
      // degrading to `[]` when felt is unavailable). A non-array body is
      // malformed — treat it as empty rather than trusting it.
      const res = await fetch(`${this.shuttleBase}/api/v1/agents`)
      if (!res.ok) throw new Error(`${res.status}`)
      const raw = (await res.json()) as AgentRecord[]
      records = Array.isArray(raw) ? raw : []
    } catch {
      agentSelect.innerHTML = '<option value="">Failed to load agents</option>'
      effortSelect.innerHTML = ''
      effortSelect.disabled = true
      chromeToggle.disabled = true
      return
    }

    // Base agents only — alias records are a convenience that the composing
    // picker supersedes; resolving one to its
    // base + axes belongs to the registry, not this list.
    const base = records.filter((a) => !a.alias_of)
    agentSelect.innerHTML = ''
    if (base.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No agents available'
      agentSelect.append(opt)
      effortSelect.disabled = true
      chromeToggle.disabled = true
      return
    }

    const defaultAgent = current.agent
      ? undefined
      : base.find((a) => a.default)?.id
    for (const agent of base) {
      const opt = document.createElement('option')
      opt.value = agent.id
      opt.textContent = agent.model ? `${agent.id} (${agent.model})` : agent.id
      if (agent.id === current.agent || (!current.agent && agent.id === defaultAgent)) {
        opt.selected = true
      }
      agentSelect.append(opt)
    }
    // A current agent absent from the registry stays selectable as a custom
    // entry so an unknown id isn't silently rewritten on the next edit.
    if (current.agent && !base.some((a) => a.id === current.agent)) {
      const opt = document.createElement('option')
      opt.value = current.agent
      opt.textContent = `${current.agent} (custom)`
      opt.selected = true
      agentSelect.prepend(opt)
    }

    // Repopulate effort options + chrome availability from a given agent's
    // metadata. The selected value is always concrete: an omitted/invalid
    // fiber value resolves to the agent's registry default. An agent change
    // therefore writes that new agent's explicit effective effort.
    const syncDependents = (agentId: string, effort: string): void => {
      const rec = records.find((a) => a.id === agentId)
      const levels = rec?.effort_levels ?? []
      effortSelect.innerHTML = ''
      for (const lvl of levels) {
        const opt = document.createElement('option')
        opt.value = lvl
        opt.textContent = lvl
        effortSelect.append(opt)
      }
      effortSelect.disabled = levels.length === 0
      const effectiveEffort = levels.includes(effort)
        ? effort
        : rec?.default_effort && levels.includes(rec.default_effort)
          ? rec.default_effort
          : ''
      effortSelect.value = effectiveEffort

      const chromeOk = rec?.chrome_capable ?? false
      chromeToggle.disabled = !chromeOk
      if (!chromeOk) chromeToggle.checked = false
    }

    const selectedAgent = (): string => agentSelect.value
    syncDependents(selectedAgent() || current.agent, current.effort)
    chromeToggle.checked = current.chrome && !chromeToggle.disabled

    const commit = (revertChromeTo?: boolean): void => {
      const accepted = onCommit({
        agent: selectedAgent(),
        effort: effortSelect.value,
        chrome: chromeToggle.checked,
      })
      if (accepted === false && revertChromeTo !== undefined) {
        chromeToggle.checked = revertChromeTo
      }
    }

    agentSelect.addEventListener('change', () => {
      // New agent: select and persist its concrete default effort, then
      // re-gate chrome and write the fresh composition.
      syncDependents(selectedAgent(), '')
      chromeToggle.checked = chromeToggle.checked && !chromeToggle.disabled
      commit()
    })
    effortSelect.addEventListener('change', () => commit())
    chromeToggle.addEventListener('change', () => commit(!chromeToggle.checked))
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
    axes: { agent: string; effort: string; chrome: boolean },
    statusEl: HTMLElement,
    errorEl: HTMLElement,
    onCommitted?: () => void,
  ): Promise<void> {
    if (!axes.agent) return
    const ok = await this.withSaveStatus(statusEl, errorEl, () =>
      this.postLifecycle({
        action: 'set-agent',
        origin: card.originId,
        fiber: card.id,
        agent: axes.agent,
        effort: axes.effort,
        chrome: axes.chrome,
      }),
    )
    if (ok) onCommitted?.()
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
      // Refresh the kanban so the change shows up in the grid (and in any
      // other modal that's reading the same card). The panel stays open — the
      // user may want to keep editing.
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
   * shared `filterParentCandidates` rule (the retired backend
   * `/kanban/fiber-search` semantics) per keystroke.
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
      const data = { fibers: filterParentCandidates(allFibers, q, excludeId) }

      dropdown.innerHTML = ''
      if (data.fibers.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'kbn-detail-parent-option kbn-detail-parent-empty'
        empty.textContent = q ? 'No matches' : 'No fibers available'
        dropdown.append(empty)
        dropdown.style.display = ''
        return
      }

      for (const fiber of data.fibers) {
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
   * supplies the dir or fails loudly in shuttle-ctl.
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
      saveBtn.textContent = 'Promote to shuttle'
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
          // standing → oneshot, which the old create-with-`--reshape` route
          // refused. The agent is NOT carried here; every axis change commits
          // separately through `commitAxes` → `set-agent`.
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
            await this.postLifecycle(
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
            await this.postLifecycle({
              action: 'repeat', origin, fiber: fiberId,
              // Undefined when the block carries none, which a paused install
              // permits; an arming install without one fails loudly in
              // shuttle-ctl.
              schedule, tz, model: card.shuttleAgent, project_dir: card.shuttleProjectDir,
            })
          } else {
            await this.postLifecycle({
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

/**
 * Probe a daemon-owned file using metadata only. `undefined` means the route is
 * unavailable or malformed; `missing` is a real revision so a file that is
 * created after the constitution opens can be noticed on the next tick.
 */
async function readFileRevision(
  shuttleBase: string,
  path: string,
  originId: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(fileInfoUrl(shuttleBase, path, originId), { cache: 'no-store' })
    if (!res.ok) return undefined
    const data = (await res.json()) as {
      exists?: unknown
      modified_at?: unknown
      size?: unknown
    }
    if (data.exists !== true) return 'missing'
    if (typeof data.modified_at !== 'number' || typeof data.size !== 'number') return undefined
    return `present:${data.modified_at}:${data.size}`
  } catch {
    return undefined
  }
}

/** Return the artifact path behind one inline `/file` or paper iframe. */
function artifactPath(artifact: RefreshableArtifact): string | null {
  const src = artifact.getAttribute('src')
  if (!src) return null
  try {
    const url = new URL(src, window.location.href)
    const path = url.searchParams.get('path')
    if (!path) return null
    if (url.pathname.endsWith('/file')) return path
    if (url.pathname.endsWith('/paper.html')) {
      return `${path.replace(/\/+$/, '')}/astra.yaml`
    }
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
