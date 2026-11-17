import '@ui-sdk/web/tabs'

/**
 * KanbanModal — the Desk, plus the views it tabs between.
 *
 * The Desk is six sections, Waiting on you, Working and Awaiting review as
 * columns, and Drafts, Resting and Roles & standing on a shelf below them,
 * each a list of family cards: every top-level constitution with everything
 * under it, once, in the section its members put it in (`deskOrder`). What waits
 * comes from one function (`attentionOf`), over the cards and the board's
 * answer of what waits on the human (`BoardFeed.waiting`). A card or a line
 * opens a constitution's view; acts on a constitution live in that view.
 *
 * Each card's owning daemon serves its column; the read model
 * (`KanbanReadModel.ts`) builds the cards and their thread graph from the
 * composite feed.
 */

import { announce, prepareAnnouncements } from '@ui-sdk/core'
import '../styles/type.css'
import './palette.css'
import './darkControls.css'
import { watchAppearance } from './appearance.js'
import './KanbanModal.css'
import { Workspace } from './workspace/Workspace.js'
import { Dock, type ConsoleOptions } from './workspace/Dock.js'
import { scheduleThumbnails } from './workspace/Thumbnail.js'
import { confirmWorkerStop } from './workspace/Verdicts.js'
import { constitutionAction, runAwaitsHuman, schedulePaused, scheduled } from './workspace/fiberPageState.js'
import { DeskKeyboard } from './DeskKeyboard.js'
import { clearPost } from './utils.js'
import { KeymapHelp } from './KeymapHelp.js'
import { DESK_ACTS, keyIntent, type KeyIntent } from './keymap.js'
import { daemonFetch, isDaemonBooting, postDaemonJson } from './daemonApi.js'
import { applyTerminalHost, TerminalHostReader } from './hostTerminal.js'
import { inLane } from './requestLanes.js'
import { isoDayLocal } from './civilDay.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { hasWorkerToStop } from './KanbanTypes.js'
import { KanbanSurfaceRenderer, boardCards, threadIndexFor } from './KanbanSurfaces.js'
import { deskCardKey, deskOrder, type DeskOrder } from './deskOrdering.js'
import { ThreadIndex } from './threads.js'
import { parseCompositeFeed, type CompositeFeed } from './KanbanComposite.js'
import { restPopover } from './RestPopover.js'
import { buildKanbanResponseFromComposite, withPatchedCard } from './KanbanReadModel.js'
import { type Verdict } from './workspace/Verdicts.js'
import { coarsePointer, onMobileChange } from './mobile.js'
import { shouldRunVisiblePoll } from '../runtime/PageAttention'
import { PhoneListening } from './phoneListening'
import { Voice } from './voice.js'
import type { WorkerOpener } from './conversationOpening.js'
import {
  collectCards,
  createTemporalFetchers,
  getView,
  listViews,
  createViewFallbackPage,
  keystrokeIsSpokenFor,
  type BoardViewId,
  type TemporalFetchers,
  settingsHotkey,
  blockingDialogOpen,
  type TemporalView,
  type ViewContext,
  viewFallbackKind,
} from './views/index.js'
import { FiberSends } from './fiberSends.js'
import { viewOfHash } from './workspace/route.js'
import type { DocKey } from './workspace/documents.js'

/** Who the ledger names for a rest, a pause or a resume given on the board. */
const BOARD_ACTOR = 'board'

/** How a verdict is said: its past tense, what follows the name, and its verb ("Closed “X” for review", "Couldn't close “X” for review"). */
const VERDICT_DONE: Record<Verdict, readonly [string, string, string]> = {
  tempered: ['Tempered', '', 'temper'], composted: ['Discarded', '', 'discard'], awaitingReview: ['Closed', ' for review', 'close'],
}

/** The message a thrown/rejected value carries, for a banner or an announce. */
const errText = (err: unknown): string => (err as { message?: string })?.message ?? String(err)

interface KanbanModalOptions {
  /**
   * Called when the user clicks a card's running-worker indicator. The host
   * POSTs the tmux session name to the daemon's `/api/v1/attach`, which
   * raises the matching kitty tab. No-op when there's no running worker.
   */
  onOpenWorker?: WorkerOpener
  /**
   * Called when the user clicks the Desk's `+` stash button. The host
   * (main.ts) opens the StashForm modal. Omit to hide the button (e.g.
   * read-only contexts).
   */
  onStashClick?: () => void
  /**
   * Called when the user clicks the Desk's `✶` new-idea button. The host
   * opens the CaptureForm modal — a chat-first capture that POSTs the yap to
   * Shuttle's `/api/v1/capture`, which spawns a background session that
   * crystallizes it into a fiber. Omit to hide the button.
   */
  onNewIdeaClick?: () => void
  /**
   * Called when the user asks for settings — the ⚙︎ at the right end of the
   * tab strip, or `⌘,` / `,`. The host opens the settings dialog, which reads
   * and rewrites the operator files on any host in the fleet. Omit to hide the
   * button AND disarm both hotkeys: a board with nowhere to send the gesture
   * should not swallow the keystroke.
   */
  onSettingsClick?: () => void
  /** Override the Shuttle daemon base — the kanban's data + write plane. Reads
   *  `GET /api/v1/fibers/composite`; writes POST the daemon transition/felt-edit/
   *  dispatch endpoints (dispatch carries user_message + resume_mode inline),
   *  owner-routed by `origin`. Defaults to `http://${hostname}:4000`. */
  shuttleBase?: string
  /**
   * Override the temporal views' read plane — the `activity`, `sessions` and
   * `commits` fetchers a {@link ViewContext} carries. Defaults to
   * {@link createTemporalFetchers} over `shuttleBase`. The offline harness
   * injects deterministic mocks here so the views are exercisable with no
   * daemon (see harness/harness-board.ts).
   */
  temporalFetchers?: TemporalFetchers
}

/** The Desk's own hotkey. The others come from the view registry, so a view
 *  names its own key and nothing here has to agree with it twice. */
const DESK_HOTKEY = '1'
const TABLIST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

interface KanbanScrollSnapshot {
  bodyLeft: number
  bodyTop: number
  columns: Record<string, number>
}

export class KanbanModal {
  private readonly onOpenWorker?: WorkerOpener
  private readonly openWorkerAfterGesture?: WorkerOpener
  private readonly onStashClick?: () => void
  private readonly onNewIdeaClick?: () => void
  private readonly onSettingsClick?: () => void
  private readonly shuttleBase: string
  private readonly handleDocumentKeyDown = (e: KeyboardEvent): void => this.handleKanbanKeyDown(e)

  private readonly temporal: TemporalFetchers

  private container: HTMLDivElement | null = null
  private body: HTMLDivElement | null = null
  private bannerEl: HTMLDivElement | null = null
  /** Unsubscribes the 700px-threshold watch installed in assembleChrome. */
  private stopMobileWatch: (() => void) | null = null

  /** The view tab strip — persistent chrome, built once in assembleChrome. */
  private tabsEl: HTMLElement | null = null
  /** The bar's Find: one field on every view (constitutions; the channels and their documents on Channels). */
  private findEl: HTMLInputElement | null = null
  /**
   * Wrapper around the Desk.
   * `display: contents` in CSS, so it adds a toggle handle WITHOUT adding a
   * layout box — the sections participate in `.kbn-body`'s flex column as if
   * they were its direct children. Switching to a
   * temporal view sets `display: none` here rather than rebuilding the Desk,
   * so scroll positions, drag state and column line-clamps survive a round
   * trip through another view.
   */
  private deskEl: HTMLDivElement | null = null
  /** Full-width slot the active temporal view mounts into. Hidden on Desk. */
  private viewHostEl: HTMLDivElement | null = null
  private activeViewId: BoardViewId = 'desk'
  /** The mounted view, or null on Desk / before the first response lands. */
  private activeView: TemporalView | null = null
  /** True when the most recent composite fetch failed. Drives the view
   *  host's error page — the Desk shows `renderError` for the same state,
   *  but a temporal view has no surfaces of its own to put it in. */
  private lastFetchFailed = false
  private daemonBooting = false
  private inflightFetchToken = 0
  private bannerTimer: number | null = null
  /** Lightweight auto-poll while mounted. 15s default. */
  private pollTimer: number | null = null
  private readonly pollIntervalMs = 15_000
  private lastFetchStartedAt: number | null = null
  private compositeEtag: string | null = null
  readonly phoneAudio: PhoneListening
  /**
   * How many multi-write gestures are still landing.
   *
   * A counter keeps nested writes from releasing the poll guard early.
   * The last gesture fetches an authoritative response for all of them.
   */
  private gestureDepth = 0
  private workspace: Workspace | null = null
  private readonly dock: Dock
  private readonly voice: Voice
  private deskKeyboard: DeskKeyboard | null = null
  /** The fleet's sent files: the rows' report marks, the library of documents and the family maps. */
  private readonly fiberSends: FiberSends
  private keymapHelp: KeymapHelp | null = null
  private workspaceReturnFocus: HTMLElement | null = null
  private workspaceReturnCard: { id: string; origin: string } | null = null
  private readonly surfaces: KanbanSurfaceRenderer

  private readonly handleConversationOpening = (): void => {
    if (this.lastResponse) this.render(this.lastResponse)
    this.dock.refreshConversationOpening()
  }

  constructor(options: KanbanModalOptions) {
    this.onOpenWorker = options.onOpenWorker
    // Kitty's quick-access panel hides on focus loss. If we activate it inside
    // the originating button's click handler, macOS can return focus to the
    // browser as that same gesture finishes, immediately hiding the terminal
    // again. Let the browser finish the gesture first; session selection and
    // Kitty activation then happen in the next task.
    //
    // Under a finger there is no kitty to raise: the same gesture goes to the
    // worker's session in the Claude app instead, when the feed knows its
    // address (`sessionLink`, stamped by the owning daemon), and to nothing
    // when it doesn't — never to a terminal on some other machine.
    this.openWorkerAfterGesture = this.onOpenWorker
      ? (tmuxSessionName, shuttleHost, past) => {
          if (coarsePointer()) {
            const link = this.sessionLinkFor(tmuxSessionName)
            if (link) window.location.assign(link)
            return
          }
          window.setTimeout(() => this.onOpenWorker?.(tmuxSessionName, shuttleHost, past), 0)
        }
      : undefined
    this.onStashClick = options.onStashClick
    this.onNewIdeaClick = options.onNewIdeaClick
    this.onSettingsClick = options.onSettingsClick
    this.shuttleBase = options.shuttleBase ?? `http://${window.location.hostname}:4000`
    this.temporal = options.temporalFetchers ?? createTemporalFetchers(this.shuttleBase)
    this.voice = new Voice(this.shuttleBase)
    this.phoneAudio = new PhoneListening(this.shuttleBase)
    this.voice.subscribe(() => this.phoneAudio.observe(this.voice.status))
    this.dock = this.console()
    this.fiberSends = new FiberSends(this.shuttleBase)
    this.surfaces = new KanbanSurfaceRenderer({
      waits: () => this.workspace!.board.waiting,
      openDetail: card => this.openDocumentChannel(card),
      clear: card => { void this.clear(card) },
      onStashClick: this.onStashClick,
      onNewIdeaClick: this.onNewIdeaClick,
    })
  }

  /** A console: the reader's own, or one a view beside it seats. */
  private console(options: ConsoleOptions = {}): Dock {
    return new Dock(
      this.shuttleBase,
      () => { void this.fetchAndRender() },
      // Expired verdicts enter the optimistic lifecycle path exactly once.
      (card, target) => this.transition(card, target, true),
      this.openWorkerAfterGesture,
      { voice: { controller: this.voice }, phone: this.phoneAudio, onRest: card => this.rest(card), onRelease: card => { void this.releaseQuarantine(card.shuttleHost) }, ...options },
    )
  }

  /**
   * Mount the kanban inside `host`. The host owns layout (size, position);
   * the kanban only stretches to fill it.
   *
   * Re-mount onto a different host element isn't supported (call `unmount()`
   * first); a repeat call on the same host just refetches in place.
   *
   * @param host  container element; the kanban appends a single child div.
   */
  mount(host: HTMLElement): void {
    if (this.container !== null) {
      // Already mounted — refetch in place rather than rebuilding the DOM.
      void this.fetchAndRender()
      return
    }
    watchAppearance()
    this.assembleChrome()
    this.phoneAudio.mount()
    host.append(this.container!)
    const wanted = new URLSearchParams(window.location.search).get('view') ?? viewOfHash(window.location.hash)
    if (wanted && listViews().some((v) => v.id === wanted)) this.setView(wanted as BoardViewId)
    this.keymapHelp = new KeymapHelp(
      () => this.workspace?.isActive ? 'reader' : this.activeViewId === 'desk' ? 'desk' : 'view',
    )
    this.workspace = new Workspace(this.container!, {
      sends: this.fiberSends,
      shuttleBase: this.shuttleBase,
      cards: () => boardCards(this.lastResponse),
      deskRows: () => this.workspaceCards(),
      deskPlacement: card => this.deskProjection.placements.get(deskCardKey(card)),
      threadIndex: () => threadIndexFor(this.lastResponse),
      origin: () => this.activeViewId === 'desk' ? 'Desk' : this.activeViewId === 'chronicle' ? 'Chronicle' : this.activeViewId === 'globe' ? 'Globe' : 'Channels',
      onVisibility: (active) => this.showWorkspace(active),
      onSight: card => this.voice.see(card),
      onReturnCard: card => {
        this.workspaceReturnCard = { id: card.id, origin: card.originId }
        this.workspaceReturnFocus = null
        this.deskKeyboard?.select({ uid: card.uid ?? card.id, origin: card.originId }, false)
      },
      onEscapeHome: () => this.workspace?.escapeHome(),
      onView: (view) => this.setView(view, false),
      dock: this.dock,
      console: options => this.console(options),
      find: this.findEl ?? undefined,
      focusFind: () => this.focusFind(),
      reveal: card => !!this.activeView?.reveal?.(card.uid ?? card.id, card.originId),
      onRest: card => this.rest(card),
      onExpand: (expanded) => { this.container?.classList.toggle('kbn-reader-expanded', expanded); this.placeReader() },
    })
    this.voice.onRex = ({ fiber_id: id, origin }) => {
      this.workspace?.rexAt(id, origin)
      if (!this.workspace?.isActive && (this.activeView?.followRex?.(id, origin) || this.activeView?.reveal?.(id, origin))) return
      this.workspace?.follow(id, origin)
    }
    this.voice.onOpen = ({ fiber_id: id, origin, page }) => { void this.workspace?.openFiber(id, origin, page, true) }
    // What waits on the human moves the Desk as much as the feed does; a line the board names before its record is read is read at once.
    this.stopBoard = this.workspace.board.subscribe(() => {
      if (!this.lastResponse) return
      this.readBoard(this.lastResponse, true)
      this.render(this.lastResponse)
    })
    document.addEventListener('keydown', this.handleDocumentKeyDown, true)
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('shuttle-conversation-opening-changed', this.handleConversationOpening)
    this.startPolling()
    this.voice.mount()
    void this.fetchAndRender()
  }

  /**
   * Tear down a mounted kanban. Safe to call when not mounted — no-op.
   * The host is responsible for removing the host div itself; we only own
   * the kanban's container (already a child of host).
   */
  unmount(): void {
    if (this.container === null) return
    this.stopBoard?.()
    this.stopBoard = null
    this.keymapHelp?.dispose()
    this.keymapHelp = null
    this.deskKeyboard?.dispose()
    this.deskKeyboard = null
    this.workspace?.dispose()
    this.workspace = null
    this.dock.reset()
    this.voice.dispose()
    this.phoneAudio.unmount()
    // A mounted temporal view may hold timers/listeners of its own — give it
    // its unmount() before the container (and its host) go away.
    this.activeView?.unmount()
    this.activeView = null
    this.closeRestPopover?.()
    document.removeEventListener('keydown', this.handleDocumentKeyDown, true)
    window.removeEventListener('resize', this.handleResize)
    window.removeEventListener('shuttle-conversation-opening-changed', this.handleConversationOpening)
    this.stopMobileWatch?.()
    this.stopMobileWatch = null
    if (this.resizeRaf !== null) {
      window.cancelAnimationFrame(this.resizeRaf)
      this.resizeRaf = null
    }
    this.stopPolling()
    this.container.remove()
    this.teardownState()
  }

  private resizeRaf: number | null = null
  private readonly handleResize = (): void => {
    // Debounce via RAF — resize fires rapidly.
    if (this.resizeRaf !== null) return
    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = null
      this.placeReader()
    })
  }

  // ---------------------------------------------------------------------------

  /**
   * Build the kanban DOM into `this.container`: the bar, the banner, the body
   * (Desk, view host) and the live region. There is no masthead: the page
   * begins at the bar; the body's top padding is its only top margin.
   */
  private assembleChrome(): void {
    this.container = document.createElement('div')
    this.container.className = 'kbn-modal'
    this.container.setAttribute('role', 'dialog')
    this.container.setAttribute('aria-modal', 'true')
    this.container.setAttribute('aria-label', 'Kanban')

    this.body = document.createElement('div')
    this.body.className = 'kbn-body'
    this.body.addEventListener('wheel', (e) => this.handleBodyWheel(e), { passive: false })
    this.body.addEventListener('scroll', () => this.updateBodyScrollAffordance(), { passive: true })

    // Verdict announcements ("Closed “X” for review.") go to the shared live region.
    prepareAnnouncements(document)

    // Transient error/info banner for transitions that fail.
    this.bannerEl = document.createElement('div')
    this.bannerEl.className = 'kbn-banner'
    this.bannerEl.setAttribute('role', 'alert')
    this.bannerEl.style.display = 'none'

    // The body's two permanent children: the Desk wrapper and the slot a
    // view mounts into. `render()` only ever rebuilds inside deskEl.
    this.tabsEl = this.buildViewTabs()
    this.deskEl = document.createElement('div')
    this.deskEl.className = 'kbn-desk'
    this.deskKeyboard = new DeskKeyboard(this.deskEl, address => {
      const card = boardCards(this.lastResponse).find(card => (card.uid ?? card.id) === address.uid && card.originId === address.origin)
      if (card) this.openDocumentChannel(card)
    })
    this.viewHostEl = document.createElement('div')
    this.viewHostEl.className = 'kbn-view-host'
    this.body.append(this.deskEl, this.viewHostEl)
    this.syncViewChrome()

    // The bar stands outside the body: the body goes inert under the reader,
    // and the bar stays live above it, in the same place on every view.
    this.container.append(this.tabsEl, this.bannerEl, this.body)

    // Crossing 700px changes what the Desk IS, not just how it is painted: the
    // columns become a pager under a folio strip, wired at build time, so the
    // Desk is rebuilt when the threshold is crossed.
    this.stopMobileWatch = onMobileChange(() => {
      if (this.activeViewId === 'desk' && this.lastResponse) this.render(this.lastResponse)
    })
  }

  /** Desk and Chronicle cards enter the same owner-addressed document channel. */
  private openDocumentChannel(card: KanbanCard, doc?: DocKey): void {
    if (this.activeViewId === 'desk') this.deskKeyboard?.select({ uid: card.uid ?? card.id, origin: card.originId }, false)
    this.workspaceReturnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
    this.workspaceReturnCard = { id: card.id, origin: card.originId }
    if (doc) this.workspace?.open(card, undefined, doc)
    else this.workspace?.openFromDesk(card)
  }

  /** Focus the bar's Find, where the bar carries one (the phone's bottom bar does not). */
  private focusFind(): boolean {
    const find = this.findEl
    if (!find || !find.getClientRects().length) return false
    find.focus({ preventScroll: true })
    find.select()
    return true
  }

  /** The reader starts beneath the bar, so the bar's top row is the reader's too. */
  private placeReader(): void {
    if (!this.container || !this.tabsEl) return
    const bar = this.tabsEl.getBoundingClientRect()
    this.container.style.setProperty('--kbn-bar-bottom', `${Math.max(0, Math.round(bar.bottom - this.container.getBoundingClientRect().top))}px`)
  }

  /** While the reader is open its origin's tab closes it, and says so. */
  private labelOriginTab(tab: HTMLElement, selected: boolean): void {
    const label = tab.querySelector('.kbn-viewtab-label')?.textContent ?? ''
    if (selected && this.container?.classList.contains('kbn-reader-open')) {
      tab.setAttribute('aria-label', `Close reader, back to ${label.charAt(0).toUpperCase()}${label.slice(1)}`)
    } else tab.removeAttribute('aria-label')
  }

  private showWorkspace(active: boolean): void {
    const was = this.container?.classList.contains('kbn-reader-open') ?? false
    this.container?.classList.toggle('kbn-reader-open', active)
    for (const tab of this.tabsEl?.querySelectorAll<HTMLElement>('.kbn-viewtab') ?? []) this.labelOriginTab(tab, tab.classList.contains('kbn-viewtab-active'))
    if (active) this.placeReader()
    // Find serves one view at a time: entering or leaving the reader empties it and lifts its filter.
    if (was !== active) this.workspace?.clearFind()
    // A view's previews under the reader give up their live bodies, and take them again when it closes.
    if (was !== active) scheduleThumbnails()
    if (this.body) {
      this.body.inert = active
      if (active) this.body.setAttribute('aria-hidden', 'true')
      else this.body.removeAttribute('aria-hidden')
    }
    if (active) return
    if (this.pendingDeskData && this.activeViewId === 'desk') {
      const data = this.pendingDeskData
      this.pendingDeskData = null
      this.render(data)
    }
    if (this.activeViewId !== 'desk') this.mountOrRefreshActiveView()
    else this.deskKeyboard?.refresh(true)
    if (this.activeViewId !== 'desk' || !this.workspaceReturnCard) return
    if (this.deskKeyboard?.focusSelection()) return
    const address = this.workspaceReturnCard
    const cardStillOwned = address && boardCards(this.lastResponse).some(card => card.id === address.id && card.originId === address.origin)
    const target = this.workspaceReturnFocus?.isConnected ? this.workspaceReturnFocus
      : cardStillOwned ? this.drawnDeskCardElements().find(el => el.dataset.fiberId === address.id)
      : this.tabsEl?.querySelector<HTMLElement>('[aria-selected="true"]')
    target?.focus({ preventScroll: true })
  }

  /** The current Desk rows shared by the reader's stepping and Desk lookup. */
  private workspaceCards(): KanbanCard[] {
    return this.deskProjection.rows
  }

  /** Every constitution the Desk draws, a card or a line. */
  private drawnDeskCardElements(): HTMLElement[] {
    return Array.from(this.deskEl?.querySelectorAll<HTMLElement>(
      '[data-fiber-id]',
    ) ?? [])
  }

  // ── View switching ──────────────────────────────────────────────────────────

  /**
   * The tab strip: `desk` plus one tab per registered view, left-aligned on
   * its own hairline row at the top of the page. Built once — the registry is
   * populated at import time, so the strip never needs to re-render; only the
   * selected tab's classes change.
   */
  private buildViewTabs(): HTMLElement {
    const strip = document.createElement('ui-tabs')
    strip.setAttribute('default-value', this.activeViewId)
    // Arrows select through the tablist; a press goes through the tab's own
    // click, which also reaches the selected tab (it closes the reader back to it).
    strip.addEventListener('valuechange', event => {
      if (event.detail.reason === 'list-navigation') this.setView(event.detail.value as BoardViewId)
    })
    strip.className = 'kbn-viewtabs'
    // The tabs alone are the tablist; Find, the view's centre and Settings ride the same bar beside it.
    const views = document.createElement('ui-tabs-list')
    views.className = 'kbn-viewtabs-views'
    views.setAttribute('aria-label', 'Board views')
    strip.append(views)

    const specs: Array<{ id: BoardViewId; label: string; hotkey: string }> = [
      { id: 'desk', label: 'desk', hotkey: DESK_HOTKEY },
      ...listViews().filter((view) => view.hotkey).map((view) => ({
        id: view.id as BoardViewId,
        label: view.title.toLowerCase(),
        hotkey: view.hotkey,
      })),
    ]

    for (const spec of specs) {
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'kbn-viewtab'
      tab.dataset.view = spec.id
      tab.title = `${spec.label} (${spec.hotkey})`

      const labelEl = document.createElement('span')
      labelEl.className = 'kbn-viewtab-label'
      labelEl.textContent = spec.label
      const hotkeyEl = document.createElement('span')
      hotkeyEl.className = 'kbn-viewtab-hotkey'
      hotkeyEl.textContent = spec.hotkey
      hotkeyEl.setAttribute('aria-hidden', 'true')
      tab.append(hotkeyEl, labelEl)
      tab.addEventListener('click', event => {
        // The tab of the view under the reader closes it, and that view puts the focus back where the reader was opened from; the tablist's own press would take it.
        if (this.workspace?.isActive && spec.id === this.activeViewId) event.stopImmediatePropagation()
        this.setView(spec.id)
      })
      const part = document.createElement('ui-tabs-tab')
      part.setAttribute('value', spec.id)
      part.append(tab)
      views.append(part)
    }

    // Find follows the tabs: one field every view shares.
    const find = document.createElement('label')
    find.className = 'kbn-viewtabs-find'
    this.findEl = document.createElement('input')
    this.findEl.type = 'search'
    this.findEl.placeholder = 'Find'
    this.findEl.setAttribute('aria-label', 'Find a constitution or transcript')
    // A view that filters itself by Find (Channels) takes it; elsewhere it lists constitutions.
    const serve = (): void => {
      const view = this.activeView
      this.workspace?.find(view?.find ? query => view.find?.(query) : undefined)
    }
    this.findEl.addEventListener('focus', serve)
    this.findEl.addEventListener('input', serve)
    // Escape puts Find away whole: its list, its filter and the focus.
    this.findEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault(); e.stopPropagation()
      this.workspace?.clearFind()
      this.findEl?.blur()
    })
    const findKey = document.createElement('span')
    findKey.className = 'kbn-viewtab-hotkey kbn-viewtabs-find-key'
    findKey.textContent = '/'
    findKey.setAttribute('aria-hidden', 'true')
    find.append(this.findEl, findKey)
    strip.append(find)

    // The centre always takes the room between Find and Settings, so Settings
    // never moves between views.
    const centre = document.createElement('div')
    centre.className = 'kbn-viewtabs-centre'
    strip.append(centre)

    // Settings rides the same row as the pages without being one of them. It
    // is deliberately NOT a tab: the tabs are windows onto the work, and
    // a preferences sheet is not a window onto anything — so it wears a glyph
    // rather than a name and a keycap, and sits at the row's end. On a phone the row scrolls; the CSS pins this one
    // element to the right edge, because a settings button you have to scroll
    // sideways to find is a settings button nobody finds.
    if (this.onSettingsClick) {
      const gear = document.createElement('button')
      gear.type = 'button'
      gear.className = 'kbn-viewtabs-settings'
      // U+2699 + U+FE0E keeps the gear as a text glyph rather than a colour emoji.
      gear.textContent = '⚙︎'
      gear.title = 'Settings (⌘, or ,)'
      gear.setAttribute('aria-label', 'Settings')
      gear.addEventListener('click', () => this.onSettingsClick?.())
      strip.append(gear)
    }
    return strip
  }

  /**
   * Switch the page. Idempotent — re-selecting the active view is a no-op, so
   * a stray click or repeated hotkey never tears a view down and back up.
   */
  private setView(id: BoardViewId, navigate = true, forceHome = false): void {
    if (forceHome && id === 'desk' && this.workspace?.isActive) {
      this.workspace.escapeHome()
      return
    }
    // With the reader open the bar marks the view it came from: that tab, or
    // its key, closes the reader back to it; any other switches and closes.
    if (navigate && this.workspace?.isActive && id === this.activeViewId) {
      this.workspace.returnToOrigin()
      return
    }
    if (navigate && this.workspace) this.workspace.suspend(id)
    if (id === this.activeViewId) return
    this.workspace?.clearFind()
    if (!this.workspace?.isActive) void this.workspace?.look(null)
    this.activeView?.unmount()
    this.activeView = null
    if (this.viewHostEl) this.viewHostEl.innerHTML = ''
    this.viewFallbackSig = null
    this.activeViewId = id
    this.syncViewChrome()
    // Coming home to the Desk with data that landed while it was hidden: paint
    // it NOW, after syncViewChrome has given the Desk a layout box again, so
    // the post-render measurement passes have something real to measure. This
    // is the second half of the deferral in `render` — see `pendingDeskData`.
    if (id === 'desk' && this.pendingDeskData) {
      const pending = this.pendingDeskData
      this.pendingDeskData = null
      this.render(pending)
      return
    }
    this.mountOrRefreshActiveView()
  }

  /** Paint the selected tab and show exactly one of Desk / view host. */
  private syncViewChrome(): void {
    const onDesk = this.activeViewId === 'desk'
    if (this.deskEl) {
      this.deskEl.style.display = onDesk ? '' : 'none'
    }
    if (this.viewHostEl) this.viewHostEl.style.display = onDesk ? 'none' : ''
    this.tabsEl?.setAttribute('value', this.activeViewId)
    for (const tab of this.tabsEl?.querySelectorAll<HTMLElement>('.kbn-viewtab') ?? []) {
      const selected = tab.dataset.view === this.activeViewId
      tab.classList.toggle('kbn-viewtab-active', selected)
      this.labelOriginTab(tab, selected)
    }
  }


  /**
   * Drive the active view's lifecycle from board data. Mounts on the first
   * call that has a response to give it (a view selected before the first
   * fetch lands waits here, not in a half-built state), and refreshes on every
   * call after that — including polls the Desk dedups away, since a view's
   * content also moves with the clock.
   */
  private mountOrRefreshActiveView(): void {
    if (this.activeViewId === 'desk' || !this.viewHostEl) return
    const view = getView(this.activeViewId)
    if (!view) return
    const ctx = this.viewContext()
    if (!ctx) {
      // No response to mount with. Say so on the page rather than leaving it
      // blank — see renderViewFallback.
      this.renderViewFallback(view.title)
      return
    }
    this.clearViewFallback()
    if (this.activeView !== view) {
      this.activeView = view
      view.mount(this.viewHostEl, ctx)
    } else {
      view.refresh(ctx)
    }
  }

  /**
   * Put a stand-in page in the view host when there is no response to mount a
   * view with, so a temporal tab never renders blank when the composite feed
   * is unreachable.
   *
   * Two states, because they are different facts: before the first response we
   * are WAITING, and after a failure the daemon is NOT ANSWERING and there is
   * something to retry. `viewFallbackKind` decides which. The page is rebuilt
   * only when the state changes, so the 15s poll does not thrash the DOM or
   * steal focus from the retry button while the user is aiming at it.
   */
  private renderViewFallback(title: string): void {
    if (!this.viewHostEl) return
    const kind = viewFallbackKind({
      onDesk: false,
      hasResponse: this.lastResponse !== null,
      lastFetchFailed: this.lastFetchFailed,
    })
    if (kind === 'none') return
    const signature = `${title}:${kind}:${this.daemonBooting ? 'booting' : 'offline'}`
    if (this.viewFallbackSig === signature) return
    this.viewFallbackSig = signature
    this.viewHostEl.innerHTML = ''
    this.viewHostEl.append(
      kind === 'error'
        ? createViewFallbackPage(title, {
            message: this.daemonBooting ? '— daemon is starting… —' : '— the daemon is not answering —',
            onRetry: this.daemonBooting ? undefined : () => { void this.fetchAndRender() },
          })
        : createViewFallbackPage(title, { message: '— waiting for the first response —' }),
    )
  }

  /** Drop the stand-in page (and its signature) before a real view mounts. */
  private clearViewFallback(): void {
    if (this.viewFallbackSig === null) return
    this.viewFallbackSig = null
    if (this.viewHostEl) this.viewHostEl.innerHTML = ''
  }

  /** Which fallback is currently painted, so it is not rebuilt every poll. */
  private viewFallbackSig: string | null = null

  /** The per-call context handed to a view. Null until the first response. */
  private viewContext(): ViewContext | null {
    const response = this.lastResponse
    if (!response) return null
    const cards = collectCards(response)
    return {
      response,
      cards,
      workspace: this.workspace ?? undefined,
      sends: this.fiberSends,
      shuttleBase: this.shuttleBase,
      // The fetchers ARE the context's temporal half — closures over their own
      // cache, so spreading them is the same object, not a rebind.
      ...this.temporal,
      openCard: (cardId) => {
        const card = resolveOpenTarget(cardId, cards, this.lastResponse?.cycles ?? [])
        if (card) this.openDocumentChannel(card)
      },
      requestRefresh: () => { void this.fetchAndRender() },
    }
  }

  /**
   * `⌘,` and bare `,` open settings — checked BEFORE the view hotkeys, which
   * is free (`settingsHotkey` only ever answers for `,`) and keeps the reading
   * order honest: the chord is the broader gesture.
   *
   * The two openings are guarded differently, which is the whole reason
   * `settingsHotkey` reports which one it saw. A chord is inert only under
   * another dialog, so `⌘,` still works with the caret in a search box. A bare
   * comma follows the same rule as every other bare key on this board, because
   * inside a text field it is a comma.
   *
   * Both are dead when the host gave no `onSettingsClick`: a board with
   * nowhere to send the gesture must not eat the keystroke.
   */
  private handleSettingsHotkey(e: KeyboardEvent): boolean {
    if (!this.onSettingsClick) return false
    const kind = settingsHotkey(e)
    if (!kind) return false
    if (kind === 'chord' ? blockingDialogOpen() : keystrokeIsSpokenFor()) return false
    e.preventDefault()
    e.stopPropagation()
    this.onSettingsClick()
    return true
  }

  /**
   * `1`–`4` switch views. Deliberately narrow: a bare digit only, so
   * `Cmd/Ctrl+1` stays the browser's tab switch, and only when the keystroke
   * is not going somewhere it matters — a focused text field, or a
   * dialog layered over the board. Returns true when the
   * key was consumed.
   */
  private handleViewHotkey(e: KeyboardEvent): boolean {
    const surface = this.workspace?.isActive ? 'reader' : 'desk'
    const intent = keyIntent(e, surface)
    if (intent !== 'desk' && intent !== 'chronicle' && intent !== 'globe' && intent !== 'channels') return false
    if (keystrokeIsSpokenFor()) return false
    e.preventDefault()
    e.stopPropagation()
    this.setView(intent, true, intent === 'desk')
    return true
  }

  /** Reset all field state to "not mounted." DOM removal is `unmount()`'s
   *  responsibility; this only clears references. */
  private teardownState(): void {
    this.container = null
    this.body = null
    this.bannerEl = null
    this.tabsEl = null
    this.findEl = null
    this.deskEl = null
    this.viewHostEl = null
    this.activeView = null
    this.activeViewId = 'desk'
    this.viewFallbackSig = null
    this.lastFetchFailed = false
    if (this.bannerTimer !== null) {
      window.clearTimeout(this.bannerTimer)
      this.bannerTimer = null
    }
  }

  // ── Verdicts ───────────────────────────────────────────────────────────────

  /**
   * Give a constitution a verdict: temper, discard, or close it for review.
   * A temper or a discard given here (not yet through the reader's undo
   * window) joins that window; one that comes back from it (`committed`) is
   * written. The card takes its new column at once, and the refetch that
   * follows the write reconciles it with what its owner serves.
   */
  private transition(card: KanbanCard, target: Verdict, committed = false): void {
    if (boardCards(this.lastResponse).find(each => each.id === card.id)?.column === target) {
      this.showBanner(`“${card.name}” is already ${VERDICT_DONE[target][0].toLowerCase()}${VERDICT_DONE[target][1]}.`, 'info')
      this.announce(`${card.name} is already ${VERDICT_DONE[target][0].toLowerCase()}${VERDICT_DONE[target][1]}.`)
      return
    }
    // A standing constitution has the run waiting on the human tempered (which
    // keeps the schedule) or is retired; its schedule is paused and resumed
    // with Rest, and it is never closed for review: a run's exit re-arms it.
    if (card.shuttleKind === 'standing' && target !== 'composted' && !(target === 'tempered' && runAwaitsHuman(card))) {
      this.showBanner(`“${card.name}” is a standing constitution — temper a run waiting on you (t), pause its schedule (s) or retire it (x).`, 'info')
      this.announce(`${card.name} runs on its schedule; pause or retire it instead.`)
      return
    }
    if ((target === 'tempered' || target === 'composted') && this.workspace && !committed) {
      this.workspace.queueVerdict(card, target)
      return
    }
    // A verdict stops the card's worker (commitTransition → killWorkerIfRunning).
    // In the workspace, Workspace.queueVerdict asks at gesture time and refuses
    // an expired verdict whose card gained an unconfirmed worker, so a committed
    // verdict arrives here already authorized. Without a workspace, ask now.
    if ((target === 'tempered' || target === 'composted') && !committed && !confirmWorkerStop(card, target)) {
      this.announce(`Left ${card.name} running.`)
      return
    }
    const optimistic = this.lastResponse && applyOptimisticTransition(this.lastResponse, card.id, target)
    if (optimistic) this.applyResponse(optimistic)
    void this.commitTransition(card, target)
  }

  /**
   * Network half of {@link transition}: stop the worker and write the
   * verdict through the daemon, then reconcile against server truth. On
   * failure it banners and the trailing refetch puts the card back where its
   * owner has it.
   */
  private async commitTransition(card: KanbanCard, target: Verdict): Promise<void> {
    // Held across the writes: a poll would otherwise erase the optimistic placement.
    this.gestureDepth += 1
    try {
      await this.killWorkerIfRunning(card)
      await postDaemonJson(this.shuttleBase, '/api/v1/transition', { fiber_id: card.id, target, origin: card.originId }, 'Transition failed')
      this.announce(target === 'tempered' && card.shuttleKind === 'standing'
        ? `Tempered the run of “${card.name}”; it runs again at its next scheduled time.`
        : `${VERDICT_DONE[target][0]} “${card.name}”${VERDICT_DONE[target][1]}.`)
    } catch (err: unknown) {
      const msg = errText(err)
      this.showBanner(`Couldn't ${VERDICT_DONE[target][2]} “${card.name}”${VERDICT_DONE[target][1]}: ${msg}`, 'error')
      this.announce(`Couldn't ${VERDICT_DONE[target][2]} ${card.name}${VERDICT_DONE[target][1]}: ${msg}`)
    }
    this.gestureDepth -= 1
    await this.fetchAndRender()
  }

  /** A waiting post's ✓: the board clears it, offering to undo for a few seconds, and says so if the daemon refuses. */
  private async clear(card: KanbanCard): Promise<void> {
    try {
      await clearPost(this.workspace!.board, card.uid ?? card.id, card.name)
    } catch (err: unknown) {
      this.showBanner(`Couldn't clear “${card.name}”'s post: ${errText(err)}`, 'error')
    }
  }

  private announce(msg: string): void {
    if (this.container) announce(msg)
  }

  private showBanner(text: string, kind: 'error' | 'info' = 'info'): void {
    if (!this.bannerEl) return
    this.bannerEl.textContent = text
    this.bannerEl.style.display = ''
    this.bannerEl.classList.toggle('kbn-banner-error', kind === 'error')
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer)
    // Errors carry the daemon's full message (often a sentence or two), so
    // they linger long enough to read; info confirmations clear quickly.
    this.bannerTimer = window.setTimeout(() => {
      if (this.bannerEl) this.bannerEl.style.display = 'none'
      this.bannerTimer = null
    }, kind === 'error' ? 12000 : 5000)
  }

  /** The claude.ai address of the live worker running as `tmux`, if the last
   * feed carried one — the phone's substitute for "open the terminal". */
  private sessionLinkFor(tmux: string): string | undefined {
    return boardCards(this.lastResponse).find((c) => c.tmuxSession === tmux)?.sessionLink
  }

  /**
   * Adopt a response as the current rendered state without a fetch — the
   * optimistic-update path. Bumps `inflightFetchToken` so any fetch already
   * in flight (a 15s poll, a prior reconcile) can't clobber this when it
   * resolves; the next `fetchAndRender` reconcile owns the authoritative
   * settle. Sets `lastResponseSig` so a reconcile that agrees dedups to a
   * no-op re-render.
   */
  private applyResponse(data: KanbanResponse): void {
    ++this.inflightFetchToken
    // The validator describes the server copy, not this optimistic render.
    this.compositeEtag = null
    this.lastResponse = data
    this.lastResponseSig = this.computeResponseSignature(data)
    this.render(data)
  }

  private async fetchAndRender(): Promise<void> {
    if (this.gestureDepth > 0) return
    this.terminalHost.refresh()
    this.lastFetchStartedAt = Date.now()
    const token = ++this.inflightFetchToken
    try {
      const headers = new Headers()
      if (this.compositeEtag) headers.set('If-None-Match', this.compositeEtag)
      const res = await daemonFetch(`${this.shuttleBase}/api/v1/fibers/composite`, { headers })
      if (token !== this.inflightFetchToken) return
      if (res.status === 304) {
        if (this.lastFeed) this.presentUnchanged(this.lastFeed)
        return
      }
      if (!res.ok) {
        this.markFetchFailed(`Server returned ${res.status}`)
        return
      }
      // The kanban reads Shuttle's loom-wide composite feed and classifies it
      // frontend-side — the sole classifier. `parseCompositeFeed` validates
      // the wire shape; `buildKanbanResponseFromComposite` collects → classifies
      // → assembles the exact `KanbanResponse` the renderer already consumes.
      this.compositeEtag = res.headers.get('ETag')
      const feed = parseCompositeFeed(await res.json())
      if (token !== this.inflightFetchToken) return
      this.presentFeed(feed)
    } catch (err: unknown) {
      if (token !== this.inflightFetchToken) return
      if (isDaemonBooting(err)) {
        this.markDaemonBooting()
      } else {
        this.markFetchFailed(errText(err))
      }
    }
  }

  /** Classify and draw a parsed feed; the last one is kept so the hub's terminal can be applied when learned. */
  private presentFeed(feed: CompositeFeed): void {
    this.lastFeed = feed
    applyTerminalHost(feed.entries, this.terminalHost.current)
    const data = buildKanbanResponseFromComposite(feed)
    // Skip re-render when the response is semantically unchanged —
    // every 15-second poll otherwise tears down ~50 cards × ~30 nodes
    // each just to rebuild them identically. Hash the meaningful
    // payload (columns + totals + staleness); `generatedAt` flickers each
    // poll even on no-op refreshes.
    // A response landed: clear any error page the views were showing.
    this.lastFetchFailed = false
    this.daemonBooting = false
    const sig = this.computeResponseSignature(data)
    const wasFirstRender = this.lastResponse === null
    this.lastResponse = data
    if (!wasFirstRender && sig === this.lastResponseSig) {
      this.refreshUnchanged(data)
      return
    }
    this.readBoard(data)
    this.lastResponseSig = sig
    this.render(data)
  }

  /**
   * A 304: the feed is the one already classified, so the poll neither
   * classifies nor fingerprints it again. Classification reads the clock only
   * for due-day promotion, so a new local civil day reclassifies, as does a
   * page showing a failure, whose redraw needs the signature back.
   */
  private presentUnchanged(feed: CompositeFeed): void {
    const data = this.lastResponse
    if (!data || this.lastResponseSig === null || isoDayLocal(Date.now()) !== isoDayLocal(data.generatedAt)) {
      this.presentFeed(feed)
      return
    }
    this.lastFetchFailed = false
    this.daemonBooting = false
    this.refreshUnchanged(data)
  }

  /**
   * A poll whose board is the one drawn: the Desk stays, but what waits on the
   * human is read again, and the workspace and a temporal view still get the
   * poll, since their content moves with the clock and the ledgers, not only
   * with the fiber feed.
   */
  private refreshUnchanged(data: KanbanResponse): void {
    this.readBoard(data)
    this.syncWorkspaceRuntime()
    this.mountOrRefreshActiveView()
  }

  /**
   * Asks the board what waits on the human, once a poll: the families of
   * everything that waits, for what each wants, and with nothing waiting one
   * family, whose answer speaks for the whole board. `unread` asks only the
   * families of lines whose records are not read yet.
   */
  private readBoard(data: KanbanResponse, unread = false): void {
    const board = this.workspace!.board, index = threadIndexFor(data), families = new Set<string>()
    for (const [uid, wait] of board.waiting) {
      const card = index.fiber(uid)
      if (card && !(unread && wait.kind)) { const root = index.rootOf(card); families.add(root.uid ?? root.id) }
    }
    const first = index.roots().find(root => !root.isCycle)
    if (!unread && !families.size && first) families.add(first.uid ?? first.id)
    if (families.size) board.read(families)
  }

  private computeResponseSignature(data: KanbanResponse): string {
    // Every surface the Desk draws from, and staleness (stale-origin cards dim
    // and disable drag even when the card lists are unchanged); not the clock
    // stamp, which moves on every poll, nor `totals`, a derivation of the rest.
    const { generatedAt: _clock, totals: _derived, ...drawn } = data
    return JSON.stringify(drawn)
  }

  private renderError(msg: string): void {
    // Into the Desk, not the body — the tab strip stays reachable so a failed
    // load doesn't strand the user on a page they can't leave.
    if (!this.deskEl) return
    // Painting an error means the Desk is no longer showing `lastResponse`, so
    // the dedup signature is now a claim about DOM that doesn't exist. Drop it,
    // or a transient 500 sticks: the next poll succeeds with a byte-identical
    // payload, agrees with the stale signature, skips the re-render, and leaves
    // "Failed to load kanban" on screen until the fiber feed happens to change
    // — minutes on a quiet board, and a manual refresh can't clear it either
    // (it goes through the same dedup). `lastResponse` is deliberately kept:
    // the temporal views read it through `viewContext`, so they keep working
    // through the outage.
    this.lastResponseSig = null
    this.deskEl.innerHTML = ''
    const errEl = document.createElement('div')
    errEl.className = 'kbn-error'
    const text = document.createElement('span')
    text.textContent = `Failed to load kanban: ${msg}`
    // The error branch replaces the whole Desk, and the board's only refresh
    // control lives in a column head that is not on screen — so the error
    // carries its own. (The poll recovers on its own, since the error clears
    // the dedup signature, but waiting up to 15s without a button is
    // indistinguishable from being stuck.)
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'kbn-error-retry'
    retry.textContent = '↻ retry'
    retry.addEventListener('click', () => {
      retry.disabled = true
      retry.textContent = '↻ retrying…'
      void this.fetchAndRender()
    })
    errEl.append(text, retry)
    this.deskEl.append(errEl)
  }

  /** Record that the daemon is still booting, on whichever page is up. */
  private markDaemonBooting(): void {
    this.lastFetchFailed = true
    this.daemonBooting = true
    this.renderBooting()
    this.renderActiveViewFallback()
  }

  private renderBooting(): void {
    if (!this.deskEl) return
    this.lastResponseSig = null
    this.deskEl.innerHTML = ''
    const state = document.createElement('div')
    state.className = 'kbn-error kbn-booting'
    state.textContent = 'daemon is starting…'
    this.deskEl.append(state)
  }

  /** Record a failed fetch and show it on whichever page is up. */
  private markFetchFailed(msg: string): void {
    this.lastFetchFailed = true
    this.daemonBooting = false
    this.renderError(msg)
    this.renderActiveViewFallback()
  }

  /** The Desk shows a failure in its own surfaces; a temporal view has none,
   *  so it gets the fallback page rather than a blank host. */
  private renderActiveViewFallback(): void {
    if (this.activeViewId === 'desk') return
    const view = getView(this.activeViewId)
    if (view) this.renderViewFallback(view.title)
  }

  /** Refresh inline worker controls and the reader's worker pill without replacing documents. */
  private syncWorkspaceRuntime(): void {
    this.workspace?.update()
  }

  private render(data: KanbanResponse): void {
    if (!this.body || !this.deskEl) return
    const index = threadIndexFor(data)
    const order = deskOrder(index, this.workspace!.board.waiting)
    this.deskProjection = order
    this.syncWorkspaceRuntime()
    if (this.workspace?.isActive) {
      this.lastResponse = data
      this.pendingDeskData = data
      return
    }

    // Never rebuild the Desk while it is hidden behind a temporal view: the
    // passes at the end of this method MEASURE, and a `display:none` subtree
    // has no layout box. The payload is held, and the Desk that comes back is
    // the one the user left, repainted from fresh data.
    if (this.activeViewId !== 'desk') {
      this.lastResponse = data
      this.mountOrRefreshActiveView()
      this.pendingDeskData = data
      return
    }
    this.pendingDeskData = null

    const scrollSnapshot = this.captureScrollSnapshot()
    const focusedRow = this.deskKeyboard?.focusedRow() ?? null
    this.deskEl.innerHTML = ''
    this.body.classList.remove('kbn-body-zoomed')
    this.deskEl.append(this.surfaces.renderDesk(order, index))

    this.restoreScrollSnapshot(scrollSnapshot)
    // A redraw repaints the selection in place: the Desk scrolls only when the
    // selection moves, never under a pointer on its way to another card.
    this.deskKeyboard?.refresh()
    this.deskKeyboard?.refocus(focusedRow)
    void this.fiberSends.refresh()
    this.updateBodyScrollAffordance()
    window.requestAnimationFrame(() => this.updateBodyScrollAffordance())
    this.lastResponse = data
    // A temporal view is fed by the same data the Desk just rebuilt from —
    // including optimistic re-renders, which never reach fetchAndRender.
    this.mountOrRefreshActiveView()
  }

  private captureScrollSnapshot(): KanbanScrollSnapshot | null {
    if (!this.body) return null
    const columns: Record<string, number> = {}
    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col[data-column]')) {
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      if (list) columns[col.dataset.column!] = list.scrollTop
    }
    return { bodyLeft: this.body.scrollLeft, bodyTop: this.body.scrollTop, columns }
  }

  private restoreScrollSnapshot(snapshot: KanbanScrollSnapshot | null): void {
    if (!this.body || !snapshot) return
    const restore = (): void => {
      if (!this.body) return
      this.body.scrollLeft = snapshot.bodyLeft
      this.body.scrollTop = snapshot.bodyTop
      for (const [column, scrollTop] of Object.entries(snapshot.columns)) {
        const list = this.body.querySelector<HTMLElement>(`.kbn-col[data-column="${column}"] .kbn-col-list`)
        if (list) list.scrollTop = scrollTop
      }
      this.updateBodyScrollAffordance()
    }
    restore()
    window.requestAnimationFrame(restore)
  }

  private lastResponse: KanbanResponse | null = null
  private deskProjection: DeskOrder = deskOrder(new ThreadIndex([]), new Map())
  /** Lets go of the board's what-waits feed on unmount. */
  private stopBoard: (() => void) | null = null
  /** The last parsed composite feed, redrawn when the hub's terminal is learned. */
  private lastFeed: CompositeFeed | null = null
  /** The hub's terminal backs runtimes that report none; learning it redraws the last feed. */
  private readonly terminalHost = new TerminalHostReader(
    () => inLane('quiet', () => daemonFetch(`${this.shuttleBase}/api/v1/version`)),
    () => { if (this.lastFeed && !this.lastFetchFailed) this.presentFeed(this.lastFeed) },
  )
  /**
   * A response that arrived while a temporal view was up, waiting for the Desk
   * to be visible again. The Desk is `display:none` behind a view, and every
   * post-render pass in `render` measures a layout box that doesn't exist
   * there, so the rebuild is deferred rather than thrown away. `setView`
   * replays it the moment the Desk comes back; null means the standing Desk
   * DOM is already current.
   */
  private pendingDeskData: KanbanResponse | null = null
  /**
   * Signature of the last-rendered response (columns + totals only). Lets
   * fetchAndRender skip identical-payload re-renders — the 15-second poll
   * fires even when nothing changed and rebuilding the column DOM is the
   * dominant frontend cost.
   */
  private lastResponseSig: string | null = null

  // ── URL + chrome helpers ───────────────────────────────────────────────────

  /**
   * Release the boot quarantine on a held card's owning host — the `⏹︎ held` →
   * `▶ release` click. Release is global per daemon: a restart parks every
   * fresh launch on that host, and this one call frees them all (idempotent).
   * Owner-routed by `origin` so a remote-owned card releases its own host's
   * daemon, not the board's. On success the parked set drops and the next poll
   * clears the held badges; refetch immediately so it reads freed without the
   * ~15s poll wait.
   */
  private async releaseQuarantine(shuttleHost?: string): Promise<void> {
    try {
      await postDaemonJson(this.shuttleBase, '/api/v1/quarantine/release', { origin: shuttleHost }, 'release failed')
      this.announce(`Released held launches${shuttleHost ? ` on ${shuttleHost}` : ''}; dispatch resumes on the next tick.`)
      await this.fetchAndRender()
    } catch (err: unknown) {
      const msg = errText(err)
      this.showBanner(`Couldn't release the hold${shuttleHost ? ` on ${shuttleHost}` : ''}: ${msg}`, 'error')
    }
  }

  /**
   * Stop a card's live worker before a drag relocates it. The board's invariant:
   * a worker is alive only while its card sits in the in-flight column — dragging
   * it anywhere else (close, pin, stash, defer) is an explicit "stop this." The
   * kill is owner-routed (the owning daemon SIGKILLs its own tmux session) and
   * synchronous, so the card reads not-running on the next refetch instead of
   * lingering ~15s until the liveness watcher notices. The kill writes no
   * lifecycle verdict — the drag's column write that follows is the sole status
   * authority. No-op for a card with no live worker. Best-effort: a failed kill
   * banners but never blocks the column write (a surviving worker is the
   * pre-existing behavior, not a new failure).
   *
   * Routed by `shuttleHost`, not `originId`: the worker runs on the fiber's
   * OWNING host, while `originId` names whichever mirror of a git-synced store
   * won the document (usually this laptop). Only the owner can
   * `tmux kill-session` it, so a mirror-routed kill is a silent no-op.
   */
  private async killWorkerIfRunning(card: KanbanCard): Promise<void> {
    if (!hasWorkerToStop(card)) return
    try {
      await postDaemonJson(this.shuttleBase,
        '/api/v1/kill',
        { fiber_id: card.id, origin: card.shuttleHost ?? card.originId },
        'kill failed',
      )
    } catch (err: unknown) {
      const msg = errText(err)
      this.showBanner(`Couldn't stop the worker for “${card.name}”: ${msg}`, 'error')
    }
  }

  /** Lightweight auto-poll while mounted. 15s interval. */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => {
      if (this.gestureDepth > 0) return
      // Hidden tabs stop polling; visible but unfocused tiled windows slow
      // down to the shared page-attention cadence.
      if (!shouldRunVisiblePoll(this.lastFetchStartedAt, Date.now(), this.pollIntervalMs)) return
      void this.fetchAndRender()
    }, this.pollIntervalMs)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * Shift+vertical wheel pans horizontally only if a scoped viewport ever
   * overflows sideways. Ordinary vertical wheel events stay native so row and
   * cell scrolling do not fight trackpads.
   */
  private handleBodyWheel(e: WheelEvent): void {
    if (!this.body || this.body.classList.contains('kbn-body-zoomed')) return
    if (this.body.scrollWidth <= this.body.clientWidth) return
    if (!e.shiftKey) return

    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
    if (e.deltaY === 0) return

    e.preventDefault()
    this.body.scrollLeft += e.deltaY
    this.updateBodyScrollAffordance()
  }

  private closeRestPopover?: () => void

  /**
   * The Rest verb. On a constitution with a schedule (a standing one's cron, a
   * seat's pulse) Rest is the schedule's: it pauses an armed schedule at once,
   * with no wake day (only a resume brings it back), and resumes a paused one,
   * which next fires at its schedule's next tick. Anything else rests until a
   * day the popover asks for, or none.
   */
  private rest(card: KanbanCard): void {
    if (scheduled(card)) { void this.toggleSchedule(card); return }
    this.closeRestPopover?.()
    this.closeRestPopover = restPopover(card, async until => {
      try {
        await postDaemonJson(this.shuttleBase, '/api/v1/lifecycle', {
          action: 'rest', fiber: card.id, origin: card.originId, until, actor: BOARD_ACTOR,
        }, 'Rest failed')
        await this.fetchAndRender()
      } catch (error) {
        this.showBanner(`Rest failed: ${errText(error)}`, 'error')
      }
    })
  }

  private async toggleSchedule(card: KanbanCard): Promise<void> {
    const resume = schedulePaused(card)
    const verb = resume ? 'Resume schedule' : 'Pause schedule'
    try {
      await postDaemonJson(this.shuttleBase, '/api/v1/lifecycle', {
        action: resume ? 'resume' : 'rest', fiber: card.id, origin: card.originId, actor: BOARD_ACTOR,
      }, `${verb} failed`)
      this.announce(resume ? `Resumed “${card.name}”'s schedule.` : `Paused “${card.name}”'s schedule.`)
    } catch (error) {
      this.showBanner(`${verb} failed: ${errText(error)}`, 'error')
    }
    await this.fetchAndRender()
  }

  private handleKanbanKeyDown(e: KeyboardEvent): void {
    // A dialog layered over the board owns every key, Tab and Escape included.
    if (!this.body || blockingDialogOpen()) return
    // The view keys work from the reader too: 1 or 2 parks it, 3 comes back to it.
    if (this.workspace?.isActive) { this.handleViewHotkey(e); return }
    const nativeControl = (e.target as HTMLElement | null)?.closest?.('button, a, [role="button"], [role="tab"]')
    if (this.handleSettingsHotkey(e)) return
    if (this.handleViewHotkey(e)) return
    // A tablist's arrows, Home and End are its own (the view strip, the phone folio), not the active view's.
    if (TABLIST_KEYS.has(e.key) && (e.target as HTMLElement | null)?.closest?.('[role="tablist"]')) return
    if (this.activeView?.keydown?.(e)) { e.preventDefault(); e.stopPropagation(); return }
    // Chronicle keeps its own record search in its head; `/` reaches the bar's Find there too, as on the Globe and Channels.
    if ((this.activeViewId === 'chronicle' || this.activeViewId === 'globe' || this.activeViewId === 'channels') && !keystrokeIsSpokenFor() && keyIntent(e, 'desk') === 'find' && this.focusFind()) {
      e.preventDefault(); e.stopPropagation()
      return
    }
    if (this.activeViewId === 'desk' && !keystrokeIsSpokenFor()) {
      const intent = keyIntent(e, 'desk')
      if (intent === 'find') {
        // The bar's Find serves every view; the phone, which has none in its bar, finds a constitution.
        if (!this.focusFind()) this.workspace?.findConstitution()
        e.preventDefault(); e.stopPropagation()
        return
      }
      const nativeActivation = e.key === 'Enter' && nativeControl
      if (intent && !nativeActivation && this.deskKeyboard?.handle(intent)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (intent && DESK_ACTS.includes(intent) && this.actOnDeskSelection(intent)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
  }

  /**
   * A verdict or Rest key on the Desk acts on the selected card or line alone,
   * the row drawn as selected (a family card names its top-level, a line its
   * member), never on what the pointer is over or the voice target. A verdict
   * waits out the same undo window as the reader's; Rest opens its popover.
   */
  private actOnDeskSelection(intent: KeyIntent): boolean {
    const address = this.deskKeyboard?.selection
    if (!address || !this.deskKeyboard?.selectedRow) return false
    const card = boardCards(this.lastResponse).find(card => (card.uid ?? card.id) === address.uid && card.originId === address.origin)
    return constitutionAction(intent, card, {
      verdict: (card, verdict) => { this.workspace?.queueVerdict(card, verdict) },
      conversation: () => {},
      rest: card => this.rest(card),
    })
  }

  private updateBodyScrollAffordance(): void {
    if (!this.body) return
    if (this.body.classList.contains('kbn-body-zoomed')) {
      this.body.classList.remove('kbn-can-scroll-left', 'kbn-can-scroll-right')
      return
    }

    const maxScrollLeft = this.body.scrollWidth - this.body.clientWidth
    this.body.classList.toggle('kbn-can-scroll-left', this.body.scrollLeft > 1)
    this.body.classList.toggle('kbn-can-scroll-right', this.body.scrollLeft < maxScrollLeft - 1)
  }

}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the card an `openCard(id)` names, across BOTH places a view can get
 * an id from: the work surfaces, and the cycles.
 *
 * Cycles are searched second and separately rather than being folded into
 * `collectCards`, because the two lists answer different questions. `ctx.cards`
 * is what a view ITERATES — due-marks, lanes, counts — and a cycle's `due` is a
 * span's closing edge, not a deadline, so a cycle in that list draws a mark
 * that means the wrong thing. What a view can OPEN is a wider set than what it
 * iterates, and this is where that widens.
 *
 * The warning is part of the contract, not debug leftovers. A lookup that
 * returned quietly on a miss would make a dead click indistinguishable from a
 * working one; a no-op that says nothing is its own defect class, so an
 * unresolvable id announces itself.
 *
 * Exported for tests, alongside the optimistic-relocation helpers below.
 */
export function resolveOpenTarget(
  cardId: string,
  cards: readonly KanbanCard[],
  cycles: readonly KanbanCard[],
): KanbanCard | null {
  const card = cards.find((c) => c.id === cardId) ?? cycles.find((c) => c.id === cardId)
  if (card) return card
  console.warn(`[kanban] openCard: no card, and no cycle, with id "${cardId}"`)
  return null
}

/**
 * A verdict painted before its write lands, as a fresh KanbanResponse (the
 * input is never mutated): the card takes the column its owner will serve,
 * closed and with its worker stopped. Null when the card is not in `resp`, or
 * for a standing run tempered, which stays armed on its schedule and is
 * placed by the refetch.
 */
export function applyOptimisticTransition(resp: KanbanResponse, cardId: string, target: Verdict): KanbanResponse | null {
  const card = boardCards(resp).find(each => each.id === cardId)
  if (!card || (target === 'tempered' && card.shuttleKind === 'standing')) return null
  return withPatchedCard(resp, cardId, () => ({
    column: target,
    status: 'closed',
    tempered: target === 'awaitingReview' ? undefined : target === 'tempered',
    closedAt: card.closedAt ?? new Date().toISOString(),
    workerState: undefined,
    tmuxSession: undefined,
    runtimePhase: undefined,
    turn: 'none',
  }))
}
