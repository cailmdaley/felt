import { renderMarkdown } from './utils.js'
import {
  ascByKey,
  civilDayToLocalDate,
  descByKey,
  dueCivilDay,
  dueSortMs,
  instantMs,
} from './civilDay.js'
import type {
  ColumnKind,
  HorizonKind,
  KanbanCard,
  KanbanOriginStaleness,
  KanbanResponse,
} from './KanbanTypes.js'
import { isAgentCard } from './KanbanModalShared.js'
import { humanizeCron, lensCycles, upcomingCycleDropTargets } from './KanbanRules.js'
import type { CycleDropTarget, CycleLensChip } from './KanbanRules.js'
import { deriveCycleLens, isSleepingOnSchedule } from './KanbanReadModel.js'
import type { CycleLens } from './KanbanReadModel.js'

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

// The Pinned band wraps its launcher chips to at most this many rows; extra
// roles page behind a "+N more" affordance rather than scrolling.
const PINNED_MAX_ROWS = 2

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
  waiting: { label: '⏸ waiting', title: 'The worker is paused at a prompt waiting for human input — open it to respond.' },
  retrying: { label: '⟳ retrying', title: 'Dispatch failed — daemon is retrying with backoff. No live worker right now.' },
  due: { label: '◴ due', title: 'Scheduled tick elapsed — awaiting dispatch.' },
  dispatched: { label: '▸ dispatched', title: 'Dispatch sent — worker starting up.' },
  running: { label: '▸ running', title: 'Daemon reports a running worker, but its session is not matched here.' },
}

/** Below this, an attention chip carries no clock: a worker that just raised
 *  its hand is simply "now", and a number there would be noise. */
const ATTENTION_AGE_FLOOR_MS = 60 * 60_000

/**
 * An idle duration as a human reads a clock face — `12m`, `3h`, `2d`. One unit,
 * coarsening as it grows: minutes under an hour, hours under a day, days after.
 * No seconds — the board repaints on a 15s poll, so a seconds figure would be
 * wrong more often than right, and "how long has this been sitting?" is never a
 * question answered in seconds. Negative or absent input gives `0m`.
 */
export function humanizeIdleAge(ms: number | undefined): string {
  const safe = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  const minutes = Math.floor(safe / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * The phase pill's text, with the wait made visible. A `waiting` worker always
 * says how long it has been waiting — that age IS the reason to look at it,
 * and it was the one thing the pill never told you. `attention` earns a clock
 * only once it has gone an hour unanswered; fresh attention needs no number.
 *
 * Computed at render, not on a timer: the board's 15s poll re-renders, so the
 * figure refreshes without a single interval running behind the page.
 */
export function phasePillLabel(
  phase: string,
  lastActivityAt: number | undefined,
  nowMs: number = Date.now(),
): string {
  const base = RUNTIME_PHASE_BADGES[phase]?.label ?? phase
  if (lastActivityAt === undefined) return base
  const age = nowMs - lastActivityAt
  if (phase === 'waiting') return `${base} · ${humanizeIdleAge(age)}`
  if (phase === 'attention' && age >= ATTENTION_AGE_FLOOR_MS) {
    return `${base} · ${humanizeIdleAge(age)}`
  }
  return base
}

/** Skim-able title for surface affordance announcements. The stored horizon is
 *  still `stashed` everywhere in the wire format and the API; "Resting" is what
 *  the human is told, because that is what the surface means — deliberately
 *  paused work, not a bin of failures. */
export const SURFACE_TITLE: Record<HorizonKind, string> = {
  now: 'Now',
  stashed: 'Resting',
}

/** Stash cluster: project key + warmth + cards under that key. */
export interface StashCluster {
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
  openDetail: (card: KanbanCard) => void
  openWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  /** Release the boot quarantine on a card's owning host — the `⏹︎ held` →
   *  `▶ release` click. Release is global per daemon (one restart parks the
   *  whole board, one click frees it), so the card only names which host. */
  releaseQuarantine?: (shuttleHost?: string) => void | Promise<void>
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
  private readonly openDetail: (card: KanbanCard) => void
  private readonly openWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  private readonly releaseQuarantine?: (shuttleHost?: string) => void | Promise<void>
  private readonly onStashClick?: () => void
  private readonly onNewIdeaClick?: () => void
  private readonly onRefresh: () => void
  /** Horizontal edge-scroll for the drag horizon. Lets a held card push
   *  against the strip's left/right edge to reach off-screen days. Separate
   *  from the body's vertical drag scroll so the two can run concurrently. */
  private edgeScrollFrame: number | null = null
  private edgeScrollVelocity = 0
  private edgeScrollTarget: HTMLElement | null = null
  /** Current page of the Pinned band when its chips overflow two rows.
   *  Cycled by the "+N more" pager; survives poll re-renders. */
  private pinnedPage = 0
  /** The horizon's aim readout — the fixed spot that names, in words, the
   *  target under the cursor. Rebuilt with the horizon on every drag. */
  private aimReadoutEl: HTMLElement | null = null
  /** Which drop target currently owns the readout, so a late `dragleave` from
   *  the cell you just left cannot blank the label the new cell just wrote. */
  private aimOwner: HTMLElement | null = null
  /** The offscreen node handed to `setDragImage`, kept only until the drag
   *  ends (the browser needs it alive for the snapshot, not after). */
  private dragGhostEl: HTMLElement | null = null

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
    this.releaseQuarantine = options.releaseQuarantine
    this.onStashClick = options.onStashClick
    this.onNewIdeaClick = options.onNewIdeaClick
    this.onRefresh = options.onRefresh
  }

  /** Render the Now surface: section header + 3-column board. `lens`, when a
   *  cycle is engaged, recedes the non-members and conjures the members that
   *  are resting (see `renderColumn`). */
  renderNowSection(
    now: KanbanResponse['now'],
    staleness: Record<string, KanbanOriginStaleness>,
    lens: CycleLens | null = null,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-now'
    if (lens) section.classList.add('kbn-section-lensed')
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', lens
      ? `Now — the desk, seen through ${lens.name}`
      : 'Now — the desk')

    const board = document.createElement('div')
    board.className = 'kbn-now-board'
    for (const kind of NOW_COLUMN_ORDER) {
      board.append(this.renderColumn(kind, now[kind], staleness, lens))
    }

    section.append(board)
    this.installSectionDragHandlers(section, 'now')
    return section
  }

  /**
   * The CYCLE LENS ROW — a quiet line of chips above the columns, one per cycle
   * that has not ended (`lensCycles`). Click one and the Desk is seen through
   * it: the cycle's members keep full strength, everything else recedes, and
   * members that were resting surface as ghosts in the column they would sit
   * in. Click it again (or its ✕) and the Desk is exactly what it was.
   *
   * A lens is a way of LOOKING, not a filter and not an edit. Nothing is
   * written, nothing is hidden, receded cards stay clickable and draggable, and
   * the state is view-local — it does not survive a reload, because "which
   * cycle was I squinting at" is not a fact about the board.
   *
   * One lens at a time: `activeId` is a single id, so engaging a second chip
   * releases the first. Chips wear the drag horizon's clothes (`cycleChipText`)
   * because a chip here, a chip on the horizon, and a band on the Chronicle are
   * all the same object.
   *
   * Returns null when there are no live cycles — an empty row would be a line
   * of chrome explaining that you have no chapters.
   */
  renderCycleLensBar(
    activeId: string | null,
    onToggle: (cycleId: string | null) => void,
    nowMs: number = Date.now(),
  ): HTMLElement | null {
    const resp = this.getLastResponse()
    const chips = lensCycles(resp?.cycles ?? [], nowMs)
    if (chips.length === 0) return null

    const bar = document.createElement('div')
    bar.className = 'kbn-lensbar'
    bar.setAttribute('role', 'region')
    bar.setAttribute('aria-label', 'Cycles — click one to see the desk through it')
    for (const chip of chips) {
      const count = deriveCycleLens(resp, chip.id, nowMs)?.count ?? 0
      bar.append(this.renderLensChip(chip, count, chip.id === activeId, onToggle))
    }
    return bar
  }

  /** One cycle as a lens chip: name, span, member count — and, when engaged, a
   *  ✕ that is part of the same click target, since clicking the chip is how
   *  you release it either way. */
  private renderLensChip(
    chip: CycleLensChip,
    count: number,
    active: boolean,
    onToggle: (cycleId: string | null) => void,
  ): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `kbn-lens-chip${chip.running ? ' kbn-lens-chip-running' : ''}${active ? ' kbn-lens-chip-active' : ''}`
    el.dataset.cycleId = chip.id
    el.setAttribute('aria-pressed', active ? 'true' : 'false')
    el.title = active
      ? `Showing the desk through ${chip.name} — click to release.`
      : `${chip.name} · ${cycleChipText(chip)} — click to see the desk through it.`
    el.setAttribute('aria-label', `${chip.name}, ${count} ${count === 1 ? 'card' : 'cards'}${active ? ' — engaged' : ''}`)

    const name = document.createElement('span')
    name.className = 'kbn-cyclechip-name'
    name.textContent = chip.name

    const span = document.createElement('span')
    span.className = 'kbn-cyclechip-span'
    span.textContent = cycleChipText(chip)

    const tally = document.createElement('span')
    tally.className = 'kbn-lens-chip-count'
    tally.textContent = String(count)

    el.append(name, span, tally)
    if (active) {
      const release = document.createElement('span')
      release.className = 'kbn-lens-chip-release'
      release.textContent = '✕'
      release.setAttribute('aria-hidden', 'true')
      el.append(release)
    }
    el.addEventListener('click', () => onToggle(active ? null : chip.id))
    return el
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

    section.append(renderBandHead('Pinned', pinned.length))

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
      this.openDetail(card)
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

  /**
   * The drag-reveal horizon: a slim row of future days that materializes below
   * the tab strip for the duration of a drag, and nothing at all the rest of
   * the time.
   *
   * The Desk used to carry a permanent timeline ribbon. Three chronological
   * views now tell that story better, so the ribbon's DISPLAY job is gone —
   * but its DROP job was load-bearing, and it was the only way to say "this one
   * on Tuesday." So the day axis survives as a pure gesture surface: it appears
   * when you pick a card up, and it is gone the moment you let go. That's why
   * there are no mini-cards on it. A drop target does not need to show you what
   * it already holds; you are aiming at a date, not reading a schedule.
   *
   * FUTURE DAYS ONLY, today first. The past was never a legal drop (the old
   * ribbon's drop guard refused it), so rendering it only ever offered targets
   * that bounced. Today means "onto the desk now" and the future days mean
   * schedule-or-snooze — `dayDropHorizon` decides which, exactly as it did when
   * the ribbon was permanent.
   *
   * Cells flex to fill the width and scroll (with drag edge-scroll) only when
   * they cannot: a wide board gets generous targets, a narrow one keeps all
   * fourteen reachable.
   *
   * Past the last day sit the CHAPTER CHIPS: the upcoming cycles, each a drop
   * target for its own opening day (`upcomingCycleDropTargets` in KanbanRules
   * decides which cycles qualify and which day each one means). They are the
   * same drop machinery as a day cell — a chip is a day cell wearing the band's
   * clothes — because "next sprint" is a date you happen to know by name. With
   * no upcoming cycles the strip is exactly what it was: days and nothing else.
   */
  renderDragHorizon(futureDays: number): HTMLElement {
    const cycles = upcomingCycleDropTargets(this.getLastResponse()?.cycles ?? [])

    const outer = document.createElement('div')
    outer.className = 'kbn-draghorizon-inner'

    const wrap = document.createElement('div')
    wrap.className = 'kbn-draghorizon-wrap'
    wrap.dataset.draghorizonWrap = '1'
    wrap.setAttribute('role', 'region')
    wrap.setAttribute('aria-label', cycles.length > 0
      ? 'Drop a card on a day, or on a cycle, to schedule or snooze it'
      : 'Drop a card on a day to schedule or snooze it')

    const row = document.createElement('div')
    row.className = 'kbn-draghorizon-row'

    for (const day of buildTimelineDays(0, futureDays)) {
      // One element is both the date label and the drop target. The old ribbon
      // split them (an axis cell above a full-height column) only because cards
      // stacked in between; with nothing in between, the split would be two
      // nodes pretending to be one.
      const cell = buildDayCell(day)
      cell.classList.add('kbn-timeline-dropcol', 'kbn-draghorizon-day')
      cell.dataset.timelineDayIso = day.iso
      this.installTimelineDayDropHandlers(cell, day.iso, dayAimLabel(day), cell)
      row.append(cell)
    }

    for (const [index, target] of cycles.entries()) {
      const chip = buildCycleChip(target, index === 0)
      this.installTimelineDayDropHandlers(chip, target.dropDay, cycleAimLabel(target))
      row.append(chip)
    }

    wrap.append(row)
    this.installEdgeScroll(wrap)

    // The aim readout: one fixed line that says, in words, where the card will
    // land. The hovered cell shouts in colour; this says it in language, in a
    // spot the cursor is never on top of.
    const readout = document.createElement('div')
    readout.className = 'kbn-draghorizon-aim'
    readout.setAttribute('role', 'status')
    readout.setAttribute('aria-live', 'polite')
    readout.textContent = ''
    this.aimReadoutEl = readout
    this.aimOwner = null

    outer.append(wrap, readout)
    return outer
  }

  /** Point the aim readout at `target` (or clear it, if `target` is the one
   *  that currently owns the line). Ownership keeps a trailing `dragleave`
   *  from erasing the label its successor just wrote. */
  private setAim(owner: HTMLElement, label: string | null): void {
    const readout = this.aimReadoutEl
    if (!readout) return
    if (label === null) {
      if (this.aimOwner !== owner) return
      this.aimOwner = null
      readout.textContent = ''
      readout.classList.remove('kbn-draghorizon-aim-live')
      return
    }
    this.aimOwner = owner
    readout.textContent = label
    readout.classList.add('kbn-draghorizon-aim-live')
  }

  /** Render the Resting surface: cluster grid keyed by containment-path's
   *  first meaningful project segment. Warm clusters first, then a
   *  divider, then held-open clusters in a dimmer style.
   *
   *  "Resting" is the human name for the surface the wire format calls
   *  `horizon: stashed`. Nothing internal changes — the horizon value, the
   *  endpoints and the cluster machinery all keep their names.
   *
   *  Above the path clustering sits one more split, by vigilance rather than
   *  project: cards with no return mechanism (`splitStashByReturn`'s
   *  UNDATED half) go first, because nothing else will ever surface them
   *  again — this is the watch list. Cards already promised back by a
   *  snooze date or a cron sit below, soonest first, needing less attention
   *  from a person. The seam between them is one quiet caption, not a
   *  second heading — Resting is still one region, just two temperatures of
   *  the same thing. */
  renderStashSection(
    stash: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-stash'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'Resting — deliberately paused, still visible')

    section.append(renderBandHead('Resting', stash.length))

    const { undated, dated } = splitStashByReturn(stash)
    const grid = document.createElement('div')
    grid.className = 'kbn-cluster-grid'
    grid.append(...this.renderClusterGroup(undated, staleness))
    if (undated.length > 0 && dated.length > 0) {
      const divider = document.createElement('div')
      divider.className = 'kbn-cluster-divider kbn-cluster-divider-group'
      divider.setAttribute('aria-hidden', 'true')
      divider.textContent = '— already coming back —'
      grid.append(divider)
    }
    grid.append(...this.renderClusterGroup(dated, staleness, sortDatedByReturn))
    if (stash.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-cluster-empty'
      empty.textContent = '— drag a card here to let it rest —'
      grid.append(empty)
    }

    section.append(grid)
    this.installSectionDragHandlers(section, 'stashed')
    return section
  }

  /** Warm-then-held-open rendering of one Resting half (the undated watch
   *  list or the dated returns), shared so the group split in
   *  `renderStashSection` doesn't have to duplicate the cold divider logic. */
  private renderClusterGroup(
    cards: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
    reorder?: (clusters: StashCluster[]) => StashCluster[],
  ): HTMLElement[] {
    const clusters = reorder ? reorder(clusterStashCards(cards)) : clusterStashCards(cards)
    const warm = clusters.filter((c) => !c.cold)
    const cold = clusters.filter((c) => c.cold)

    const nodes: HTMLElement[] = []
    for (const c of warm) nodes.push(this.renderCluster(c, staleness))
    if (cold.length > 0) {
      const divider = document.createElement('div')
      divider.className = 'kbn-cluster-divider'
      divider.setAttribute('aria-hidden', 'true')
      divider.textContent = '— held open —'
      nodes.push(divider)
      for (const c of cold) nodes.push(this.renderCluster(c, staleness))
    }
    return nodes
  }

  /** Halt the horizon's edge-scroll rAF. Called on drop, on drag-leave, and by
   *  the modal on unmount so the tick can't outlive the board. */
  stopEdgeScroll(): void {
    this.edgeScrollVelocity = 0
    this.edgeScrollTarget = null
    if (this.edgeScrollFrame === null) return
    window.cancelAnimationFrame(this.edgeScrollFrame)
    this.edgeScrollFrame = null
  }

  /** Edge-scroll the drag horizon when a drag approaches its left or right
   *  edge — the horizontal twin of the body's vertical drag-scroll, and the
   *  only way to reach day fourteen on a narrow board while holding a card.
   *  Velocity rises with how far into the 80px margin the cursor has pushed.
   *
   *  (It used to also toggle the ribbon's `.kbn-drag-open` expand class. The
   *  horizon has no closed state to open now: it exists only during a drag.) */
  private installEdgeScroll(wrap: HTMLElement): void {
    const EDGE_PX = 80
    const MAX_STEP_PX = 28
    const onDragOver = (e: DragEvent): void => {
      if (!this.getDragSourceId()) return
      const r = wrap.getBoundingClientRect()
      const leftPressure = Math.max(0, EDGE_PX - (e.clientX - r.left))
      const rightPressure = Math.max(0, EDGE_PX - (r.right - e.clientX))
      const direction = rightPressure > 0 ? 1 : leftPressure > 0 ? -1 : 0
      const pressure = Math.max(leftPressure, rightPressure) / EDGE_PX
      this.edgeScrollVelocity = direction === 0
        ? 0
        : direction * Math.max(6, Math.round(Math.pow(pressure, 1.35) * MAX_STEP_PX))
      if (this.edgeScrollVelocity === 0) {
        this.stopEdgeScroll()
        return
      }
      this.edgeScrollTarget = wrap
      this.startEdgeScroll()
    }
    const onDragLeave = (e: DragEvent): void => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget as Node)) return
      this.stopEdgeScroll()
    }
    wrap.addEventListener('dragover', onDragOver)
    wrap.addEventListener('dragleave', onDragLeave)
    wrap.addEventListener('drop', () => this.stopEdgeScroll())
  }

  private startEdgeScroll(): void {
    if (this.edgeScrollFrame !== null) return
    const tick = (): void => {
      const target = this.edgeScrollTarget
      if (!target || !this.getDragSourceId() || this.edgeScrollVelocity === 0) {
        this.stopEdgeScroll()
        return
      }
      target.scrollLeft += this.edgeScrollVelocity
      this.edgeScrollFrame = window.requestAnimationFrame(tick)
    }
    this.edgeScrollFrame = window.requestAnimationFrame(tick)
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

  private installTimelineDayDropHandlers(
    dropCol: HTMLElement,
    iso: string,
    aimLabel?: string,
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
      if (aimLabel) this.setAim(dropCol, active ? aimLabel : null)
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
        void this.setSurface(card, dayDropHorizon(this.getLastResponse(), card.id), { due: iso })
      }
    })
  }

  /**
   * Render a single cluster: containment path + count + items.
   *
   * The heading is the FULL path a split descended to (`science/unions`), set
   * small in the mono face so a deep key stays scannable — the parent segments
   * dimmed, the last one at full strength. You read "unions" and keep "science"
   * as context, which is the whole point of splitting rather than renaming.
   *
   * A cluster that could not be split (every card shares the next segment, or
   * none has one) still caps at four cards, with the rest behind a "+N more"
   * that expands in place. Expanding, not paging: paging hides cards you were
   * about to compare, and Resting is a place you read rather than operate.
   */
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
    name.title = cluster.key
    const segments = cluster.key.split('/')
    const leaf = segments.pop() ?? cluster.key
    if (segments.length > 0) {
      const parents = document.createElement('span')
      parents.className = 'kbn-cluster-name-parents'
      parents.textContent = `${segments.join('/')}/`
      name.append(parents)
    }
    const leafEl = document.createElement('span')
    leafEl.className = 'kbn-cluster-name-leaf'
    leafEl.textContent = leaf
    name.append(leafEl)
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

    const overflow = cluster.cards.slice(MAX_CLUSTER_CARDS)
    for (const card of cluster.cards.slice(0, MAX_CLUSTER_CARDS)) {
      el.append(this.renderClusterItem(card, staleness[card.originId]))
    }
    if (overflow.length > 0) {
      const hidden = overflow.map((card) => {
        const item = this.renderClusterItem(card, staleness[card.originId])
        item.hidden = true
        el.append(item)
        return item
      })
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'kbn-tl-pager kbn-cluster-more'
      more.textContent = `+${overflow.length} more`
      more.title = `${cluster.cards.length} resting under ${cluster.key} — click to show them all`
      more.addEventListener('click', (e) => {
        e.stopPropagation()
        const opening = hidden[0]?.hidden === true
        for (const item of hidden) item.hidden = !opening
        more.textContent = opening ? '− fewer' : `+${overflow.length} more`
      })
      el.append(more)
    }
    return el
  }

  private renderClusterItem(
    card: KanbanCard,
    staleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = staleness?.status === 'stale'
    const sleeping = isSleepingOnSchedule(card)
    const el = document.createElement('div')
    el.className = isAgentCard(card) ? 'kbn-cluster-item kbn-cluster-item-agent' : 'kbn-cluster-item kbn-cluster-item-human'
    if (sleeping) el.classList.add('kbn-cluster-item-standing')
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

    // TWO WAYS OF COMING BACK, said differently on purpose.
    //
    // A standing role asleep on its cron returns BY ITSELF — "↻ returns Aug 12"
    // — and the ↻ is the whole distinction from a snooze, which is a thing YOU
    // put down and which "wakes" on a day you chose. Reading them the same way
    // would make the desk claim you had parked a role you never touched.
    //
    // The day comes from `nextLaunchAt`, the cron's next occurrence (an INSTANT,
    // so it is formatted from the instant, not read as a civil day). A role
    // whose schedule will not parse simply shows no chip rather than a lie.
    if (sleeping) {
      const returns = card.nextLaunchAt ? formatLaunchDay(card.nextLaunchAt) : null
      const schedule = humanizeCron(card.shuttleSchedule) ?? card.shuttleSchedule
      const chip = document.createElement('span')
      chip.className = 'kbn-cluster-item-wakes kbn-cluster-item-returns'
      chip.textContent = returns ? `↻ returns ${returns}` : '↻ on a schedule'
      const detail = [schedule, returns && `next ${returns}`].filter(Boolean).join(' · ')
      chip.title = `Sleeping on its schedule${detail ? ` — ${detail}` : ''}. It dispatches itself.`
      el.append(chip)
      el.title = `${card.name} — sleeping on its schedule${detail ? ` (${detail})` : ''}`
    } else if (card.due) {
      const wakes = document.createElement('span')
      wakes.className = 'kbn-cluster-item-wakes'
      wakes.textContent = `wakes ${formatDue(card.due)}`
      wakes.title = `Resting until ${formatDue(card.due)} — it returns to the desk that day`
      el.append(wakes)
      el.title = `${card.name} — resting until ${formatDue(card.due)}`
    }

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      this.openDetail(card)
    })
    return el
  }

  /**
   * Render one Now-surface column (Drafts / In Flight / Awaiting). The
   * column header doubles as the lifecycle-transition drop target.
   */
  renderColumn(
    kind: NowColumnKind,
    cards: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
    lens: CycleLens | null = null,
  ): HTMLElement {
    const title = COLUMN_TITLES[kind]
    const ghosts = lens ? lens.ghosts.filter((g) => g.column === kind) : []
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
    // The count is what the column is SHOWING, so it grows by the ghosts the
    // lens conjured. With no lens, ghosts is empty and this is the plain count.
    headCount.textContent = String(cards.length + ghosts.length)
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

    if (cards.length === 0 && ghosts.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-empty'
      empty.setAttribute('role', 'listitem')
      empty.textContent = '— nothing here —'
      list.append(empty)
    } else {
      for (const card of cards) {
        list.append(this.renderCard(card, kind, staleness[card.originId], {
          // A lensed column recedes what the cycle does not claim. The card
          // stays live — clickable, draggable — because a lens is a way of
          // looking, not a filter that takes the board away from you.
          dim: lens !== null && !lens.memberIds.has(card.id),
        }))
      }
      // Ghosts sit AFTER the real cards: they are not on this column, they are
      // being shown as belonging to the chapter you are looking at.
      for (const ghost of ghosts) {
        list.append(this.renderCard(ghost.card, kind, staleness[ghost.card.originId], { ghost: true }))
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
    kind: NowColumnKind,
    originStaleness?: KanbanOriginStaleness,
    lensState: { dim?: boolean; ghost?: boolean } = {},
  ): HTMLElement {
    const isStale = originStaleness?.status === 'stale'

    const el = document.createElement('div')
    el.className = `kbn-card kbn-card-${kind}${isStale ? ' kbn-card--stale' : ''}`
    if (lensState.dim) el.classList.add('kbn-card--lens-off')
    if (lensState.ghost) el.classList.add('kbn-card--lens-ghost')
    el.setAttribute('role', 'listitem')
    const ariaSuffix = isStale
      ? ` — waiting on ${originStaleness.hostname ?? card.originId}, drag disabled`
      : ''
    const lensSuffix = lensState.ghost ? ' — resting, shown for this cycle' : ''
    el.setAttribute('aria-label', `${card.name} — ${COLUMN_TITLES[kind]}${lensSuffix}${ariaSuffix}`)
    el.draggable = !isStale
    el.dataset.fiberId = card.id
    // A fiber in a git-synced store is served by every daemon holding it. The
    // board shows one card (see `dedupeMirroredRows`); say on hover where else
    // it lives, so "one card" doesn't read as "the other host lost it".
    if (card.mirroredOrigins?.length) {
      el.title = `${card.name}\nAlso on ${card.mirroredOrigins.join(', ')} — shown from ${card.originId}`
    }

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
      const { title } = RUNTIME_PHASE_BADGES[card.runtimePhase]
      const phase = document.createElement('span')
      phase.className = `kbn-card-phase kbn-card-phase-${card.runtimePhase}`
      phase.textContent = phasePillLabel(card.runtimePhase, card.lastActivityAt)
      phase.title = title
      meta.append(phase)
    }
    // Boot-quarantine hold: a genuinely-fresh launch the owning daemon is
    // withholding after a restart. Reads as "held, awaiting release" — distinct
    // from the "▸ aloft" running pill and from an idle-active card (mutually
    // exclusive with `runningWorker`: held means parked, not running). The badge
    // IS the release control: hover flips `⏹︎ held` → `▶ release`, click POSTs
    // the release to the card's OWNING host. Release is global per daemon (one
    // restart parks the whole board, one click frees every held launch on that
    // host), so `title` names that so a single click isn't a surprise.
    if (card.held) {
      const heldEl = document.createElement('button')
      heldEl.type = 'button'
      heldEl.className = 'kbn-card-held'
      const since = card.heldSince
        ? ` since ${new Date(card.heldSince).toLocaleTimeString()}`
        : ''
      const host = card.shuttleHost
      heldEl.setAttribute(
        'aria-label',
        `Release boot quarantine${host ? ` on ${host}` : ''} — dispatches every held launch`,
      )
      heldEl.title =
        `Held by boot quarantine — a fresh launch parked until release${since}. ` +
        `The daemon restarted; click to release${host ? ` ${host}` : ''} and dispatch ` +
        'every held launch on that host.'
      const heldLabel = document.createElement('span')
      heldLabel.className = 'kbn-card-held-label'
      heldLabel.textContent = '⏹︎ held'
      const releaseLabel = document.createElement('span')
      releaseLabel.className = 'kbn-card-held-release'
      releaseLabel.textContent = '▶ release'
      heldEl.append(heldLabel, releaseLabel)
      heldEl.addEventListener('click', (e) => {
        e.stopPropagation()
        heldEl.disabled = true
        void Promise.resolve(this.releaseQuarantine?.(host)).finally(() => {
          heldEl.disabled = false
        })
      })
      meta.append(heldEl)
    }
    if (card.runningWorker) {
      const tmuxName = card.runningWorker
      const w = document.createElement('button')
      w.type = 'button'
      if (phaseTakesOverWorker && card.runtimePhase) {
        // The human-attention phase IS the button — the chip opens the worker,
        // and (for `waiting`, plus a long-unanswered `attention`) says how long
        // it has been standing there.
        const age = card.lastActivityAt !== undefined
          ? humanizeIdleAge(Date.now() - card.lastActivityAt)
          : null
        w.className = `kbn-card-worker kbn-card-worker-${card.runtimePhase}`
        w.textContent = phasePillLabel(card.runtimePhase, card.lastActivityAt)
        if (card.runtimePhase === 'attention') {
          w.setAttribute('aria-label', `Worker needs you now — open terminal: ${tmuxName}`)
          w.title = `Worker raised its hand${age ? ` ${age} ago` : ''} — click to open ${tmuxName} in kitty`
        } else {
          w.setAttribute('aria-label', `Worker waiting for you — open terminal: ${tmuxName}`)
          w.title = `Worker paused on input${age ? ` ${age} ago` : ''} — click to open ${tmuxName} in kitty`
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
      this.openDetail(card)
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
        this.attachDragGhost(e, el, card)
      }
    })
    el.addEventListener('dragend', () => {
      el.classList.remove('kbn-card-dragging')
      this.setDragSourceId(null)
      this.releaseDragGhost()
      if (includePlainText) this.stopDragAutoScroll()
    })
  }

  /**
   * Replace the browser's default drag image with a small translucent token.
   *
   * The default is a full-opacity snapshot of the card, and a card is a tall
   * opaque object: held over the drag horizon it covers the very day cell you
   * are aiming at. (The `.kbn-card-dragging` fade cannot help — it styles the
   * SOURCE element, and the snapshot is of the element as it was picked up.)
   *
   * So the ghost is an explicit clone: the card's title alone, one line, half
   * opaque, anchored just below-right of the cursor so the cursor itself is
   * never under it. You still see what you are carrying; you can also see
   * what you are about to drop it on, which is the point.
   *
   * The node has to be in the document and rendered for the snapshot to work,
   * so it lives offscreen and is removed on `dragend`.
   */
  private attachDragGhost(e: DragEvent, source: HTMLElement, card: KanbanCard): void {
    if (typeof e.dataTransfer?.setDragImage !== 'function') return
    this.releaseDragGhost()
    const ghost = document.createElement('div')
    ghost.className = 'kbn-drag-ghost'
    ghost.textContent = card.name
    ghost.style.width = `${Math.min(240, Math.max(120, source.offsetWidth || 200))}px`
    document.body.append(ghost)
    this.dragGhostEl = ghost
    e.dataTransfer.setDragImage(ghost, -12, -10)
  }

  private releaseDragGhost(): void {
    this.dragGhostEl?.remove()
    this.dragGhostEl = null
  }
}

/** The head of a Desk band (Pinned, Resting) — the column head's own parts at
 *  band scale: a small-caps title, the count in mono beside it, and an
 *  optional italic gloss. No dropcap: the F2/F1 initial needs the column
 *  title's size to read as illumination (see `.kbn-bandhead-title`). */
function renderBandHead(label: string, count: number, gloss?: string): HTMLElement {
  const head = document.createElement('div')
  head.className = 'kbn-bandhead'

  const title = document.createElement('h2')
  title.className = 'kbn-bandhead-title'
  title.textContent = label
  head.append(title)

  if (count > 0) {
    const countEl = document.createElement('span')
    countEl.className = 'kbn-bandhead-count'
    countEl.textContent = String(count)
    head.append(countEl)
  }
  if (gloss) {
    const glossEl = document.createElement('span')
    glossEl.className = 'kbn-bandhead-gloss'
    glossEl.textContent = gloss
    head.append(glossEl)
  }
  return head
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

export interface TimelineDay {
  iso: string
  label: string
  weekdayLabel: string
  isToday: boolean
  isPast: boolean
  isWeekend: boolean
  weekBoundary: boolean
}

/**
 * The strip of day columns, from `past` days back to `future` days ahead.
 *
 * Strides by CALENDAR day, not by 86_400_000 ms. A fixed-millisecond stride
 * drifts an hour across a DST transition and eventually skips or repeats a
 * civil day — and a skipped column is a card that VANISHES, because its due
 * day finds no column to land on. `setDate(getDate() + 1)` is local-calendar
 * arithmetic: it always lands on the next civil day, 23- or 25-hour.
 * `today` is injectable so the DST crossings are testable.
 */
export function buildTimelineDays(
  past: number,
  future: number,
  today: Date = new Date(),
): TimelineDay[] {
  const days: TimelineDay[] = []
  const cursor = new Date(today.getTime())
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - past)
  for (let offset = -past; offset <= future; offset += 1) {
    const d = new Date(cursor.getTime())
    cursor.setDate(cursor.getDate() + 1)
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

/** `Aug 12` — a civil day said the short way, for a chip that has no room for
 *  more. Falls back to the raw ISO if the day will not parse. */
function shortDayLabel(iso: string): string {
  const d = civilDayToLocalDate(iso)
  if (!d) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** What the aim readout says while a day cell is the target. Today is a
 *  different act from the rest of the strip — it puts the card back on the
 *  desk — so it gets its own sentence rather than a date. */
function dayAimLabel(day: TimelineDay): string {
  if (day.isToday) return '→ onto the desk, today'
  return `→ resting until ${day.weekdayLabel} ${shortDayLabel(day.iso)}`
}

/** What the aim readout says while a cycle chip is the target. A cycle
 *  already underway means "later this chapter", not "when it opens". */
function cycleAimLabel(target: CycleDropTarget): string {
  return target.running
    ? `→ resting until ${shortDayLabel(target.dropDay)} · later in ${target.name}`
    : `→ resting until ${shortDayLabel(target.dropDay)} · ${target.name} opens`
}

/** A cycle's span as a chip says it — `Aug 12 – Aug 26`, or `Aug 12 –` for a
 *  chapter still open at its right edge. Shared by the drag horizon's drop
 *  chips and the lens row, so the two never drift apart. */
export function cycleChipText(span: { start: string; end: string; openEnded: boolean }): string {
  return span.openEnded
    ? `${shortDayLabel(span.start)} –`
    : `${shortDayLabel(span.start)} – ${shortDayLabel(span.end)}`
}

/**
 * One cycle as a drop target on the drag horizon: its name over its span, in
 * the Chronicle band's ochre — the same annotation register, so a chip on the
 * strip and a band on the page read as the same object.
 *
 * `leading` draws the seam between the day cells and the chapters. It is a
 * class on the first chip rather than a separate divider node, because a
 * divider would be one more thing a drag can be over and nothing can be
 * dropped on.
 */
function buildCycleChip(target: CycleDropTarget, leading: boolean): HTMLElement {
  const el = document.createElement('div')
  el.className = 'kbn-timeline-dropcol kbn-draghorizon-cycle'
  if (leading) el.classList.add('kbn-draghorizon-cycle-first')
  if (target.running) el.classList.add('kbn-draghorizon-cycle-running')
  el.dataset.cycleId = target.id
  el.dataset.timelineDayIso = target.dropDay

  const name = document.createElement('span')
  name.className = 'kbn-cyclechip-name'
  name.textContent = target.name

  const span = document.createElement('span')
  span.className = 'kbn-cyclechip-span'
  span.textContent = cycleChipText(target)

  el.append(name, span)
  el.title = target.running
    ? `${target.name} is already running — drop here to rest until tomorrow (${shortDayLabel(target.dropDay)}), later this cycle.`
    : `Drop here to rest until ${target.name} opens on ${shortDayLabel(target.dropDay)}.`
  return el
}

/**
 * The containment path a card clusters under — its id's segments, minus the
 * one thing that is not a group: THE CARD'S OWN LEAF SLUG. The last segment
 * names the fiber, not a folder it lives in. Descend into it and every card
 * becomes a cluster of one, which is how a "split deeper" rule turns a
 * readable group of six into six headings.
 *
 * A top-level card (`foo`) keeps its own name as its only segment — it has no
 * containing folder, and a cluster has to be called something.
 */
function containmentSegments(id: string): string[] {
  const segments = id.split('/').filter(Boolean)
  return segments.length > 1 ? segments.slice(0, -1) : segments
}

/** Above this many cards, a cluster splits on its next path segment. Four is
 *  what fits a cluster card without it becoming a list you scroll. */
const MAX_CLUSTER_CARDS = 4

/**
 * Split one over-full group by descending its containment path until no group
 * exceeds `MAX_CLUSTER_CARDS` — "science 6" becomes "science/unions 3" +
 * "science/spt3g 3".
 *
 * Two ways this stops, and the second is the one that keeps it honest:
 *
 *   1. The group is small enough. Done.
 *   2. Descending one segment yields a SINGLE group — every card shares the
 *      next segment, or none of them has one. There is nothing to discriminate
 *      on, so the group stays over-full and the renderer caps it at four behind
 *      a "+N more". Splitting anyway would produce a deeper heading holding
 *      exactly the same cards, which reads as progress and isn't.
 *
 * A card with no deeper segment stays at the current level rather than being
 * dropped, so `science/loose` and `science/unions/a…e` split into "science 1"
 * and "science/unions 5" instead of losing the loose one.
 */
function splitByPathDepth(cards: KanbanCard[], depth: number): Array<{ key: string; cards: KanbanCard[] }> {
  const keyAt = (card: KanbanCard, d: number): string =>
    containmentSegments(card.id).slice(0, d).join('/')
  const here = { key: keyAt(cards[0], depth), cards }
  if (cards.length <= MAX_CLUSTER_CARDS) return [here]

  const deeper = new Map<string, KanbanCard[]>()
  for (const card of cards) {
    const segments = containmentSegments(card.id)
    // A card that has run out of path stays where it is.
    const key = keyAt(card, segments.length > depth ? depth + 1 : depth)
    const bucket = deeper.get(key)
    if (bucket) bucket.push(card)
    else deeper.set(key, [card])
  }
  if (deeper.size <= 1) return [here]
  return [...deeper.values()].flatMap((group) => splitByPathDepth(group, depth + 1))
}

/**
 * When a resting card comes back on its own — a `due:` snooze date, or a
 * standing role asleep on its cron (it dispatches itself regardless of
 * whether `nextLaunchAt` parsed to a shown date). Anything else has no
 * appointment at all: nothing is going to surface it again, so a person is
 * the only mechanism that ever will.
 */
function hasScheduledReturn(card: KanbanCard): boolean {
  return isSleepingOnSchedule(card) || !!card.due
}

/**
 * Split Resting into the two kinds of paused work, which need opposite
 * amounts of vigilance:
 *
 *   • UNDATED — no return mechanism at all. These are the ones that can
 *     quietly drift out of mind, since nothing will ever put them back in
 *     front of anyone. They come first, because they are the watch list.
 *   • DATED — a snooze date or a cron already promises they'll be back.
 *     Lower vigilance, so they sit below.
 *
 * Order within each list is untouched here — `clusterStashCards` and
 * `sortDatedByReturn` decide that once the caller has clustered/sorted.
 */
export function splitStashByReturn(
  stash: KanbanCard[],
): { undated: KanbanCard[]; dated: KanbanCard[] } {
  const undated: KanbanCard[] = []
  const dated: KanbanCard[] = []
  for (const card of stash) (hasScheduledReturn(card) ? dated : undated).push(card)
  return { undated, dated }
}

/** The instant a dated resting card is next expected back — a cron's next
 *  occurrence for a sleeping role, otherwise its `due:` day. Absent for a
 *  card `splitStashByReturn` would have called undated; such a card sorts
 *  last via `ascByKey`'s undefined-last rule, rather than crash. */
function returnMs(card: KanbanCard): number | undefined {
  if (isSleepingOnSchedule(card)) return card.nextLaunchAt ? instantMs(card.nextLaunchAt) : undefined
  return dueSortMs(card.due)
}

/** Re-sort clusters already built by `clusterStashCards` so the dated half of
 *  Resting reads soonest-return-first — the ordering the containment-path
 *  clustering doesn't give you on its own. Cluster membership (and the
 *  warm/cold split) is untouched; only the order of clusters and the cards
 *  within each is affected. */
export function sortDatedByReturn(clusters: StashCluster[]): StashCluster[] {
  return clusters
    .map((c) => ({ ...c, cards: [...c.cards].sort((a, b) => ascByKey(returnMs(a), returnMs(b))) }))
    .sort((a, b) => ascByKey(returnMs(a.cards[0]), returnMs(b.cards[0])))
}

/**
 * Group the Resting cards into clusters by containment path, splitting any
 * cluster that would hold more than four cards (see `splitByPathDepth`).
 *
 * Warm and cold never mix: a held-open card belongs under the divider, so the
 * split runs independently within each warmth and a cluster is wholly one or
 * the other.
 */
export function clusterStashCards(stash: KanbanCard[]): StashCluster[] {
  const out: StashCluster[] = []
  for (const cold of [false, true]) {
    const mine = stash.filter((card) => (card.cold === true) === cold)
    if (mine.length === 0) continue
    // First pass at depth 1 (today's behavior), then descend only where needed.
    const roots = new Map<string, KanbanCard[]>()
    for (const card of mine) {
      const key = containmentSegments(card.id).slice(0, 1).join('/')
      const bucket = roots.get(key)
      if (bucket) bucket.push(card)
      else roots.set(key, [card])
    }
    for (const group of roots.values()) {
      for (const split of splitByPathDepth(group, 1)) {
        out.push({ key: split.key, cold, cards: split.cards })
      }
    }
  }
  for (const c of out) {
    // `createdAt` is an INSTANT: compare epoch ms, never the RFC3339 strings —
    // a string compare orders by local wall clock, so a Berkeley-created fiber
    // sinks below an older Paris one (see civilDay.ts).
    c.cards.sort((a, b) => descByKey(instantMs(a.createdAt), instantMs(b.createdAt)))
  }
  out.sort((a, b) => {
    if (a.cold !== b.cold) return a.cold ? 1 : -1
    return descByKey(instantMs(a.cards[0]?.createdAt), instantMs(b.cards[0]?.createdAt))
  })
  return out
}

/** The `due <date>` chip on a card. Reads the value as the CIVIL DAY it names,
 *  the same way the timeline places the card — otherwise one render pass showed
 *  two different days: the card sat on the Thursday column while its own chip
 *  read Wednesday. The day is materialized as a local date, never re-parsed as
 *  an instant (see civilDay.ts). */
/**
 * `Aug 12` from an INSTANT — the next-launch twin of `formatDue`. A cron
 * occurrence is a real point in time, so it is read with `instantMs` and shown
 * in the reader's own zone; running it through `formatDue` would treat the
 * offset as a civil day and could name the day before. Empty string when the
 * instant will not parse, which the caller reads as "say nothing".
 */
export function formatLaunchDay(iso: string): string {
  const ms = instantMs(iso)
  if (ms === undefined) return ''
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatDue(iso: string): string {
  const date = civilDayToLocalDate(dueCivilDay(iso))
  if (!date) return iso
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

/**
 * What a drop on a FUTURE day column means for this card — the one place the
 * board decides between scheduling and snoozing.
 *
 *   • A card on the desk (Drafts, Awaiting review) or already Resting →
 *     `stashed`. Dropping it on a day is "not now, come back then": the card
 *     leaves the desk for Resting and keeps the date as its return ticket.
 *     Composing the two fields is what snooze IS — there is no third stored
 *     state, so nothing new has to be migrated, classified, or cleaned up.
 *   • Anything else — an In-flight card, a closed run in the past lane → `now`.
 *     These are being *scheduled*: they keep their column and take the date as
 *     a bare `due:`, which is all scheduling has ever meant.
 *
 * A drop on TODAY never routes here: today means "onto the desk now", which is
 * `setSurface(card, 'now', { due: null })` at the call sites.
 */
export function dayDropHorizon(resp: KanbanResponse | null, id: string): HorizonKind {
  if (!resp) return 'now'
  if (resp.now.drafts.some((c) => c.id === id)) return 'stashed'
  if (resp.now.awaitingReview.some((c) => c.id === id)) return 'stashed'
  if (resp.stash.some((c) => c.id === id)) return 'stashed'
  return 'now'
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
