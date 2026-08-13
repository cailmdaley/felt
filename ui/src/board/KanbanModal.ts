/**
 * KanbanModal — the Desk, plus the chronological views it tabs between.
 *
 * The Desk, top to bottom:
 *
 *   Now     — three lifecycle columns (Drafts | In flight | Awaiting review).
 *             The dense workflow board for what is actively being worked.
 *   Pinned  — a slim launcher band of at-rest `kind:pinned` umbrella roles.
 *   Resting — deliberately paused work, clustered on the containment path's
 *             first meaningful project token. Held-open clusters (cold:true)
 *             sit below warm ones in a dimmer style. Stored as
 *             `horizon: stashed`; "Resting" is the human name.
 *
 * TIME IS NOT A DESK SURFACE. A permanent day-ribbon used to sit above Now,
 * showing past landings and future-dated work on one scrollable axis. The
 * chronicle / week / day views tell that story better, so the ribbon's display
 * job retired and Pinned + Resting inherited its vertical room. What the ribbon
 * uniquely OWNED was the gesture — "this one on Tuesday" — so the day axis
 * survives as the drag-reveal horizon: a slim row of future days that appears
 * under the tab strip while a card is in the air and vanishes on drop. See
 * `syncDragHorizon` here and `renderDragHorizon` in KanbanSurfaces.
 *
 * Interaction:
 *   • Drag a card onto a day in the drag horizon → schedule or snooze, decided
 *     by where the card sits (`dayDropHorizon`): a desk or resting card gets
 *     `due` + `horizon: stashed` (snooze); anything else just gets `due`.
 *   • Drag onto today → onto the desk now (due cleared).
 *   • Drag into Resting → horizon=stashed, dateless.
 *   • Drag back up to the now-board → clear horizon/cold.
 *   • Drop on a now-board column header routes through the daemon's
 *     /api/v1/transition lifecycle path.
 *   • Click a card body to open its detail modal.
 *
 * Classification happens once, frontend-side: `classifyFiber` in
 * `KanbanRules.ts` buckets the composite feed into surfaces. The drag handler's
 * only knob is which surface command plus due/cold tuple to POST.
 */

import './KanbanModal.css'
import { FiberDetailModal } from './FiberDetailModal.js'
import type {
  ColumnKind,
  HorizonKind,
  KanbanCard,
  KanbanResponse,
} from './KanbanTypes.js'
import { dispatchIneligibleReason, errorMessageFromResponse, isAgentCard } from './KanbanModalShared.js'
import { COLUMN_TITLES, KanbanSurfaceRenderer, SURFACE_TITLE, findCardColumn } from './KanbanSurfaces.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite, deriveCycleLens, restingCards } from './KanbanReadModel.js'
import {
  KANBAN_TIMELINE_WINDOW,
  nextStandingLaunch,
  STANDING_TIMELINE_HORIZON_MS,
} from './KanbanRules.js'
import { sameCivilDue } from './civilDay.js'
import { shouldRunVisiblePoll } from '../runtime/PageAttention'
import {
  collectCards,
  createTemporalFetchers,
  getView,
  listViews,
  createViewFallbackPage,
  keystrokeIsSpokenFor,
  normalizeFocusDate,
  type BoardViewId,
  type TemporalFetchers,
  type TemporalView,
  type ViewContext,
  viewFallbackKind,
} from './views/index.js'

// (Action-button helpers removed — drag is the only transition surface for
// now. The DnD drop handler reads `target` from the column the card lands
// on, no per-card mapping needed. Re-introduce TRANSITIONS_FROM if a
// keyboard / context-menu path returns later.)

interface KanbanModalOptions {
  /**
   * Called when the user clicks a card's running-worker indicator. The host
   * resolves the tmux session name to a portolan session id and focuses that
   * kitty tab. No-op when the running tmux session isn't tracked by portolan.
   */
  onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  /**
   * Called when the user clicks the header's `+` stash button. The host
   * (KanbanHost in src/vellum/mount.tsx) opens the StashForm modal. Mirrors
   * the `n` hotkey path so keyboard and mouse converge on the same affordance.
   * Omit to hide the button (e.g. read-only contexts).
   */
  onStashClick?: () => void
  /**
   * Called when the user clicks the header's `✶` new-idea button. The host
   * opens the CaptureForm modal — a chat-first capture that POSTs the yap to
   * Shuttle's `/api/v1/capture`, which spawns a background session that
   * crystallizes it into a fiber. Omit to hide the button.
   */
  onNewIdeaClick?: () => void
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

/** The Desk's own hotkey. The other three come from the view registry, so a
 *  view names its own key and nothing here has to agree with it twice. */
const DESK_HOTKEY = '1'

interface KanbanScrollSnapshot {
  bodyLeft: number
  bodyTop: number
  columns: Partial<Record<ColumnKind, number>>
}

export class KanbanModal {
  private readonly onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly openWorkerAfterGesture?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly onStashClick?: () => void
  private readonly onNewIdeaClick?: () => void
  private readonly shuttleBase: string
  private readonly handleDocumentKeyDown = (e: KeyboardEvent): void => this.handleKanbanKeyDown(e)

  private readonly temporal: TemporalFetchers

  private container: HTMLDivElement | null = null
  private body: HTMLDivElement | null = null
  private liveEl: HTMLDivElement | null = null
  private bannerEl: HTMLDivElement | null = null
  /** The view tab strip — persistent chrome, built once in assembleChrome. */
  private tabsEl: HTMLDivElement | null = null
  /**
   * Wrapper around the four Desk surfaces (ribbon + Now + Pinned + Stash).
   * `display: contents` in CSS, so it adds a toggle handle WITHOUT adding a
   * layout box — the sections keep participating in `.kbn-body`'s flex column
   * exactly as they did when they were its direct children. Switching to a
   * temporal view sets `display: none` here rather than rebuilding the Desk,
   * so scroll positions, drag state and column line-clamps survive a round
   * trip through another view.
   */
  private deskEl: HTMLDivElement | null = null
  /**
   * Host for the drag-reveal horizon — the slim row of future days that stands
   * in for the retired Timeline ribbon. Empty and zero-height at rest; filled
   * and expanded for exactly as long as a card is in the air. It sits OUTSIDE
   * `deskEl` so a board re-render (a poll landing mid-drag) can't tear the drop
   * target out from under the cursor.
   */
  private dragHorizonEl: HTMLDivElement | null = null
  /** Full-width slot the active temporal view mounts into. Hidden on Desk. */
  private viewHostEl: HTMLDivElement | null = null
  private activeViewId: BoardViewId = 'desk'
  /** The mounted view, or null on Desk / before the first response lands. */
  private activeView: TemporalView | null = null
  /**
   * The shared temporal cursor — one bare civil day (`YYYY-MM-DD`) across all
   * views, or null for today/current. Held here rather than in any view so it
   * SURVIVES a tab switch: page Day back to Tuesday, press `4`, and Week opens
   * on Tuesday's week. Read into every ViewContext, so a view sees it on mount
   * and on every refresh. Reset to null on unmount, with the rest of the
   * chrome state.
   */
  private focusDate: string | null = null
  /**
   * The cycle the Desk is currently seen through, or null for the plain Desk.
   * VIEW-LOCAL on purpose: never persisted, never sent anywhere, and dropped on
   * unmount. "Which chapter was I squinting at" is a posture of the moment, not
   * a fact about the board, and a lens that survived a reload would be a filter
   * you forgot you set. One at a time — this is a single id, so engaging a
   * second chip releases the first.
   */
  private lensCycleId: string | null = null
  /** True when the most recent composite fetch failed. Drives the view
   *  host's error page — the Desk shows `renderError` for the same state,
   *  but a temporal view has no surfaces of its own to put it in. */
  private lastFetchFailed = false
  private inflightFetchToken = 0
  /**
   * Backing field for `dragSourceId`. Mutate via the property accessor below
   * (or via `setDragSource`) so drag state stays in sync everywhere it shows:
   * the `kbn-dragging` body class, and the drag-reveal horizon.
   *
   * This setter is the single choke point for "a drag is in progress" — every
   * surface starts its drags through `installDraggable` and every drop ends
   * them through `setDragSourceId(null)` — which is exactly why the horizon
   * hangs off it rather than off per-surface handlers.
   */
  private _dragSourceId: string | null = null
  private get dragSourceId(): string | null { return this._dragSourceId }
  private set dragSourceId(value: string | null) {
    this._dragSourceId = value
    if (this.body) this.body.classList.toggle('kbn-dragging', value !== null)
    this.syncDragHorizon(value !== null)
  }
  private dragAutoScrollFrame: number | null = null
  private dragAutoScrollVelocity = 0
  private bannerTimer: number | null = null
  private hasClaimedInitialFocus = false
  /** Lightweight auto-poll while mounted. 15s default. */
  private pollTimer: number | null = null
  private readonly pollIntervalMs = 15_000
  /** Server-owned forward window, from the last response — how many future
   *  days the drag horizon offers. */
  private timelineFutureDays: number = KANBAN_TIMELINE_WINDOW.futureDays
  private lastFetchStartedAt: number | null = null
  /** Intermediate fiber-detail modal — one instance, re-used across opens. */
  private detailModal: FiberDetailModal | null = null
  private readonly surfaces: KanbanSurfaceRenderer

  constructor(options: KanbanModalOptions) {
    this.onOpenWorker = options.onOpenWorker
    // Kitty's quick-access panel hides on focus loss. If we activate it inside
    // the originating button's click handler, macOS can return focus to the
    // browser as that same gesture finishes, immediately hiding the terminal
    // again. Let the browser finish the gesture first; session selection and
    // Kitty activation then happen in the next task.
    this.openWorkerAfterGesture = this.onOpenWorker
      ? (tmuxSessionName, shuttleHost) => {
          window.setTimeout(() => this.onOpenWorker?.(tmuxSessionName, shuttleHost), 0)
        }
      : undefined
    this.onStashClick = options.onStashClick
    this.onNewIdeaClick = options.onNewIdeaClick
    this.shuttleBase = options.shuttleBase ?? `http://${window.location.hostname}:4000`
    this.temporal = options.temporalFetchers ?? createTemporalFetchers(this.shuttleBase)
    this.detailModal = new FiberDetailModal(
      this.shuttleBase,
      () => { void this.fetchAndRender() },
      // Terminal moves (Temper / Compost) route through the same optimistic
      // path as the inline card buttons and drags — instant relocation,
      // background commit, reconcile.
      (card, target) => this.transition(card, target),
      // Status-pill double-click → focus the running worker's kitty tab.
      this.openWorkerAfterGesture,
    )
    this.surfaces = new KanbanSurfaceRenderer({
      getDragSourceId: () => this.dragSourceId,
      setDragSourceId: (id) => { this.dragSourceId = id },
      getLastResponse: () => this.lastResponse,
      stopDragAutoScroll: () => this.stopDragAutoScroll(),
      transition: (card, target) => this.transition(card, target),
      setSurface: (card, horizon, opts) => this.setSurface(card, horizon, opts),
      pin: (card) => this.pinRole(card),
      openDetail: (card) => this.detailModal?.open(card),
      openWorker: this.openWorkerAfterGesture,
      releaseQuarantine: (host) => this.releaseQuarantine(host),
      // The masthead dissolved; its three actions now live in the column heads
      // (Drafts → Stash, In flight → New idea, Awaiting review → Refresh).
      onStashClick: this.onStashClick,
      onNewIdeaClick: this.onNewIdeaClick,
      onRefresh: () => void this.refreshFromSource(),
    })
  }

  /**
   * Mount the kanban inside `host`. The host owns layout (size, position,
   * border), scrim, Escape ordering, and lockBackground — vellum's workspace
   * slot supplies the host div and the modal chrome around it; the kanban
   * only stretches to fill it.
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
    this.assembleChrome()
    host.append(this.container!)
    document.addEventListener('keydown', this.handleDocumentKeyDown, true)
    window.addEventListener('resize', this.handleResize)
    void this.fetchAndRender()
    this.startPolling()
    // ?view=day|week|chronicle|shelf deep-links a view — for humans sharing a
    // spot and for headless QA, which can't press a hotkey. Unknown values
    // fall through to the Desk.
    const wanted = new URLSearchParams(window.location.search).get('view')
    if (wanted && (wanted === 'desk' || listViews().some((v) => v.id === wanted))) {
      this.setView(wanted as BoardViewId)
    }
  }

  /**
   * Tear down a mounted kanban. Safe to call when not mounted — no-op.
   * The host is responsible for removing the host div itself; we only own
   * the kanban's container (already a child of host).
   */
  unmount(): void {
    if (this.container === null) return
    // The fiber-detail panel floats on document.body, not in our container —
    // tab-away/close would otherwise orphan it over whatever is behind (and
    // its presence makes the workspace's Escape handler yield, so the orphan
    // would eat the first Escape too).
    this.detailModal?.close()
    // A mounted temporal view may hold timers/listeners of its own — give it
    // its unmount() before the container (and its host) go away.
    this.activeView?.unmount()
    this.activeView = null
    document.removeEventListener('keydown', this.handleDocumentKeyDown, true)
    window.removeEventListener('resize', this.handleResize)
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
    // Debounce via RAF — resize fires rapidly during a drag.
    if (this.resizeRaf !== null) return
    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = null
      this.expandOutcomesToFillSpace()
    })
  }

  // ---------------------------------------------------------------------------

  /**
   * Build the kanban DOM into `this.container`. Vellum's outer modal owns
   * close (via its own close button) — the kanban only renders the column
   * grid, banner, and live region.
   *
   * The masthead band dissolved (board-chrome-redesign): no "Kanban" title,
   * no scope subtitle, no stats line. Its three actions — Stash `+`, New idea
   * `✶`, Refresh `↻` — folded into the three column heads, one per lane (see
   * KanbanSurfaceRenderer.makeColumnAction). The page starts nearly flush at
   * the top (the tab strip), with only the body's own tight top padding as
   * margin — the standalone web UI has no workspace corner chrome to clear
   * (that was Portolan's native shell; this bundle runs in a plain tab).
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
    this.body.addEventListener('dragover', (e) => this.handleBodyDragOver(e))
    this.body.addEventListener('dragleave', (e) => this.handleBodyDragLeave(e))
    this.body.addEventListener('drop', () => this.stopDragAutoScroll())

    // aria-live region for transition announcements ("Moved 'X' to Tempered.")
    // — invisible but read by screen readers and observable in the a11y tree.
    this.liveEl = document.createElement('div')
    this.liveEl.className = 'kbn-live'
    this.liveEl.setAttribute('role', 'status')
    this.liveEl.setAttribute('aria-live', 'polite')

    // Transient error/info banner for transitions that fail.
    this.bannerEl = document.createElement('div')
    this.bannerEl.className = 'kbn-banner'
    this.bannerEl.setAttribute('role', 'alert')
    this.bannerEl.style.display = 'none'

    // The body's four permanent children: the view tab strip, the drag-reveal
    // horizon (zero-height and empty until a drag starts), the Desk wrapper
    // (display: contents — see the field docstring), and the slot a temporal
    // view mounts into. `render()` only ever rebuilds inside deskEl; the
    // horizon is filled and emptied by `syncDragHorizon`, never by render.
    this.tabsEl = this.buildViewTabs()
    this.dragHorizonEl = document.createElement('div')
    this.dragHorizonEl.className = 'kbn-draghorizon'
    this.deskEl = document.createElement('div')
    this.deskEl.className = 'kbn-desk'
    this.viewHostEl = document.createElement('div')
    this.viewHostEl.className = 'kbn-view-host'
    this.body.append(this.tabsEl, this.dragHorizonEl, this.deskEl, this.viewHostEl)
    this.syncViewChrome()

    this.container.append(this.bannerEl, this.body, this.liveEl)
  }

  // ── View switching ──────────────────────────────────────────────────────────

  /**
   * The tab strip: `desk` plus one tab per registered view, left-aligned on
   * its own hairline row at the top of the page. Built once — the registry is
   * populated at import time, so the strip never needs to re-render; only the
   * selected tab's classes change.
   */
  private buildViewTabs(): HTMLDivElement {
    const strip = document.createElement('div')
    strip.className = 'kbn-viewtabs'
    strip.setAttribute('role', 'tablist')
    strip.setAttribute('aria-label', 'Board views')

    const specs: Array<{ id: BoardViewId; label: string; hotkey: string }> = [
      { id: 'desk', label: 'desk', hotkey: DESK_HOTKEY },
      ...listViews().map((view) => ({
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
      tab.setAttribute('role', 'tab')
      tab.title = `${spec.label} (${spec.hotkey})`

      const labelEl = document.createElement('span')
      labelEl.className = 'kbn-viewtab-label'
      labelEl.textContent = spec.label
      const hotkeyEl = document.createElement('span')
      hotkeyEl.className = 'kbn-viewtab-hotkey'
      hotkeyEl.textContent = spec.hotkey
      hotkeyEl.setAttribute('aria-hidden', 'true')
      tab.append(hotkeyEl, labelEl)
      tab.addEventListener('click', () => this.setView(spec.id))
      strip.append(tab)
    }
    return strip
  }

  /**
   * Switch the page. Idempotent — re-selecting the active view is a no-op, so
   * a stray click or repeated hotkey never tears a view down and back up.
   */
  private setView(id: BoardViewId): void {
    if (id === this.activeViewId) return
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

  /**
   * Move the shared temporal cursor and let the active view redraw on it.
   *
   * Deliberately NOT a re-mount: the view keeps its DOM, its scroll position
   * and any local UI state, and patches itself from the new `focusDate` in its
   * `refresh`. Unconditional — calling it with the day already showing still
   * refreshes, so a "go to today" control works from any state without the
   * caller having to know whether it is already there.
   */
  private setFocusDate(dayISO: string | null): void {
    this.focusDate = normalizeFocusDate(dayISO)
    this.mountOrRefreshActiveView()
  }

  /**
   * The programmatic twin of clicking a tab — one entry point for a view that
   * wants to hand off to another ("see this week", "open that day"), optionally
   * moving the cursor as part of the same gesture so the destination mounts
   * already on the right day instead of flashing today first.
   *
   * Re-targeting the ALREADY-ACTIVE view is a refresh rather than a no-op when
   * the cursor moved: "show me this in Day" is a real request even when Day is
   * what you are looking at.
   */
  private switchView(id: BoardViewId, opts?: { focusDate?: string }): void {
    const requested = opts?.focusDate
    const nextFocus = requested === undefined ? this.focusDate : normalizeFocusDate(requested)
    const focusMoved = nextFocus !== this.focusDate
    this.focusDate = nextFocus
    if (id !== this.activeViewId) {
      // setView mounts (or refreshes) with a context built from the cursor we
      // just set, so the destination never renders the old day.
      this.setView(id)
      return
    }
    if (focusMoved) this.mountOrRefreshActiveView()
  }

  /**
   * Raise or drop the drag-reveal horizon.
   *
   * Built fresh on every drag rather than kept around, so its "today" is always
   * the real today (a board left open overnight would otherwise offer yesterday
   * as a drop target) and its width always matches the last response's forward
   * window. Fourteen day cells is nothing to build.
   *
   * Desk only: the temporal views own their own time axis, and a horizon
   * hovering over them would be a second, contradictory one.
   */
  private syncDragHorizon(dragging: boolean): void {
    const host = this.dragHorizonEl
    if (!host) return
    const wanted = dragging && this.activeViewId === 'desk'
    if (wanted === host.classList.contains('kbn-draghorizon-open')) return
    if (wanted) {
      host.innerHTML = ''
      host.append(this.surfaces.renderDragHorizon(this.timelineFutureDays))
      host.classList.add('kbn-draghorizon-open')
      return
    }
    host.classList.remove('kbn-draghorizon-open')
    host.innerHTML = ''
    this.surfaces.stopEdgeScroll()
  }

  /** Paint the selected tab and show exactly one of Desk / view host. */
  private syncViewChrome(): void {
    const onDesk = this.activeViewId === 'desk'
    // Leaving the Desk mid-drag takes the horizon with it.
    if (!onDesk) this.syncDragHorizon(false)
    if (this.deskEl) this.deskEl.style.display = onDesk ? '' : 'none'
    if (this.viewHostEl) this.viewHostEl.style.display = onDesk ? 'none' : ''
    for (const tab of this.tabsEl?.querySelectorAll<HTMLElement>('.kbn-viewtab') ?? []) {
      const selected = tab.dataset.view === this.activeViewId
      tab.classList.toggle('kbn-viewtab-active', selected)
      tab.setAttribute('aria-selected', String(selected))
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
   * Open a card's detail panel by id — the `openCard` a ViewContext exposes.
   *
   * Looks past `ctx.cards`, which is the WORK surfaces only. A cycle is an
   * annotation, not work: it lives in `response.cycles` and deliberately
   * appears in none of the eight surfaces `collectCards` walks, so a view that
   * draws cycle bands or chips would hand over an id this list has never heard
   * of. Widening `collectCards` would have been the smaller diff and the wrong
   * one — views walk `ctx.cards` to place due-marks, and a cycle's `due` is a
   * span's closing edge, not a deadline, so every such view would have to learn
   * to skip them. The lookup widens here instead; the contract stays put.
   *
   * A miss WARNS rather than returning quietly. The bug this replaces was
   * silent — a click that did nothing at all, with no throw and no log, found
   * only by someone watching the overlay in a browser. A no-op that says
   * nothing is its own defect class, so the next unknown id announces itself.
   */
  private openCardById(cardId: string, cards: KanbanCard[]): void {
    const card = resolveOpenTarget(cardId, cards, this.lastResponse?.cycles ?? [])
    if (card) this.detailModal?.open(card)
  }

  /**
   * Put a stand-in page in the view host when there is no response to mount a
   * view with — the fix for a temporal tab rendering as a completely blank
   * page when the composite feed is unreachable.
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
    const signature = `${title}:${kind}`
    if (this.viewFallbackSig === signature) return
    this.viewFallbackSig = signature
    this.viewHostEl.innerHTML = ''
    this.viewHostEl.append(
      kind === 'error'
        ? createViewFallbackPage(title, {
            message: '— the daemon is not answering —',
            onRetry: () => { void this.fetchAndRender() },
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
      shuttleBase: this.shuttleBase,
      activity: (fromMs, toMs) => this.temporal.activity(fromMs, toMs),
      sessions: (sinceMs) => this.temporal.sessions(sinceMs),
      commits: (sinceMs, untilMs) => this.temporal.commits(sinceMs, untilMs),
      moment: (session, fromMs, toMs, host, full) =>
        this.temporal.moment(session, fromMs, toMs, host, full),
      openCard: (cardId) => this.openCardById(cardId, cards),
      // The Desk's worker pill, handed to the views. Passed through rather than
      // wrapped: it is already the gesture-deferred form (see the constructor —
      // kitty hides on focus loss, so activation waits for the click to finish),
      // and it is already undefined when the host wired no `onOpenWorker`, which
      // is exactly the optionality the contract promises.
      openWorker: this.openWorkerAfterGesture,
      requestRefresh: () => { void this.fetchAndRender() },
      // Read at build time, and the context is rebuilt for every mount and
      // refresh — so a view always sees the current cursor, never a snapshot
      // from when it mounted.
      focusDate: this.focusDate,
      setFocusDate: (dayISO) => this.setFocusDate(dayISO),
      switchView: (id, opts) => this.switchView(id, opts),
    }
  }

  /**
   * `1`–`5` switch views. Deliberately narrow: a bare digit only, so
   * `Cmd/Ctrl+1` stays the browser's tab switch, and only when the keystroke
   * is not going somewhere it matters — a focused text field, or a Radix
   * dialog / fiber-detail panel layered over the board. Returns true when the
   * key was consumed.
   */
  private handleViewHotkey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    const match = listViews().find((v) => v.hotkey === e.key)
    if (!match && e.key !== DESK_HOTKEY) return false
    if (keystrokeIsSpokenFor()) return false
    const id: BoardViewId = match ? match.id : 'desk'
    e.preventDefault()
    e.stopPropagation()
    this.setView(id)
    return true
  }

  /** Reset all field state to "not mounted." DOM removal is `unmount()`'s
   *  responsibility; this only clears references. */
  private teardownState(): void {
    this.container = null
    this.body = null
    this.liveEl = null
    this.bannerEl = null
    this.tabsEl = null
    this.deskEl = null
    this.viewHostEl = null
    this.activeView = null
    this.activeViewId = 'desk'
    this.focusDate = null
    this.lensCycleId = null
    this.viewFallbackSig = null
    this.lastFetchFailed = false
    this.dragSourceId = null
    this.hasClaimedInitialFocus = false
    this.stopDragAutoScroll()
    if (this.bannerTimer !== null) {
      window.clearTimeout(this.bannerTimer)
      this.bannerTimer = null
    }
  }

  // ── Transitions ─────────────────────────────────────────────────────────────

  /**
   * Apply a drag's lifecycle target to a card. Refetches the kanban on
   * success; shows the banner on failure. Optimism is left to the caller
   * (the click handler removes the card from the source DOM list before
   * awaiting).
   *
   * Drag-to-inFlight is the launch verb. It routes through the unified
   * force-dispatch path (the same one FiberDetailModal's "New session ▸"
   * uses): a single fresh POST /api/v1/dispatch with `force: true, ad_hoc:
   * true` and no message — drag carries no directive (resume-previous and
   * "talk first" intent live behind the detail modal). force bypasses status /
   * enabled / review_state / schedule / validity gates, so closed (tempered or
   * composted), paused, awaiting-review, and dormant-standing cards all
   * fire a worker immediately — no waiting on the 15s poller; the dispatch
   * reopens a closed lifecycle itself, so no separate transition write runs.
   *
   * Drag-from-timeline-or-stash composes the surface horizon write
   * (setSurface(card, 'now')) with the lifecycle verb. Previously the
   * surface-shift branch returned after writing the Now surface command, relying on
   * classifyFiber to "redirect to the right column" — but standing roles
   * always re-classify back to the timeline (their lifecycle column is
   * `scheduled`, horizon-independent), and tempered/closed past cards
   * never actually leave timeline.past. Composing both writes makes drag
   * take precedence: the gesture lands the card where the user dropped
   * it AND fires the action that column means.
   */
  private transition(card: KanbanCard, target: ColumnKind): void {
    // A verdict on a card with a LIVE worker kills that worker (commitTransition
    // → killWorkerIfRunning), and it did so silently — one click on Compost and
    // a running session was gone, while "New session", which destroys less,
    // asked first. Confirm the destructive one too. Gated on `runningWorker`, so
    // the overwhelmingly common case (a verdict on a finished run) stays a
    // single click. This is the choke point for every path — the card's inline
    // buttons, the detail panel's terminal moves, and a drag onto the column —
    // so one guard covers all three.
    if ((target === 'tempered' || target === 'composted') && card.runningWorker) {
      const verb = target === 'tempered' ? 'temper' : 'compost'
      const ok = window.confirm(
        `“${card.name}” has a live worker. This stops it — ${verb} anyway?`,
      )
      if (!ok) {
        this.announce(`Left ${card.name} running.`)
        return
      }
    }

    // Use the server's placement from the last response — that's the source
    // of truth for which column the card is in. Re-deriving from card fields
    // here is a footgun: column classification depends on `shuttle.enabled`,
    // `idea` tag, `tempered`, standing-role review state, etc. — anything
    // the local rule misses (or drifts from the server) silently no-ops the
    // drag with a snap-back.
    const fromKind = findCardColumn(this.lastResponse, card.id)
    if (fromKind === target) {
      // Dropped back onto the column it already lives in — a no-op, but say so
      // rather than letting the drag feel ignored.
      this.showBanner(`“${card.name}” is already in ${COLUMN_TITLES[target]}.`, 'info')
      this.announce(`${card.name} is already in ${COLUMN_TITLES[target]}.`)
      return
    }

    // Surface-shift case: card lives on a non-Now surface (timeline.futureDated
    // / stash). For drag onto a Now lifecycle column we first
    // promote to Now (the "park on desk" half of the gesture), then fall
    // through to the lifecycle verb (the "act on it" half) — never early-return.
    const isNowColumn = target === 'drafts' || target === 'inFlight' || target === 'awaitingReview'
    const resp = this.lastResponse
    const onTimelineOrStash = !!resp && [
      ...resp.timeline.futureDated,
      ...resp.stash,
    ].some((c) => c.id === card.id)
    // Park on the desk whenever leftover planning fields would otherwise
    // re-route the card after the lifecycle verb lands: a stale `horizon`
    // re-stashes a reopened draft, a leftover `due:` re-futures it. (The
    // closed→drafts reopen-as-draft made this reachable: a card stashed
    // while open, closed, then dragged back to Drafts carries both.)
    const needSurfaceShift =
      isNowColumn &&
      ((fromKind === null && onTimelineOrStash) ||
        card.storedHorizon !== undefined ||
        (target === 'drafts' && card.due !== undefined))

    // Optimism: reflect the gesture's named destination *now*, before the
    // server write returns. This is honoring the drop, not reclassifying —
    // the user dropped the card on `target`, so it goes there. classifyFiber
    // stays authoritative: commitTransition refetches and reconciles, so a
    // surprising server classification (or server-enriched card fields like
    // closedAt) self-corrects within one refetch. The slow part — a daemon
    // round-trip, a worker spawn for inFlight — no longer blocks the card
    // from moving.
    const optimistic = applyOptimisticTransition(this.lastResponse, card.id, target)
    if (optimistic) this.applyResponse(optimistic)

    void this.commitTransition(card, target, needSurfaceShift)
  }

  /**
   * Network half of {@link transition}: settle file state (and launch, for
   * inFlight) through the daemon, then reconcile against server truth.
   *
   * Runs in the background after the optimistic render so its latency is
   * invisible. On failure it banners and the trailing refetch snaps the
   * card back to where the server actually has it; on success the refetch
   * replaces the optimistic placement with the authoritative response
   * (a no-op re-render when they already agree, via the signature dedup in
   * fetchAndRender).
   */
  private async commitTransition(
    card: KanbanCard,
    target: ColumnKind,
    needSurfaceShift: boolean,
  ): Promise<void> {
    try {
      if (needSurfaceShift) {
        // Same write policy as commitSurface's `now`: clear horizon/cold and
        // (for a Drafts drop) the `due:` — "park on the desk" means no
        // planning fields left to re-route the card on the next classify.
        const surfaceBody: Record<string, unknown> = {
          fiber_id: card.id, origin: card.originId, unset: ['horizon', 'cold'],
        }
        if (target === 'drafts' && card.due !== undefined) surfaceBody.due = null
        const surfaceRes = await fetch(this.horizonUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(surfaceBody),
        })
        if (!surfaceRes.ok) {
          throw new Error(await errorMessageFromResponse(surfaceRes, 'Park-on-desk failed'))
        }
      }

      if (target === 'inFlight') {
        await this.launchFromDrag(card)
      } else {
        // Dragging a running card off in-flight stops its worker first — the
        // board's "alive only while in-flight" invariant. inFlight is the one
        // target that doesn't kill (it's a (re)dispatch, and a pinned card
        // dragged here is at rest, not running).
        await this.killWorkerIfRunning(card)
        const res = await fetch(this.transitionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fiber_id: card.id, target, origin: card.originId }),
        })
        if (!res.ok) {
          throw new Error(await errorMessageFromResponse(res, 'Transition failed'))
        }
      }
      this.announce(`Moved “${card.name}” to ${COLUMN_TITLES[target]}.`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't move “${card.name}” to ${COLUMN_TITLES[target]}: ${msg}`, 'error')
      this.announce(`Move failed: ${msg}`)
    }
    // Always refetch — server is the source of truth. Reconciles (or reverts)
    // the optimistic placement.
    await this.fetchAndRender()
  }

  /**
   * Drag-to-inFlight launch path. A SINGLE daemon call: POST
   * /api/v1/dispatch (force=true, ad_hoc=true) owns the whole launch —
   * owner-routed by `origin`, it reopens the lifecycle if the fiber is
   * closed and dispatches on the host that owns `shuttle.host`.
   *
   * This used to fire a transition target=inFlight FIRST, but that was
   * both redundant (requeue already reopens-if-closed) and harmful: for an
   * enabled fiber the transition resolved to dispatch-ad-hoc and SPAWNED the
   * worker immediately, racing requeue's own force-dispatch into a 409
   * already_running. Collapsing to one call removed the race; the drag
   * carries no directive. (overnight-audit C6, regression from 5973cdc.)
   */
  private async launchFromDrag(card: KanbanCard): Promise<void> {
    // Drag launch always starts fresh. Resume-previous and "talk first" intent
    // live behind the detail modal where the user can choose them intentionally.
    // The daemon's force/ad-hoc dispatch reopens a closed lifecycle and spawns
    // the worker on the owning host (owner-routed by `origin`).
    let requeueRes: Response
    try {
      requeueRes = await fetch(this.requeueUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiber_id: card.id,
          origin: card.originId,
          force: true,
          ad_hoc: true,
          // "Drag launch always starts fresh" is unconditional — stamp it as an
          // explicit fresh directive, NOT the marker auto-decide (which would
          // resume a dirty-dead transcript; see dispatcher commit 3bdb776).
          resume_mode: 'fresh',
        }),
      })
    } catch (err: unknown) {
      const detail = (err as { message?: string })?.message ?? String(err)
      throw new Error(`Couldn't reach the Shuttle daemon: ${detail}`)
    }
    if (!requeueRes.ok) {
      const body = (await requeueRes.json().catch(() => ({}))) as { reason?: string; detail?: string; message?: string; error?: string }
      // Prefer the structured ineligibility copy (detail/message name the
      // actual host / project_dir); only fall back to the generic error or
      // status when the daemon gave us nothing to map.
      if (body.reason || body.detail || body.message) {
        throw new Error(dispatchIneligibleReason(body))
      }
      throw new Error(body.error || `requeue ${requeueRes.status}`)
    }
  }

  /**
   * POST a surface edit. Computes the horizon/cold/due frontmatter diff
   * client-side and posts it through the daemon's `/api/v1/felt-edit`
   * (owner-routed by `origin`) so the drag is one atomic write.
   *
   *   • Drag a scheduled/in-flight card onto a date column →
   *     setSurface(card, 'now', { due }); the edit persists due, clears horizon,
   *     and the card keeps its lifecycle column while wearing the date.
   *   • SNOOZE — drag a desk card (Drafts / Awaiting review) or a resting card
   *     onto a date column → setSurface(card, 'stashed', { due }); ONE felt-edit
   *     writes `horizon: stashed` AND `due:` together, so no poll can ever
   *     observe half of it. Which of the two a day-drop means is decided by
   *     `dayDropHorizon` at the drop site, from where the card currently sits.
   *   • Drag into Resting                 → setSurface(card, 'stashed', { cold? }).
   *   • Drag back up to now               → setSurface(card, 'now') clears horizon.
   *
   * When `opts.due` is omitted the existing `due:` is preserved — except
   * when stashing, where an omitted `due` resolves to `null`. Stashing
   * clears the deadline on purpose: `due:` means timeline placement until
   * it becomes imminent, so a hand-stash gesture that didn't drop the due
   * would not be a dateless stash. Clearing it is what makes stash mean
   * "future, no date." Callers can still pass an explicit `due` to override.
   */
  private setSurface(
    card: KanbanCard,
    horizon: HorizonKind,
    opts: { cold?: boolean; due?: string | null } = {},
  ): void {
    // A standing role is placed on the timeline by its schedule
    // (`nextStandingLaunch`), not by hand — a horizon/due write here is
    // silently ignored by the read model and just leaves dead frontmatter.
    // Reject the planning gesture with an explanation rather than no-op. The
    // lifecycle gestures still work: drag to In flight runs it now (that's
    // `transition` → force-dispatch, not this path), and Temper / Compost
    // close it.
    if (card.shuttleKind === 'standing') {
      this.showBanner(
        `“${card.name}” is a standing role — it runs on its schedule. Edit the schedule to change when it runs, or drag it to In flight to run it now.`,
        'info',
      )
      this.announce(`${card.name} runs on its schedule; drag it to In flight to run it now.`)
      return
    }
    // A resting pinned role lives on the strip, not the planner — a horizon/due
    // write would be ignored by the classifier (pinned+active always reads
    // `pinned`) and the card would snap back. Same family as the standing guard.
    if (card.shuttleKind === 'pinned' && card.status === 'active') {
      this.showBanner(
        `“${card.name}” is a pinned role — it rests on the Pinned strip. Drag it to In flight to run it, or unpin it to plan it.`,
        'info',
      )
      this.announce(`${card.name} is pinned; drag it to In flight to run it.`)
      return
    }
    // The awaiting run of a cyclical pinned role (closed untempered) takes
    // verdict gestures — accept (drag to Tempered / In flight) or compost — not
    // planning ones; a planning write would leave it classified awaiting and
    // snap back. (Standing roles already returned above, so only `pinned`
    // reaches here — a closed oneshot awaiting review CAN be stashed, via the
    // reopen-as-draft compose in commitSurface.)
    if (card.status === 'closed' && card.tempered === undefined && card.shuttleKind === 'pinned') {
      this.showBanner(
        `“${card.name}” is a pinned role awaiting review — accept it (drag to Tempered) or compost it first.`,
        'info',
      )
      this.announce(`${card.name} awaits a verdict; accept or compost it first.`)
      return
    }
    const wantsCold = horizon === 'stashed' ? (opts.cold ?? false) : undefined
    const due = horizon === 'stashed' && opts.due === undefined ? null : opts.due

    const sameHorizon =
      card.storedHorizon === horizon && (card.cold ?? false) === (opts.cold ?? false)
    const sameDue = due === undefined || sameCivilDue(card.due, due)
    // Any CLOSED card — a tempered/composted past run OR an awaiting-review one
    // (closed, untempered) — classifies by its lifecycle state, not its stored
    // horizon: it sits in Awaiting review / Past regardless of a `horizon:
    // stashed` left in its frontmatter. So even when the stored horizon already
    // equals the target, the drop is a real state change — commitSurface
    // reopens it as a draft so it actually leaves that column and lands on the
    // surface. Never short-circuit a closed card. (This was the "reminders
    // bridge already has horizon:stashed, so dragging to stash silently
    // no-ops" bug — sameHorizon was true but the card never moved.)
    const isClosedSource = card.status === 'closed'
    if (!isClosedSource && sameHorizon && sameDue) {
      // A genuine no-op: an open/active card already on this surface with these
      // fields. Tell the user rather than leaving the drag feeling broken.
      this.showBanner(`“${card.name}” is already in ${SURFACE_TITLE[horizon]}.`, 'info')
      this.announce(`${card.name} is already in ${SURFACE_TITLE[horizon]}.`)
      return
    }

    // Optimism for the one unambiguous destination: `stashed` drops the card
    // into the stash grid. `now` stays on the refetch path — the Now surface
    // doesn't name a lifecycle column, so an optimistic placement there would
    // be a reclassification.
    if (horizon === 'stashed') {
      const optimistic = applyOptimisticSurface(this.lastResponse, card.id, { cold: wantsCold, due })
      if (optimistic) this.applyResponse(optimistic)
    }

    void this.commitSurface(card, horizon, { cold: wantsCold, due })
  }

  /**
   * Network half of {@link setSurface}: POST the horizon edit, then reconcile.
   * Runs in the background after the optimistic render (when there was one), so
   * its latency is invisible; banners + snaps back on failure.
   */
  private async commitSurface(
    card: KanbanCard,
    horizon: HorizonKind,
    opts: { cold?: boolean; due?: string | null },
  ): Promise<void> {
    try {
      // Parking a running card on a planning surface (stash / future date) stops
      // its worker — alive only while in-flight.
      await this.killWorkerIfRunning(card)
      // A planning surface holds DRAFTS. A card that isn't one yet is parked as
      // one first via `/transition target=drafts`: a closed card reopens as a
      // deferred draft (daemon: reopen --as-draft → status:open, verdict
      // cleared — NOT active, so it is not auto-dispatched; the slides
      // snap-back fix), an armed/active card pauses (otherwise an active
      // oneshot reclassifies straight back to In flight after the refetch).
      // setSurface's guards already bannered the states where this verb is
      // wrong (standing, resting pinned, cyclical awaiting run). Every card on
      // a Desk column carries a shuttle block, so the lifecycle verbs always
      // apply — see `shouldIncludeInKanban`.
      if (card.status !== 'open') {
        const parkRes = await fetch(this.transitionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fiber_id: card.id, target: 'drafts', origin: card.originId }),
        })
        if (!parkRes.ok) {
          throw new Error(await errorMessageFromResponse(parkRes, 'Park-as-draft failed'))
        }
      }
      // Port of the backend `computeHorizonPatch`: the horizon "surface" is not
      // stored verbatim — Now is absence (clear `horizon`+`cold`), future
      // placement is `due:`, and only `stashed` writes a stored horizon. The
      // daemon `/api/v1/felt-edit` is a raw frontmatter writer, so this policy
      // (which used to live server-side) is now applied here, the sole
      // classifier's twin on the write side.
      const set: Record<string, string | boolean> = {}
      const unset: string[] = []
      if (horizon === 'stashed') {
        set.horizon = 'stashed'
        if (opts.cold === true) set.cold = true
        else if (opts.cold === false) unset.push('cold')
        // cold === undefined → leave the existing `cold:` line alone.
      } else {
        unset.push('horizon', 'cold')
      }
      const payload: Record<string, unknown> = { fiber_id: card.id, origin: card.originId }
      if (Object.keys(set).length > 0) payload.set = set
      if (unset.length > 0) payload.unset = unset
      if (opts.due !== undefined) payload.due = opts.due
      const res = await fetch(this.horizonUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        throw new Error(await errorMessageFromResponse(res, 'Surface edit failed'))
      }
      this.announce(`Moved “${card.name}” to ${SURFACE_TITLE[horizon]}.`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't move “${card.name}” to ${SURFACE_TITLE[horizon]}: ${msg}`, 'error')
      this.announce(`Surface move failed: ${msg}`)
    }
    await this.fetchAndRender()
  }

  /**
   * "Onto the Pinned shelf" gesture: reshape an existing shuttle fiber to a
   * resting `kind:pinned` role. The off-the-shelf twin of dragging a pinned
   * card onto In-flight (dispatch). Optimistically lands the card on the
   * pinned surface, then posts the daemon's `reshape pinned` in the background
   * and reconciles.
   *
   * v1 scope (matches the spec): the source must already carry a shuttle block
   * (a bare human-due draft has no host/project_dir to install from — promote
   * it first), and must not be closed (the `pin` writer refuses a closed fiber;
   * reopen-then-pin is a follow-up). Both are surfaced as banners, not silent
   * no-ops.
   */
  private pinRole(card: KanbanCard): void {
    // An already-pinned role that is RESTING (status:active) is already on the
    // strip — tell the user rather than silently swallowing the drag. But a
    // pinned role whose last run is awaiting review (status:closed, tempered
    // undefined) classifies into Awaiting review, NOT onto the strip; dragging
    // it to the strip means "bring it back to rest," which the closed-card
    // compose below (reopen → reshape → active) delivers. Returning
    // unconditionally was the bug: a once-pinned card left closed could never
    // be re-rested from the board.
    if (card.shuttleKind === 'pinned' && card.status !== 'closed') {
      // A *running* pinned role shows in In-flight, not at rest on the strip
      // (the live-worker override in classifyFiber). Dragging it back to the
      // strip means "stop it": kill the worker so it comes to rest. No reshape —
      // it's already pinned, so re-pinning would be a pointless round-trip.
      if (card.runningWorker) {
        const optimistic = applyOptimisticPin(this.lastResponse, card.id)
        if (optimistic) this.applyResponse(optimistic)
        void this.stopRunningPinnedRole(card)
        return
      }
      this.showBanner(`“${card.name}” is already pinned — it's resting on the strip.`, 'info')
      this.announce(`${card.name} is already pinned.`)
      return
    }
    if (card.shuttleKind === undefined) {
      this.showBanner(`“${card.name}” has no shuttle block — promote it before pinning.`, 'error')
      return
    }
    // A closed card (awaiting-review or a tempered/composted past run) is no
    // longer refused: `reshape` writes the shape and nothing else, so commitPin
    // follows it with a `pause` that parks the card — status:open, tempered and
    // closed-at cleared. applyOptimisticPin already lands the card at rest
    // (status:active) on the strip, so the optimistic move holds for a closed
    // source too.
    // A running card dragged onto the strip is stopped first (commitPin kills
    // the worker before the reshape), so it comes to rest on the strip rather
    // than staying in Now via the live-worker override. The optimistic move to
    // the strip therefore holds.
    const optimistic = applyOptimisticPin(this.lastResponse, card.id)
    if (optimistic) this.applyResponse(optimistic)
    void this.commitPin(card)
  }

  /**
   * Network half of {@link pinRole}. The gesture means two things — "be a
   * pinned role" and "come to rest on the strip" — so a card that already
   * carries a shuttle block says both, in two calls:
   *
   *   `reshape pinned` rewrites kind (dropping any schedule) and NOTHING else,
   *   so model, host and project_dir stay where they are instead of being
   *   echoed back through a create verb; then `pause` parks it — status:open
   *   with tempered / closed-at cleared, which IS rest on the strip. The old
   *   `pin --reshape` delivered the parking by accident, as a side effect of
   *   rebuilding the whole block; now the intent is stated.
   *
   * Non-atomic on purpose. The hazard this codebase learned to fear was
   * `uninstall` + `pin`, where a failed second write left a fiber with NO block
   * at all. Here a failed `pause` leaves a correctly pinned role that simply
   * isn't parked yet — visible, harmless, and re-driveable by the same drag. An
   * atomic block-rebuild would cost more than it buys.
   *
   * A card with no block yet has nothing to reshape (the verb errors on one),
   * so it takes `pin`, the create verb — which parks at status:open itself, no
   * second call needed. `project_dir` is a hint only on that path: when it
   * can't resolve here (undefined), `postLifecycle` drops it and the daemon
   * falls back. A running card is killed first on both paths, so by the time
   * `pause` runs its own kill is a no-op. Reconciles via the trailing refetch.
   */
  private async commitPin(card: KanbanCard): Promise<void> {
    try {
      await this.killWorkerIfRunning(card)
      // The /lifecycle endpoint keys on `fiber` (not `fiber_id`, which
      // /dispatch and /felt-edit use) — matching FiberDetailModal's reshape.
      if (isAgentCard(card)) {
        await this.postLifecycle({
          action: 'reshape', kind: 'pinned', fiber: card.id, origin: card.originId,
        })
        await this.postLifecycle({ action: 'pause', fiber: card.id, origin: card.originId })
      } else {
        await this.postLifecycle({
          action: 'pin',
          fiber: card.id,
          origin: card.originId,
          model: card.shuttleAgent,
          host: card.shuttleHost,
          project_dir: this.resolveProjectDir(card),
        })
      }
      this.announce(`Pinned “${card.name}”.`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't pin “${card.name}”: ${msg}`, 'error')
      this.announce(`Pin failed: ${msg}`)
    }
    await this.fetchAndRender()
  }

  /** POST one lifecycle verb, throwing the daemon's error text on non-2xx.
   *  Undefined body fields are dropped so the daemon sees only what's set. */
  private async postLifecycle(body: Record<string, unknown>): Promise<void> {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined))
    const res = await fetch(this.lifecycleUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean),
    })
    if (!res.ok) {
      throw new Error(await errorMessageFromResponse(res, 'Lifecycle action failed'))
    }
  }

  /** Worker cwd for a reshape: the fiber's own `project_dir`. Mirrors
   *  FiberDetailModal.projectDirFor. */
  private resolveProjectDir(card: KanbanCard): string | undefined {
    return card.shuttleProjectDir
  }

  private announce(msg: string): void {
    if (!this.liveEl) return
    // Clear → set forces re-announcement on identical text.
    this.liveEl.textContent = ''
    window.setTimeout(() => {
      if (this.liveEl) this.liveEl.textContent = msg
    }, 50)
  }

  private showBanner(text: string, kind: 'error' | 'info' = 'info'): void {
    if (!this.bannerEl) return
    this.bannerEl.textContent = text
    this.bannerEl.style.display = ''
    this.bannerEl.classList.toggle('kbn-banner-error', kind === 'error')
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer)
    // Errors now carry the daemon's full message (often a sentence or two), so
    // they linger long enough to read; info confirmations clear quickly.
    this.bannerTimer = window.setTimeout(() => {
      if (this.bannerEl) this.bannerEl.style.display = 'none'
      this.bannerTimer = null
    }, kind === 'error' ? 12000 : 5000)
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
    this.lastResponse = data
    this.lastResponseSig = this.computeResponseSignature(data)
    this.render(data)
  }


  private async fetchAndRender(): Promise<void> {
    this.lastFetchStartedAt = Date.now()
    const token = ++this.inflightFetchToken
    try {
      const res = await fetch(this.kanbanUrl())
      if (token !== this.inflightFetchToken) return
      if (!res.ok) {
        this.markFetchFailed(`Server returned ${res.status}`)
        return
      }
      // The kanban now reads Shuttle's loom-wide composite feed and classifies
      // it frontend-side — the sole classifier. `parseCompositeFeed` validates
      // the wire shape; `buildKanbanResponseFromComposite` collects → classifies
      // → assembles the exact `KanbanResponse` the renderer already consumes.
      const feed = parseCompositeFeed(await res.json())
      const data = buildKanbanResponseFromComposite(feed)
      if (token !== this.inflightFetchToken) return
      // Skip re-render when the response is semantically unchanged —
      // every 15-second poll otherwise tears down ~50 cards × ~30 nodes
      // each just to rebuild them identically. Hash the meaningful
      // payload (columns + totals + staleness); `generatedAt` flickers each
      // poll even on no-op refreshes.
      // A response landed: clear any error page the views were showing.
      this.lastFetchFailed = false
      const sig = this.computeResponseSignature(data)
      const wasFirstRender = this.lastResponse === null
      this.lastResponse = data
      if (!wasFirstRender && sig === this.lastResponseSig) {
        // The Desk skips an identical-payload re-render, but a temporal view
        // still gets its poll: its content moves with the clock (and with
        // activity and the ledgers), not only with the fiber feed.
        this.mountOrRefreshActiveView()
        return
      }
      this.lastResponseSig = sig
      this.render(data)
    } catch (err: unknown) {
      if (token !== this.inflightFetchToken) return
      const msg = (err as { message?: string })?.message ?? String(err)
      this.markFetchFailed(msg)
    }
  }

  private async refreshFromSource(): Promise<void> {
    // Kanban content is read live from each owning daemon's `/api/v1/fibers`
    // route, so a manual refresh is just a re-fetch — there is no remote
    // snapshot to prompt. (The old POST /kanban/refresh push-trigger was
    // retired with the pushed fiber-tree snapshot store.)
    this.announce('Refreshing…')
    await this.fetchAndRender()
    window.setTimeout(() => {
      void this.fetchAndRender()
    }, 800)
  }

  private computeResponseSignature(data: KanbanResponse): string {
    // Hash the three surfaces + totals + staleness — stale-origin cards dim
    // and disable drag even when the card lists themselves are unchanged.
    return JSON.stringify({
      n: data.now,
      tl: data.timeline,
      s: data.stash,
      p: data.pinned,
      t: data.totals,
      tt: data.temperedTotal,
      tw: data.timelineWindow,
      st: data.staleness,
    })
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
    // control lives in a column head that is no longer on screen — so the state
    // that most needs a retry was the one state with no way to ask for one.
    // (The poll does recover on its own now that the error clears the dedup
    // signature, but waiting up to 15s without a button is indistinguishable
    // from being stuck.)
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

  /**
   * Record a failed fetch and show it on whichever page is up. The Desk has
   * `renderError` and its own surfaces; a temporal view has neither, so it gets
   * the fallback page instead of the blank host it used to get.
   */
  private markFetchFailed(msg: string): void {
    this.lastFetchFailed = true
    this.renderError(msg)
    if (this.activeViewId !== 'desk') {
      const view = getView(this.activeViewId)
      if (view) this.renderViewFallback(view.title)
    }
  }

  private render(data: KanbanResponse): void {
    if (!this.body || !this.deskEl) return

    // Never rebuild the Desk while it is hidden behind a temporal view. Every
    // pass at the end of this method MEASURES — `expandOutcomesToFillSpace`
    // reads column heights, `restoreScrollSnapshot` writes scrollTops — and a
    // `display:none` subtree has no layout box, so each one silently does
    // nothing. Worse than nothing, in fact: the clamp pass clears
    // `--card-line-clamp` before it measures, so a hidden rebuild leaves every
    // column pinned to the 4-line CSS default and the outcome text it had
    // expanded to fill the column comes back truncated. Nothing repairs it on
    // the way back either, so the board sat wrong until the next data-changing
    // poll — up to 15 seconds after the user returned.
    //
    // Holding the payload instead is also what makes the promise in the
    // `deskEl` docstring true: the Desk that comes back is the one the user
    // left, scroll positions and clamps intact, repainted from fresh data at
    // the moment it can see what it is doing.
    if (this.activeViewId !== 'desk') {
      this.lastResponse = data
      this.pendingDeskData = data
      this.mountOrRefreshActiveView()
      return
    }
    this.pendingDeskData = null

    const scrollSnapshot = this.captureScrollSnapshot()
    const { now, timelineWindow, pinned, staleness } = data
    this.timelineFutureDays = timelineWindow.futureDays
    // The masthead stats line dissolved (board-chrome-redesign) — the board
    // speaks for itself (column counts, the Pinned/Resting sections), and stale
    // origins already dim their cards + show "waiting on <host>".

    this.deskEl.innerHTML = ''
    this.body.classList.remove('kbn-body-zoomed')

    // Three surfaces, top to bottom: the Now board, the pinned-role launcher
    // band, then Resting. The Timeline ribbon that used to sit above all of
    // them is gone — the chronological views tell that story now, and the day
    // axis survives only as the drag-reveal horizon under the tab strip (see
    // `syncDragHorizon`). Its removal is what gives Pinned and Resting the room
    // to sit on screen instead of below the fold.
    // The cycle lens: a row of chips above the columns, and — when one is
    // engaged — a lens the Now board is drawn through. Derived fresh from the
    // response every render, so a poll that changes a `due:` moves a card in or
    // out of the chapter without anything to invalidate. A lens whose cycle has
    // vanished from the feed resolves to null and simply releases itself.
    const lens = deriveCycleLens(data, this.lensCycleId)
    if (this.lensCycleId !== null && lens === null) this.lensCycleId = null
    const lensBar = this.surfaces.renderCycleLensBar(
      this.lensCycleId,
      (cycleId) => this.setLensCycle(cycleId),
    )
    if (lensBar) this.deskEl.append(lensBar)

    this.deskEl.append(this.surfaces.renderNowSection(now, staleness, lens))
    // The Pinned strip always renders (a permanent park/drop target) — see
    // renderPinnedSection; no null guard needed.
    this.deskEl.append(this.surfaces.renderPinnedSection(pinned, staleness))
    // Resting draws everything at rest — snoozed work AND standing roles asleep
    // between runs. The second kind classifies as `scheduled` and used to be
    // drawn only by the timeline ribbon, which no longer exists; see
    // `restingCards`.
    this.deskEl.append(this.surfaces.renderStashSection(restingCards(data), staleness))

    this.restoreScrollSnapshot(scrollSnapshot)
    this.claimInitialFocus()
    this.updateBodyScrollAffordance()
    window.requestAnimationFrame(() => this.updateBodyScrollAffordance())
    // Expand line-clamp on outcomes in now-section columns with spare
    // vertical space. Two RAFs let layout settle at the 4-line default
    // before measuring scrollHeight.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => this.expandOutcomesToFillSpace())
    })
    this.lastResponse = data
    // A temporal view is fed by the same data the Desk just rebuilt from —
    // including optimistic re-renders, which never reach fetchAndRender.
    this.mountOrRefreshActiveView()
  }

  /**
   * Per-column post-render pass that sets `--card-line-clamp` to fill
   * the column with at most 3 visible cards. The goal: maximize on-
   * screen space utilization while never showing more than three cards
   * in a single column at once.
   *
   * Algorithm per column:
   *   1. effectiveN = min(card_count, 3) — how many cards we want
   *      visible at once. Beyond 3, the column scrolls and unseen cards
   *      stay at the same height as the visible ones.
   *   2. targetCardHeight = (column_height - gaps_between_visible_cards)
   *      / effectiveN. The height each card should grow toward.
   *   3. avgNonOutcomeHeight = (sum of non-outcome height across cards
   *      in the column) / N. The ambient overhead — header + name +
   *      slug + meta + padding + gaps — varies card-to-card so we
   *      average it.
   *   4. targetOutcomeHeight = targetCardHeight - avgNonOutcomeHeight.
   *   5. targetLines = floor(targetOutcomeHeight / line_height).
   *   6. Clamp lives in [4, 16]. Apply to .kbn-col so all cards
   *      inherit via the cascade.
   *
   * Floor() biases toward undershoot. The clamp is per-column so
   * sparser columns can show longer outcomes — each column is sized
   * to fit its own contents, not a global lowest common denominator.
   */
  private expandOutcomesToFillSpace(): void {
    if (!this.body) return
    // Outcome font-size × line-height = 12.5 × 1.4 = 17.5px per line at design
    // size. The board's type rides `--kbn-type-scale` (KanbanModal.css), so the
    // measure has to ride it too — a fixed 17.5 would over-count lines and clamp
    // outcomes short as soon as the scale moves off 1. `.kbn-col` pins the
    // scale back to 1 (Desk cards render at design size), so this has to read
    // the effective value at the column, not the root/body default.
    const readTypeScale = (el: HTMLElement): number =>
      Number.parseFloat(
        getComputedStyle(el).getPropertyValue('--kbn-type-scale'),
      ) || 1
    // Gap between cards in .kbn-col-list (CSS: gap: 8px).
    const cardGap = 8
    const minClamp = 4
    const maxVisibleCards = 3
    // No upper cap on the clamp value: targetLines is already bounded by
    // (column_height - overhead) / lineHeight, so a single-card column
    // expands to fill the column. Cards with short outcomes show their
    // full content (line-clamp is a max, not a fixed height) — the
    // overgrown clamp value is harmless when there's nothing to clamp.

    // Reset cascade roots before measuring so a stale variable from a
    // prior render doesn't bias offsetHeight readings. Clear at every
    // level we might have set it (body, col, card).
    this.body.style.removeProperty('--card-line-clamp')
    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col')) {
      col.style.removeProperty('--card-line-clamp')
    }
    for (const card of this.body.querySelectorAll<HTMLElement>('.kbn-card')) {
      card.style.removeProperty('--card-line-clamp')
    }
    // Force layout to settle at the 4-line default before measuring.
    void this.body.offsetHeight

    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col')) {
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      if (!list) continue
      const cards = list.querySelectorAll<HTMLElement>('.kbn-card')
      if (cards.length === 0) continue

      const lineHeight = 17.5 * readTypeScale(col)
      const effectiveN = Math.min(cards.length, maxVisibleCards)
      const totalGapHeight = (effectiveN - 1) * cardGap
      // Subtract a small per-column safety buffer — browser line-height
      // computation rounds at sub-pixel boundaries, and rounding up by
      // half a pixel × N cards adds up to a couple pixels of overshoot.
      // This buffer gives us guaranteed undershoot at the cost of a
      // hairline of empty space at the column bottom — exactly the
      // tradeoff the user asked for.
      const safetyBuffer = 4
      const targetCardHeight =
        (list.clientHeight - totalGapHeight - safetyBuffer) / effectiveN

      // Use the MAX non-outcome height across cards in the column, not
      // the average. Awaiting-review cards carry [Temper][Compost] in
      // the meta row which adds a couple pixels over the in-flight
      // baseline; in-flight cards may carry the worker pill. Sizing to
      // the average over-allocates outcome space to the chunkier cards,
      // which is exactly the overshoot symptom. Max is conservative.
      let maxNonOutcome = 0
      for (const card of cards) {
        const outcome = card.querySelector<HTMLElement>('.kbn-card-outcome')
        const outcomeHeight = outcome ? outcome.offsetHeight : 0
        const nonOutcome = card.offsetHeight - outcomeHeight
        if (nonOutcome > maxNonOutcome) maxNonOutcome = nonOutcome
      }

      const targetOutcomeHeight = targetCardHeight - maxNonOutcome
      if (targetOutcomeHeight <= 0) continue

      const targetLines = Math.floor(targetOutcomeHeight / lineHeight)
      const clamp = Math.max(minClamp, targetLines)
      if (clamp <= minClamp) continue

      col.style.setProperty('--card-line-clamp', String(clamp))
    }
  }

  private claimInitialFocus(): void {
    if (this.hasClaimedInitialFocus || !this.body) return
    // Nothing to claim while a temporal view is up — the Desk's column heads
    // are hidden, so focusing one would be a silent no-op that also burns the
    // one-shot flag.
    if (this.activeViewId !== 'desk') return

    this.hasClaimedInitialFocus = true
    window.requestAnimationFrame(() => {
      if (!this.body) return
      const active = document.activeElement
      if (active instanceof HTMLElement && this.container?.contains(active)) return
      this.body.querySelector<HTMLElement>('.kbn-col-head')?.focus({ preventScroll: true })
    })
  }

  private captureScrollSnapshot(): KanbanScrollSnapshot | null {
    if (!this.body) return null

    const columns: Partial<Record<ColumnKind, number>> = {}
    for (const col of this.body.querySelectorAll<HTMLElement>('.kbn-col[data-column]')) {
      const kind = col.dataset.column as ColumnKind | undefined
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      if (kind && list) columns[kind] = list.scrollTop
    }
    // The drag horizon's own scrollLeft is deliberately NOT captured: it only
    // exists during a drag, and a drag never survives a re-render.
    return {
      bodyLeft: this.body.scrollLeft,
      bodyTop: this.body.scrollTop,
      columns,
    }
  }

  private restoreScrollSnapshot(snapshot: KanbanScrollSnapshot | null): void {
    if (!this.body || !snapshot) return

    const restore = (): void => {
      if (!this.body) return
      this.body.scrollLeft = snapshot.bodyLeft
      this.body.scrollTop = snapshot.bodyTop
      for (const [kind, scrollTop] of Object.entries(snapshot.columns) as [ColumnKind, number][]) {
        const list = this.body.querySelector<HTMLElement>(`.kbn-col[data-column="${kind}"] .kbn-col-list`)
        if (list) list.scrollTop = scrollTop
      }
      this.updateBodyScrollAffordance()
    }

    restore()
    window.requestAnimationFrame(restore)
  }

  /** Stash the latest response so drop handlers can resolve cards by id. */
  private lastResponse: KanbanResponse | null = null
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

  /** GET the loom-wide composite fiber feed from the Shuttle daemon.
   *  `buildKanbanResponseFromComposite` classifies it frontend-side. */
  private kanbanUrl(): string {
    return `${this.shuttleBase}/api/v1/fibers/composite`
  }

  /** POST a drag transition to the daemon. The daemon maps the column `target`
   *  → a lifecycle action and owner-routes by `origin`, carried in the body. */
  private transitionUrl(): string {
    return `${this.shuttleBase}/api/v1/transition`
  }

  /** POST a felt frontmatter edit (horizon / cold / due) to the daemon,
   *  owner-routed by `origin`. */
  private horizonUrl(): string {
    return `${this.shuttleBase}/api/v1/felt-edit`
  }

  /** POST a force/ad-hoc dispatch to the daemon, owner-routed by `origin`. */
  private requeueUrl(): string {
    return `${this.shuttleBase}/api/v1/dispatch`
  }

  /** POST a shuttle lifecycle verb (install/repeat/pin/uninstall/…) to the
   *  daemon, owner-routed by `origin`. */
  private lifecycleUrl(): string {
    return `${this.shuttleBase}/api/v1/lifecycle`
  }

  /** POST a hard-kill of a fiber's live worker to the daemon, owner-routed by
   *  `origin`. */
  private killUrl(): string {
    return `${this.shuttleBase}/api/v1/kill`
  }

  /** POST a boot-quarantine release to the daemon, owner-routed by `origin`
   *  (the held card's owning host). */
  private releaseUrl(): string {
    return `${this.shuttleBase}/api/v1/quarantine/release`
  }

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
      const res = await fetch(this.releaseUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: shuttleHost }),
      })
      if (!res.ok) {
        this.showBanner(`Couldn't release the hold${shuttleHost ? ` on ${shuttleHost}` : ''}: ${await errorMessageFromResponse(res, 'release failed')}`, 'error')
        return
      }
      this.announce(`Released held launches${shuttleHost ? ` on ${shuttleHost}` : ''}; dispatch resumes on the next tick.`)
      await this.fetchAndRender()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
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
   */
  private async killWorkerIfRunning(card: KanbanCard): Promise<void> {
    if (!card.runningWorker) return
    try {
      const res = await fetch(this.killUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fiber_id: card.id, origin: card.originId }),
      })
      if (!res.ok) {
        this.showBanner(`Couldn't stop the worker for “${card.name}”: ${await errorMessageFromResponse(res, 'kill failed')}`, 'error')
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      this.showBanner(`Couldn't stop the worker for “${card.name}”: ${msg}`, 'error')
    }
  }

  /**
   * Drag a *running* pinned role off In-flight onto the strip: stop its worker
   * and let it come to rest. The board invariant — a worker is alive only while
   * its card sits in In-flight — applied to the one card kind that lives on the
   * strip when idle. No reshape (it's already pinned); the kill + refetch is the
   * whole gesture, and the optimistic pin already landed it on the strip.
   */
  private async stopRunningPinnedRole(card: KanbanCard): Promise<void> {
    await this.killWorkerIfRunning(card)
    this.announce(`Stopped “${card.name}”; resting on the Pinned strip.`)
    await this.fetchAndRender()
  }

  /** Lightweight auto-poll while mounted. 15s interval. */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => {
      // Never rebuild the board out from under a held card. The drop targets
      // would move mid-gesture, and — worse — the source node gets replaced, so
      // its `dragend` listener dies with it and the drag state never clears,
      // stranding the drag horizon open across the top of the page. The drag is
      // seconds long and every drop refetches on landing, so nothing goes stale
      // for waiting.
      if (this.dragSourceId !== null) return
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

    const verticalDelta = e.deltaY
    const horizontalDelta = e.deltaX
    if (Math.abs(verticalDelta) < Math.abs(horizontalDelta)) return

    const boardDelta = verticalDelta
    if (boardDelta === 0) return

    e.preventDefault()
    this.body.scrollLeft += boardDelta
    this.updateBodyScrollAffordance()
  }

  /**
   * Engage (or release) the cycle lens and repaint the Desk from the response
   * already in hand. No fetch: membership is derived from data the board has,
   * so the lens turns on at the speed of a repaint.
   */
  private setLensCycle(cycleId: string | null): void {
    if (this.lensCycleId === cycleId) return
    this.lensCycleId = cycleId
    if (this.lastResponse) this.render(this.lastResponse)
  }

  private handleKanbanKeyDown(e: KeyboardEvent): void {
    if (!this.body) return
    // Escape releases the lens FIRST, before it can reach the workspace handler
    // that closes the whole board. Releasing a lens and closing the board are
    // both "back out of what I'm looking at"; the nearer one wins.
    if (e.key === 'Escape' && this.lensCycleId !== null && this.activeViewId === 'desk') {
      e.preventDefault()
      e.stopPropagation()
      this.setLensCycle(null)
      return
    }
    if (this.handleViewHotkey(e)) return
    // Column Tab-nav is a Desk gesture — a temporal view owns its own focus
    // order, and the Desk's column heads are display:none behind it anyway.
    if (e.key !== 'Tab' || this.activeViewId !== 'desk') return

    const active = document.activeElement as HTMLElement | null
    const heads = Array.from(this.body.querySelectorAll<HTMLElement>('.kbn-col-head'))
      .filter(head => head.offsetParent !== null)
    if (heads.length === 0) return

    const activeHead = active?.closest<HTMLElement>('.kbn-col-head')
    const activeCol = active?.closest<HTMLElement>('.kbn-col')
    const activeColHead = activeCol?.querySelector<HTMLElement>('.kbn-col-head') ?? null
    const currentHead = activeHead ?? activeColHead
    const fallbackIndex = this.currentColumnIndexFromScroll(heads)
    const index = currentHead && this.body.contains(currentHead)
      ? heads.indexOf(currentHead)
      : fallbackIndex

    if (index === -1) return

    e.preventDefault()
    e.stopPropagation()

    const nextIndex = (index + (e.shiftKey ? -1 : 1) + heads.length) % heads.length
    const next = heads[nextIndex]
    next.focus({ preventScroll: true })
    this.scrollColumnToStart(next.closest<HTMLElement>('.kbn-col'))
    this.updateBodyScrollAffordance()
  }

  private currentColumnIndexFromScroll(heads: HTMLElement[]): number {
    if (!this.body) return -1

    const bodyLeft = this.body.getBoundingClientRect().left
    const distances = heads.map((head, index) => {
      const col = head.closest<HTMLElement>('.kbn-col')
      const distance = col ? Math.abs(col.getBoundingClientRect().left - bodyLeft) : Number.POSITIVE_INFINITY
      return { index, distance }
    })
    distances.sort((a, b) => a.distance - b.distance)
    return distances[0]?.index ?? -1
  }

  private scrollColumnToStart(col: HTMLElement | null): void {
    if (!this.body || !col) return

    const bodyLeft = this.body.getBoundingClientRect().left
    const colLeft = col.getBoundingClientRect().left
    const paddingLeft = Number.parseFloat(window.getComputedStyle(this.body).paddingLeft) || 0
    this.body.scrollTo({
      left: this.body.scrollLeft + colLeft - bodyLeft - paddingLeft,
      behavior: 'smooth',
    })
  }

  private handleBodyDragOver(e: DragEvent): void {
    if (!this.body || !this.dragSourceId || this.body.classList.contains('kbn-body-zoomed')) return
    if (this.body.scrollHeight <= this.body.clientHeight) return

    const rect = this.body.getBoundingClientRect()
    const edge = 96
    const maxStep = 34
    const topPressure = Math.max(0, edge - (e.clientY - rect.top))
    const bottomPressure = Math.max(0, edge - (rect.bottom - e.clientY))
    const direction = bottomPressure > 0 ? 1 : topPressure > 0 ? -1 : 0
    const pressure = Math.max(topPressure, bottomPressure) / edge

    this.dragAutoScrollVelocity = direction === 0
      ? 0
      : direction * Math.max(10, Math.round(Math.pow(pressure, 1.35) * maxStep))

    if (this.dragAutoScrollVelocity === 0) {
      this.stopDragAutoScroll()
      return
    }

    this.startDragAutoScroll()
  }

  private handleBodyDragLeave(e: DragEvent): void {
    if (!this.body) return
    if (e.relatedTarget && this.body.contains(e.relatedTarget as Node)) return
    this.stopDragAutoScroll()
  }

  private startDragAutoScroll(): void {
    if (this.dragAutoScrollFrame !== null) return

    const tick = (): void => {
      if (!this.body || !this.dragSourceId || this.dragAutoScrollVelocity === 0) {
        this.stopDragAutoScroll()
        return
      }

      this.body.scrollTop += this.dragAutoScrollVelocity
      this.updateBodyScrollAffordance()
      this.dragAutoScrollFrame = window.requestAnimationFrame(tick)
    }

    this.dragAutoScrollFrame = window.requestAnimationFrame(tick)
  }

  private stopDragAutoScroll(): void {
    // Every dragend / drop path in the modal funnels through here. Also
    // wind down the horizon's horizontal edge-scroll so its rAF tick
    // doesn't keep running past the drag's lifetime.
    this.surfaces.stopEdgeScroll()
    this.dragAutoScrollVelocity = 0
    if (this.dragAutoScrollFrame === null) return
    window.cancelAnimationFrame(this.dragAutoScrollFrame)
    this.dragAutoScrollFrame = null
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

// ── Fiber Detail Modal ───────────────────────────────────────────────────────
//
// Intermediate console-style modal for editing a kanban card without opening
// full vellum. Opens on card click; provides editable outcome, shuttle agent
// selector, and parent-fiber autocomplete. "Open in vellum" deep-links to
// the fiber's full editor for more advanced changes.

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Lift `cardId` out of whichever single surface of `resp` holds it. Returns
 * the lifted card (null if absent) plus the surface arrays with it removed —
 * `drop` returns the same array reference when the card isn't in a list, so
 * untouched surfaces are shared with the input and only the source surface
 * actually changes. The shared basis both optimistic relocators build on.
 */
function liftCardFromSurfaces(resp: KanbanResponse, cardId: string): {
  card: KanbanCard | null
  now: KanbanResponse['now']
  pinned: KanbanCard[]
  timeline: KanbanResponse['timeline']
  stash: KanbanCard[]
} {
  let card: KanbanCard | null = null
  const drop = (list: KanbanCard[]): KanbanCard[] => {
    const idx = list.findIndex((c) => c.id === cardId)
    if (idx < 0) return list
    card = list[idx]
    return [...list.slice(0, idx), ...list.slice(idx + 1)]
  }
  return {
    now: {
      drafts: drop(resp.now.drafts),
      inFlight: drop(resp.now.inFlight),
      awaitingReview: drop(resp.now.awaitingReview),
    },
    pinned: drop(resp.pinned),
    timeline: {
      ...resp.timeline,
      past: drop(resp.timeline.past),
      futureDated: drop(resp.timeline.futureDated),
      anytimeSoon: drop(resp.timeline.anytimeSoon),
    },
    stash: drop(resp.stash),
    card,
  }
}

/**
 * Reassemble a response from mutated surfaces with the length-derived totals
 * recomputed so the masthead stats line stays honest until the reconcile
 * lands. `temperedTotal` is a historical count that can exceed the recent-N
 * `past` slice, so it's supplied explicitly rather than recounted.
 */
function withSurfaces(
  resp: KanbanResponse,
  s: {
    now: KanbanResponse['now']
    pinned: KanbanCard[]
    timeline: KanbanResponse['timeline']
    stash: KanbanCard[]
    temperedTotal: number
  },
): KanbanResponse {
  return {
    ...resp,
    now: s.now,
    pinned: s.pinned,
    timeline: s.timeline,
    stash: s.stash,
    totals: {
      ...resp.totals,
      drafts: s.now.drafts.length,
      inFlight: s.now.inFlight.length,
      awaitingReview: s.now.awaitingReview.length,
      past: s.timeline.past.length,
      futureDated: s.timeline.futureDated.length,
      anytimeSoon: s.timeline.anytimeSoon.length,
      stash: s.stash.length,
      pinned: s.pinned.length,
    },
    temperedTotal: Math.max(0, s.temperedTotal),
  }
}

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
 * The warning is part of the contract, not debug leftovers. This function
 * replaces a lookup that returned quietly on a miss, which made a dead click
 * indistinguishable from a working one and cost a browser session to find. A
 * no-op that says nothing is its own defect class; the next unresolvable id
 * announces itself.
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
 * Optimistic relocation of one card to a lifecycle `target` column, returned
 * as a fresh KanbanResponse (the input is never mutated). Returns null when
 * the card isn't anywhere in `resp` — the caller then skips optimism and
 * leans on the post-commit refetch alone.
 *
 * This honors the gesture's *named* destination; it does NOT re-derive
 * placement from fiber fields (that stays the server's `classifyFiber`). It
 * only patches the minimal fields the destination's own rendering reads — the
 * past lane keys off `status`/`tempered` and a `closedAt` day-column, and
 * closing the fiber drops the running-worker pill. `temperedTotal` is adjusted
 * by the move *direction* rather than recounted off the (possibly capped)
 * array.
 */
export function applyOptimisticTransition(
  resp: KanbanResponse | null,
  cardId: string,
  target: ColumnKind,
  nowIso: string = new Date().toISOString(),
): KanbanResponse | null {
  if (!resp) return null
  const wasTempered = resp.timeline.past.some((c) => c.id === cardId && c.tempered === true)
  const { card, now, pinned, timeline, stash } = liftCardFromSurfaces(resp, cardId)
  if (!card) return null

  const moved: KanbanCard = { ...card }
  // Any UNTEMPERED non-draft state counts, not just awaiting (status:closed):
  // Temper can land while the run is still status:active (worker alive or just
  // killed, exit writer not yet run) and the daemon resolves it to accept
  // there too — the morning-post temper bug. Mirrors shuttle's actions.ex.
  const isCyclicalAwaiting =
    card.status !== 'open' && card.tempered === undefined &&
    (card.shuttleKind === 'standing' || card.shuttleKind === 'pinned')
  if (target === 'tempered' && isCyclicalAwaiting) {
    // Dropping the awaiting run of a cyclical role on Tempered is ACCEPT —
    // the daemon re-arms the role (status:active, verdict cleared) rather
    // than terminating it, so the card's home is the strip (pinned) or the
    // timeline at its next launch (standing), NOT the past lane. Honoring
    // the re-arm here keeps optimism equal to the committed reclassify
    // (the no-snap-back invariant).
    moved.status = 'active'
    moved.tempered = undefined
    moved.closedAt = undefined
    moved.runningWorker = undefined
    moved.runtimePhase = undefined
    if (card.shuttleKind === 'pinned') {
      return withSurfaces(resp, { now, pinned: [moved, ...pinned], timeline, stash, temperedTotal: resp.temperedTotal })
    }
    const nowMs = Date.parse(nowIso)
    moved.nextLaunchAt = nextStandingLaunch(
      {
        shuttleKind: 'standing',
        status: 'active',
        shuttleSchedule: card.shuttleSchedule ? { expr: card.shuttleSchedule, tz: card.shuttleTz ?? 'UTC' } : undefined,
      },
      nowMs,
    )
    const launchMs = moved.nextLaunchAt ? Date.parse(moved.nextLaunchAt) : NaN
    const withinStrip = Number.isFinite(launchMs) && launchMs - nowMs <= STANDING_TIMELINE_HORIZON_MS
    if (withinStrip) timeline.futureDated = [...timeline.futureDated, moved]
    else timeline.anytimeSoon = [...timeline.anytimeSoon, moved]
    return withSurfaces(resp, { now, pinned, timeline, stash, temperedTotal: resp.temperedTotal })
  }
  if (target === 'tempered' || target === 'composted') {
    moved.status = 'closed'
    moved.tempered = target === 'tempered'
    moved.runningWorker = undefined           // closing the fiber stops its worker
    moved.closedAt = card.closedAt ?? nowIso  // past lane skips cards with no closedAt day-column
    timeline.past = [moved, ...timeline.past] // past renders recency-desc — freshest first
  } else if (target !== 'pinned') {
    // `pinned` is never a drag/optimistic target — pinned cards dispatch *out*
    // (pinned → inFlight), never *in*. The guard keeps `now[target]` indexed by
    // the three Now columns only.
    //
    // Patch the fields the destination's own rendering + the next classify
    // read, mirroring the committed verbs: drafts = reopen-as-draft/pause +
    // park-on-desk; awaitingReview = close with the verdict cleared; inFlight
    // = dispatch (the worker pill arrives with the refetch).
    if (target === 'drafts') {
      moved.status = 'open'
      moved.tempered = undefined
      moved.closedAt = undefined
      moved.runningWorker = undefined
      moved.runtimePhase = undefined
      moved.storedHorizon = undefined
      moved.effectiveHorizon = 'now'
      moved.drifted = false
      moved.due = undefined
    } else if (target === 'awaitingReview') {
      moved.status = 'closed'
      moved.tempered = undefined
      moved.closedAt = card.closedAt ?? nowIso
      moved.runningWorker = undefined
      moved.runtimePhase = undefined
    } else if (target === 'inFlight') {
      moved.status = 'active'
      moved.tempered = undefined
      moved.closedAt = undefined
    }
    now[target] = [...now[target], moved]
  }

  const temperedDelta = (target === 'tempered' ? 1 : 0) - (wasTempered ? 1 : 0)
  return withSurfaces(resp, { now, pinned, timeline, stash, temperedTotal: resp.temperedTotal + temperedDelta })
}

/**
 * Optimistic relocation of one card to Resting — the holding grid, dateless or
 * snoozed. The unambiguous-destination twin of {@link applyOptimisticTransition}:
 * `now` is deliberately excluded because the Now surface doesn't name a single
 * lifecycle column, so placing there would mean reclassifying. Returns null
 * when the card is absent.
 */
export function applyOptimisticSurface(
  resp: KanbanResponse | null,
  cardId: string,
  opts: { cold?: boolean; due?: string | null } = {},
): KanbanResponse | null {
  if (!resp) return null
  const { card, now, pinned, timeline, stash } = liftCardFromSurfaces(resp, cardId)
  if (!card) return null

  // A planning-surface drop parks the card as a draft (commitSurface's
  // park-as-draft transition): closed reopens to open with the verdict
  // cleared, active pauses to open, and the kill strips the worker pill —
  // mirrored here so the optimistic card matches the committed reclassify
  // (the no-snap-back invariant).
  const moved: KanbanCard = {
    ...card,
    status: 'open',
    tempered: undefined,
    closedAt: undefined,
    runningWorker: undefined,
    runtimePhase: undefined,
    storedHorizon: 'stashed',
    effectiveHorizon: 'stashed',
    drifted: false,
    cold: opts.cold ?? false,
    // A bare stash clears the deadline; a SNOOZE is a stash that keeps one (the
    // caller passed an explicit day). Dropping the due here would have shown a
    // dateless resting card for one frame and then snapped the date back in on
    // the refetch — the optimistic card must be the card the write produces.
    due: opts.due ?? undefined,
  }
  return withSurfaces(resp, { now, pinned, timeline, stash: [moved, ...stash], temperedTotal: resp.temperedTotal })
}

/**
 * Optimistic relocation of one card onto the Pinned strip — the "onto the
 * shelf" twin of {@link applyOptimisticSurface}. Patches the minimal fields the
 * strip + classifier read: `kind:pinned`, resting `status:active`, and the
 * schedule cleared (a pinned block has none). Returns null when the card is
 * absent. The trailing refetch reconciles against the daemon's reshape.
 */
export function applyOptimisticPin(
  resp: KanbanResponse | null,
  cardId: string,
): KanbanResponse | null {
  if (!resp) return null
  const { card, now, pinned, timeline, stash } = liftCardFromSurfaces(resp, cardId)
  if (!card) return null

  const moved: KanbanCard = {
    ...card,
    shuttleKind: 'pinned',
    status: 'active',
    shuttleSchedule: undefined,
    shuttleTz: undefined,
    nextLaunchAt: undefined,
  }
  return withSurfaces(resp, {
    now,
    pinned: [moved, ...pinned],
    timeline,
    stash,
    temperedTotal: resp.temperedTotal,
  })
}
