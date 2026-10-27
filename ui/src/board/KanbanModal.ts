/**
 * KanbanModal — the Desk, plus the chronological views it tabs between.
 *
 * The Desk, top to bottom:
 *
 *   Now     — three lifecycle columns (Drafts | In flight | Awaiting review).
 *             The dense workflow board for what is actively being worked.
 *   Resting — deliberately paused work, clustered on the containment path's
 *             first meaningful project token. Held-open clusters (cold:true)
 *             sit below warm ones in a dimmer style. Stored as
 *             `horizon: stashed`; "Resting" is the human name.
 *
 * TIME IS NOT A DESK SURFACE. The chronicle tells the story of past landings
 * and future-dated work, so the Desk's height goes to Now and Resting.
 * What the Desk needs from a day axis is the gesture — "this one on Tuesday"
 * — so it has the drag-reveal horizon: a slim row of future days that appears
 * under the tab strip while a card is in the air and vanishes on drop. See
 * `syncDragHorizon` here and `renderDragHorizon` in KanbanSurfaces.
 *
 * Interaction:
 *   • Drag a card onto a day in the drag horizon → schedule or snooze, decided
 *     by where the card sits (`dayDropHorizon`): a desk or resting card gets
 *     `due` + `horizon: stashed` (snooze); anything else just gets `due`.
 *   • Drag onto today → onto the desk now (due cleared).
 *   • Drag into Resting → horizon=stashed, keeping any future `due:` (which
 *     makes it a snooze that returns on its own); an already-elapsed `due:` is
 *     cleared, and said out loud, because it would bounce the card back.
 *   • Drag back up to the now-board → clear horizon/cold.
 *   • Drop on a now-board column header routes through the daemon's
 *     /api/v1/transition lifecycle path.
 *   • Click a card body to open its channel in the document workspace.
 *
 * Classification happens once, frontend-side: `classifyFiber` in
 * `KanbanRules.ts` buckets the composite feed into surfaces. The drag handler's
 * only knob is which surface command plus due/cold tuple to POST.
 */

import './palette.css'
import './darkControls.css'
import { watchAppearance } from './appearance.js'
import './KanbanModal.css'
import './deskRows.css'
import { Workspace } from './workspace/Workspace.js'
import { Dock, type MeetingJoinResult } from './workspace/Dock.js'
import { confirmWorkerStop } from './workspace/Verdicts.js'
import { constitutionAction } from './workspace/fiberPageState.js'
import { DeskKeyboard } from './DeskKeyboard.js'
import { KeymapHelp } from './KeymapHelp.js'
import { keyIntent } from './keymap.js'
import type { SidebarEntry } from './workspace/SidebarFlight.js'
import { daemonFetch, isDaemonBooting } from './daemonApi.js'
import { inLane } from './requestLanes.js'
import type {
  ColumnKind,
  HorizonKind,
  KanbanCard,
  KanbanResponse,
} from './KanbanTypes.js'
import { hasWorkerToStop } from './KanbanTypes.js'
import { dispatchFailureMessage, isAgentCard, needsProjectDir, postDaemonJson, postForceDispatch, type DispatchFailureBody } from './KanbanModalShared.js'
import { PINNED_TAG, THREAD_PIN, type ThreadPinRequest } from './ThreadPeek.js'
import { COLUMN_TITLES, FALLBACK_DEFAULT_AGENT, KanbanSurfaceRenderer, SURFACE_TITLE, boardCards, threadIndexFor, findCardById, findCardColumn, formatDue } from './KanbanSurfaces.js'
import { moveDestinations, seatAtRest } from './MoveDestinations.js'
import type { MoveAction, MoveBroker } from './MoveDestinations.js'
import { openMoveMenu } from './MoveMenu.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { restPopover } from './RestPopover.js'
import { rolePopover, type RoleChoice, type RoleProfile } from './RolePopover.js'
import { buildKanbanResponseFromComposite, deriveCycleLens, isQuestion, restingCards, surfaceTotals, projectDeskFrontier } from './KanbanReadModel.js'
import { threadKey } from './threads.js'
import {
  dueBouncesFromResting,
  nextStandingLaunch,
  restingUntil,
} from './KanbanRules.js'
import { sameCivilDue } from './civilDay.js'
import { coarsePointer, isMobileViewport, onMobileChange } from './mobile.js'
import { shouldRunVisiblePoll } from '../runtime/PageAttention'
import { joinDeliveryPhrase, meetingStatusUrl, supportedMeetingModes, meetingJoinable, meetingPollDelay, MeetingStopGuard, parseMeetingStatus, type MeetingRecord, type MeetingStatus } from './meeting.js'
import { joinMeeting as requestMeetingJoin, stopMeeting as requestMeetingStop, type MeetingMode } from '../forms/meetingApi'
import { PhoneMeeting, type PhoneCaptureAttempt } from './phoneMeeting'
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
import { isTypingTarget } from './views/ViewRegistry.js'
import { FiberSends } from './fiberSends.js'
import type { DocKey } from './workspace/documents.js'

/** The message a thrown/rejected value carries, for a banner or an announce. */
const errText = (err: unknown): string => (err as { message?: string })?.message ?? String(err)

function registryDefaultAgent(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  for (const value of raw) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    if (record.default === true && typeof record.id === 'string') return record.id
  }
  return null
}

interface KanbanModalOptions {
  /**
   * Called when the user clicks a card's running-worker indicator. The host
   * POSTs the tmux session name to the daemon's `/api/v1/attach`, which
   * raises the matching kitty tab. No-op when there's no running worker.
   */
  onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  /**
   * Called when the user clicks the Drafts lane's `+` stash button. The host
   * (main.ts) opens the StashForm modal. Omit to hide the button (e.g.
   * read-only contexts).
   */
  onStashClick?: () => void
  /**
   * Called when the user clicks the In flight lane's `✶` new-idea button. The host
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
/** A host that refused its agent registry is asked again after this long. */
const AGENT_RETRY_MS = 60_000
const DESK_HOTKEY = '1'

interface KanbanScrollSnapshot {
  bodyLeft: number
  bodyTop: number
  columns: Partial<Record<ColumnKind, number>>
}

export class KanbanModal {
  private readonly onOpenWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly openWorkerAfterGesture?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly openMeetingTerminalAfterGesture?: (tmuxSessionName: string) => void
  private readonly onStashClick?: () => void
  private readonly onNewIdeaClick?: () => void
  private readonly onSettingsClick?: () => void
  private readonly shuttleBase: string
  private readonly handleDocumentKeyDown = (e: KeyboardEvent): void => this.handleKanbanKeyDown(e)
  private readonly handleMeetingVisibilityChange = (): void => {
    if (document.hidden) {
      if (this.meetingPollTimer !== null) window.clearTimeout(this.meetingPollTimer)
      this.meetingPollTimer = null
      this.meetingFetchController?.abort()
    } else if (this.meetingFetchPromise) {
      const pending = this.meetingFetchPromise
      this.meetingFetchController?.abort()
      void pending.then(() => this.fetchMeetingStatus())
    } else {
      void this.fetchMeetingStatus()
    }
  }

  private readonly temporal: TemporalFetchers

  private container: HTMLDivElement | null = null
  private body: HTMLDivElement | null = null
  private liveEl: HTMLDivElement | null = null
  private bannerEl: HTMLDivElement | null = null
  /** Unsubscribes the 700px-threshold watch installed in assembleChrome. */
  private stopMobileWatch: (() => void) | null = null

  /** The view tab strip — persistent chrome, built once in assembleChrome. */
  private tabsEl: HTMLDivElement | null = null
  /**
   * Right-hand end of the tab strip, where the cycle lens chips live. The tabs
   * never fill their row, so the chips ride in the space already there rather
   * than spending a band of vertical space on chrome that is usually empty.
   * Refilled by `render` (the chips carry live member counts); hidden off the
   * Desk by `syncViewChrome`, since a lens is a Desk posture.
   */
  private lensSlotEl: HTMLDivElement | null = null
  /** The bar's Find: one field on every view (constitutions; the Board's folios; the reader's sidebar). */
  private findEl: HTMLInputElement | null = null
  /** The bar's centre while the reader is open: its map of pages. */
  /** The bar's right end while the reader is open: its page count, before Settings. */
  /**
   * Wrapper around the Desk surfaces (Now + Resting).
   * `display: contents` in CSS, so it adds a toggle handle WITHOUT adding a
   * layout box — the sections participate in `.kbn-body`'s flex column as if
   * they were its direct children. Switching to a
   * temporal view sets `display: none` here rather than rebuilding the Desk,
   * so scroll positions, drag state and column line-clamps survive a round
   * trip through another view.
   */
  private deskEl: HTMLDivElement | null = null
  /**
   * Host for the drag-reveal horizon — the slim row of future days a card can
   * be dropped on. Empty at rest; filled for exactly as
   * long as a card is in the air. It sits OUTSIDE `deskEl` so a board re-render
   * (a poll landing mid-drag) can't tear the drop target out from under the
   * cursor — and it is permanently zero-height, the band inside it hanging
   * out of flow over the Now board, so raising it never moves the desk under a
   * cursor that has already aimed (see the CSS block for the full argument).
   */
  private dragHorizonEl: HTMLDivElement | null = null
  /** Full-width slot the active temporal view mounts into. Hidden on Desk. */
  private viewHostEl: HTMLDivElement | null = null
  private activeViewId: BoardViewId = 'desk'
  /** The mounted view, or null on Desk / before the first response lands. */
  private activeView: TemporalView | null = null
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
  private daemonBooting = false
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
    this.syncDragHorizon(value !== null || (this.surfaces?.isDragging() ?? false))
  }
  private dragAutoScrollFrame: number | null = null
  private dragAutoScrollVelocity = 0
  private bannerTimer: number | null = null
  /** Lightweight auto-poll while mounted. 15s default. */
  private pollTimer: number | null = null
  private readonly pollIntervalMs = 15_000
  private lastFetchStartedAt: number | null = null
  private compositeEtag: string | null = null
  private meetingStatus: MeetingStatus = { available: false, modes: [], recorder: null, meeting: null }
  private meetingRecorder: string | null = null
  private meetingStartUncertain = false
  private meetingPollTimer: number | null = null
  private meetingClockTimer: number | null = null
  private meetingFetchPromise: Promise<void> | null = null
  private meetingFetchController: AbortController | null = null
  private readonly meetingStopGuard = new MeetingStopGuard()
  readonly phoneAudio: PhoneMeeting
  private meetingReadEpoch = 0
  /**
   * How many multi-write gestures are still landing.
   *
   * A counter keeps nested writes from releasing the poll guard early.
   * The gesture's own refetch always runs.
   */
  private gestureDepth = 0
  private workspace: Workspace | null = null
  private readonly dock: Dock
  private deskKeyboard: DeskKeyboard | null = null
  /** Each fiber's newest report, for the rows' marks. */
  private fiberSends: FiberSends | null = null
  private keymapHelp: KeymapHelp | null = null
  private workspaceReturnFocus: HTMLElement | null = null
  private workspaceReturnCard: { id: string; origin: string } | null = null
  private readonly surfaces: KanbanSurfaceRenderer

  private readonly handleConversationOpening = (): void => {
    if (this.lastResponse) this.render(this.lastResponse)
    this.dock.refreshConversationOpening()
  }

  private readonly handleThreadPin = (event: Event): void => {
    const { card, pinned } = (event as CustomEvent<ThreadPinRequest>).detail
    void this.pinThread(card, pinned)
  }

  /** Pin or unpin a thread: its `pinned` tag, drawn at once and written through the owner's felt-edit. */
  private async pinThread(card: KanbanCard, pinned: boolean): Promise<void> {
    const key = threadKey(card)
    const mark = (on: boolean): void => {
      for (const c of boardCards(this.lastResponse)) {
        if (threadKey(c) !== key) continue
        const rest = (c.tags ?? []).filter(tag => tag !== PINNED_TAG)
        c.tags = on ? [...rest, PINNED_TAG] : rest
      }
      if (this.lastResponse) this.render(this.lastResponse)
    }
    mark(pinned)
    try {
      await this.postFeltEdit({ fiber_id: card.id, origin: card.originId, [pinned ? 'add' : 'remove']: [PINNED_TAG] }, pinned ? 'Pin failed' : 'Unpin failed')
      this.announce(pinned ? `Pinned ${card.name}` : `Unpinned ${card.name}`)
    } catch (err: unknown) {
      mark(!pinned)
      this.showBanner(`Couldn't ${pinned ? 'pin' : 'unpin'} “${card.name}”: ${errText(err)}`, 'error')
    }
    await this.fetchAndRender()
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
      ? (tmuxSessionName, shuttleHost) => {
          if (coarsePointer()) {
            const link = this.sessionLinkFor(tmuxSessionName)
            if (link) window.location.assign(link)
            return
          }
          window.setTimeout(() => this.onOpenWorker?.(tmuxSessionName, shuttleHost), 0)
        }
      : undefined
    // Meeting Terminal is an explicit request for the daemon-local hark pane.
    // Unlike a worker tap on a phone, it has no app-session link to open.
    this.openMeetingTerminalAfterGesture = this.onOpenWorker
      ? (session) => window.setTimeout(() => this.onOpenWorker?.(session), 0)
      : undefined
    this.onStashClick = options.onStashClick
    this.onNewIdeaClick = options.onNewIdeaClick
    this.onSettingsClick = options.onSettingsClick
    this.shuttleBase = options.shuttleBase ?? `http://${window.location.hostname}:4000`
    this.temporal = options.temporalFetchers ?? createTemporalFetchers(this.shuttleBase)
    this.dock = new Dock(
      this.shuttleBase,
      () => { void this.fetchAndRender() },
      // Expired verdicts enter the optimistic lifecycle path exactly once.
      (card, target) => this.transition(card, target, { verdictCommitted: true }),
      this.openWorkerAfterGesture,
      {
        meeting: {
          canJoin: () => !this.meetingStartUncertain && meetingJoinable(this.meetingStatus) && supportedMeetingModes(this.meetingStatus, isMobileViewport()).length > 0,
          modes: () => supportedMeetingModes(this.meetingStatus, isMobileViewport()),
          recorder: () => this.meetingStatus.recorder ?? null,
          join: (card, mode, note) => this.joinCardMeeting(card, mode, note),
          current: () => this.meetingStatus.meeting,
          stop: (meeting) => this.stopCurrentMeeting(meeting),
          stopRequested: (meeting) => this.meetingStopGuard.isRequested(meeting),
        },
        onRest: card => this.openRestPopover(card),
      },
    )
    // A new report changes a row's mark; reports are throttled to a minute, so
    // this redraw is rare.
    this.fiberSends = new FiberSends(this.shuttleBase, () => {
      if (this.container && this.lastResponse && this.activeViewId === 'desk') this.render(this.lastResponse)
    })
    this.surfaces = new KanbanSurfaceRenderer({
      getLatestReport: card => this.fiberSends?.latest(card),
      getDragSourceId: () => this.dragSourceId,
      setDragSourceId: (id) => { this.dragSourceId = id },
      getLastResponse: () => this.lastResponse,
      stopDragAutoScroll: () => this.stopDragAutoScroll(),
      transition: (card, target) => this.transition(card, target),
      setSurface: (card, horizon, opts) => this.setSurface(card, horizon, opts),
      makeSeat: (card, anchor) => this.makeSeat(card, anchor),
      openDetail: (card, forceRail) => { this.openDocumentChannel(card); if (forceRail) this.workspace?.forceThreadRail() },
      onRest: card => this.openRestPopover(card),
      getFleetDefaultAgent: (origin) => this.fleetDefaultAgents.get(origin) ?? FALLBACK_DEFAULT_AGENT,
      onCardLongPress: (card, anchor) => this.openMoveMenuFor(card, anchor),
      openWorker: this.openWorkerAfterGesture,
      releaseQuarantine: (host) => this.releaseQuarantine(host),
      onStashClick: this.onStashClick,
      onNewIdeaClick: this.onNewIdeaClick,
      getMeeting: () => this.meetingStatus.meeting,
      getPhoneMeeting: () => this.phoneAudio,
      isMeetingStopRequested: (meeting) => this.meetingStopGuard.isRequested(meeting),
      onMeetingTerminal: (session) => this.openMeetingTerminalAfterGesture?.(session),
      onMeetingStop: (meeting) => this.stopCurrentMeeting(meeting),
      onRefresh: () => void this.refreshFromSource(),
    })
    this.phoneAudio = new PhoneMeeting(this.shuttleBase, () => this.presentMeeting(), () => this.surfaces.updatePhoneLevel())
  }

  /** Capture's response supersedes reads that began before recording started. */
  meetingStarted(meeting: MeetingRecord | null): void {
    this.meetingReadEpoch += 1
    if (meeting) {
      this.meetingRecorder = meeting.recorder ?? this.meetingStatus.recorder ?? null
      this.meetingStatus = { ...this.meetingStatus, available: true, recorder: this.meetingRecorder, meeting }
    }
    this.presentMeeting()
    this.surfaces.selectInFlight()
    void this.refreshMeeting()
  }

  /** Refresh local meeting availability and lifecycle independently of the fiber feed. */
  async refreshMeeting(): Promise<void> {
    if (this.meetingFetchPromise) {
      const pending = this.meetingFetchPromise
      this.meetingFetchController?.abort()
      await pending
    }
    await this.fetchMeetingStatus()
  }

  /**
   * Record a meeting on this machine and join it to `card`'s constitution. The
   * banner says how its worker received the meeting; the returned string is
   * the error to show beside the control, or null once recording began.
   */
  private async joinCardMeeting(
    card: KanbanCard,
    mode: MeetingMode,
    composeNote: () => Promise<string>,
  ): Promise<MeetingJoinResult> {
    if (this.meetingStartUncertain) return { error: 'Recording start is unconfirmed. Inspect the recorder before starting another meeting.', delivered: false }
    const recorder = this.meetingStatus.recorder
    let opening: PhoneCaptureAttempt | undefined
    let generation: number | undefined
    if (mode === 'phone') {
      try {
        opening = this.phoneAudio.begin()
        generation = await opening.ready
      } catch (error) {
        opening?.cancel()
        const message = errText(error)
        this.showBanner(`Couldn't start the meeting: ${message}`, 'error')
        return { error: message, delivered: false }
      }
    }
    // The note waits for any pasted images to reach the owning host; a failed
    // upload starts no meeting.
    let note: string
    try {
      note = await composeNote()
    } catch (error) {
      opening?.cancel()
      return { error: errText(error), delivered: false }
    }
    const outcome = await requestMeetingJoin(this.shuttleBase, {
      fiberId: card.id,
      origin: card.originId,
      recorder,
      mode,
      note,
    })
    if (outcome.kind === 'error') {
      if (outcome.uncertain) {
        this.meetingStartUncertain = true
        this.meetingRecorder = outcome.recorder ?? recorder ?? null
        void this.refreshMeeting()
      }
      opening?.cancel()
      this.showBanner(`Couldn't start the meeting: ${outcome.message}`, 'error')
      return { error: outcome.message, delivered: false }
    }
    if (outcome.kind === 'joined') {
      this.showBanner(`Recording — “${card.name}” ${joinDeliveryPhrase(outcome.delivery)}.`, 'info')
    } else if (outcome.kind === 'unconfirmed') {
      this.showBanner(`Recording — sent to “${card.name}”, not yet confirmed: ${outcome.detail}`, 'info')
    } else {
      this.showBanner(`Recording, but “${card.name}” didn't receive the meeting: ${outcome.error}`, 'error')
    }
    let audioError: string | null = null
    if (opening && generation !== undefined) {
      try { opening.bind(generation, outcome.meeting) } catch (error) {
        audioError = errText(error)
        this.showBanner(audioError, 'error')
      }
    }
    this.meetingStarted(outcome.meeting)
    void this.fetchAndRender()
    return { error: audioError, delivered: outcome.kind !== 'recording' }
  }

  private async stopCurrentMeeting(meeting: MeetingRecord): Promise<void> {
    if (!this.meetingStopGuard.request(meeting)) return
    this.presentMeeting()
    try {
      await requestMeetingStop(this.shuttleBase, fetch, meeting)
      if (meeting.phone) this.phoneAudio.cancel()
    } catch (error) {
      this.showBanner(`Couldn't stop the meeting: ${errText(error)}`, 'error')
    }
    await this.refreshMeeting()
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
    const wanted = new URLSearchParams(window.location.search).get('view')
    if (wanted && listViews().some((v) => v.id === wanted)) this.setView(wanted as BoardViewId)
    else if (window.location.hash.startsWith('#/board')) this.setView('shelf')
    else if (window.location.hash === '#/chronicle') this.setView('chronicle')
    this.keymapHelp = new KeymapHelp(
      () => this.workspace?.isActive ? 'reader' : this.activeViewId === 'desk' ? 'desk' : 'overview',
    )
    this.workspace = new Workspace(this.container!, {
      shuttleBase: this.shuttleBase,
      localHost: () => this.lastResponse?.feltHost,
      cards: () => this.workspaceCards(),
      threadIndex: () => threadIndexFor(this.lastResponse),
      origin: () => this.activeViewId === 'desk' ? 'Desk' : this.activeViewId === 'chronicle' ? 'Chronicle' : 'Board',
      onVisibility: (active) => this.showWorkspace(active),
      deskColumn: card => this.workspaceColumn(card),
      onReturnCard: card => {
        this.workspaceReturnCard = { id: card.id, origin: card.originId }
        this.workspaceReturnFocus = null
        this.deskKeyboard?.select({ uid: card.uid ?? card.id, origin: card.originId }, false)
      },
      onEscapeHome: () => this.workspace?.escapeHome(),
      onView: (view) => this.setView(view === 'board' ? 'shelf' : view, false),
      dock: this.dock,
      find: this.findEl ?? undefined,
      focusFind: () => this.focusFind(),
      onRest: card => this.openRestPopover(card),
      onExpand: (expanded) => { this.container?.classList.toggle('kbn-reader-expanded', expanded); this.placeReader() },
    })
    document.addEventListener('keydown', this.handleDocumentKeyDown, true)
    document.addEventListener('visibilitychange', this.handleMeetingVisibilityChange)
    window.addEventListener('resize', this.handleResize)
    window.addEventListener('shuttle-conversation-opening-changed', this.handleConversationOpening)
    document.addEventListener(THREAD_PIN, this.handleThreadPin)
    this.startPolling()
    void this.fetchAndRender()
  }

  /**
   * Tear down a mounted kanban. Safe to call when not mounted — no-op.
   * The host is responsible for removing the host div itself; we only own
   * the kanban's container (already a child of host).
   */
  unmount(): void {
    this.surfaces.closeMenu()
    if (this.container === null) return
    this.keymapHelp?.dispose()
    this.keymapHelp = null
    this.deskKeyboard?.dispose()
    this.deskKeyboard = null
    this.workspace?.dispose()
    this.workspace = null
    this.dock.reset()
    this.phoneAudio.unmount()
    // A mounted temporal view may hold timers/listeners of its own — give it
    // its unmount() before the container (and its host) go away.
    this.activeView?.unmount()
    this.activeView = null
    this.closeRestPopover?.()
    this.closeRolePopover?.()
    document.removeEventListener('keydown', this.handleDocumentKeyDown, true)
    document.removeEventListener('visibilitychange', this.handleMeetingVisibilityChange)
    window.removeEventListener('resize', this.handleResize)
    window.removeEventListener('shuttle-conversation-opening-changed', this.handleConversationOpening)
    document.removeEventListener(THREAD_PIN, this.handleThreadPin)
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
    // Debounce via RAF — resize fires rapidly during a drag.
    if (this.resizeRaf !== null) return
    this.resizeRaf = window.requestAnimationFrame(() => {
      this.resizeRaf = null
      this.placeVeil()
      this.placeReader()
    })
  }

  // ---------------------------------------------------------------------------

  /**
   * Build the kanban DOM into `this.container`: the banner, the body (tab
   * strip, drag horizon, Desk, view host) and the live region.
   *
   * There is no masthead. Three actions — Stash `+`, New idea `✶`, and
   * Refresh `↻` — live in the lane heads (see
   * KanbanSurfaceRenderer.makeColumnAction). The page begins at the tab
   * strip; the body's top padding is its only top margin.
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
    this.body.addEventListener('dragover', (e) => this.handleBodyDragOver(e), true)
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
    this.deskKeyboard = new DeskKeyboard(this.deskEl, address => {
      const card = boardCards(this.lastResponse).find(card => (card.uid ?? card.id) === address.uid && card.originId === address.origin)
      if (card) this.openDocumentChannel(card)
    })
    this.viewHostEl = document.createElement('div')
    this.viewHostEl.className = 'kbn-view-host'
    this.body.append(this.dragHorizonEl, this.deskEl, this.viewHostEl)
    this.syncViewChrome()

    // The bar stands outside the body: the body goes inert under the reader,
    // and the bar stays live above it, in the same place on every view.
    this.container.append(this.tabsEl, this.bannerEl, this.body, this.liveEl)

    // Crossing 700px changes what the Desk IS, not just how it is painted: the
    // Now triad becomes a pager with a folio strip, and the two bands grow fold
    // affordances that only exist on a phone. Those are wired at build time, so
    // the surfaces have to be rebuilt when the threshold is crossed — a resized
    // window otherwise keeps desktop wiring under a mobile layout.
    this.stopMobileWatch = onMobileChange(() => {
      if (this.activeViewId === 'desk' && this.lastResponse) this.render(this.lastResponse)
    })
  }

  /** Desk and Chronicle cards enter the same owner-addressed document channel. */
  private openDocumentChannel(card: KanbanCard, compose = false, doc?: DocKey): void {
    if (this.activeViewId === 'desk') this.deskKeyboard?.select({ uid: card.uid ?? card.id, origin: card.originId }, false)
    this.workspaceReturnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
    this.workspaceReturnCard = { id: card.id, origin: card.originId }
    if (compose) this.workspace?.compose(card)
    else if (doc) this.workspace?.open(card, undefined, doc)
    else if (card.status === 'active' && isQuestion(card)) this.workspace?.openQuestion(card)
    else this.workspace?.open(card)
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
    if (this.body) {
      this.body.inert = active
      if (active) this.body.setAttribute('aria-hidden', 'true')
      else this.body.removeAttribute('aria-hidden')
    }
    if (active) { this.workspace?.hideOverview(); return }
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
      : cardStillOwned ? Array.from(this.deskEl?.querySelectorAll<HTMLElement>('[data-fiber-id]') ?? []).find(el => el.dataset.fiberId === address.id)
      : this.tabsEl?.querySelector<HTMLElement>('[aria-selected="true"]')
    target?.focus({ preventScroll: true })
  }

  /** The reader takes the opened card's actual drawn region, preserving the flight seam. */
  private workspaceColumn(card: KanbanCard): SidebarEntry[] {
    const sources = this.deskKeyboard?.columnFor({ uid: card.uid ?? card.id, origin: card.originId }) ?? []
    const cards = new Map(this.workspaceCards().map(row => [JSON.stringify([row.originId, row.uid ?? row.id]), row]))
    return sources.flatMap(source => {
      const card = cards.get(JSON.stringify([source.dataset.cardOrigin, source.dataset.cardUid]))
      if (!card) return []
      const band = source.closest('.kbn-flight-band')?.querySelector('.kbn-flight-caption')?.textContent ?? undefined
      return [{ card, band, source }]
    })
  }

  /** Drawn Desk order, followed by chronological cards. */
  private workspaceCards(): KanbanCard[] {
    if (!this.lastResponse) return []
    const cards = boardCards(this.lastResponse)
    const byId = new Map(cards.map(card => [card.id, card]))
    const seen = new Set<string>()
    const ordered: KanbanCard[] = []
    for (const el of this.deskEl?.querySelectorAll<HTMLElement>('[data-fiber-id]') ?? []) {
      const card = byId.get(el.dataset.fiberId ?? '')
      if (card && !seen.has(card.id)) { seen.add(card.id); ordered.push(card) }
    }
    return [...ordered, ...cards.filter(card => !seen.has(card.id))]
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
    // The tabs alone are the tablist; Find, the view's centre and Settings ride the same bar beside it.
    const views = document.createElement('div')
    views.className = 'kbn-viewtabs-views'
    views.setAttribute('role', 'tablist')
    views.setAttribute('aria-label', 'Board views')
    strip.append(views)

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
      views.append(tab)
    }

    // Find follows the tabs: one field every view shares.
    const find = document.createElement('label')
    find.className = 'kbn-viewtabs-find'
    this.findEl = document.createElement('input')
    this.findEl.type = 'search'
    this.findEl.placeholder = 'Find a constitution or transcript'
    this.findEl.setAttribute('aria-label', 'Find a constitution or transcript')
    this.findEl.addEventListener('focus', () => this.workspace?.find(this.activeViewId === 'shelf'))
    this.findEl.addEventListener('input', () => this.workspace?.find(this.activeViewId === 'shelf'))
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

    // The centre holds the Desk's cycle lens chips, at its right end. It always
    // takes the room between Find and Settings, so Settings never moves between views.
    const centre = document.createElement('div')
    centre.className = 'kbn-viewtabs-centre'
    this.lensSlotEl = document.createElement('div')
    this.lensSlotEl.className = 'kbn-viewtabs-lens'
    centre.append(this.lensSlotEl)
    strip.append(centre)

    // Settings rides the same row as the pages without being one of them. It
    // is deliberately NOT a tab: the tabs are windows onto the work, and
    // a preferences sheet is not a window onto anything — so it wears a glyph
    // rather than a name and a keycap, and sits past the lens where the row
    // has already ended. On a phone the row scrolls; the CSS pins this one
    // element to the right edge, because a settings button you have to scroll
    // sideways to find is a settings button nobody finds.
    if (this.onSettingsClick) {
      const gear = document.createElement('button')
      gear.type = 'button'
      gear.className = 'kbn-viewtabs-settings'
      // U+2699 + U+FE0E: the text variation selector, as the manicule uses, so
      // this renders as a serif mark rather than a colour emoji.
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
    if (navigate && this.workspace) {
      if (id === 'shelf') this.workspace.showBoard()
      else this.workspace.suspend(id)
    }
    if (id === this.activeViewId) return
    this.workspace?.clearFind()
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
      host.append(this.surfaces.renderDragHorizon())
      // The band is built at height 0 and grown by the class. A style flush
      // between the two gives the transition a starting height to animate FROM
      // — without it the browser sees one computed style and the strip snaps.
      void host.offsetHeight
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
    // The Board's sheet is a vellum veil over the Desk, which stays drawn
    // beneath it, untouchable and out of the accessibility tree.
    const veiled = this.activeViewId === 'shelf'
    // Leaving the Desk mid-drag takes the horizon with it.
    if (!onDesk) this.syncDragHorizon(false)
    if (this.deskEl) {
      this.deskEl.style.display = onDesk || veiled ? '' : 'none'
      this.deskEl.inert = veiled
      if (veiled) this.deskEl.setAttribute('aria-hidden', 'true')
      else this.deskEl.removeAttribute('aria-hidden')
    }
    this.body?.classList.toggle('kbn-body-veiled', veiled)
    this.placeVeil()
    // The chips ride in the tab strip, which every view shares — but the lens
    // they engage only means anything on the Desk.
    if (this.lensSlotEl) this.lensSlotEl.style.display = onDesk ? '' : 'none'
    if (this.viewHostEl) this.viewHostEl.style.display = onDesk ? 'none' : ''
    for (const tab of this.tabsEl?.querySelectorAll<HTMLElement>('.kbn-viewtab') ?? []) {
      const selected = tab.dataset.view === this.activeViewId
      tab.classList.toggle('kbn-viewtab-active', selected)
      tab.setAttribute('aria-selected', String(selected))
      this.labelOriginTab(tab, selected)
      // On a phone the strip scrolls, so the tab you just chose can be off
      // screen the moment it becomes current — a hotkey lands there. Bring it
      // back into the run.
      if (selected && isMobileViewport()) {
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
      }
    }
  }

  /** The veiled view host starts under the tab strip and covers the rest of the page. */
  private placeVeil(): void {
    if (!this.container || !this.tabsEl || this.activeViewId !== 'shelf') return
    const top = this.tabsEl.getBoundingClientRect().bottom - this.container.getBoundingClientRect().top
    this.container.style.setProperty('--kbn-veil-top', `${Math.max(0, Math.round(top))}px`)
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
   * `1`–`3` switch views. Deliberately narrow: a bare digit only, so
   * `Cmd/Ctrl+1` stays the browser's tab switch, and only when the keystroke
   * is not going somewhere it matters — a focused text field, or a Radix
   * dialog layered over the board. Returns true when the
   * key was consumed.
   */
  private handleViewHotkey(e: KeyboardEvent): boolean {
    const surface = this.workspace?.isActive ? 'reader' : this.activeViewId === 'shelf' ? 'overview' : 'desk'
    const intent = keyIntent(e, surface)
    if (intent !== 'desk' && intent !== 'chronicle' && intent !== 'board') return false
    if (keystrokeIsSpokenFor()) return false
    const id: BoardViewId = intent === 'desk' ? 'desk' : intent === 'chronicle' ? 'chronicle' : 'shelf'
    e.preventDefault()
    e.stopPropagation()
    this.setView(id, true, intent === 'desk')
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
    this.lensSlotEl = null
    this.findEl = null
    this.deskEl = null
    this.viewHostEl = null
    this.activeView = null
    this.activeViewId = 'desk'
    this.lensCycleId = null
    this.viewFallbackSig = null
    this.lastFetchFailed = false
    this.dragSourceId = null
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
   * force-dispatch path (the same one the dock's "New session ▸"
   * uses): a single fresh POST /api/v1/dispatch with `force: true, ad_hoc:
   * true` and no message — drag carries no directive (resume-previous and
   * "talk first" intent live on the fiber page). force bypasses status /
   * enabled / review_state / schedule / validity gates, so closed (tempered or
   * composted), paused, awaiting-review, and dormant-standing cards all
   * fire a worker immediately — no waiting on the 15s poller; the dispatch
   * reopens a closed lifecycle itself, so no separate transition write runs.
   *
   * Drag-from-timeline-or-stash composes the park-on-desk write with the
   * lifecycle verb rather than writing the surface alone and trusting
   * classifyFiber to redirect: standing constitutions always re-classify back to the
   * timeline (their lifecycle column is `scheduled`, horizon-independent),
   * and tempered/closed past cards never leave timeline.past. Composing both
   * writes makes the drag take precedence: the gesture lands the card where
   * the user dropped it AND fires the action that column means.
   */
  private transition(
    card: KanbanCard,
    target: ColumnKind,
    /**
     * For a gesture that has ALREADY painted its destination and is now
     * delegating the lifecycle half here (a row dropped on a column). Two things have to be said, and both are about the same trap:
     *
     *  • `basis` — the response as it was BEFORE that paint. Every question
     *    this method asks ("which column is it in now?", "does it need parking
     *    on the desk?") is a question about where the card came FROM, and
     *    `this.lastResponse` no longer knows: it already shows the card at its
     *    destination. Asked against it, `fromKind === target` and the whole
     *    transition early-returns with "already in In flight" — the write never
     *    goes out and the optimistic card sits there as a lie.
     *  • `skipOptimistic` — don't paint it a second time. Not merely redundant:
     *    a second `applyOptimisticTransition` would lift the card from its NEW
     *    surface and re-place it, and re-derive nothing useful.
     */
    opts: { basis?: KanbanResponse | null; skipOptimistic?: boolean; verdictCommitted?: boolean } = {},
  ): void {
    const basis = opts.basis !== undefined ? opts.basis : this.lastResponse
    // Server placement, or the gesture's pre-paint basis, determines a no-op.
    // A same-column verdict must not authorize a delayed write after reopening.
    const fromKind = findCardColumn(basis, card.id)
    if (fromKind === target) {
      this.showBanner(`“${card.name}” is already in ${COLUMN_TITLES[target]}.`, 'info')
      this.announce(`${card.name} is already in ${COLUMN_TITLES[target]}.`)
      return
    }
    if ((target === 'tempered' || target === 'composted') && this.workspace && !opts.verdictCommitted) {
      this.workspace.queueVerdict(card, target)
      return
    }
    // A verdict stops the card's worker (commitTransition → killWorkerIfRunning).
    // In the workspace, Workspace.queueVerdict asks at gesture time and refuses
    // an expired verdict whose card gained an unconfirmed worker, so a committed
    // verdict arrives here already authorized. Without a workspace, ask now.
    if ((target === 'tempered' || target === 'composted') && !opts.verdictCommitted && !confirmWorkerStop(card, target)) {
      this.announce(`Left ${card.name} running.`)
      return
    }

    // Surface-shift case: card lives on a non-Now surface (timeline.futureDated
    // / stash). For drag onto a Now lifecycle column we first
    // promote to Now (the "park on desk" half of the gesture), then fall
    // through to the lifecycle verb (the "act on it" half) — never early-return.
    const isNowColumn = target === 'drafts' || target === 'inFlight' || target === 'awaitingReview'
    const onTimelineOrStash = !!basis && [
      ...basis.timeline.futureDated,
      ...basis.stash,
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
    if (!opts.skipOptimistic) {
      const optimistic = applyOptimisticTransition(basis, card.id, target)
      if (optimistic) this.applyResponse(optimistic)
    }

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
    // Held across the writes AND the trailing reconcile: the launch half can
    // take seconds, and until the daemon has actually dispatched, the honest
    // server answer is "this card is a draft" — true, and not what was asked
    // for. The poll stays out until the refetch below settles it.
    this.gestureDepth += 1
    try {
      if (needSurfaceShift) {
        // Same write policy as commitSurface's `now`: clear horizon/cold and
        // (for a Drafts drop) the `due:` — "park on the desk" means no
        // planning fields left to re-route the card on the next classify.
        const surfaceBody: Record<string, unknown> = {
          fiber_id: card.id, origin: card.originId, unset: ['horizon', 'cold'],
        }
        if (target === 'drafts' && card.due !== undefined) surfaceBody.due = null
        await this.postFeltEdit(surfaceBody, 'Park-on-desk failed')
      }

      let moved = true
      if (target === 'inFlight') {
        moved = await this.launchFromDrag(card)
      } else {
        // Dragging a running card off in-flight stops its worker first — the
        // board's "alive only while in-flight" invariant. inFlight is the one
        // target that doesn't kill (it's a (re)dispatch).
        await this.killWorkerIfRunning(card)
        await this.postTransition(card, target, 'Transition failed')
      }
      this.announce(
        moved
          ? `Moved “${card.name}” to ${COLUMN_TITLES[target]}.`
          : `“${card.name}” needs a project directory before it can start.`,
      )
    } catch (err: unknown) {
      const msg = errText(err)
      this.showBanner(`Couldn't move “${card.name}” to ${COLUMN_TITLES[target]}: ${msg}`, 'error')
      this.announce(`Move failed: ${msg}`)
    }
    try {
      // Always refetch — server is the source of truth. Reconciles (or reverts)
      // the optimistic placement.
      await this.fetchAndRender()
    } finally {
      this.gestureDepth -= 1
    }
  }

  /**
   * Drag-to-inFlight launch: ONE force dispatch owns the whole launch, with no
   * transition beside it — the dispatch reopens a closed lifecycle itself, and
   * a second write would race it into a 409 already_running.
   *
   * A drag carries no message and always starts fresh; resuming and saying
   * something first live on the fiber page, where they are chosen on
   * purpose. `fresh` is stamped explicitly rather than left to the daemon's
   * auto-decide, which would resume a transcript that died dirty.
   *
   * A start refused for want of a project directory is not a failed move but
   * a question: the card's panel opens with the directory prompt, and the
   * answer is `false`. Any other refusal throws the daemon's reason.
   */
  private async launchFromDrag(card: KanbanCard): Promise<boolean> {
    let res: Response
    try {
      res = await postForceDispatch(this.shuttleBase, card, { resume_mode: 'fresh' })
    } catch (err: unknown) {
      throw new Error(`Couldn't reach the Shuttle daemon: ${errText(err)}`)
    }
    if (res.ok) return true
    const body = (await res.json().catch(() => ({}))) as DispatchFailureBody
    if (needsProjectDir(body)) {
      this.workspaceReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      this.workspaceReturnCard = { id: card.id, origin: card.originId }
      this.workspace?.openStartPrompt(card, body)
      return false
    }
    throw new Error(dispatchFailureMessage(body, `reopen ${res.status}`, res.status))
  }

  /** POST one frontmatter edit, owner-routed by `origin`, throwing the
   *  daemon's own message on failure. The shared half of every sequence
   *  write. */
  private async postFeltEdit(
    payload: Record<string, unknown>,
    label = 'Frontmatter edit failed',
  ): Promise<void> {
    await this.postJson('/api/v1/felt-edit', payload, label)
  }

  /**
   * `horizon` is a planning field, not the card's current board surface.
   * An active oneshot can retain `horizon: stashed` while its lifecycle puts
   * it in In flight (the live-worker override, or simply `status:active`).
   * Compare against the surface the classifier is actually showing, or a
   * drag returns "already in Resting" before it can stop and park the worker.
   */
  private sameSurface(card: KanbanCard, horizon: HorizonKind, opts: { cold?: boolean }): boolean {
    const actuallyOnHorizon = horizon === 'stashed'
      ? !hasWorkerToStop(card) && card.status === 'open' && card.effectiveHorizon === 'stashed'
      : card.effectiveHorizon === 'now'
    return actuallyOnHorizon && (card.cold ?? false) === (opts.cold ?? false)
  }

  /**
   * `undefined` means "the date is not being touched", so it can never be the
   * half of a drop that makes it a real change — a preserved due leaves the
   * verdict entirely to the surface test. Re-dropping an already-resting dated
   * card into Resting is therefore a true no-op, reported as such — never a
   * silent deadline deletion.
   */
  private sameDueAs(card: KanbanCard, due: string | null | undefined): boolean {
    return due === undefined || sameCivilDue(card.due, due)
  }

  /**
   * Would `setSurface` find nothing to write for this card?
   *
   * Never for a CLOSED card. A tempered/composted past run OR an
   * awaiting-review one (closed, untempered) classifies by its lifecycle
   * state, not its stored horizon: it sits in Awaiting review / Past
   * regardless of a `horizon: stashed` left in its frontmatter. So even when
   * the stored horizon already equals the target, the drop is a real state
   * change — commitSurface reopens it as a draft so it actually leaves that
   * column and lands on the surface.
   */
  private alreadyOnSurface(
    card: KanbanCard,
    horizon: HorizonKind,
    opts: { cold?: boolean; due?: string | null },
  ): boolean {
    return card.status !== 'closed' && this.sameSurface(card, horizon, opts) && this.sameDueAs(card, opts.due)
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
   * When `opts.due` is omitted the existing `due:` is PRESERVED, stashing
   * included. Putting a card down in Resting is one gesture and it does one
   * thing: it moves the card. The date the human wrote is theirs, and a drag
   * that quietly deleted it — "I'll look at Croatia in October" becoming a
   * dateless card nothing will ever surface again — is the second, destructive
   * act a gesture must never smuggle in. Preserved, `horizon: stashed` + a
   * future `due:` compose into the snooze that brings the card back by itself.
   *
   * The ONE exception: a `due:` that is today or already past would bounce the card straight back onto the
   * desk, because `effectiveHorizon`'s drift branch outranks its stashed branch
   * — the drop would read as ignored. Such a due is cleared, and `commitSurface`
   * says so in a banner. `dueBouncesFromResting` (KanbanRules) is the test.
   *
   * Callers can still pass an explicit `due` to override either way: a day
   * (the date-column snooze) or `null` to clear on purpose.
   */
  private setSurface(
    card: KanbanCard,
    horizon: HorizonKind,
    opts: { cold?: boolean; due?: string | null } = {},
  ): void {

    // A standing constitution is placed on the timeline by its schedule
    // (`nextStandingLaunch`), not by hand — a horizon/due write here is
    // silently ignored by the read model and just leaves dead frontmatter.
    // Reject the planning gesture with an explanation rather than no-op. The
    // lifecycle gestures still work: drag to In flight runs it now (that's
    // `transition` → force-dispatch, not this path), and Temper / Compost
    // close it.
    if (card.shuttleKind === 'standing') {
      this.showBanner(
        `“${card.name}” is a standing constitution — it runs on its schedule. Edit the schedule to change when it runs, or drag it to In flight to run it now.`,
        'info',
      )
      this.announce(`${card.name} runs on its schedule; drag it to In flight to run it now.`)
      return
    }
    const wantsCold = horizon === 'stashed' ? (opts.cold ?? false) : undefined
    // A bare stash keeps the card's own `due:` — `due` stays undefined, which
    // commitSurface reads as "don't send the key", and felt leaves the line
    // alone. Only a deadline that would bounce the card back is dropped, and
    // the drop is reported rather than done under the gesture's cover.
    const dropsStaleDue =
      horizon === 'stashed' && opts.due === undefined && dueBouncesFromResting(card.due)
    const due = dropsStaleDue ? null : opts.due

    if (this.alreadyOnSurface(card, horizon, { cold: opts.cold, due })) {
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

    void this.commitSurface(card, horizon, { cold: wantsCold, due, dropsStaleDue })
  }

  /**
   * Network half of {@link setSurface}: POST the horizon edit, then reconcile.
   * Runs in the background after the optimistic render (when there was one), so
   * its latency is invisible; banners + snaps back on failure.
   *
   * `opts.dropsStaleDue` is the one thing this method reports rather than does:
   * setSurface decided to clear an already-elapsed deadline, and the human is
   * told which date went. See `announceSurfaceLanding`.
   */
  private async commitSurface(
    card: KanbanCard,
    horizon: HorizonKind,
    opts: { cold?: boolean; due?: string | null; dropsStaleDue?: boolean },
  ): Promise<void> {
    try {
      // Into Resting is `shuttle rest`, the worker's own exit said by hand: the
      // owning daemon writes `status: open` + `horizon: stashed` inside its
      // Poller, clears the verdict, stamps the clean-exit marker, and stops a
      // live worker through its backend (tmux or an app conversation). A card
      // that already carries a verdict is past review, which rest refuses, so
      // it reopens as a draft first, as every other planning drop does.
      // setSurface's guards already bannered the states where neither verb
      // applies (standing). Every card on a Desk column carries a shuttle
      // block, so the lifecycle verbs always apply — see `shouldIncludeInKanban`.
      const hasVerdict = card.status === 'closed' && card.tempered !== undefined
      if (horizon === 'stashed' && !hasVerdict) {
        await this.postJson('/api/v1/lifecycle', {
          action: 'rest', fiber: card.id, origin: card.originId,
        }, 'Rest failed')
      } else {
        // Any other planning surface (a future date, or back onto the desk)
        // holds DRAFTS. Parking a running card there stops its worker — alive
        // only while in-flight — and a card that isn't a draft yet is parked as
        // one via `/transition target=drafts`: a closed card reopens as a
        // deferred draft (reopen --as-draft → status:open, verdict cleared,
        // not armed), an armed card pauses (otherwise an active oneshot
        // reclassifies straight back to In flight after the refetch).
        await this.killWorkerIfRunning(card)
        if (card.status !== 'open') {
          await this.postTransition(card, 'drafts', 'Park-as-draft failed')
        }
      }
      // What rest does not write — `cold`, and a date the drop names — rides
      // the horizon edit below; the horizon itself is restated, harmlessly.
      // The horizon "surface" is not stored verbatim — Now is absence (clear
      // `horizon`+`cold`), future placement is `due:`, and only `stashed`
      // writes a stored horizon. The daemon `/api/v1/felt-edit` is a raw
      // frontmatter writer, so this policy lives here, the sole classifier's
      // twin on the write side.
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
      await this.postFeltEdit(payload, 'Surface edit failed')
      this.announceSurfaceLanding(card, horizon, opts)
    } catch (err: unknown) {
      const msg = errText(err)
      this.showBanner(`Couldn't move “${card.name}” to ${SURFACE_TITLE[horizon]}: ${msg}`, 'error')
      this.announce(`Surface move failed: ${msg}`)
    }
    await this.fetchAndRender()
  }

  /**
   * Say where the card landed, in the register the landing deserves.
   *
   * Three cases, and the split is about what the human can already SEE:
   *
   *   • A stale deadline was dropped → a visible BANNER naming the date that
   *     went. This is the only branch that destroys something the human wrote,
   *     so it is the only one that interrupts; silence here would be a date
   *     deleted without a word.
   *   • Resting with a wake day → announce "resting until <day>". No banner:
   *     the card itself grows a `wakes <day>` chip in the Resting grid
   *     (KanbanSurfaces' stash card), so the sighted user is already told. The
   *     announcement carries that same fact to a screen reader, which cannot
   *     see the chip.
   *   • Anything else → the plain "Moved to <surface>".
   *
   * The wake day comes from `restingUntil`, the same rule the chip and the
   * timeline ghost use, rather than a date formatted by hand here — one rule,
   * so the sentence and the chip can never name different days.
   */
  private announceSurfaceLanding(
    card: KanbanCard,
    horizon: HorizonKind,
    opts: { due?: string | null; dropsStaleDue?: boolean },
  ): void {
    if (opts.dropsStaleDue === true) {
      const gone = card.due ? formatDue(card.due) : null
      const msg = gone
        ? `“${card.name}” is resting, and its ${gone} deadline — already past — was cleared. Give it a new date to have it come back on its own.`
        : `Moved “${card.name}” to Resting.`
      this.showBanner(msg, 'info')
      this.announce(msg)
      return
    }
    // The due the write left on the document: an explicit day (or an explicit
    // clear) from the caller, otherwise the card's own, preserved.
    const settledDue = opts.due === undefined ? card.due : (opts.due ?? undefined)
    const wakes = horizon === 'stashed' ? restingUntil({ horizon: 'stashed', due: settledDue }) : undefined
    this.announce(
      wakes
        ? `“${card.name}” is resting until ${formatDue(wakes)}, when it returns to the desk.`
        : `Moved “${card.name}” to ${SURFACE_TITLE[horizon]}.`,
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
    const r = this.lastResponse
    if (!r) return undefined
    const cards = [...r.now.drafts, ...r.now.inFlight, ...r.now.awaitingReview]
    return cards.find((c) => c.tmuxSession === tmux)?.sessionLink
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

  private async fetchMeetingStatus(): Promise<void> {
    if (!this.container || !shouldRunVisiblePoll(null, Date.now(), this.pollIntervalMs)) return
    if (this.meetingFetchPromise) return this.meetingFetchPromise
    if (this.meetingPollTimer !== null) {
      window.clearTimeout(this.meetingPollTimer)
      this.meetingPollTimer = null
    }

    const controller = new AbortController()
    const epoch = this.meetingReadEpoch
    this.meetingFetchController = controller
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    let succeeded = false
    const pending = (async () => {
      try {
        const response = await fetch(meetingStatusUrl(this.shuttleBase, this.meetingRecorder, isMobileViewport()), { signal: controller.signal })
        if (!response.ok || !this.container) return
        const status = parseMeetingStatus(await response.json())
        if (!status || epoch !== this.meetingReadEpoch) return
        succeeded = true
        this.meetingStopGuard.observe(status.meeting)
        const availabilityChanged = status.available !== this.meetingStatus.available
        this.meetingStatus = status
        if (status.meeting) this.meetingRecorder = status.recorder ?? status.meeting.recorder ?? null
        else if (!this.meetingStartUncertain) this.meetingRecorder = null
        this.phoneAudio.observe(status.meeting)
        this.syncMeetingClock()
        this.dock.syncMeeting()
        if (availabilityChanged && this.lastResponse) this.render(this.lastResponse)
        else this.presentMeeting()
      } catch {
        // An unavailable service or a timed-out read backs off to the board cadence.
      } finally {
        window.clearTimeout(timeout)
        if (this.meetingFetchController === controller) this.meetingFetchController = null
        this.meetingFetchPromise = null
        this.scheduleMeetingPoll(succeeded)
      }
    })()
    this.meetingFetchPromise = pending
    return pending
  }

  /** Update the drawn meeting in place, or redraw the desk when it moved
   *  onto or off its card. */
  private presentMeeting(): void {
    if (!this.surfaces.updateMeetingPresentation() && this.lastResponse) this.render(this.lastResponse)
  }

  private scheduleMeetingPoll(succeeded = true): void {
    if (this.meetingPollTimer !== null) {
      window.clearTimeout(this.meetingPollTimer)
      this.meetingPollTimer = null
    }
    if (!this.container) return
    // Use the board's visibility gate without its unfocused-window slowdown;
    // meeting status is lightweight and runs at the contract's visible cadence.
    const visible = shouldRunVisiblePoll(null, Date.now(), this.pollIntervalMs)
    const delay = meetingPollDelay(visible, succeeded, this.meetingStatus.meeting)
    if (delay === null) return
    this.meetingPollTimer = window.setTimeout(() => {
      this.meetingPollTimer = null
      void this.fetchMeetingStatus()
    }, delay)
  }

  private syncMeetingClock(): void {
    const meeting = this.meetingStatus.meeting
    const ticking = meeting !== null && meeting.state !== 'failed' && meeting.state !== 'starting' && meeting.started_at !== null
    if (!ticking && this.meetingClockTimer !== null) {
      window.clearInterval(this.meetingClockTimer)
      this.meetingClockTimer = null
    } else if (ticking && this.meetingClockTimer === null) {
      this.meetingClockTimer = window.setInterval(() => this.surfaces.updateMeetingDuration(), 1_000)
    }
  }

  private async fetchAndRender(): Promise<void> {
    void this.fetchMeetingStatus()
    this.lastFetchStartedAt = Date.now()
    const token = ++this.inflightFetchToken
    try {
      const headers = new Headers()
      if (this.compositeEtag) headers.set('If-None-Match', this.compositeEtag)
      const res = await daemonFetch(`${this.shuttleBase}/api/v1/fibers/composite`, { headers })
      if (token !== this.inflightFetchToken) return
      if (res.status === 304) {
        this.lastFetchFailed = false
        this.daemonBooting = false
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
      const data = buildKanbanResponseFromComposite(feed)
      if (token !== this.inflightFetchToken) return
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
      this.ensureFleetDefaultAgents(data)
      if (!wasFirstRender && sig === this.lastResponseSig) {
        // The Desk skips an identical-payload re-render, but a temporal view
        // still gets its poll: its content moves with the clock (and with
        // activity and the ledgers), not only with the fiber feed. The open
        // card's worker pill crosses its idle threshold on the clock too.
        this.syncWorkspaceRuntime()
        this.mountOrRefreshActiveView()
        return
      }
      this.lastResponseSig = sig
      this.render(data)
    } catch (err: unknown) {
      if (token !== this.inflightFetchToken) return
      if (isDaemonBooting(err)) {
        this.markDaemonBooting()
      } else {
        this.markFetchFailed(errText(err))
      }
    }
  }

  private async refreshFromSource(): Promise<void> {
    // Kanban content is read live from each owning daemon's `/api/v1/fibers`
    // route, so a manual refresh is just a re-fetch — there is no remote
    // snapshot to prompt.
    this.announce('Refreshing…')
    await this.fetchAndRender()
    window.setTimeout(() => {
      void this.fetchAndRender()
    }, 800)
  }

  private computeResponseSignature(data: KanbanResponse): string {
    // Hash the surfaces + staleness — stale-origin cards dim and disable drag
    // even when the card lists themselves are unchanged. `totals` is a pure
    // `.length` derivation of those same surfaces, so hashing it could only
    // produce redundant work.
    return JSON.stringify({
      n: data.now,
      tl: data.timeline,
      s: data.stash,
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
    this.surfaces.closeMenu()
    if (!this.body || !this.deskEl) return
    this.ensureFleetDefaultAgents(data)
    this.syncWorkspaceRuntime()
    if (this.workspace?.isActive) {
      this.lastResponse = data
      this.pendingDeskData = data
      return
    }

    // Never rebuild the Desk while it is hidden behind a temporal view. The
    // passes at the end of this method MEASURE — `restoreScrollSnapshot`
    // writes scrollTops — and a `display:none` subtree has no layout box, so
    // each one silently does nothing.
    //
    // Holding the payload instead is also what makes the promise in the
    // `deskEl` docstring true: the Desk that comes back is the one the user
    // left, scroll positions intact, repainted from fresh data at the moment
    // it can see what it is doing.
    // The Board veils a Desk that must exist: its first paint happens beneath
    // the veil, and later data waits for the Desk to be in front again.
    const veiledFirstPaint = this.activeViewId === 'shelf' && !this.deskEl.hasChildNodes()
    if (this.activeViewId !== 'desk') {
      this.lastResponse = data
      this.mountOrRefreshActiveView()
      if (!veiledFirstPaint) {
        this.pendingDeskData = data
        return
      }
    }
    this.pendingDeskData = null

    const scrollSnapshot = this.captureScrollSnapshot()
    const { now, staleness } = data

    this.deskEl.innerHTML = ''
    this.body.classList.remove('kbn-body-zoomed')

    // Three surfaces, top to bottom: the Now board, the Roles band (when any
    // seat is at rest), then Resting. The day axis is only the drag-reveal horizon under
    // the tab strip (see `syncDragHorizon`).
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
    if (this.lensSlotEl) {
      this.lensSlotEl.innerHTML = ''
      if (lensBar) this.lensSlotEl.append(lensBar)
    }

    this.deskEl.append(this.surfaces.renderNowSection(now, staleness, lens))
    // Seats at rest sit in their own band between Now and Resting.
    const rolesBand = this.surfaces.renderRolesSection(data.roles, staleness)
    if (rolesBand) this.deskEl.append(rolesBand)
    // Resting draws everything at rest — snoozed work AND standing constitutions asleep
    // between runs, which classify as `scheduled`; see `restingCards`.
    this.deskEl.append(this.surfaces.renderStashSection(restingCards(data), staleness))

    this.restoreScrollSnapshot(scrollSnapshot)
    // A redraw repaints the selection in place: the Desk scrolls only when the
    // selection moves, never under a pointer on its way to another card.
    this.deskKeyboard?.refresh()
    void this.fiberSends?.refresh()
    this.updateBodyScrollAffordance()
    window.requestAnimationFrame(() => this.updateBodyScrollAffordance())
    this.lastResponse = data
    // A temporal view is fed by the same data the Desk just rebuilt from —
    // including optimistic re-renders, which never reach fetchAndRender.
    this.mountOrRefreshActiveView()
  }

  private ensureFleetDefaultAgents(data: KanbanResponse): void {
    for (const card of boardCards(data)) {
      if (!isAgentCard(card) || !card.shuttleAgent) continue
      const origin = card.originId
      if (this.fleetDefaultAgents.has(origin) || this.fleetDefaultAgentLoads.has(origin)) continue
      if ((this.fleetDefaultAgentMisses.get(origin) ?? -Infinity) > Date.now() - AGENT_RETRY_MS) continue
      this.fleetDefaultAgentLoads.add(origin)
      void inLane('quiet', () => daemonFetch(`${this.shuttleBase}/api/v1/agents?origin=${encodeURIComponent(origin)}`)
        .then(async response => ({ ok: response.ok, body: response.ok ? await response.json() as unknown : null })))
        .then(({ ok, body }) => {
          if (!ok) { this.fleetDefaultAgentMisses.set(origin, Date.now()); return }
          this.fleetDefaultAgentMisses.delete(origin)
          const agent = registryDefaultAgent(body)
          if (!agent) return
          const fallback = this.fleetDefaultAgents.get(origin) ?? FALLBACK_DEFAULT_AGENT
          this.fleetDefaultAgents.set(origin, agent)
          if (agent !== fallback && this.lastResponse && this.container) this.render(this.lastResponse)
        })
        .catch(() => { this.fleetDefaultAgentMisses.set(origin, Date.now()) })
        .finally(() => this.fleetDefaultAgentLoads.delete(origin))
    }
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
  private readonly fleetDefaultAgents = new Map<string, string>()
  private readonly fleetDefaultAgentLoads = new Set<string>()
  /** When each unreachable host last refused its registry; renders retry it after AGENT_RETRY_MS. */
  private readonly fleetDefaultAgentMisses = new Map<string, number>()
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

  /** {@link postDaemonJson} against this board's daemon. */
  private postJson(path: string, body: unknown, label: string): Promise<void> {
    return postDaemonJson(this.shuttleBase, path, body, label)
  }

  /** The drag/menu lifecycle write: the daemon maps the column `target` -> a
   *  lifecycle action. */
  private async postTransition(card: KanbanCard, target: ColumnKind, label: string): Promise<void> {
    await this.postJson('/api/v1/transition', { fiber_id: card.id, target, origin: card.originId }, label)
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
      await this.postJson('/api/v1/quarantine/release', { origin: shuttleHost }, 'release failed')
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
      await this.postJson(
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
    this.scheduleMeetingPoll()
    this.pollTimer = window.setInterval(() => {
      if (this.surfaces.isDragging()) return
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
    this.meetingFetchController?.abort()
    this.meetingFetchController = null
    if (this.meetingPollTimer !== null) {
      window.clearTimeout(this.meetingPollTimer)
      this.meetingPollTimer = null
    }
    if (this.meetingClockTimer !== null) {
      window.clearInterval(this.meetingClockTimer)
      this.meetingClockTimer = null
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

  private closeRolePopover?: () => void

  private makeSeat(card: KanbanCard, anchor: HTMLElement): void {
    this.closeRolePopover?.()
    if (card.shuttleRole) {
      void this.commitSeat(card)
      return
    }
    this.closeRolePopover = rolePopover(card, anchor, async () => {
      const response = await daemonFetch(`${this.shuttleBase}/api/v1/roles`)
      if (!response.ok) throw new Error(await response.text())
      return await response.json() as RoleProfile[]
    }, choice => this.commitSeat(card, choice))
  }

  /** Office assignment and seat marking precede the ordinary Resting drop.
   * Standing seats keep their schedule and their current run untouched. */
  private async commitSeat(card: KanbanCard, choice?: RoleChoice): Promise<void> {
    try {
      if (choice) {
        await this.postJson('/api/v1/lifecycle', {
          action: 'role', fiber: card.id, origin: card.originId, ...choice,
        }, 'Role assignment failed')
      }
      await this.postJson('/api/v1/lifecycle', {
        action: 'seat', fiber: card.id, origin: card.originId,
      }, 'Seat assignment failed')
      const seated = { ...card, shuttleRole: choice?.role ?? card.shuttleRole, shuttleSeat: true }
      const optimistic = applyOptimisticSeat(this.lastResponse, seated)
      if (optimistic) this.applyResponse(optimistic)
      if (card.shuttleKind === 'standing') {
        const message = `“${card.name}” is a seat. It keeps its schedule; its current run is unchanged.`
        this.showBanner(message, 'info')
        this.announce(message)
      } else if (!this.sameSurface(card, 'stashed', { cold: card.cold })) {
        this.setSurface(seated, 'stashed')
        return
      } else {
        this.announce(`${card.name} is a seat of ${seated.shuttleRole}.`)
      }
    } catch (error) {
      const message = `Couldn't make “${card.name}” a seat: ${errText(error)}`
      this.showBanner(message, 'error')
      this.announce(message)
    }
    await this.fetchAndRender()
  }

  private closeRestPopover?: () => void

  private openRestPopover(card: KanbanCard): void {
    this.closeRestPopover?.()
    this.closeRestPopover = restPopover(card, async until => {
      try {
        await this.postJson('/api/v1/lifecycle', {
          action: 'rest', fiber: card.id, origin: card.originId, until,
        }, 'Rest failed')
        await this.fetchAndRender()
      } catch (error) {
        this.showBanner(`Rest failed: ${errText(error)}`, 'error')
      }
    })
  }

  private handleKanbanKeyDown(e: KeyboardEvent): void {
    if (!this.body) return
    // The view keys work from the reader too: 1 or 2 parks it, 3 comes back to it.
    if (this.workspace?.isActive) { this.handleViewHotkey(e); return }
    const nativeControl = (e.target as HTMLElement | null)?.closest?.('button, a, [role="button"], [role="tab"]')
    // Escape releases an engaged lens and goes no further — "back out of what
    // I'm looking at", and the lens is the nearest thing being looked through.
    // A field takes its own Escape (the bar's Find puts itself away) before the lens is released.
    if (e.key === 'Escape' && this.lensCycleId !== null && this.activeViewId === 'desk' && !isTypingTarget(e.target as HTMLElement | null)) {
      e.preventDefault()
      e.stopPropagation()
      this.setLensCycle(null)
      return
    }
    if (this.handleSettingsHotkey(e)) return
    if (this.handleViewHotkey(e)) return
    if (e.key === 'Escape' && this.activeViewId === 'shelf' && !keystrokeIsSpokenFor()) {
      if (this.workspace?.handleOverviewEscapeLayer()) { e.preventDefault(); e.stopPropagation(); return }
      e.preventDefault(); e.stopPropagation(); this.setView('desk'); return
    }
    // Chronicle keeps its own record search in its head; `/` reaches the bar's Find there too.
    if (this.activeViewId === 'chronicle' && !keystrokeIsSpokenFor() && keyIntent(e, 'desk') === 'find' && this.focusFind()) {
      e.preventDefault(); e.stopPropagation()
      return
    }
    if (this.activeViewId === 'desk' && !keystrokeIsSpokenFor()) {
      const intent = keyIntent(e, 'desk')
      const address = this.deskKeyboard?.selection
      const selected = address && this.workspaceCards().find(card => (card.uid ?? card.id) === address.uid && card.originId === address.origin)
      if (intent && constitutionAction(intent, selected, {
        verdict: (card, verdict) => { this.workspace?.queueVerdict(card, verdict) },
        compose: card => this.openDocumentChannel(card, true),
        conversation: card => this.dock.openConversation(card),
        rest: card => this.openRestPopover(card),
      })) {
        e.preventDefault(); e.stopPropagation()
        return
      }
      if (intent === 'find') {
        const filter = [...this.deskEl!.querySelectorAll<HTMLInputElement>('input[type="search"], input[data-card-filter]')]
          .find(input => !input.closest('[hidden],[inert]') && input.getClientRects().length > 0)
        if (this.focusFind()) { /* The bar's Find serves every view. */ }
        else if (filter) filter.focus({ preventScroll: true })
        else this.workspace?.findConstitution()
        e.preventDefault(); e.stopPropagation()
        return
      }
      const nativeActivation = e.key === 'Enter' && nativeControl
      if (intent && !nativeActivation && this.deskKeyboard?.handle(intent)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
    // Column Tab-nav is a Desk gesture — a temporal view owns its own focus
    // order, and the Desk's column heads are display:none behind it anyway.
    if (e.key !== 'Tab' || this.activeViewId !== 'desk') return

    const active = document.activeElement as HTMLElement | null
    // A card's explicit controls are reachable before column navigation resumes.
    const row = active?.closest<HTMLElement>('.kbn-card, .kbn-cluster-item')
    if (row && active) {
      const stops = [row, ...row.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')]
      const at = stops.indexOf(active)
      const next = at >= 0 ? stops[at + (e.shiftKey ? -1 : 1)] : undefined
      if (next) { e.preventDefault(); e.stopPropagation(); next.focus({ preventScroll: true }); return }
    }
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
    let nearest = -1
    let nearestDistance = Number.POSITIVE_INFINITY
    heads.forEach((head, index) => {
      const col = head.closest<HTMLElement>('.kbn-col')
      const distance = col ? Math.abs(col.getBoundingClientRect().left - bodyLeft) : Number.POSITIVE_INFINITY
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = index
      }
    })
    return nearest
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
    if (!this.body || !this.surfaces.isDragging() || this.body.classList.contains('kbn-body-zoomed')) return
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
      if (!this.body || !this.surfaces.isDragging() || this.dragAutoScrollVelocity === 0) {
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

  /**
   * The Move menu's seam. Why the menu exists is written once, in
   * `MoveDestinations.ts`; these four calls are the ONLY thing the menu is
   * given, so it never learns a column or a wire protocol,
   * and every item it performs lands in the same private gesture method the
   * equivalent drop lands in. Each call rules on {@link liveCard}.
   */
  private readonly moveBroker: MoveBroker = {
    // Legal destinations, ruled on where the board actually has the card
    // (`findCardColumn`) rather than a local re-derivation.
    destinations: (card) => {
      const live = this.liveCard(card)
      return moveDestinations(live, findCardColumn(this.lastResponse, live.id))
    },
    perform: (card, action) => this.performMove(this.liveCard(card), action),
  }

  /** Teardown for the open move menu. Non-null iff one is up — a second long
   *  press replaces the first rather than stacking a second menu on it. */
  private closeMoveMenu: (() => void) | null = null

  /**
   * A card held still under the thumb offers what a drag would offer.
   *
   * Touch has no drag backend, so this is the ONLY way to move a card on a
   * phone; on desktop it is a harmless extra beside the drag. Nothing to offer
   * means nothing appears — a menu with no items is worse than no menu, and the
   * card is not broken, it is simply somewhere terminal.
   */
  private openMoveMenuFor(card: KanbanCard, anchor: HTMLElement): void {
    this.closeMoveMenu?.()
    this.closeMoveMenu = null
    if (this.moveBroker.destinations(card).length === 0) return
    this.closeMoveMenu = openMoveMenu(card, anchor, this.moveBroker, () => {
      this.closeMoveMenu = null
    })
  }

  /**
   * THE LIVE CARD, not the one the menu is holding.
   *
   * The menu stays open for as long as the reader wants while the board polls
   * underneath it — so the `KanbanCard` captured at the long press goes stale:
   * the worker finishes, the card closes, someone tempers it from another
   * host. Every broker call therefore re-resolves the card by id before it
   * rules or writes, and only falls back to the caller's copy when the board
   * genuinely has no row for it (a card that has left the feed entirely,
   * where the stale copy is all anyone has).
   *
   * This is the same discipline `transition` already follows for the COLUMN,
   * for the same reason: a gesture ruled on a stale read is a gesture that
   * silently no-ops or writes the wrong thing.
   */
  private liveCard(card: KanbanCard): KanbanCard {
    return findCardById(this.lastResponse, card.id) ?? card
  }

  /** Perform one destination. Each branch is the drop's own entry
   *  point, so banners, optimism and reconciliation are inherited whole. */
  private performMove(card: KanbanCard, action: MoveAction): void {
    switch (action.kind) {
      case 'transition':
        this.transition(card, action.target)
        return
      case 'surface':
        this.setSurface(card, action.horizon)
        return
    }
  }

}

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
  timeline: KanbanResponse['timeline']
  stash: KanbanCard[]
  roles: KanbanCard[]
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
    timeline: {
      ...resp.timeline,
      past: drop(resp.timeline.past),
      futureDated: drop(resp.timeline.futureDated),
    },
    stash: drop(resp.stash),
    roles: drop(resp.roles),
    card: card ?? resp.threads?.find(c => c.id === cardId) ?? null,
  }
}

/**
 * Reassemble a response from mutated surfaces with the length-derived totals
 * recomputed.
 */
function withSurfaces(
  resp: KanbanResponse,
  s: {
    now: KanbanResponse['now']
    timeline: KanbanResponse['timeline']
    stash: KanbanCard[]
    roles?: KanbanCard[]
  },
): KanbanResponse {
  const roles = s.roles ?? resp.roles
  return projectDeskFrontier({
    ...resp,
    now: s.now,
    timeline: s.timeline,
    stash: s.stash,
    roles,
    totals: surfaceTotals({ ...s, roles }),
  })
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
 * Optimistic relocation of one card to a lifecycle `target` column, returned
 * as a fresh KanbanResponse (the input is never mutated). Returns null when
 * the card isn't anywhere in `resp` — the caller then skips optimism and
 * leans on the post-commit refetch alone.
 *
 * This honors the gesture's *named* destination; it does NOT re-derive
 * placement from fiber fields (that stays the server's `classifyFiber`). It
 * only patches the minimal fields the destination's own rendering reads — the
 * past lane keys off `status`/`tempered` and a `closedAt` day-column, and
 * closing the fiber drops the running-worker pill.
 */
export function applyOptimisticTransition(
  resp: KanbanResponse | null,
  cardId: string,
  target: ColumnKind,
): KanbanResponse | null {
  if (!resp) return null
  const nowIso = new Date().toISOString()
  const { card, now, timeline, stash, roles } = liftCardFromSurfaces(resp, cardId)
  if (!card) return null

  const moved: KanbanCard = { ...card }
  // Any UNTEMPERED non-draft state counts, not just awaiting (status:closed):
  // Temper can land while the run is still status:active (worker alive or just
  // killed, exit writer not yet run) and the daemon resolves it to accept
  // there too. Mirrors the daemon's lifecycle actions.
  const isStandingAwaiting =
    card.status !== 'open' && card.tempered === undefined && card.shuttleKind === 'standing'
  if (target === 'tempered' && isStandingAwaiting) {
    // Dropping the awaiting run of a standing constitution on Tempered is
    // ACCEPT — the daemon re-arms it (status:active, verdict cleared) rather
    // than terminating it, so the card's home is the timeline at its next
    // launch, NOT the past lane. Honoring
    // the re-arm here keeps optimism equal to the committed reclassify
    // (the no-snap-back invariant).
    moved.status = 'active'
    moved.tempered = undefined
    moved.closedAt = undefined
    moved.workerState = undefined
    moved.tmuxSession = undefined
    moved.runtimePhase = undefined
    const nowMs = Date.parse(nowIso)
    moved.nextLaunchAt = nextStandingLaunch(
      {
        shuttleKind: 'standing',
        status: 'active',
        shuttleSchedule: card.shuttleSchedule ? { expr: card.shuttleSchedule, tz: card.shuttleTz ?? 'UTC' } : undefined,
      },
      nowMs,
    )
    // A standing seat re-armed between runs rests among the Roles.
    if (moved.shuttleSeat === true && moved.shuttleRole) return withSurfaces(resp, { now, timeline, stash, roles: withSeat(roles, moved) })
    timeline.futureDated = [...timeline.futureDated, moved]
    return withSurfaces(resp, { now, timeline, stash, roles })
  }
  if (target === 'tempered' || target === 'composted') {
    moved.status = 'closed'
    moved.tempered = target === 'tempered'
    moved.workerState = undefined           // closing the fiber stops its worker
    moved.tmuxSession = undefined
    moved.closedAt = card.closedAt ?? nowIso  // past lane skips cards with no closedAt day-column
    timeline.past = [moved, ...timeline.past]
  } else {
    // Patch the fields the destination's own rendering + the next classify
    // read, mirroring the committed verbs: drafts = reopen-as-draft/pause +
    // park-on-desk; awaitingReview = close with the verdict cleared; inFlight
    // = dispatch (the worker pill arrives with the refetch).
    if (target === 'drafts') {
      moved.status = 'open'
      moved.tempered = undefined
      moved.closedAt = undefined
      moved.workerState = undefined
      moved.tmuxSession = undefined
      moved.runtimePhase = undefined
      moved.storedHorizon = undefined
      moved.effectiveHorizon = 'now'
      moved.drifted = false
      moved.due = undefined
    } else if (target === 'awaitingReview') {
      moved.status = 'closed'
      moved.tempered = undefined
      moved.closedAt = card.closedAt ?? nowIso
      moved.workerState = undefined
      moved.tmuxSession = undefined
      moved.runtimePhase = undefined
    } else if (target === 'inFlight') {
      moved.status = 'active'
      moved.tempered = undefined
      moved.closedAt = undefined
    }
    // A seat parked as a draft is a seat at rest: it goes back to its role.
    if (target === 'drafts' && moved.shuttleSeat === true && moved.shuttleRole) {
      return withSurfaces(resp, { now, timeline, stash, roles: withSeat(roles, moved) })
    }
    now[target] = [...now[target], moved]
  }

  return withSurfaces(resp, { now, timeline, stash, roles })
}

/** Optimistically mark the seat without changing a running or closed lifecycle. */
export function applyOptimisticSeat(resp: KanbanResponse | null, seat: KanbanCard): KanbanResponse | null {
  if (!resp) return null
  const patch = (cards: KanbanCard[]): KanbanCard[] => cards.map(card => card.id === seat.id
    ? { ...card, shuttleRole: seat.shuttleRole, shuttleSeat: true } : card)
  const updated = withSurfaces(resp, {
    now: { drafts: patch(resp.now.drafts), inFlight: patch(resp.now.inFlight), awaitingReview: patch(resp.now.awaitingReview) },
    timeline: { ...resp.timeline, past: patch(resp.timeline.past), futureDated: patch(resp.timeline.futureDated) },
    stash: patch(resp.stash), roles: patch(resp.roles),
  })
  return seatAtRest(seat)
    ? placeOptimistically(updated, seat.id, () => ({}))
    : updated
}

/** `roles` with `seat` placed where the read model's name order puts it. */
function withSeat(roles: KanbanCard[], seat: KanbanCard): KanbanCard[] {
  const at = roles.findIndex((c) => c.name.localeCompare(seat.name) > 0)
  return at < 0 ? [...roles, seat] : [...roles.slice(0, at), seat, ...roles.slice(at)]
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
  // A planning-surface drop parks the card as a draft (commitSurface's
  // park-as-draft transition): closed reopens to open with the verdict
  // cleared, active pauses to open, and the kill strips the worker pill —
  // mirrored here so the optimistic card matches the committed reclassify
  // (the no-snap-back invariant).
  return placeOptimistically(resp, cardId, (card) => ({
    status: 'open',
    tempered: undefined,
    closedAt: undefined,
    workerState: undefined,
    tmuxSession: undefined,
    runtimePhase: undefined,
    storedHorizon: 'stashed',
    effectiveHorizon: 'stashed',
    drifted: false,
    cold: opts.cold ?? false,
    // The optimistic card must be the card the WRITE produces, or the board
    // shows one frame of a lie and then snaps. `undefined` is setSurface's
    // "leave the date alone" (a bare stash preserves a future deadline), so
    // it keeps the card's own; an explicit day or an explicit `null` — the
    // date-column snooze, and the stale-due clear — wins over it.
    due: opts.due === undefined ? card.due : (opts.due ?? undefined),
  }))
}

/**
 * The skeleton of the stash relocator above: lift the card off whichever
 * surface holds it, patch it, and put it back at the head of Resting (a seat
 * among the Roles).
 * Returns a fresh response (the input is never mutated), or null when there is
 * no response or the card is absent from it.
 */
function placeOptimistically(
  resp: KanbanResponse | null,
  cardId: string,
  patch: (card: KanbanCard) => Partial<KanbanCard>,
): KanbanResponse | null {
  if (!resp) return null
  const { card, now, timeline, stash, roles } = liftCardFromSurfaces(resp, cardId)
  if (!card) return null
  const moved: KanbanCard = { ...card, ...patch(card) }
  // Resting a seat keeps it a seat: it comes to rest among the Roles.
  if (moved.shuttleSeat === true && moved.shuttleRole) return withSurfaces(resp, { now, timeline, stash, roles: withSeat(roles, moved) })
  return withSurfaces(resp, { now, timeline, stash: [moved, ...stash], roles })
}
