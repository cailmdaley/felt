/**
 * KanbanModal — three-surface view of Shuttle-managed fibers.
 *
 * Top-to-bottom on a long page:
 *
 *   Now      — the desk. Three lifecycle columns (Drafts | In flight |
 *              Awaiting review). The dense workflow board for what's
 *              actively being worked.
 *   Timeline — the road behind and ahead. Past landings on the left,
 *              future-dated fibers on the right. One horizontal
 *              axis, scrollable.
 *   Stash    — visible cluster grid keyed on containment-path's first
 *              meaningful project token. Held-open clusters (cold:true)
 *              appear below warm clusters in a dimmer style.
 *
 * Interaction:
 *   • Drag a card down onto a timeline date column → due=that date
 *     (legacy horizon storage clears).
 *   • Drag into the stash → horizon=stashed.
 *   • Drag back up to the now-board → clear horizon/cold.
 *   • Drop on a now-board column header routes through the daemon's
 *     /api/v1/transition lifecycle path.
 *   • Click a card body to open its detail modal.
 *
 * Classification happens once, frontend-side: `classifyFiber` in
 * `src/ui/KanbanRules.ts` buckets the composite feed into surfaces. The
 * drag handler's only knob is which surface command plus due/cold tuple
 * to POST.
 */

import './KanbanModal.css'
import { FiberDetailModal } from './FiberDetailModal.js'
import type {
  ColumnKind,
  HorizonKind,
  KanbanCard,
  KanbanOriginStaleness,
  KanbanResponse,
  RemoteShuttleSnapshotDiagnostic,
} from './KanbanTypes.js'
import { dispatchIneligibleReason, errorMessageFromResponse } from './KanbanModalShared.js'
import { COLUMN_TITLES, KanbanSurfaceRenderer, SURFACE_TITLE, findCardColumn } from './KanbanSurfaces.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { nextStandingLaunch, STANDING_TIMELINE_HORIZON_MS } from './KanbanRules.js'
import { buildCityResolver, type CityFeltRoot } from './KanbanCityResolver.js'
import { shouldRunVisiblePoll } from '../runtime/PageAttention'
import { fetchWithBootPrefetch } from '../runtime/bootPrefetch'

export { FiberDetailModal } from './FiberDetailModal.js'
export { dispatchIneligibleReason } from './KanbanModalShared.js'

// (Action-button helpers removed — drag is the only transition surface for
// now. The DnD drop handler reads `target` from the column the card lands
// on, no per-card mapping needed. Re-introduce TRANSITIONS_FROM if a
// keyboard / context-menu path returns later.)

interface KanbanModalOptions {
  /** Called when the user activates a card — host opens the fiber's md in vellum. */
  onOpenFiber: (card: KanbanCard, options?: { openInNewWindow?: boolean }) => void
  /**
   * Called when the user clicks a card's running-worker indicator. The host
   * resolves the tmux session name to a portolan session id and focuses that
   * kitty tab. No-op when the running tmux session isn't tracked by portolan.
   */
  onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  /**
   * Called when the user clicks a sent deliverable in a card's detail panel
   * — host opens the absolute path in vellum's file viewer (owner-routed by
   * the card's origin for remote paths). Optional; absent → inert rows.
   */
  onOpenFile?: (fullPath: string, originId: string) => void
  /**
   * Called right after a successful Shuttle dispatch (Resume / New Session
   * buttons → daemon `tmux new-session -d` succeeded) to attach a kitty
   * tab to the freshly-spawned tmux session by name. Distinct from
   * `onOpenWorker` because portolan's SessionTracker hasn't polled the
   * new session yet, so a session-id lookup would silently no-op.
   *
   * Pairs with the wait-for-client gate in shuttle's run-script: the
   * harness pauses until an interactive client attaches, then renders
   * its first frame at the kitty terminal's size instead of tmux's
   * detached default-size 80x24. Without this auto-attach the gate
   * would time out (~10s) and the harness would proceed at default-size,
   * leaving content baked into scrollback at 80 cols.
   */
  onAttachFreshTmux?: (tmuxSessionName: string) => void
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
  /** Pinned cities' `.felt` realpaths, read FRESH per fetch (cities update on WS
   *  pushes) to build the browser `CityResolver` that attributes composite-feed
   *  rows to cities. Omit in read-only/test contexts (rows go unattributed). */
  getCityFeltRoots?: () => CityFeltRoot[]
}

/**
 * When set, scope the kanban to a single city via `?cityId=` query param.
 * Default null = loom-wide (the original v0 behaviour). Stage 1 of the
 * vellum-kanban constitution: local-origin cities only; remote-origin
 * city scoping unlocks in Stage 3.
 */
interface KanbanCityScope {
  cityId: string
  cityName: string
}

interface KanbanScrollSnapshot {
  bodyLeft: number
  bodyTop: number
  columns: Partial<Record<ColumnKind, number>>
  timelineLeft?: number
}

export class KanbanModal {
  private readonly onOpenFiber: (card: KanbanCard, options?: { openInNewWindow?: boolean }) => void
  private readonly onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly openWorkerAfterGesture?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly onOpenFile?: (fullPath: string, originId: string) => void
  private readonly onAttachFreshTmux?: (tmuxSessionName: string) => void
  private readonly onStashClick?: () => void
  private readonly onNewIdeaClick?: () => void
  private readonly shuttleBase: string
  private readonly getCityFeltRoots?: () => CityFeltRoot[]
  private readonly handleDocumentKeyDown = (e: KeyboardEvent): void => this.handleKanbanKeyDown(e)

  private container: HTMLDivElement | null = null
  private body: HTMLDivElement | null = null
  private liveEl: HTMLDivElement | null = null
  private bannerEl: HTMLDivElement | null = null
  private inflightFetchToken = 0
  /**
   * Backing field for `dragSourceId`. Mutate via the property accessor below
   * (or via `setDragSource`) so the `kbn-dragging` body class stays in sync —
   * the CSS keeps the hook around even though no rule currently targets it
   * (the original `.kbn-dragging .kbn-tl-card { pointer-events: none }`
   * Chromium-only fix swept up timeline-card sources too; the strip-level
   * elementsFromPoint fallback in installTimelineStripDragFallback replaced
   * it in every engine). Future drag-state CSS can hang off this class.
   */
  private _dragSourceId: string | null = null
  private get dragSourceId(): string | null { return this._dragSourceId }
  private set dragSourceId(value: string | null) {
    this._dragSourceId = value
    if (this.body) this.body.classList.toggle('kbn-dragging', value !== null)
  }
  private dragAutoScrollFrame: number | null = null
  private dragAutoScrollVelocity = 0
  private bannerTimer: number | null = null
  private hasClaimedInitialFocus = false
  /** Null = global (default). Set by mount(...{cityScope}); cleared by
   *  unmount(). */
  private cityScope: KanbanCityScope | null = null
  /** Bug 3: lightweight auto-poll while mounted. 15s default. */
  private pollTimer: number | null = null
  private readonly pollIntervalMs = 15_000
  private timelinePastDays = 0
  private lastFetchStartedAt: number | null = null
  /** Disconnects ResizeObserver + scroll listener installed by the timeline
   *  strip's adaptive-height handler. Called at the start of each render
   *  (the strip gets rebuilt) and on unmount. */
  private timelineAdaptiveCleanup: (() => void) | null = null
  /** Intermediate fiber-detail modal — one instance, re-used across opens. */
  private detailModal: FiberDetailModal | null = null
  private readonly surfaces: KanbanSurfaceRenderer
  /** Unsubscribe from the kanban-delta bus; set on mount, called on unmount. */

  constructor(options: KanbanModalOptions) {
    this.onOpenFiber = options.onOpenFiber
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
    this.onOpenFile = options.onOpenFile
    this.onAttachFreshTmux = options.onAttachFreshTmux
    this.onStashClick = options.onStashClick
    this.onNewIdeaClick = options.onNewIdeaClick
    this.shuttleBase = options.shuttleBase ?? `http://${window.location.hostname}:4000`
    this.getCityFeltRoots = options.getCityFeltRoots
    this.detailModal = new FiberDetailModal(
      this.shuttleBase,
      this.onOpenFiber,
      () => { void this.fetchAndRender() },
      this.onAttachFreshTmux,
      // Terminal moves (Temper / Compost) route through the same optimistic
      // path as the inline card buttons and drags — instant relocation,
      // background commit, reconcile.
      (card, target) => this.transition(card, target),
      // Status-pill double-click → focus the running worker's kitty tab.
      this.openWorkerAfterGesture,
      // City → project_dir for shuttle installs (promote + reshape echo).
      (cityId) =>
        this.getCityFeltRoots?.().find((r) => r.cityId === cityId)?.projectPath || undefined,
      // Sent-files strip → vellum file viewer via the host's openFile.
      { onOpenFile: (fullPath, originId) => this.onOpenFile?.(fullPath, originId) },
    )
    this.surfaces = new KanbanSurfaceRenderer({
      getDragSourceId: () => this.dragSourceId,
      setDragSourceId: (id) => { this.dragSourceId = id },
      getLastResponse: () => this.lastResponse,
      stopDragAutoScroll: () => this.stopDragAutoScroll(),
      transition: (card, target) => this.transition(card, target),
      setSurface: (card, horizon, opts) => this.setSurface(card, horizon, opts),
      pin: (card) => this.pinRole(card),
      openDetail: (card, column) => this.detailModal?.open(card, this.cityScope?.cityId, column),
      openWorker: this.openWorkerAfterGesture,
      setTimelineAdaptiveCleanup: (cleanup) => { this.timelineAdaptiveCleanup = cleanup },
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
   * Re-mount with a different `cityScope` is supported in place: scope swap
   * updates the chrome and refetches without rebuilding the DOM. Re-mount
   * onto a different host element isn't supported (call `unmount()` first).
   *
   * @param host  container element; the kanban appends a single child div.
   * @param opts.cityScope  optional per-city scope; null = global aggregation.
   */
  mount(
    host: HTMLElement,
    opts: { cityScope?: KanbanCityScope | null } = {},
  ): void {
    if (this.container !== null) {
      // Already mounted: scope swap is the only meaningful re-call. The
      // masthead (and its scope subtitle) dissolved, so there's no chrome to
      // update — just refetch in place rather than rebuilding DOM from scratch.
      this.cityScope = opts.cityScope ?? null
      void this.fetchAndRender()
      return
    }
    this.cityScope = opts.cityScope ?? null
    this.assembleChrome()
    host.append(this.container!)
    document.addEventListener('keydown', this.handleDocumentKeyDown, true)
    window.addEventListener('resize', this.handleResize)
    void this.fetchAndRender()
    this.startPolling()
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
    document.removeEventListener('keydown', this.handleDocumentKeyDown, true)
    window.removeEventListener('resize', this.handleResize)
    if (this.resizeRaf !== null) {
      window.cancelAnimationFrame(this.resizeRaf)
      this.resizeRaf = null
    }
    this.stopPolling()
    this.timelineAdaptiveCleanup?.()
    this.timelineAdaptiveCleanup = null
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
   * the top (the Timeline ribbon), with only the body's own tight top padding
   * as margin — the standalone web UI has no workspace corner chrome to clear
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

    this.container.append(this.bannerEl, this.body, this.liveEl)
  }

  /** Reset all field state to "not mounted." DOM removal is `unmount()`'s
   *  responsibility; this only clears references. */
  private teardownState(): void {
    this.container = null
    this.body = null
    this.liveEl = null
    this.bannerEl = null
    this.dragSourceId = null
    this.hasClaimedInitialFocus = false
    this.stopDragAutoScroll()
    // Reset scope on every teardown so the next mount lands at default
    // global scope; a follow-on `mount(...{cityScope})` with a scope
    // re-sets before assemble.
    this.cityScope = null
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
   *   • Drag onto a timeline date column → setSurface(card, 'soon', { due });
   *     the edit persists due and clears horizon.
   *   • Drag into stash                   → setSurface(card, 'stashed', { cold? }).
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
    // A block-less human due-card is on the board only by virtue of its `due:`
    // (the daemon's composite feed admits non-shuttle rows via a --has-field
    // due walk). Stashing clears the due, which would drop the card off the
    // board entirely — a silent vanish, not a stash. Refuse with an explanation.
    if (horizon === 'stashed' && card.shuttleKind === undefined) {
      this.showBanner(
        `“${card.name}” is a due-date card without a shuttle block — stashing would drop it off the board. Give it a new date instead, or promote it first.`,
        'info',
      )
      this.announce(`${card.name} has no shuttle block; pick a date instead of stashing.`)
      return
    }

    const wantsCold = horizon === 'stashed' ? (opts.cold ?? false) : undefined
    const due = horizon === 'stashed' && opts.due === undefined ? null : opts.due
    const sameHorizon =
      card.storedHorizon === horizon && (card.cold ?? false) === (opts.cold ?? false)
    const sameDue = due === undefined || (card.due ?? null) === due
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

    // Optimism for the unambiguous destinations: `soon` parks the card on the
    // timeline at its due, `stashed` drops it into the stash grid. `now` stays
    // on the refetch path — the Now surface doesn't name a lifecycle column, so
    // an optimistic placement there would be a reclassification.
    if (horizon === 'soon' || horizon === 'stashed') {
      const optimistic = applyOptimisticSurface(this.lastResponse, card.id, horizon, { cold: wantsCold, due })
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
      // wrong (standing, resting pinned, cyclical awaiting run). Block-less
      // human due-cards are skipped: the lifecycle verbs need a shuttle block
      // (shuttle-ctl refuses without one), and the classifier routes a
      // block-less card to the planning surfaces regardless of open/active,
      // so there is nothing to park.
      if (card.status !== 'open' && card.shuttleKind !== undefined) {
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
   * pinned surface, then composes the daemon reshape (uninstall + pin) in the
   * background and reconciles.
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
      // it's already pinned, so uninstall+pin would be a pointless round-trip.
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
    // longer refused: the `pin` writer refuses status:closed, so commitPin
    // composes a reopen-as-draft first (mirroring the stash drop's park).
    // applyOptimisticPin already lands the card at rest (status:active) on the
    // strip, so the optimistic move holds for a closed source too.
    // A running card dragged onto the strip is stopped first (commitPin kills
    // the worker before the reshape), so it comes to rest on the strip rather
    // than staying in Now via the live-worker override. The optimistic move to
    // the strip therefore holds.
    const optimistic = applyOptimisticPin(this.lastResponse, card.id)
    if (optimistic) this.applyResponse(optimistic)
    void this.commitPin(card)
  }

  /**
   * Network half of {@link pinRole}: uninstall the existing block (pin refuses
   * to clobber), then pin with the fiber's model/host/project_dir echoed so the
   * reshaped block stays owned and dispatchable. Mirrors the FiberDetailModal
   * kind-reshape composition; reconciles via the trailing refetch.
   */
  private async commitPin(card: KanbanCard): Promise<void> {
    try {
      // A running card is stopped before the reshape — `pin` refuses a closed
      // fiber, but a kill writes no status, so the resting role pins cleanly and
      // comes to rest on the strip immediately.
      await this.killWorkerIfRunning(card)
      // `pin` refuses a status:closed fiber, so a closed source (awaiting-review
      // or a tempered past run) is reopened as a draft first — status:open,
      // verdict cleared — exactly the park-as-draft the stash drop composes.
      // pin then sees status:open and brings the role to rest at active. (A
      // bare reopen → active would auto-dispatch before the reshape lands.)
      if (card.status === 'closed') {
        const reopenRes = await fetch(this.transitionUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fiber_id: card.id, target: 'drafts', origin: card.originId }),
        })
        if (!reopenRes.ok) {
          throw new Error(await errorMessageFromResponse(reopenRes, 'Reopen-as-draft failed'))
        }
      }
      // The /lifecycle endpoint keys on `fiber` (not `fiber_id`, which
      // /dispatch and /felt-edit use) — matching FiberDetailModal's reshape.
      await this.postLifecycle({ action: 'uninstall', fiber: card.id, origin: card.originId })
      await this.postLifecycle({
        action: 'pin',
        fiber: card.id,
        origin: card.originId,
        model: card.shuttleAgent,
        host: card.shuttleHost,
        project_dir: this.resolveProjectDir(card),
      })
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

  /** Worker cwd for a reshape: the fiber's own `project_dir`, else the owning
   *  city's project path. Mirrors FiberDetailModal.projectDirFor. */
  private resolveProjectDir(card: KanbanCard): string | undefined {
    return (
      card.shuttleProjectDir ??
      (card.cityId ? this.getCityFeltRoots?.().find((r) => r.cityId === card.cityId)?.projectPath : undefined)
    )
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
      // First mount on a `#mode=kanban` deep link picks up the
      // boot-stashed prefetch (kicked off from index.html's inline
      // script). Subsequent fetches (15s poll, scope swap) hit the
      // fallthrough `fetch()` directly.
      const res = await fetchWithBootPrefetch(this.kanbanUrl())
      if (token !== this.inflightFetchToken) return
      if (!res.ok) {
        this.renderError(`Server returned ${res.status}`)
        return
      }
      // The kanban now reads Shuttle's loom-wide composite feed and classifies
      // it frontend-side — the sole classifier. `parseCompositeFeed` validates
      // the wire shape; `buildKanbanResponseFromComposite` collects → classifies
      // → assembles the exact `KanbanResponse` the renderer already consumes.
      // City attribution is the injected browser `buildCityResolver`, rebuilt
      // each fetch from the latest pinned-city realpaths (cities update on WS
      // pushes); a city-scoped board narrows to its own city.
      const feed = parseCompositeFeed(await res.json())
      const resolveCity = buildCityResolver(this.getCityFeltRoots?.() ?? [])
      const data = buildKanbanResponseFromComposite(feed, {
        resolveCity,
        scopeCityId: this.cityScope?.cityId,
      })
      if (token !== this.inflightFetchToken) return
      // Skip re-render when the response is semantically unchanged —
      // every 15-second poll otherwise tears down ~50 cards × ~30 nodes
      // each just to rebuild them identically. Hash the meaningful
      // payload (columns + totals + staleness); `generatedAt` flickers each
      // poll even on no-op refreshes.
      const sig = this.computeResponseSignature(data)
      const wasFirstRender = this.lastResponse === null
      this.lastResponse = data
      if (!wasFirstRender && sig === this.lastResponseSig) return
      this.lastResponseSig = sig
      this.render(data)
    } catch (err: unknown) {
      if (token !== this.inflightFetchToken) return
      const msg = (err as { message?: string })?.message ?? String(err)
      this.renderError(msg)
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
      sd: shuttleDiagnosticsSignature(data.shuttleDiagnostics),
    })
  }

  private renderError(msg: string): void {
    if (!this.body) return
    this.body.innerHTML = ''
    const errEl = document.createElement('div')
    errEl.className = 'kbn-error'
    errEl.textContent = `Failed to load kanban: ${msg}`
    this.body.append(errEl)
  }

  private render(data: KanbanResponse): void {
    if (!this.body) return

    const scrollSnapshot = this.captureScrollSnapshot()
    const { now, timeline, timelineWindow, stash, pinned, staleness } = data
    this.timelinePastDays = timelineWindow.pastDays
    // The masthead stats line dissolved (board-chrome-redesign) — the board
    // speaks for itself (column counts, the Pinned/Timeline/Stash sections),
    // and stale origins already dim their cards + show "waiting on <host>".

    // Tear down any per-render observers from the previous strip before we
    // throw away the DOM nodes they observed.
    this.timelineAdaptiveCleanup?.()
    this.timelineAdaptiveCleanup = null

    this.body.innerHTML = ''
    this.body.classList.remove('kbn-body-zoomed')

    // "Sky over board" order: the Timeline horizon strip sits at the top of
    // the page, the pinned-role launcher band beneath it, then the Now board,
    // then Stash. Time reads as an illuminated strip you drag work *up* into.
    this.body.append(this.surfaces.renderTimelineSection(timeline, now, timelineWindow, staleness))
    // The Pinned strip always renders (a permanent park/drop target) — see
    // renderPinnedSection; no null guard needed.
    this.body.append(this.surfaces.renderPinnedSection(pinned, staleness))
    this.body.append(this.surfaces.renderNowSection(now, staleness))
    this.body.append(this.surfaces.renderStashSection(stash, staleness))

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
    // Scroll the timeline strip so today sits ~28% from the left on
    // initial render, matching the playground reference. Skipped when
    // the snapshot already had a horizontal scroll position.
    if (!scrollSnapshot?.timelineLeft) {
      window.requestAnimationFrame(() => this.surfaces.scrollTimelineToToday(this.body, this.timelinePastDays))
    }
    this.lastResponse = data
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
    // Outcome font-size × line-height = 12.5 × 1.4 = 17.5px per line.
    const lineHeight = 17.5
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
    const timeline = this.body.querySelector<HTMLElement>('[data-timeline-wrap]')
    return {
      bodyLeft: this.body.scrollLeft,
      bodyTop: this.body.scrollTop,
      columns,
      timelineLeft: timeline?.scrollLeft,
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
      if (snapshot.timelineLeft !== undefined) {
        const timeline = this.body.querySelector<HTMLElement>('[data-timeline-wrap]')
        if (timeline) timeline.scrollLeft = snapshot.timelineLeft
      }
      this.updateBodyScrollAffordance()
    }

    restore()
    window.requestAnimationFrame(restore)
  }

  renderColumn(
    kind: ColumnKind,
    cards: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    return this.surfaces.renderColumn(kind, cards, staleness)
  }

  renderCard(
    card: KanbanCard,
    kind: ColumnKind,
    originStaleness?: KanbanOriginStaleness,
  ): HTMLElement {
    return this.surfaces.renderCard(card, kind, originStaleness)
  }

  /** Stash the latest response so drop handlers can resolve cards by id. */
  private lastResponse: KanbanResponse | null = null
  /**
   * Signature of the last-rendered response (columns + totals only). Lets
   * fetchAndRender skip identical-payload re-renders — the 15-second poll
   * fires even when nothing changed and rebuilding the column DOM is the
   * dominant frontend cost.
   */
  private lastResponseSig: string | null = null

  // ── URL + chrome helpers (city-scope aware) ────────────────────────────────

  /** GET the loom-wide composite fiber feed from the Shuttle daemon. No
   *  `?cityId=` — the feed is loom-wide and scope narrowing happens
   *  frontend-side in `buildKanbanResponseFromComposite`. */
  private kanbanUrl(): string {
    return `${this.shuttleBase}/api/v1/fibers/composite`
  }

  /** POST a drag transition to the daemon. The daemon maps the column `target`
   *  → a lifecycle action and owner-routes by `origin` (carried in the body),
   *  so no `?cityId=` scoping. */
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

  /** Bug 3: lightweight auto-poll while mounted. 15s interval. */
  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => {
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

  private handleKanbanKeyDown(e: KeyboardEvent): void {
    if (!this.body || e.key !== 'Tab') return

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
    // wind down the horizontal timeline edge-scroll so its rAF tick
    // doesn't keep running past the drag's lifetime.
    this.surfaces.stopTimelineEdgeScroll()
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
 * Optimistic relocation of one card to a planning *surface* — `soon` (parked
 * on the timeline at its `due` day-column) or `stashed` (the dateless holding
 * grid). The unambiguous-destination twin of {@link applyOptimisticTransition}:
 * `now` is deliberately excluded because the Now surface doesn't name a single
 * lifecycle column, so placing there would mean reclassifying. Returns null
 * when the card is absent.
 */
export function applyOptimisticSurface(
  resp: KanbanResponse | null,
  cardId: string,
  horizon: 'soon' | 'stashed',
  opts: { cold?: boolean; due?: string | null } = {},
): KanbanResponse | null {
  if (!resp) return null
  const { card, now, pinned, timeline, stash } = liftCardFromSurfaces(resp, cardId)
  if (!card) return null

  // A planning-surface drop parks the card as a draft (commitSurface's
  // park-as-draft transition): closed reopens to open with the verdict
  // cleared, active pauses to open, and the kill strips the worker pill —
  // mirrored here so the optimistic card matches the committed reclassify
  // (the no-snap-back invariant, KanbanGestures.property.test.ts).
  const moved: KanbanCard = {
    ...card,
    status: 'open',
    tempered: undefined,
    closedAt: undefined,
    runningWorker: undefined,
    runtimePhase: undefined,
    storedHorizon: horizon,
    effectiveHorizon: horizon,
    drifted: false,
  }
  let nextStash = stash
  if (horizon === 'stashed') {
    moved.cold = opts.cold ?? false
    moved.due = undefined                                   // stashing clears the deadline
    nextStash = [moved, ...stash]
  } else {
    moved.cold = undefined
    if (opts.due !== undefined && opts.due !== null) moved.due = opts.due
    timeline.futureDated = [...timeline.futureDated, moved] // placed by due day-column; intra-day order settles on reconcile
  }
  return withSurfaces(resp, { now, pinned, timeline, stash: nextStash, temperedTotal: resp.temperedTotal })
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

function shuttleDiagnosticsSignature(
  diagnostics: KanbanResponse['shuttleDiagnostics'] | undefined,
): Array<Pick<RemoteShuttleSnapshotDiagnostic, 'originId' | 'receivedAt' | 'eligibleCount' | 'blockedCount' | 'orphanCount'>> {
  return (diagnostics?.remoteSnapshots ?? [])
    .map(({ originId, receivedAt, eligibleCount, blockedCount, orphanCount }) => ({
      originId,
      receivedAt,
      eligibleCount,
      blockedCount,
      orphanCount,
    }))
    .sort((a, b) => a.originId.localeCompare(b.originId))
}

