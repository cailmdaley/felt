import { renderMarkdown } from './utils.js'
import type {
  ColumnKind,
  HorizonKind,
  KanbanCard,
  KanbanOriginStaleness,
  KanbanResponse,
} from './KanbanTypes.js'
import { isAgentCard } from './KanbanModalShared.js'

export const COLUMN_TITLES: Record<ColumnKind, string> = {
  drafts: 'Drafts',
  inFlight: 'In flight',
  awaitingReview: 'Awaiting review',
  tempered: 'Tempered',
  composted: 'Composted',
  pinned: 'Pinned',
}

type NowColumnKind = 'drafts' | 'inFlight' | 'awaitingReview'
const NOW_COLUMN_ORDER: NowColumnKind[] = ['drafts', 'inFlight', 'awaitingReview']

// 225px per day column -> ~7 days visible at a time in the standard
// kanban modal viewport (~1574px wide). The wrap stays horizontally
// scrollable for the server-provided range.
const TIMELINE_DAY_WIDTH_PX = 225

// The Pinned band wraps its launcher chips to at most this many rows; extra
// roles page behind a "+N more" affordance rather than scrolling.
const PINNED_MAX_ROWS = 2

/** Stash cluster-key derivation: skip umbrella roots (`ai-futures`,
 *  `ai`) and use the first project-level segment instead. Containment-
 *  path remains the load-bearing axis (always present, no user
 *  effort); the skip list is empirically-noisy umbrellas that don't
 *  carry meaning for the user. */
const CLUSTER_KEY_SKIP_ROOTS = new Set<string>(['ai-futures', 'ai'])

/**
 * Daemon runtime phases that earn a chip on an In-flight card.
 *
 * Two live-worker flavors, both of which *take over* the worker pill — the chip
 * becomes the clickable worker button itself, so the human-attention state IS
 * the call-to-action rather than a flag beside it. `attention` (raised its hand
 * via Notification) takes over from the first event — the red manicule chip.
 * `waiting` (the worker stopped at a prompt) takes over once idle ≥60s — the
 * amber chip (the daemon stamps `waiting` the instant a stop fires, so the
 * takeover is gated downstream in `renderCard`; under 60s the pill stays the
 * plain "▸ aloft"). The third live category, `working` (busy mid-tool), has NO entry here — its
 * absence IS the "no chip" behavior. The rest fire *without* a live worker to
 * show: `running` is the rare unmatched case (daemon says running but no session
 * resolved); `retrying`/`due`/`dispatched` are genuinely worker-less. Either way
 * the chip lets the card explain itself instead of reading as an anomaly. Phases
 * that drive their own column (`scheduled`, `awaiting`, `accepted`, `dormant`)
 * are omitted — the column already says it.
 */
const RUNTIME_PHASE_BADGES: Record<string, { label: string; title: string }> = {
  // The manicule (U+261E) followed by the U+FE0E text variation selector forces
  // a serif text glyph, not a color emoji — paired with `font-variant-emoji:
  // text` and the EB Garamond stack in CSS.
  attention: { label: '☞︎ needs you now', title: 'The worker raised its hand (Notification) — it needs you now. Open it to respond.' },
  waiting: { label: '⏸ waiting for you', title: 'The worker is paused at a prompt waiting for human input — open it to respond.' },
  retrying: { label: '⟳ retrying', title: 'Dispatch failed — daemon is retrying with backoff. No live worker right now.' },
  due: { label: '◴ due', title: 'Scheduled tick elapsed — awaiting dispatch.' },
  dispatched: { label: '▸ dispatched', title: 'Dispatch sent — worker starting up.' },
  running: { label: '▸ running', title: 'Daemon reports a running worker, but its session is not matched here.' },
}

/** Skim-able title for surface affordance announcements. */
export const SURFACE_TITLE: Record<HorizonKind, string> = {
  now: 'Now',
  soon: 'Soon',
  stashed: 'Stash',
}

/** The visual variants a timeline mini-card can take, by lifecycle position. */
type TimelineCardKind = 'past' | 'future' | 'awaiting' | 'inflight' | 'draft'

/** Stash cluster: project key + warmth + cards under that key. */
interface StashCluster {
  key: string
  cold: boolean
  cards: KanbanCard[]
}

interface KanbanSurfaceRendererOptions {
  getDragSourceId: () => string | null
  setDragSourceId: (id: string | null) => void
  getLastResponse: () => KanbanResponse | null
  stopDragAutoScroll: () => void
  transition: (card: KanbanCard, target: ColumnKind) => void | Promise<void>
  setSurface: (
    card: KanbanCard,
    horizon: HorizonKind,
    opts?: { cold?: boolean; due?: string | null },
  ) => void | Promise<void>
  /** Reshape a fiber to a resting `kind:pinned` role — the drag-onto-the-
   *  Pinned-strip gesture. The off-the-shelf twin of `setSurface`/`transition`. */
  pin: (card: KanbanCard) => void | Promise<void>
  openDetail: (card: KanbanCard, column: ColumnKind) => void
  openWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  setTimelineAdaptiveCleanup: (cleanup: (() => void) | null) => void
  /** Stash a new fiber — the Drafts head's `+` action. Omit to render the
   *  Drafts head title + count alone (read-only context). */
  onStashClick?: () => void
  /** Open the chat-first capture — the In flight head's `✶` action. Omit to
   *  render the In flight head title + count alone. */
  onNewIdeaClick?: () => void
  /** Re-fetch the board — the Awaiting review head's `↻` action. Always wired
   *  (refresh is never read-only). */
  onRefresh: () => void
}

export class KanbanSurfaceRenderer {
  private readonly getDragSourceId: () => string | null
  private readonly setDragSourceId: (id: string | null) => void
  private readonly getLastResponse: () => KanbanResponse | null
  private readonly stopDragAutoScroll: () => void
  private readonly transition: (card: KanbanCard, target: ColumnKind) => void | Promise<void>
  private readonly setSurface: (
    card: KanbanCard,
    horizon: HorizonKind,
    opts?: { cold?: boolean; due?: string | null },
  ) => void | Promise<void>
  private readonly pin: (card: KanbanCard) => void | Promise<void>
  private readonly openDetail: (card: KanbanCard, column: ColumnKind) => void
  private readonly openWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly setTimelineAdaptiveCleanup: (cleanup: (() => void) | null) => void
  private readonly onStashClick?: () => void
  private readonly onNewIdeaClick?: () => void
  private readonly onRefresh: () => void
  /** Horizontal edge-scroll for the timeline wrap during drag. Lets the
   *  user drag a card from Now toward the timeline's left/right edge to
   *  auto-scroll into off-screen days. Separate from the body's vertical
   *  drag scroll so they can run concurrently. */
  private timelineEdgeScrollFrame: number | null = null
  private timelineEdgeScrollVelocity = 0
  private timelineEdgeScrollTarget: HTMLElement | null = null
  /** Current page of the Pinned band when its chips overflow two rows.
   *  Cycled by the "+N more" pager; survives poll re-renders. */
  private pinnedPage = 0

  constructor(options: KanbanSurfaceRendererOptions) {
    this.getDragSourceId = options.getDragSourceId
    this.setDragSourceId = options.setDragSourceId
    this.getLastResponse = options.getLastResponse
    this.stopDragAutoScroll = options.stopDragAutoScroll
    this.transition = options.transition
    this.setSurface = options.setSurface
    this.pin = options.pin
    this.openDetail = options.openDetail
    this.openWorker = options.openWorker
    this.setTimelineAdaptiveCleanup = options.setTimelineAdaptiveCleanup
    this.onStashClick = options.onStashClick
    this.onNewIdeaClick = options.onNewIdeaClick
    this.onRefresh = options.onRefresh
  }

  /** Render the Now surface: section header + 3-column board. */
  renderNowSection(
    now: KanbanResponse['now'],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-now'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'Now — the desk')

    const board = document.createElement('div')
    board.className = 'kbn-now-board'
    for (const kind of NOW_COLUMN_ORDER) {
      board.append(this.renderColumn(kind, now[kind], staleness))
    }

    section.append(board)
    this.installSectionDragHandlers(section, 'now')
    return section
  }

  /** Render the Pinned band: a dense wrap of at-rest pinned-role launcher
   *  chips, sitting between the Timeline ribbon and the Now board. These are
   *  schedule-less `kind:pinned` roles the poller never auto-fires; you
   *  dispatch one by dragging it onto the Now In-flight column (the chips are
   *  draggable and `findCardColumn` returns 'pinned' so the drag routes through
   *  `transition(card,'inFlight')`). Chips are stable-ordered by fiber path and
   *  wrap to at most PINNED_MAX_ROWS rows in the available width; extra roles
   *  page behind a "+N more" affordance rather than scrolling (measured after
   *  layout in installPinnedPagination). ALWAYS rendered — even with zero parked
   *  roles — because the band IS the drop target for parking a role, so hiding
   *  it when empty made parking impossible exactly when nothing was parked. The
   *  empty state shrinks to a slim "drag a role here" hint.
   */
  renderPinnedSection(
    pinned: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-pinned'
    if (pinned.length === 0) section.classList.add('kbn-section-pinned-empty')
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', `Pinned (${pinned.length}) — drag a role here to park it; drag one to In flight to start it`)

    const head = document.createElement('h2')
    head.className = 'kbn-pinned-title'
    head.textContent = pinned.length ? `Pinned · ${pinned.length}` : 'Pinned'
    section.append(head)

    const row = document.createElement('div')
    row.className = 'kbn-pinned-row'
    row.setAttribute('role', 'list')
    if (pinned.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'kbn-pinned-empty-hint'
      hint.textContent = 'Drag a role here to park it on the strip'
      row.append(hint)
    } else {
      // Stable ordering by fiber path (id) so the launcher band holds still —
      // pinned is a *launcher*, and muscle memory only works if a role sits in
      // the same place every visit. The read model's most-recently-used order
      // would shuffle chips out from under the user's hand.
      const ordered = [...pinned].sort((a, b) => a.id.localeCompare(b.id))
      const chips = ordered.map((card) => this.renderPinnedChip(card, staleness[card.originId]))
      for (const chip of chips) row.append(chip)
      // Wrapping + "+N more" paging is a post-layout measurement (chip widths
      // aren't known until the band is in the DOM), so defer to a rAF once the
      // section has been attached by the modal's render pass.
      window.requestAnimationFrame(() => this.installPinnedPagination(row, chips))
    }
    section.append(row)
    this.installPinnedDropHandlers(section)
    return section
  }

  /**
   * Cap the Pinned band to PINNED_MAX_ROWS rows and page the overflow. Chips
   * wrap naturally; we measure their row ranks (by offsetTop), keep the chips
   * that fall in the first two rows for the current page, hide the rest, and —
   * when there's overflow — append a "+N more" pager that cycles pages in place.
   * Re-runnable and idempotent: it first reveals every chip and drops any prior
   * pager so each measurement starts from the full set.
   */
  private installPinnedPagination(row: HTMLElement, chips: HTMLElement[]): void {
    if (chips.length === 0) return
    row.querySelector('.kbn-pin-more')?.remove()
    for (const chip of chips) chip.style.display = ''
    if (row.clientWidth === 0) return // not laid out yet; a later render retries

    // Row rank of each chip from its vertical offset (chips on the same visual
    // row share an offsetTop). perPageBase = how many fit in the first two rows.
    const tops = chips.map((c) => c.offsetTop)
    const distinctTops = [...new Set(tops)].sort((a, b) => a - b)
    if (distinctTops.length <= PINNED_MAX_ROWS) {
      this.pinnedPage = 0
      return // everything fits; no paging needed
    }
    const rowTopCutoff = distinctTops[PINNED_MAX_ROWS] // first row that overflows
    // Reserve one slot for the pager so it always sits within the two rows.
    const perPage = Math.max(1, tops.filter((t) => t < rowTopCutoff).length - 1)
    const totalPages = Math.ceil(chips.length / perPage)
    this.pinnedPage = Math.min(this.pinnedPage, totalPages - 1)

    const start = this.pinnedPage * perPage
    const end = start + perPage
    chips.forEach((chip, i) => {
      chip.style.display = i >= start && i < end ? '' : 'none'
    })
    const remaining = chips.length - end
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'kbn-tl-pager kbn-pin-more'
    more.textContent = remaining > 0 ? `+${remaining} more` : `↺ ${totalPages}`
    more.title = `${chips.length} pinned roles — page ${this.pinnedPage + 1}/${totalPages}. Click to cycle.`
    more.setAttribute('aria-label', `Show more pinned roles (page ${this.pinnedPage + 1} of ${totalPages})`)
    more.addEventListener('click', (e) => {
      e.stopPropagation()
      this.pinnedPage = (this.pinnedPage + 1) % totalPages
      this.installPinnedPagination(row, chips)
    })
    row.append(more)
  }

  /**
   * One pinned role as a compact launcher chip — the launcher-not-monitor
   * rework. The user arrives with intent ("start X") and scans for the role,
   * so the chip carries only what locates and launches it: an actor glyph,
   * the role name, a status/staleness dot, and the agent/host hint. No outcome
   * text (it lives on the `title` tooltip for the rare glance). The two
   * human-attention phases (`attention`/`waiting`) still earn a small marker —
   * they're genuinely "this one needs you." Click opens the fiber detail (same
   * as the old card); the chip stays draggable so drag-to-In-flight dispatches
   * it and drag-off-strip is handled upstream.
   */
  private renderPinnedChip(
    card: KanbanCard,
    originStaleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = originStaleness?.status === 'stale'
    const isAgent = isAgentCard(card)

    const el = document.createElement('button')
    el.type = 'button'
    el.className = `kbn-pin-chip${isAgent ? ' kbn-pin-chip-agent' : ' kbn-pin-chip-human'}${isStale ? ' kbn-card--stale' : ''}`
    el.dataset.fiberId = card.id
    el.setAttribute('role', 'listitem')
    el.draggable = !isStale
    el.title = card.outcome ? `${card.name} — ${card.outcome}` : card.name
    el.setAttribute('aria-label', `${card.name}${isStale ? ' — waiting on origin, drag disabled' : ''}`)

    if (!isStale) this.installDraggable(el, card, true)

    // Status/staleness dot: stale (grey), live worker (teal, pulsing), or at-
    // rest (faint). The dot is the whole health read — no text needed.
    const dotState = isStale ? 'stale' : card.runningWorker ? 'live' : card.held ? 'held' : 'rest'
    const dot = document.createElement('span')
    dot.className = `kbn-pin-chip-dot kbn-pin-chip-dot-${dotState}`
    dot.setAttribute('aria-hidden', 'true')

    const glyph = document.createElement('span')
    glyph.className = 'kbn-pin-chip-glyph'
    glyph.setAttribute('aria-hidden', 'true')
    glyph.textContent = isAgent ? '◐' : '✓'

    const name = document.createElement('span')
    name.className = 'kbn-pin-chip-name'
    name.textContent = card.name

    const hint = document.createElement('span')
    hint.className = 'kbn-pin-chip-hint'
    hint.textContent = isAgent ? (card.shuttleAgent ?? 'agent') : 'me'

    el.append(dot, glyph, name, hint)

    // Attention-bearing marker — the one thing that overrides "launcher, not
    // monitor." A parked role whose worker raised its hand (or is waiting on
    // input) shows a small manicule/pause chip so it can call you back.
    const phase = card.runtimePhase
    if (phase === 'attention' || phase === 'waiting') {
      const badge = RUNTIME_PHASE_BADGES[phase]
      const mark = document.createElement('span')
      mark.className = `kbn-pin-chip-attn kbn-pin-chip-attn-${phase}`
      mark.textContent = phase === 'attention' ? '☞︎' : '⏸'
      mark.title = badge.title
      mark.setAttribute('aria-label', badge.label)
      el.append(mark)
    }

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return
      this.openDetail(card, 'pinned')
    })
    return el
  }

  /**
   * The "onto the shelf" half of the Pinned strip: dropping a card here
   * reshapes it to a resting `kind:pinned` role via `pin`. The off-write twin
   * of dragging a pinned card onto In-flight (which dispatches it). Mirrors
   * `installSectionDragHandlers` (the stash shelf), differing only in the write
   * it commits — pinning is a `/lifecycle` reshape, not a `/felt-edit` field.
   * A card already on the strip drops to a no-op (its column is already pinned).
   */
  private installPinnedDropHandlers(section: HTMLElement): void {
    section.addEventListener('dragover', (e) => {
      if (!this.getDragSourceId()) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      section.classList.add('kbn-section-drop')
    })
    section.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && section.contains(e.relatedTarget as Node)) return
      section.classList.remove('kbn-section-drop')
    })
    section.addEventListener('drop', (e) => {
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.getDragSourceId()
      section.classList.remove('kbn-section-drop')
      this.setDragSourceId(null)
      this.stopDragAutoScroll()
      if (!fiberId) return
      e.preventDefault()
      const card = findCardById(this.getLastResponse(), fiberId)
      if (!card) return
      // A card already resting on the strip is handled inside pinRole, which
      // banners "already pinned" rather than no-opping silently here.
      void this.pin(card)
    })
  }

  /** Render the Timeline surface: scrollable day-column grid with past
   *  landings on the left, today centered, future-dated cards on the
   *  right.
   *
   *  Now cards project onto the strip too - drafts and inflight stack
   *  on today's column, awaiting-review on its closedAt. They still
   *  live in the Now section above; the timeline ghosts give the user
   *  one comprehensive temporal view, and let them drag any active
   *  card forward as a visual-scheduling gesture (drop on a future
   *  date -> setSurface(soon, due=iso), which routes the card to
   *  timeline.futureDated and out of the Now column).
   */
  renderTimelineSection(
    timeline: KanbanResponse['timeline'],
    now: KanbanResponse['now'],
    timelineWindow: KanbanResponse['timelineWindow'],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-timeline'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'Timeline — past and soon')

    const wrap = document.createElement('div')
    wrap.className = 'kbn-timeline-wrap'
    wrap.dataset.timelineWrap = '1'

    const days = buildTimelineDays(timelineWindow.pastDays, timelineWindow.futureDays)
    const dayIndex = new Map<string, number>(days.map((d, i) => [d.iso, i]))

    const axis = document.createElement('div')
    axis.className = 'kbn-timeline-axis'
    axis.style.gridTemplateColumns = `repeat(${days.length}, ${TIMELINE_DAY_WIDTH_PX}px)`
    const axisCells = days.map((day) => buildDayCell(day))
    for (const cell of axisCells) axis.append(cell)
    wrap.append(axis)

    const strip = document.createElement('div')
    strip.className = 'kbn-timeline-strip'
    strip.style.gridTemplateColumns = `repeat(${days.length}, ${TIMELINE_DAY_WIDTH_PX}px)`

    const dropColByIso = new Map<string, HTMLElement>()
    const axisCellByIso = new Map<string, HTMLElement>()
    for (let i = 0; i < days.length; i += 1) {
      const dropCol = document.createElement('div')
      dropCol.className = `kbn-timeline-dropcol${days[i].isToday ? ' kbn-timeline-dropcol-today' : ''}`
      dropCol.style.gridColumn = String(i + 1)
      dropCol.dataset.timelineDayIso = days[i].iso
      this.installTimelineDayDropHandlers(dropCol, days[i].iso, axisCells[i])
      strip.append(dropCol)
      dropColByIso.set(days[i].iso, dropCol)
      axisCellByIso.set(days[i].iso, axisCells[i])
    }
    this.installTimelineStripDragFallback(strip, dropColByIso, axisCellByIso)

    const rowByCol = new Map<number, number>()
    const nextRow = (col: number): number => {
      const row = (rowByCol.get(col) ?? 0) + 1
      rowByCol.set(col, row)
      return row
    }

    const todayIso = isoDay(new Date())
    const todayCol = dayIndex.get(todayIso) ?? null
    if (todayCol !== null) {
      for (const card of now.inFlight) {
        strip.append(this.renderTimelineCard(card, todayCol, nextRow(todayCol), 'inflight', staleness[card.originId]))
      }
    }
    for (const card of now.awaitingReview) {
      // Ghost at closedAt — but a closed fiber can carry a null closed_at (a
      // close that didn't stamp the date), and with no fallback that silently
      // dropped the card off the timeline entirely (it showed on the desk but
      // "vanished" from the temporal view). Fall back to modifiedAt (≈ when the
      // run closed it), then today, so an awaiting card is always findable.
      const col = awaitingGhostDayColumn(card, dayIndex, todayCol)
      if (col === null) continue
      strip.append(this.renderTimelineCard(card, col, nextRow(col), 'awaiting', staleness[card.originId]))
    }
    for (const card of timeline.past) {
      const col = dayIndexForIso(card.closedAt, dayIndex)
      if (col === null) continue
      strip.append(this.renderTimelineCard(card, col, nextRow(col), 'past', staleness[card.originId]))
    }
    if (todayCol !== null) {
      for (const card of now.drafts) {
        // Drifted drafts — an imminent `due:` pulled them onto the desk — park
        // at their due-date column ("every card lives on the timeline at its
        // real date") while still appearing in the Now board. Undated drafts
        // sit at today, their natural now-position.
        const col = card.due ? (dayIndexForIso(card.due, dayIndex) ?? todayCol) : todayCol
        strip.append(this.renderTimelineCard(card, col, nextRow(col), 'draft', staleness[card.originId]))
      }
    }
    for (const card of timeline.futureDated) {
      const col = dayIndexForIso(card.nextLaunchAt ?? card.due, dayIndex)
      if (col === null) continue
      const kind = card.status === 'closed' ? 'awaiting' : 'future'
      strip.append(this.renderTimelineCard(card, col, nextRow(col), kind, staleness[card.originId]))
    }
    wrap.append(strip)

    this.installAdaptiveStripHeight(wrap, strip, rowByCol, days.length)
    this.installTimelineEdgeScroll(wrap)

    // The day-strip (14-day window, horizontally scrollable) and a fixed
    // "Later" rail sit side by side. The rail holds armed standing roles
    // firing beyond the strip horizon (timeline.anytimeSoon) — placeless on
    // the day axis, but they must not silently vanish, so they get a compact
    // always-visible column pinned to the strip's right. Rendered only when
    // populated; otherwise the wrap claims the full width as before.
    const row = document.createElement('div')
    row.className = 'kbn-timeline-row'
    row.append(wrap)
    if (timeline.anytimeSoon.length > 0) {
      row.append(this.renderLaterRail(timeline.anytimeSoon, staleness))
    }
    section.append(row)

    // No collapse chevron on the Timeline: it's the always-visible horizon
    // ribbon now, so a collapse toggle is redundant (and the user never used
    // it). The Timeline was the only section that ever carried collapse chrome,
    // so it retired with this section (installSectionChrome deleted wholesale).
    return section
  }

  /** Render the "Later" rail: a compact, always-visible column pinned to the
   *  right of the scrollable day strip, holding armed standing roles whose
   *  next firing lies beyond the 14-day window (timeline.anytimeSoon). These
   *  have no place on the day axis, but a far-future cron must still *show*
   *  somewhere — this is that somewhere. Read-only (no drag): a cron's date
   *  is set by its schedule, not by dropping it on a day. */
  private renderLaterRail(
    cards: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const rail = document.createElement('aside')
    rail.className = 'kbn-timeline-later'
    rail.setAttribute('aria-label', `Later — ${cards.length} scheduled beyond the strip`)

    const head = document.createElement('div')
    head.className = 'kbn-timeline-later-head'
    head.textContent = 'Later'
    rail.append(head)

    const list = document.createElement('div')
    list.className = 'kbn-timeline-later-cards'
    list.setAttribute('role', 'list')
    for (const card of cards) list.append(this.renderLaterCard(card, staleness[card.originId]))
    rail.append(list)
    return rail
  }

  private renderLaterCard(
    card: KanbanCard,
    staleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = staleness?.status === 'stale'
    const el = document.createElement('div')
    el.className = `kbn-tl-later-card${isStale ? ' kbn-card--stale' : ''}`
    el.dataset.fiberId = card.id
    el.title = card.name
    el.setAttribute('role', 'listitem')

    const when = document.createElement('span')
    when.className = 'kbn-tl-later-when'
    when.textContent = formatLaterWhen(card.nextLaunchAt ?? card.due)
    const title = document.createElement('span')
    title.className = 'kbn-tl-later-title'
    title.textContent = card.name
    el.append(when, title)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      this.openDetail(card, 'inFlight')
    })
    return el
  }

  /** Render the Stash surface: cluster grid keyed by containment-path's
   *  first meaningful project segment. Warm clusters first, then a
   *  divider, then held-open clusters in a dimmer style. */
  renderStashSection(
    stash: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-stash'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'Stash — set aside, visible')

    const clusters = clusterStashCards(stash)
    const warm = clusters.filter((c) => !c.cold)
    const cold = clusters.filter((c) => c.cold)

    const grid = document.createElement('div')
    grid.className = 'kbn-cluster-grid'
    for (const c of warm) grid.append(this.renderCluster(c, staleness))
    if (cold.length > 0) {
      const divider = document.createElement('div')
      divider.className = 'kbn-cluster-divider'
      divider.setAttribute('aria-hidden', 'true')
      divider.textContent = '— held open —'
      grid.append(divider)
      for (const c of cold) grid.append(this.renderCluster(c, staleness))
    }
    if (clusters.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-cluster-empty'
      empty.textContent = '— nothing stashed —'
      grid.append(empty)
    }

    section.append(grid)
    this.installSectionDragHandlers(section, 'stashed')
    return section
  }

  /** Position the timeline horizontal scroll so today sits at ~28% from
   *  the left, matching the playground reference. Skipped when the
   *  snapshot already had a horizontal scroll position. */
  scrollTimelineToToday(body: HTMLElement | null, timelinePastDays: number): void {
    if (!body) return
    const wrap = body.querySelector<HTMLElement>('[data-timeline-wrap]')
    if (!wrap) return
    const todayOffset = timelinePastDays * TIMELINE_DAY_WIDTH_PX
    const target = todayOffset - wrap.clientWidth * 0.28
    wrap.scrollLeft = Math.max(0, target)
  }

  stopTimelineEdgeScroll(): void {
    this.timelineEdgeScrollVelocity = 0
    this.timelineEdgeScrollTarget = null
    if (this.timelineEdgeScrollFrame === null) return
    window.cancelAnimationFrame(this.timelineEdgeScrollFrame)
    this.timelineEdgeScrollFrame = null
  }

  /** Bind a scroll + resize listener that sizes the strip to fit the max
   *  card stack among horizontally-visible day-columns. */
  private installAdaptiveStripHeight(
    wrap: HTMLElement,
    strip: HTMLElement,
    rowByCol: Map<number, number>,
    totalDays: number,
  ): void {
    const ROW_PX = 22
    const STRIP_PADDING_PX = 6
    const TIMELINE_MAX_VISIBLE_ROWS = 10
    const recompute = (): void => {
      const sLeft = wrap.scrollLeft
      const sRight = sLeft + wrap.clientWidth
      const firstCol = Math.max(0, Math.floor(sLeft / TIMELINE_DAY_WIDTH_PX))
      const lastCol = Math.min(totalDays - 1, Math.floor((sRight - 1) / TIMELINE_DAY_WIDTH_PX))
      let maxRows = 1
      for (let c = firstCol; c <= lastCol; c += 1) {
        const r = rowByCol.get(c)
        if (r !== undefined && r > maxRows) maxRows = r
      }
      const visibleRows = Math.min(maxRows, TIMELINE_MAX_VISIBLE_ROWS)
      // Publish the measured full height as a CSS variable rather than setting
      // `height` directly. CSS owns the compact↔expanded switch (a slim ribbon
      // by default; grows to this full height on hover and while a drag is in
      // flight anywhere on the board — drag-to-schedule means dragging *up*
      // into an inviting horizon). Keeping the switch + transition in CSS keeps
      // this measurement job pure and the animation jank-free.
      strip.style.setProperty('--tl-full-height', `${visibleRows * ROW_PX + STRIP_PADDING_PX}px`)
    }
    let rafScheduled = false
    const schedule = (): void => {
      if (rafScheduled) return
      rafScheduled = true
      window.requestAnimationFrame(() => {
        rafScheduled = false
        recompute()
      })
    }
    wrap.addEventListener('scroll', schedule, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    ro?.observe(wrap)
    window.requestAnimationFrame(recompute)

    this.setTimelineAdaptiveCleanup(() => {
      wrap.removeEventListener('scroll', schedule)
      ro?.disconnect()
    })
  }

  /** Edge-scroll the timeline wrap when a drag approaches its left or
   *  right edge. Mirrors the body's vertical drag-scroll. */
  private installTimelineEdgeScroll(wrap: HTMLElement): void {
    const EDGE_PX = 80
    const MAX_STEP_PX = 28
    const onDragOver = (e: DragEvent): void => {
      if (!this.getDragSourceId()) return
      const r = wrap.getBoundingClientRect()
      const leftPressure = Math.max(0, EDGE_PX - (e.clientX - r.left))
      const rightPressure = Math.max(0, EDGE_PX - (r.right - e.clientX))
      const direction = rightPressure > 0 ? 1 : leftPressure > 0 ? -1 : 0
      const pressure = Math.max(leftPressure, rightPressure) / EDGE_PX
      this.timelineEdgeScrollVelocity = direction === 0
        ? 0
        : direction * Math.max(6, Math.round(Math.pow(pressure, 1.35) * MAX_STEP_PX))
      if (this.timelineEdgeScrollVelocity === 0) {
        this.stopTimelineEdgeScroll()
        return
      }
      this.timelineEdgeScrollTarget = wrap
      this.startTimelineEdgeScroll()
    }
    const onDragLeave = (e: DragEvent): void => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget as Node)) return
      this.stopTimelineEdgeScroll()
    }
    const onDrop = (): void => this.stopTimelineEdgeScroll()
    wrap.addEventListener('dragover', onDragOver)
    wrap.addEventListener('dragleave', onDragLeave)
    wrap.addEventListener('drop', onDrop)
  }

  private startTimelineEdgeScroll(): void {
    if (this.timelineEdgeScrollFrame !== null) return
    const tick = (): void => {
      const target = this.timelineEdgeScrollTarget
      if (!target || !this.getDragSourceId() || this.timelineEdgeScrollVelocity === 0) {
        this.stopTimelineEdgeScroll()
        return
      }
      target.scrollLeft += this.timelineEdgeScrollVelocity
      this.timelineEdgeScrollFrame = window.requestAnimationFrame(tick)
    }
    this.timelineEdgeScrollFrame = window.requestAnimationFrame(tick)
  }

  /** Install drop handlers on a section (Now or Stash) - drop anywhere
   *  inside the section that isn't a column header writes the legacy
   *  surface command for the card. Now clears horizon; Stash writes
   *  'stashed'. */
  private installSectionDragHandlers(section: HTMLElement, horizon: 'now' | 'stashed'): void {
    section.addEventListener('dragover', (e) => {
      if (!this.getDragSourceId()) return
      if ((e.target as HTMLElement).closest('.kbn-col-head')) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      section.classList.add('kbn-section-drop')
    })
    section.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && section.contains(e.relatedTarget as Node)) return
      section.classList.remove('kbn-section-drop')
    })
    section.addEventListener('drop', (e) => {
      if ((e.target as HTMLElement).closest('.kbn-col-head')) return
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.getDragSourceId()
      section.classList.remove('kbn-section-drop')
      this.setDragSourceId(null)
      this.stopDragAutoScroll()
      if (!fiberId) return
      e.preventDefault()
      const card = findCardById(this.getLastResponse(), fiberId)
      if (!card) return
      void this.setSurface(card, horizon)
    })
  }

  /**
   * Cursor-based forwarder for timeline strip drops: when an overlay card
   * sits on top of a dropcol and WKWebView delivers the dragover to the
   * card instead of the dropcol underneath, this handler finds the dropcol
   * at cursor coordinates and mirrors its handler.
   */
  private installTimelineStripDragFallback(
    strip: HTMLElement,
    dropColByIso: Map<string, HTMLElement>,
    axisCellByIso: Map<string, HTMLElement>,
  ): void {
    const findDropcolAt = (clientX: number, clientY: number): HTMLElement | null => {
      const els = document.elementsFromPoint(clientX, clientY)
      for (const el of els) {
        if (el instanceof HTMLElement && el.classList.contains('kbn-timeline-dropcol')) {
          return el
        }
      }
      return null
    }
    const isDropEligible = (id: string, iso: string): boolean => {
      const today = isoDay(new Date())
      if (iso < today) return false
      return !!findCardById(this.getLastResponse(), id)
    }
    const clearActives = (): void => {
      for (const dc of dropColByIso.values()) dc.classList.remove('kbn-timeline-dropcol-active')
      for (const ac of axisCellByIso.values()) ac.classList.remove('kbn-timeline-day-drop-active')
    }

    strip.addEventListener('dragover', (e) => {
      const dragSourceId = this.getDragSourceId()
      if (!dragSourceId) return
      const target = e.target as HTMLElement | null
      if (target && target.classList.contains('kbn-timeline-dropcol')) return
      const dropcol = findDropcolAt(e.clientX, e.clientY)
      if (!dropcol) return
      const iso = dropcol.dataset.timelineDayIso
      if (!iso) return
      if (!isDropEligible(dragSourceId, iso)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      clearActives()
      dropcol.classList.add('kbn-timeline-dropcol-active')
      const axis = axisCellByIso.get(iso)
      axis?.classList.add('kbn-timeline-day-drop-active')
    })

    strip.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && strip.contains(e.relatedTarget as Node)) return
      clearActives()
    })

    strip.addEventListener('drop', (e) => {
      const target = e.target as HTMLElement | null
      if (target && target.classList.contains('kbn-timeline-dropcol')) return
      const dropcol = findDropcolAt(e.clientX, e.clientY)
      if (!dropcol) return
      const iso = dropcol.dataset.timelineDayIso
      if (!iso) return
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.getDragSourceId()
      e.preventDefault()
      e.stopPropagation()
      clearActives()
      this.setDragSourceId(null)
      this.stopDragAutoScroll()
      if (!fiberId) return
      if (!isDropEligible(fiberId, iso)) return
      const card = findCardById(this.getLastResponse(), fiberId)
      if (!card) return
      if (iso === isoDay(new Date())) {
        void this.setSurface(card, 'now', { due: null })
      } else {
        void this.setSurface(card, 'soon', { due: iso })
      }
    })
  }

  private installTimelineDayDropHandlers(
    dropCol: HTMLElement,
    iso: string,
    axisCell?: HTMLElement,
  ): void {
    const isDropEligible = (id: string): boolean => {
      const today = isoDay(new Date())
      if (iso < today) return false
      return !!findCardById(this.getLastResponse(), id)
    }
    const setActive = (active: boolean): void => {
      dropCol.classList.toggle('kbn-timeline-dropcol-active', active)
      axisCell?.classList.toggle('kbn-timeline-day-drop-active', active)
    }
    dropCol.addEventListener('dragover', (e) => {
      const dragSourceId = this.getDragSourceId()
      if (!dragSourceId) return
      if (!isDropEligible(dragSourceId)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      setActive(true)
    })
    dropCol.addEventListener('dragleave', () => {
      setActive(false)
    })
    dropCol.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.getDragSourceId()
      setActive(false)
      this.setDragSourceId(null)
      this.stopDragAutoScroll()
      if (!fiberId) return
      if (!isDropEligible(fiberId)) return
      const card = findCardById(this.getLastResponse(), fiberId)
      if (!card) return
      const today = isoDay(new Date())
      if (iso === today) {
        void this.setSurface(card, 'now', { due: null })
      } else {
        void this.setSurface(card, 'soon', { due: iso })
      }
    })
  }

  /** Render a single cluster (project name + count + items list). */
  private renderCluster(
    cluster: StashCluster,
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const el = document.createElement('div')
    el.className = cluster.cold ? 'kbn-cluster kbn-cluster-cold' : 'kbn-cluster'
    el.dataset.clusterKey = cluster.key

    const head = document.createElement('div')
    head.className = 'kbn-cluster-head'
    const name = document.createElement('span')
    name.className = 'kbn-cluster-name'
    name.textContent = cluster.key
    const count = document.createElement('span')
    count.className = 'kbn-cluster-count'
    count.textContent = String(cluster.cards.length)
    head.append(name, count)
    if (cluster.cold) {
      const tag = document.createElement('span')
      tag.className = 'kbn-cluster-tag'
      tag.textContent = 'held open'
      head.append(tag)
    }
    el.append(head)

    for (const card of cluster.cards) {
      el.append(this.renderClusterItem(card, staleness[card.originId]))
    }
    return el
  }

  private renderClusterItem(
    card: KanbanCard,
    staleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = staleness?.status === 'stale'
    const el = document.createElement('div')
    el.className = isAgentCard(card) ? 'kbn-cluster-item kbn-cluster-item-agent' : 'kbn-cluster-item kbn-cluster-item-human'
    el.draggable = !isStale
    el.dataset.fiberId = card.id
    el.title = card.name
    el.setAttribute('role', 'listitem')
    el.setAttribute('aria-label', card.name)

    if (!isStale) this.installDraggable(el, card, false)

    const glyph = document.createElement('span')
    glyph.className = 'kbn-cluster-item-glyph'
    glyph.textContent = isAgentCard(card) ? '◐' : '✓'
    const title = document.createElement('span')
    title.className = 'kbn-cluster-item-title'
    title.textContent = card.name
    el.append(glyph, title)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      this.openDetail(card, 'drafts')
    })
    return el
  }

  /** Compact card variant for the timeline strip - single-line with
   *  glyph + title, color-coded by past/future/agent/human. */
  private renderTimelineCard(
    card: KanbanCard,
    column: number,
    row: number,
    kind: TimelineCardKind,
    staleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = staleness?.status === 'stale'
    const isComposted = kind === 'past' && card.tempered === false
    const variantClass =
      kind === 'past'
        ? (isComposted ? 'kbn-tl-card-composted' : 'kbn-tl-card-past')
        : kind === 'awaiting'
          ? 'kbn-tl-card-awaiting'
          : kind === 'inflight'
            ? 'kbn-tl-card-inflight'
            : kind === 'draft'
              ? 'kbn-tl-card-draft'
              : (isAgentCard(card) ? 'kbn-tl-card-agent' : 'kbn-tl-card-human')

    const el = document.createElement('div')
    el.className = `kbn-tl-card ${variantClass}${isStale ? ' kbn-card--stale' : ''}`
    el.style.gridColumn = String(column + 1)
    el.style.gridRow = String(row)
    const isFutureAwaiting = kind === 'awaiting' && !!card.due
    const isNowProjection = kind === 'inflight' || kind === 'draft'
    const isDraggable = !isStale && (kind === 'future' || kind === 'past' || isFutureAwaiting || isNowProjection)
    el.draggable = isDraggable
    el.dataset.fiberId = card.id
    el.title = card.name
    el.setAttribute('role', 'listitem')

    if (isDraggable) this.installDraggable(el, card, false)

    const glyph = document.createElement('span')
    glyph.className = 'kbn-tl-card-glyph'
    glyph.textContent =
      kind === 'past'
        ? (isComposted ? '✗' : '✓')
        : kind === 'awaiting'
          ? '◌'
          : kind === 'inflight'
            ? '◐'
            : kind === 'draft'
              ? '○'
              : (isAgentCard(card) ? '◐' : '✓')
    const title = document.createElement('span')
    title.className = 'kbn-tl-card-title'
    title.textContent = card.name
    el.append(glyph, title)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      const colKind: ColumnKind =
        kind === 'past'
          ? (isComposted ? 'composted' : 'tempered')
          : kind === 'awaiting'
            ? 'awaitingReview'
            : kind === 'inflight'
              ? 'inFlight'
              : 'drafts'
      this.openDetail(card, colKind)
    })
    return el
  }

  /**
   * Render one Now-surface column (Drafts / In Flight / Awaiting). The
   * column header doubles as the lifecycle-transition drop target.
   */
  renderColumn(
    kind: ColumnKind,
    cards: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const title = COLUMN_TITLES[kind]
    const col = document.createElement('section')
    col.className = `kbn-col kbn-col-${kind}`
    col.setAttribute('role', 'region')
    col.setAttribute('aria-label', `${title} (${cards.length})`)
    col.dataset.column = kind

    // The head is a focusable drop target (keyboard column-nav focuses it; the
    // DnD handlers below route a drop on it through the lifecycle transition).
    // It's a `div[role=button]`, not a `<button>`, so the per-kind action below
    // can nest a real `<button>` inside it without button-in-button invalidity.
    const head = document.createElement('div')
    head.className = 'kbn-col-head'
    head.tabIndex = 0
    head.setAttribute('role', 'button')
    head.setAttribute('aria-label', `Drop here to move to ${title}`)
    const headTitle = document.createElement('h2')
    headTitle.className = 'kbn-col-title'
    appendCappedText(headTitle, title)
    const headCount = document.createElement('span')
    headCount.className = 'kbn-col-count'
    headCount.textContent = String(cards.length)
    // Title + count cluster on the left; the per-kind action sits at the right
    // edge (the head is `justify-content: space-between`).
    const headLabel = document.createElement('div')
    headLabel.className = 'kbn-col-head-label'
    headLabel.append(headTitle, headCount)
    head.append(headLabel)
    const action = this.makeColumnAction(kind)
    if (action) head.append(action)

    const dropToColumn = (e: DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.getDragSourceId()
      col.classList.remove('kbn-col-drop')
      this.setDragSourceId(null)
      this.stopDragAutoScroll()
      if (!fiberId) return
      const card = findCardById(this.getLastResponse(), fiberId)
      if (!card) return
      void this.transition(card, kind)
    }
    const dragOverColumn = (e: DragEvent): void => {
      if (!this.getDragSourceId()) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      col.classList.add('kbn-col-drop')
    }
    const dragLeaveColumn = (root: HTMLElement) => (e: DragEvent): void => {
      if (e.relatedTarget && root.contains(e.relatedTarget as Node)) return
      col.classList.remove('kbn-col-drop')
    }
    head.addEventListener('dragover', dragOverColumn)
    head.addEventListener('dragleave', dragLeaveColumn(head))
    head.addEventListener('drop', dropToColumn)
    col.addEventListener('dragover', dragOverColumn)
    col.addEventListener('dragleave', dragLeaveColumn(col))
    col.addEventListener('drop', dropToColumn)

    const list = document.createElement('div')
    list.className = 'kbn-col-list'
    list.setAttribute('role', 'list')

    if (cards.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-empty'
      empty.setAttribute('role', 'listitem')
      empty.textContent = '— nothing here —'
      list.append(empty)
    } else {
      for (const card of cards) {
        list.append(this.renderCard(card, kind, staleness[card.originId]))
      }
    }

    col.append(head, list)
    return col
  }

  /**
   * The per-lane head action — one tinted round button at the column head's
   * right edge, the verb that feeds the lane (color = lane identity):
   *
   *   Drafts          → Stash `+`  (ochre)   onStashClick
   *   In flight       → New idea `✶` (cobalt) onNewIdeaClick
   *   Awaiting review → Refresh `↻` (teal)   onRefresh
   *
   * Returns null for a lane whose callback isn't wired (read-only context) —
   * those heads render title + count alone. Refresh is always available.
   * Every button stops click propagation (the head is itself a focusable drop
   * target). Refresh spins its glyph briefly so in-flight state rides the
   * button, not a `.kbn-status` text line.
   */
  private makeColumnAction(kind: ColumnKind): HTMLButtonElement | null {
    const spec =
      kind === 'drafts'
        ? this.onStashClick && {
            glyph: '+', modifier: 'drafts',
            label: 'Stash a new fiber (n)', onClick: this.onStashClick,
          }
        : kind === 'inFlight'
          ? this.onNewIdeaClick && {
              glyph: '✶', modifier: 'inFlight',
              label: 'New idea — speak it into a card', onClick: this.onNewIdeaClick,
            }
          : kind === 'awaitingReview'
            ? {
                glyph: '↻', modifier: 'awaitingReview',
                label: 'Refresh the board', onClick: this.onRefresh, spin: true,
              }
            : null
    if (!spec) return null

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `kbn-col-action kbn-col-action-${spec.modifier}`
    btn.textContent = spec.glyph
    btn.setAttribute('aria-label', spec.label)
    btn.title = spec.label
    btn.addEventListener('click', (e) => {
      // The head is a drop target + focusable; a click on its action must not
      // bubble up to it (or to the column's open-detail / drag wiring).
      e.stopPropagation()
      if ('spin' in spec && spec.spin) {
        btn.classList.remove('kbn-col-action-spinning')
        // Reflow so a back-to-back refresh re-triggers the animation.
        void btn.offsetWidth
        btn.classList.add('kbn-col-action-spinning')
        window.setTimeout(() => btn.classList.remove('kbn-col-action-spinning'), 650)
      }
      spec.onClick()
    })
    return btn
  }

  /**
   * Render one grid card. Title click opens the reading surface in vellum;
   * body click opens the action detail modal.
   */
  renderCard(
    card: KanbanCard,
    kind: ColumnKind,
    originStaleness?: KanbanOriginStaleness,
  ): HTMLElement {
    const isStale = originStaleness?.status === 'stale'

    const el = document.createElement('div')
    el.className = `kbn-card kbn-card-${kind}${isStale ? ' kbn-card--stale' : ''}`
    el.setAttribute('role', 'listitem')
    const ariaSuffix = isStale
      ? ` — waiting on ${originStaleness.hostname ?? card.originId}, drag disabled`
      : ''
    el.setAttribute('aria-label', `${card.name} — ${COLUMN_TITLES[kind]}${ariaSuffix}`)
    el.draggable = !isStale
    el.dataset.fiberId = card.id

    if (!isStale) this.installDraggable(el, card, true)

    const headerRow = document.createElement('div')
    headerRow.className = 'kbn-card-header'

    const glyph = document.createElement('span')
    glyph.className = `kbn-card-glyph ${isAgentCard(card) ? 'kbn-card-glyph-agent' : 'kbn-card-glyph-human'}`
    glyph.textContent = isAgentCard(card) ? '◐' : '✓'

    // The title is plain text — clicking anywhere on the card (title
    // included) opens the fiber-detail panel, which IS the fiber as a
    // vellum page. The old title-click → vellum-proper shortcut retired
    // with the kanban-card-vellum-page rework; drill-out to the full
    // workspace lives in the panel (id slug, dropdown, wikilinks).
    const name = document.createElement('span')
    name.className = 'kbn-card-name'
    name.textContent = card.name

    headerRow.append(glyph, name)
    el.append(headerRow)

    const idEl = document.createElement('div')
    idEl.className = 'kbn-card-id'
    idEl.textContent = card.id
    el.append(idEl)

    if (card.outcome) {
      const outcome = document.createElement('div')
      outcome.className = 'kbn-card-outcome'
      outcome.innerHTML = renderMarkdown(card.outcome)
      el.append(outcome)
    }

    const meta = document.createElement('div')
    meta.className = 'kbn-card-meta'

    const actor = document.createElement('span')
    actor.className = `kbn-card-actor ${isAgentCard(card) ? 'kbn-card-actor-agent' : 'kbn-card-actor-human'}`
    actor.textContent = isAgentCard(card) ? (card.shuttleAgent ?? 'agent') : 'me'
    meta.append(actor)

    if (card.due) {
      const due = document.createElement('span')
      due.className = 'kbn-card-due'
      due.textContent = `due ${formatDue(card.due)}`
      due.title = card.due
      meta.append(due)
    }

    if (card.drifted) {
      const drift = document.createElement('span')
      drift.className = 'kbn-card-drift'
      drift.textContent = '↑'
      drift.title = `Promoted from ${card.storedHorizon ?? 'unset'} by due date`
      meta.append(drift)
    }

    if ((kind === 'drafts' || kind === 'awaitingReview' || kind === 'inFlight') && !isStale) {
      const reviewMetaActions = document.createElement('div')
      reviewMetaActions.className = 'kbn-card-review-meta-actions'

      const temperMetaBtn = document.createElement('button')
      temperMetaBtn.type = 'button'
      temperMetaBtn.className = 'kbn-action kbn-action-tempered kbn-review-meta-btn'
      temperMetaBtn.textContent = 'Temper'
      temperMetaBtn.setAttribute('aria-label', `Temper fiber: ${card.name}`)
      temperMetaBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.transition(card, 'tempered')
      })

      const compostMetaBtn = document.createElement('button')
      compostMetaBtn.type = 'button'
      compostMetaBtn.className = 'kbn-action kbn-action-drafts kbn-review-meta-btn'
      compostMetaBtn.textContent = 'Compost'
      compostMetaBtn.setAttribute('aria-label', `Compost fiber: ${card.name}`)
      compostMetaBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.transition(card, 'composted')
      })

      reviewMetaActions.append(temperMetaBtn, compostMetaBtn)
      meta.append(reviewMetaActions)
    }

    // A phase badge and a live-worker pill exclude each other. The worker-less
    // phases (retrying/due/dispatched/running) only show as a standalone span
    // chip when there is no pill to convey liveness. The two human-attention
    // phases on a *live* worker instead *take over* the pill — the chip becomes
    // the clickable worker button itself, so the call-to-action IS the worker:
    //   • `attention` (raised its hand via Notification) — the red manicule
    //     chip. No idle gate — attention is urgent from the first event.
    //   • `waiting` (stopped at a prompt) — the amber chip. Gated to idle ≥60s:
    //     the daemon stamps `waiting` the instant a worker stops, so without
    //     this gate every momentary pause would flip the pill. Under 60s it
    //     stays the plain "▸ aloft" pill (the sort still floats it up).
    // A `working` worker has no badge entry, so it never takes over; the
    // worker-less lifecycle phases take the `!runningWorker` branch below,
    // untouched by the idle gate (their `lastActivityAt` is absent → Infinity).
    const idleMs = card.lastActivityAt !== undefined ? Date.now() - card.lastActivityAt : Infinity
    const phaseTakesOverWorker =
      kind === 'inFlight' &&
      !!card.runningWorker &&
      (card.runtimePhase === 'attention' ||
        (card.runtimePhase === 'waiting' && idleMs >= 60_000))
    const showPhase =
      kind === 'inFlight' &&
      card.runtimePhase &&
      RUNTIME_PHASE_BADGES[card.runtimePhase] &&
      !card.runningWorker
    if (showPhase && card.runtimePhase) {
      const { label, title } = RUNTIME_PHASE_BADGES[card.runtimePhase]
      const phase = document.createElement('span')
      phase.className = `kbn-card-phase kbn-card-phase-${card.runtimePhase}`
      phase.textContent = label
      phase.title = title
      meta.append(phase)
    }
    // Boot-quarantine hold: a genuinely-fresh launch the owning daemon is
    // withholding after a restart. Reads as "held, awaiting release" — distinct
    // from the "▸ aloft" running pill and from an idle-active card (mutually
    // exclusive with `runningWorker`: held means parked, not running). Release is
    // global (`bin/shuttle release`), so this is a status indicator, not a
    // per-card action button.
    if (card.held) {
      const heldEl = document.createElement('span')
      heldEl.className = 'kbn-card-held'
      heldEl.setAttribute('role', 'status')
      heldEl.textContent = '⏹︎ held'
      const since = card.heldSince
        ? ` since ${new Date(card.heldSince).toLocaleTimeString()}`
        : ''
      heldEl.title =
        `Held by boot quarantine — a fresh launch parked until release${since}. ` +
        'The daemon restarted; run `bin/shuttle release` to dispatch held launches.'
      meta.append(heldEl)
    }
    if (card.runningWorker) {
      const tmuxName = card.runningWorker
      const w = document.createElement('button')
      w.type = 'button'
      if (phaseTakesOverWorker && card.runtimePhase) {
        // The human-attention phase IS the button — the chip opens the worker.
        w.className = `kbn-card-worker kbn-card-worker-${card.runtimePhase}`
        w.textContent = RUNTIME_PHASE_BADGES[card.runtimePhase].label
        if (card.runtimePhase === 'attention') {
          w.setAttribute('aria-label', `Worker needs you now — open terminal: ${tmuxName}`)
          w.title = `Worker raised its hand — click to open ${tmuxName} in kitty`
        } else {
          w.setAttribute('aria-label', `Worker waiting for you — open terminal: ${tmuxName}`)
          w.title = `Worker paused on input — click to open ${tmuxName} in kitty`
        }
      } else {
        w.className = 'kbn-card-worker'
        w.textContent = '▸ aloft'
        w.setAttribute('aria-label', `Open worker terminal: ${tmuxName}`)
        w.title = `Worker aloft — click to open ${tmuxName} in kitty`
      }
      w.addEventListener('click', (e) => {
        e.stopPropagation()
        this.openWorker?.(tmuxName, card.shuttleHost)
      })
      meta.append(w)
    }
    el.append(meta)

    if (kind === 'inFlight' && !card.dependsOnSatisfied) {
      const block = document.createElement('div')
      block.className = 'kbn-card-blocked'
      block.textContent = `blocked on: ${(card.dependsOn ?? []).join(', ')}`
      el.append(block)
    }

    if (isStale) {
      const hostname = originStaleness.hostname ?? card.originId
      const waiting = document.createElement('div')
      waiting.className = 'kbn-card-waiting'
      waiting.setAttribute('role', 'status')
      waiting.title = originStaleness.staleSince
        ? `Disconnected since ${originStaleness.staleSince}`
        : 'Origin agent disconnected'
      waiting.textContent = `⌛ waiting on ${hostname}`
      el.append(waiting)
    }

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a, button, textarea')) return
      this.openDetail(card, kind)
    })

    return el
  }

  private installDraggable(el: HTMLElement, card: KanbanCard, includePlainText: boolean): void {
    el.addEventListener('dragstart', (e) => {
      this.setDragSourceId(card.id)
      el.classList.add('kbn-card-dragging')
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/x-fiber-id', card.id)
        if (includePlainText) e.dataTransfer.setData('text/plain', card.name)
      }
    })
    el.addEventListener('dragend', () => {
      el.classList.remove('kbn-card-dragging')
      this.setDragSourceId(null)
      if (includePlainText) this.stopDragAutoScroll()
    })
  }
}

/** Append `label` to `el` with the leading alphabetic character wrapped in
 *  a `<span class="kbn-cap" data-letter="X">X</span>` so it picks up the
 *  layered EBGI F2 + F1 dropcap treatment. */
export function appendCappedText(el: HTMLElement, label: string): void {
  if (!label) return
  const first = label.charAt(0)
  if (!/^[A-Za-z]$/.test(first)) {
    el.textContent = label
    return
  }
  const cap = document.createElement('span')
  cap.className = 'kbn-cap'
  const upper = first.toUpperCase()
  cap.dataset.letter = upper
  cap.textContent = upper
  el.append(cap)
  const rest = label.slice(1)
  if (rest) el.append(document.createTextNode(rest))
}

function isoDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

interface TimelineDay {
  iso: string
  label: string
  weekdayLabel: string
  isToday: boolean
  isPast: boolean
  isWeekend: boolean
  weekBoundary: boolean
}

function buildTimelineDays(past: number, future: number): TimelineDay[] {
  const days: TimelineDay[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let offset = -past; offset <= future; offset += 1) {
    const d = new Date(today.getTime() + offset * 86_400_000)
    const dow = d.getDay()
    days.push({
      iso: isoDay(d),
      label: String(d.getDate()),
      weekdayLabel: d.toLocaleDateString(undefined, { weekday: 'short' }),
      isToday: offset === 0,
      isPast: offset < 0,
      isWeekend: dow === 0 || dow === 6,
      weekBoundary: dow === 0,
    })
  }
  return days
}

function buildDayCell(day: TimelineDay): HTMLElement {
  const el = document.createElement('div')
  const classes = ['kbn-timeline-day']
  if (day.isToday) classes.push('kbn-timeline-day-today')
  if (day.isPast) classes.push('kbn-timeline-day-past')
  if (day.isWeekend) classes.push('kbn-timeline-day-weekend')
  if (day.weekBoundary) classes.push('kbn-timeline-day-week-boundary')
  el.className = classes.join(' ')
  el.dataset.dayIso = day.iso

  const dow = document.createElement('span')
  dow.className = 'kbn-timeline-day-dow'
  dow.textContent = day.isToday ? 'today' : day.weekdayLabel
  const num = document.createElement('span')
  num.className = 'kbn-timeline-day-num'
  num.textContent = day.label
  el.append(dow, num)
  return el
}

/** Compact launch-date label for a Later-rail card. Month + day for a
 *  same-year firing; adds the year once the cron reaches into another
 *  calendar year so a far-future role reads unambiguously. */
function formatLaterWhen(iso: string | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  )
}

/**
 * The timeline day-column for an awaiting-review ghost. Pure and exported so
 * the placement table suite can assert the closed-card sub-invariant — "an
 * awaiting card is always findable on BOTH the desk and the timeline" — over
 * every generated card state: with a non-null todayCol this NEVER returns
 * null. Fallback chain closedAt → modifiedAt → today (a closed fiber can
 * carry `closed_at: null`, and with no fallback the ghost silently vanished —
 * 11eeb43); an out-of-window stamp also falls through to today rather than
 * dropping the ghost.
 */
export function awaitingGhostDayColumn(
  card: Pick<KanbanCard, 'closedAt' | 'modifiedAt'>,
  dayIndex: Map<string, number>,
  todayCol: number | null,
): number | null {
  return (
    dayIndexForIso(card.closedAt, dayIndex) ??
    dayIndexForIso(card.modifiedAt, dayIndex) ??
    todayCol
  )
}

function dayIndexForIso(
  iso: string | undefined,
  dayIndex: Map<string, number>,
): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return dayIndex.get(isoDay(d)) ?? null
}

function clusterStashCards(stash: KanbanCard[]): StashCluster[] {
  const byKey = new Map<string, StashCluster>()
  for (const card of stash) {
    const key = stashClusterKey(card.id)
    const cold = card.cold === true
    const composite = `${key}::${cold ? 'cold' : 'warm'}`
    let cluster = byKey.get(composite)
    if (!cluster) {
      cluster = { key, cold, cards: [] }
      byKey.set(composite, cluster)
    }
    cluster.cards.push(card)
  }
  const out = [...byKey.values()]
  for (const c of out) {
    c.cards.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }
  out.sort((a, b) => {
    if (a.cold !== b.cold) return a.cold ? 1 : -1
    const aT = a.cards[0]?.createdAt ?? ''
    const bT = b.cards[0]?.createdAt ?? ''
    return bT.localeCompare(aT)
  })
  return out
}

function stashClusterKey(id: string): string {
  const segments = id.split('/').filter(Boolean)
  for (const seg of segments) {
    if (!CLUSTER_KEY_SKIP_ROOTS.has(seg)) return seg
  }
  return segments[segments.length - 1] ?? id
}

function formatDue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Find which Now-surface column the server has placed a card in, per
 * the last response. Returns null when the card lives outside the now
 * surface (or isn't in the response at all).
 */
export function findCardColumn(resp: KanbanResponse | null, id: string): ColumnKind | null {
  if (!resp) return null
  for (const kind of NOW_COLUMN_ORDER) {
    if (resp.now[kind].some((c) => c.id === id)) return kind
  }
  if (resp.pinned.some((c) => c.id === id)) return 'pinned'
  for (const c of resp.timeline.past) {
    if (c.id === id) return c.tempered === false ? 'composted' : 'tempered'
  }
  return null
}

function findCardById(resp: KanbanResponse | null, id: string): KanbanCard | null {
  if (!resp) return null
  for (const kind of NOW_COLUMN_ORDER) {
    const hit = resp.now[kind].find((c) => c.id === id)
    if (hit) return hit
  }
  for (const list of [resp.timeline.past, resp.timeline.futureDated, resp.stash, resp.pinned]) {
    const hit = list.find((c) => c.id === id)
    if (hit) return hit
  }
  return null
}
