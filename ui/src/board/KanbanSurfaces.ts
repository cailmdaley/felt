import { installFrontierDetails } from './DeskFrontier.js'
import { responseThreadIndex, ThreadIndex } from './threads.js'
import { stateDot } from './stateDot.js'
import type { FiberSend } from './fiberSends.js'
import { markVerdictHost, type Verdict } from './workspace/Verdicts.js'
import { openActionMenu, type ConversationAction } from './conversationMenu.js'
import { dressVerb, lifecycleVerbsFor, verbSpec } from './workspace/lifecycleVerbs.js'
import {
  ascByKey,
  civilWeekday,
  dueCivilDay,
  dueSortMs,
  formatCivilDay,
  formatInstant,
  hostZone,
  instantMs,
  isoDayLocal,
  shiftCivilDay,
  type Zone,
} from './civilDay.js'
import type {
  ColumnKind,
  HorizonKind,
  KanbanCard,
  KanbanOriginStaleness,
  KanbanResponse,
} from './KanbanTypes.js'
import { turnOf } from './turn.js'
import { isAgentCard } from './KanbanModalShared.js'
import {
  humanizeCron,
  lensCycles,
} from './KanbanRules.js'
import type {
  CycleLensChip,
} from './KanbanRules.js'
import { byCreatedAtDesc, deriveCycleLens, IN_FLIGHT_BANDS, inFlightBand, isSleepingOnSchedule } from './KanbanReadModel.js'
import { coarsePointer, isMobileViewport } from './mobile.js'
import type { PhoneMeeting } from './phoneMeeting'
import { paintPhoneLevel, paintPhoneMeetingControls } from './phoneMeetingControls'
import { attachLongPress } from './longPress.js'
import {
  activeFolioIndex,
  folioScrollTarget,
  readBandState,
  writeBandState,
  type BandId,
} from './deskMobile.js'
import type { CycleLens } from './KanbanReadModel.js'
import { formatMeetingDuration, meetingActions, meetingDuration, meetingStateWord, paintTranscript, seatMeetingHost, type MeetingRecord } from './meeting.js'

export const FALLBACK_DEFAULT_AGENT = 'claude-opus'

/** A seat is a constitution, never a temporal cycle or an ordinary note. */
export function seatDropRefusal(card: KanbanCard): string | null {
  if (card.isCycle) return 'A cycle marks time and cannot become a seat.'
  if (!card.shuttleKind) return 'Only a constitution with a Shuttle block can become a seat.'
  return null
}

export const COLUMN_TITLES: Record<ColumnKind, string> = {
  drafts: 'Drafts',
  inFlight: 'In flight',
  awaitingReview: 'Awaiting review',
  tempered: 'Tempered',
  composted: 'Discarded',
}

type NowColumnKind = 'drafts' | 'inFlight' | 'awaitingReview'
const NOW_COLUMN_ORDER: NowColumnKind[] = ['drafts', 'inFlight', 'awaitingReview']

// How many days forward the drag-reveal horizon offers as drop targets. It is
// the WIDTH OF A GESTURE SURFACE and nothing else — no card is filed by it, no
// list is partitioned by it.
//
// THREE WEEKS: the strip is all calendar — the chapter chips are drop targets
// on the Desk's own always-visible cycle row (`renderCycleLensBar`) — and three
// weeks is still inside "a day you can picture"; past that you write a `due:`.
const DRAG_HORIZON_DAYS = 21



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

/** One live edge-scroll axis: its rAF handle, current velocity, and the
 *  element being scrolled. */
interface AxisScroll {
  frame: number | null
  velocity: number
  target: HTMLElement | null
}

/** Everything the two edge-scroll axes differ by. Carried rather than
 *  normalized: the capture phase, the overflow guard and the liveness
 *  predicate are each a real behavioural difference. */
interface AxisScrollSpec {
  axis: 'x' | 'y'
  state: AxisScroll
  edgePx: number
  maxStepPx: number
  /** Capture phase, for the columns: observe the gesture before a drop target handles it. */
  capture: boolean
  /** Columns only: a column that does not overflow has nothing to scroll. */
  requireOverflow: boolean
  live: () => boolean
  stop: () => void
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
  /** Make this constitution a seat, choosing an office when it has none. */
  makeSeat?: (card: KanbanCard, anchor: HTMLElement) => void | Promise<void>
  openDetail: (card: KanbanCard, forceRail?: boolean) => void
  /** The newest report a card sent — the row's mark. */
  getLatestReport?: (card: KanbanCard) => FiberSend | undefined
  /** Opens the Rest popover on the card's own Rest affordance. */
  onRest?: (card: KanbanCard) => void
  /** A verdict through the same undo window the header and keys use. */
  verdict?: (card: KanbanCard, verdict: Verdict) => void
  /** Resolve the owning host's registry default for agent labels. */
  getFleetDefaultAgent?: (origin: string) => string
  /** A card held still under the thumb — the touch reading of the drag. The
   *  renderer only reports the gesture and the element to hang a menu off; what
   *  it raises is the board's business. Omit to leave cards press-inert. */
  onCardLongPress?: (card: KanbanCard, anchor: HTMLElement) => void
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
  getMeeting?: () => MeetingRecord | null
  getPhoneMeeting?: () => PhoneMeeting
  isMeetingStopRequested?: (meeting: MeetingRecord) => boolean
  onMeetingTerminal?: (session: string) => void
  onMeetingStop?: (meeting: MeetingRecord) => void | Promise<void>
}

export class KanbanSurfaceRenderer {
  /** Open thread families, carried across the Desk's rebuilds. */
  /** Horizontal edge-scroll for the drag horizon. Lets a held card push
   *  against the strip's left/right edge to reach off-screen days. Separate
   *  from the body's vertical drag scroll so the two can run concurrently. */
  private readonly hScroll: AxisScroll = { frame: null, velocity: 0, target: null }
  /** Vertical twin of the above, for the columns. A separate record rather
   *  than a second axis on the same one, because the two run against
   *  DIFFERENT elements — the horizon strip scrolls sideways while a column
   *  scrolls down — and can be live at the same time. */
  private readonly vScroll: AxisScroll = { frame: null, velocity: 0, target: null }
  /** Which leaf of the mobile Now pager the reader is on. A fresh visit opens
   *  on In flight, whose Your turn band leads; the leaf is held across renders
   *  so a poll-driven rebuild doesn't turn the page somewhere else. */
  private folioIndex = NOW_COLUMN_ORDER.indexOf('inFlight')
  /** The horizon's aim readout — the fixed spot that names, in words, the
   *  target under the cursor. Rebuilt with the horizon on every drag. */
  private aimReadoutEl: HTMLElement | null = null
  /** Which drop target currently owns the readout, so a late `dragleave` from
   *  the cell you just left cannot blank the label the new cell just wrote. */
  private aimOwner: HTMLElement | null = null
  /** The offscreen node handed to `setDragImage`, kept only until the drag
   *  ends (the browser needs it alive for the snapshot, not after). */
  private dragGhostEl: HTMLElement | null = null
  private readonly o: KanbanSurfaceRendererOptions
  private currentMeetingList: HTMLElement | null = null
  /** The card the live meeting was last drawn on; `null` while it draws its own. */
  private meetingHostId: string | null = null

  constructor(options: KanbanSurfaceRendererOptions) {
    this.o = options
  }

  private agentName(card: KanbanCard): string | null {
    if (!isAgentCard(card) || !card.shuttleAgent) return null
    const fleetDefault = this.o.getFleetDefaultAgent?.(card.originId) ?? FALLBACK_DEFAULT_AGENT
    return card.shuttleAgent === fleetDefault ? null : card.shuttleAgent
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

    // A meeting's host card rides at the top of In flight while it records.
    const seated = seatMeetingHost(now, this.o.getMeeting?.() ?? null)
    now = seated.now
    this.meetingHostId = seated.host?.id ?? null

    const board = document.createElement('div')
    board.className = 'kbn-now-board'
    const counts: number[] = []
    for (const kind of NOW_COLUMN_ORDER) {
      board.append(this.renderColumn(kind, now[kind], staleness, lens))
      const ghosts = lens ? lens.ghosts.filter((g) => g.column === kind).length : 0
      counts.push(now[kind].length + ghosts)
    }

    // The folio strip rides ABOVE the board in the DOM on every viewport; only
    // the mobile media query gives it a box. Building it unconditionally keeps
    // one DOM for both shapes, so a window dragged across 700px changes layout
    // without a re-render.
    const folio = this.buildFolioStrip(board, counts)
    section.append(folio, board)
    if (isMobileViewport()) adoptColumnActions(board, folio)
    this.installFolioPager(board, folio)
    this.installSectionDragHandlers(section, {
      skipColHead: true,
      commit: (card) => void this.o.setSurface(card, 'now'),
    })
    return section
  }

  /**
   * Make a band head fold its band away — mobile only.
   *
   * On a phone the pager already fills the screen, so Resting stacks below it
   * and becomes a leaf you open. On the desktop board they are
   * standing furniture that is always shown, so nothing here applies: the head
   * gets no interactive role, no listener and no fold mark, and the CSS that
   * acts on `kbn-band-folded` lives entirely inside the mobile query.
   *
   * The class is stamped regardless of viewport so a window resized past 700px
   * finds the band in the state its owner last left it; only the affordance is
   * conditional.
   */
  private installBandCollapse(section: HTMLElement, head: HTMLElement, band: BandId): void {
    const state = readBandState()
    let open = state[band]
    const paint = (): void => {
      section.classList.toggle('kbn-band-folded', !open)
      head.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
    const mark = document.createElement('span')
    mark.className = 'kbn-bandhead-fold'
    mark.setAttribute('aria-hidden', 'true')
    head.append(mark)
    paint()
    if (!isMobileViewport()) return
    head.setAttribute('role', 'button')
    head.tabIndex = 0
    const toggle = (): void => {
      open = !open
      paint()
      writeBandState({ ...readBandState(), [band]: open })
    }
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      toggle()
    })
  }

  /**
   * THE FOLIO STRIP — the mobile Desk's page marks.
   *
   * At phone width the Now triad cannot be three columns, so it becomes three
   * leaves you turn. The strip is how you know which leaf you are on and how
   * you jump: one segment per column, carrying the column's own illuminated
   * initial in the column's own pigment (ochre / cobalt / verdigris) plus its
   * live count. The active segment is the leaf lifted off the desk — it wears
   * `.kbn-col`'s rag ground and hairline and closes over the rule beneath the
   * strip, the way a tabbed divider sits proud of the leaves behind it.
   *
   * Invisible above 700px: the three columns are all on screen there, so a
   * strip naming them is a label for what you can already see.
   */
  private buildFolioStrip(board: HTMLElement, counts: number[]): HTMLElement {
    const strip = document.createElement('div')
    strip.className = 'kbn-folio'
    strip.setAttribute('role', 'tablist')
    strip.setAttribute('aria-label', 'Now — which column is showing')

    NOW_COLUMN_ORDER.forEach((kind, i) => {
      // A tab says the leaf in one plain word and its count; the column's
      // full name is its accessible name.
      const title = COLUMN_TITLES[kind]
      // A div, not a button: on a phone the column's own action glyph moves
      // into this segment (see `adoptColumnActions`), and a real <button>
      // inside a <button> is invalid HTML that browsers un-nest on parse.
      const seg = document.createElement('div')
      seg.className = `kbn-folio-seg kbn-col-${kind}`
      seg.dataset.folio = String(i)
      seg.setAttribute('role', 'tab')
      seg.tabIndex = -1
      seg.setAttribute('aria-label', `${title} (${counts[i]})`)

      const name = document.createElement('span')
      name.className = 'kbn-folio-name'
      name.textContent = title

      const count = document.createElement('span')
      count.className = 'kbn-folio-count'
      count.textContent = String(counts[i])

      seg.append(name, count)
      const turnTo = (): void => {
        board.scrollTo({
          left: folioScrollTarget(i, board.clientWidth, NOW_COLUMN_ORDER.length),
          behavior: 'smooth',
        })
      }
      seg.addEventListener('click', (e) => {
        // The adopted action glyph lives inside this segment; pressing it is
        // "dispatch a draft", not "turn to Drafts".
        if ((e.target as HTMLElement).closest('.kbn-col-action')) return
        turnTo()
      })
      seg.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        if ((e.target as HTMLElement).closest('.kbn-col-action')) return
        e.preventDefault()
        turnTo()
      })
      strip.append(seg)
    })
    return strip
  }

  /**
   * Keep the strip honest about where the pager sits, and put the pager back
   * where it was across a re-render.
   *
   * The scroll offset IS the state — nothing else can stay true through a
   * momentum fling — so the active leaf is derived from `scrollLeft` on every
   * scroll event rather than tracked separately. `folioIndex` survives on the
   * renderer only so a poll-driven rebuild doesn't yank the reader back to
   * Drafts mid-read.
   */
  private installFolioPager(board: HTMLElement, strip: HTMLElement): void {
    const segs = Array.from(strip.querySelectorAll<HTMLElement>('.kbn-folio-seg'))
    const paint = (index: number): void => {
      segs.forEach((seg, i) => {
        const on = i === index
        seg.classList.toggle('kbn-folio-seg-active', on)
        seg.setAttribute('aria-selected', on ? 'true' : 'false')
        seg.tabIndex = on ? 0 : -1
      })
    }
    /** Read the leaf off the board and mark it on the strip. The board is the
     *  only authority: whatever `scrollLeft` says is the page you are on. */
    const syncFromScroll = (): void => {
      this.folioIndex = activeFolioIndex(board.scrollLeft, board.clientWidth, segs.length)
      paint(this.folioIndex)
    }
    paint(this.folioIndex)
    board.addEventListener('scroll', syncFromScroll, { passive: true })
    // Restore the leaf after layout — the section is still detached while this
    // method runs, so `clientWidth` is 0 and a scroll write would be dropped.
    // The write can still fail (a viewport that crossed back above 700px, a
    // Desk torn down before the frame arrived), so the mark is re-derived from
    // the board either way: a strip claiming leaf 2 over a board showing leaf 0
    // is worse than losing the reader's place.
    if (this.folioIndex > 0) {
      const wanted = this.folioIndex
      window.requestAnimationFrame(() => {
        if (board.isConnected && board.clientWidth > 0) {
          board.scrollLeft = folioScrollTarget(wanted, board.clientWidth, segs.length)
        }
        syncFromScroll()
      })
    }
  }

  /**
   * The CYCLE LENS ROW — a quiet line of chips at the right end of the view tab
   * strip, one per cycle that has not ended (`lensCycles`). Click one and the
   * Desk is seen through
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
   * Each chip accepts a card drop, like a day cell on the strip. `dropDay` (from
   * `lensCycles`) is what a drop here writes — a chip is a day
   * cell you happen to know by name. A cycle with no `start:` is a deadline
   * rather than a span, so it has no day to offer and simply refuses, silently
   * and without claiming the event.
   *
   * Returns null when there are no live cycles — an empty row would be a line
   * of chrome explaining that you have no chapters.
   */
  renderCycleLensBar(
    activeId: string | null,
    onToggle: (cycleId: string | null) => void,
    nowMs: number = Date.now(),
  ): HTMLElement | null {
    const resp = this.o.getLastResponse()
    const chips = lensCycles(resp?.cycles ?? [], nowMs)
    if (chips.length === 0) return null

    const bar = document.createElement('div')
    bar.className = 'kbn-lensbar'
    bar.setAttribute('role', 'region')
    bar.setAttribute('aria-label', 'Cycles — click one to see the desk through it, or drop a card on it')
    for (const chip of chips) {
      const count = deriveCycleLens(resp, chip.id, nowMs)?.count ?? 0
      const el = this.renderLensChip(chip, count, chip.id === activeId, onToggle)
      if (chip.dropDay !== undefined) {
        this.installTimelineDayDropHandlers(el, chip.dropDay, cycleAimLabel(chip, chip.dropDay))
        el.title = `${el.title} Or drop something here to rest it until ${shortDayLabel(chip.dropDay)}.`
      }
      bar.append(el)
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
    const countLabel = `${count} ${count === 1 ? 'card' : 'cards'}`
    el.title = active
      ? `Showing the desk through ${chip.name} · ${countLabel} — click to release.`
      : `${chip.name} · ${cycleChipText(chip)} · ${countLabel} — click to see the desk through it.`
    el.setAttribute('aria-label', `${chip.name}, ${count} ${count === 1 ? 'card' : 'cards'}${active ? ' — engaged' : ''}`)

    const name = document.createElement('span')
    name.className = 'kbn-cyclechip-name'
    name.textContent = chip.name

    const span = document.createElement('span')
    span.className = 'kbn-cyclechip-span'
    span.textContent = cycleChipText(chip)

    const tally = document.createElement('span')
    tally.className = 'kbn-lens-chip-count'
    tally.textContent = `${count} ${count === 1 ? 'card' : 'cards'}`

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

  /**
   * The drag-reveal horizon: a slim row of future days that materializes below
   * the tab strip for the duration of a drag, and nothing at all the rest of
   * the time.
   *
   * Chronicle is where the Desk's days are READ; this strip is only where
   * they are AIMED AT — the one way to say "this one on Tuesday." It appears
   * when you pick a card up and is gone the moment you let go, which is why
   * there are no mini-cards on it. A drop target does not need to show you what
   * it already holds; you are aiming at a date, not reading a schedule.
   *
   * FUTURE DAYS ONLY, today first. The past is never a legal drop (the drop
   * guard refuses it), so rendering it would only offer targets that bounce.
   * Today means "onto the desk now" and the future days mean
   * schedule-or-snooze — `dayDropHorizon` decides which.
   *
   * Cells flex to fill the width and scroll (with drag edge-scroll) only when
   * they cannot: a wide board gets generous targets, a narrow one keeps all
   * three weeks reachable.
   *
   * DAYS ONLY. The cycle chips are drop targets on the Desk's own cycle row
   * (`renderCycleLensBar`), always on screen, so "next sprint" is a date you
   * can aim at without a second copy of that row here.
   */
  renderDragHorizon(): HTMLElement {
    const outer = document.createElement('div')
    outer.className = 'kbn-draghorizon-inner'

    const wrap = document.createElement('div')
    wrap.className = 'kbn-draghorizon-wrap'
    wrap.dataset.draghorizonWrap = '1'
    wrap.setAttribute('role', 'region')
    wrap.setAttribute('aria-label', 'Drop a card on a day to schedule or snooze it')

    const row = document.createElement('div')
    row.className = 'kbn-draghorizon-row'

    for (const day of buildTimelineDays(0, DRAG_HORIZON_DAYS)) {
      // One element is both the date label and the drop target: nothing is
      // drawn between the two, so there is nothing to split them for.
      const cell = buildDayCell(day)
      cell.classList.add('kbn-timeline-dropcol', 'kbn-draghorizon-day')
      this.installTimelineDayDropHandlers(cell, day.iso, dayAimLabel(day))
      row.append(cell)
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

    const restingHead = renderBandHead('Resting', stash.length)
    section.append(restingHead)
    this.installBandCollapse(section, restingHead, 'resting')

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
    this.installSectionDragHandlers(section, {
      skipColHead: true,
      commit: (card) => void this.o.setSurface(card, 'stashed'),
    })
    return section
  }

  /**
   * The Roles band: every seat at rest (`shuttle.seat`), as a dense wrap of
   * launcher chips above Resting. A seat is an office you return to, so the
   * chip carries only what finds and starts it: a dot, the constitution's name,
   * and its agent, or its next firing for a standing seat. Every seat renders —
   * no "+N more", because a launcher you reach for daily must never be on page
   * two. Click opens the fiber; drag it to In flight to start it.
   *
   * Drop a constitution on the band to make it a seat and let it rest,
   * choosing an office first when it has none. The empty band stays reachable
   * for the first seat.
   */
  renderRolesSection(
    roles: KanbanCard[],
    staleness: Record<string, KanbanOriginStaleness>,
  ): HTMLElement {
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-roles'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', `Roles (${roles.length}) — drop a constitution here to make a seat`)

    const head = renderBandHead('Roles', roles.length)
    section.append(head)
    this.installBandCollapse(section, head, 'roles')

    const row = document.createElement('div')
    row.className = 'kbn-roles-row'
    row.setAttribute('role', 'list')
    for (const card of roles) row.append(this.renderRoleSeat(card, staleness[card.originId]))
    if (roles.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'kbn-cluster-empty'
      empty.textContent = '— drag a constitution here to make a seat —'
      row.append(empty)
    }
    section.append(row)
    this.installSectionDragHandlers(section, {
      skipColHead: false,
      skipTarget: '.kbn-role-chip, .kbn-role-threads',
      refusal: seatDropRefusal,
      commit: card => void this.o.makeSeat?.(card, section),
    })
    return section
  }

  /** A quiet seat is a single chip in the Roles band. */
  private renderRoleSeat(
    card: KanbanCard,
    originStaleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    return this.renderRoleChip(card, originStaleness)
  }

  private renderRoleChip(
    card: KanbanCard,
    originStaleness: KanbanOriginStaleness | undefined,
  ): HTMLElement {
    const isStale = originStaleness?.status === 'stale'
    const el = document.createElement('button')
    el.type = 'button'
    el.className = `kbn-role-chip${isStale ? ' kbn-card--stale' : ''}`
    el.dataset.fiberId = card.id
    el.dataset.cardUid = card.uid ?? card.id
    el.dataset.cardOrigin = card.originId
    el.setAttribute('role', 'listitem')
    el.draggable = !isStale && !coarsePointer()
    if (!isStale) this.installDraggable(el, card, true)
    this.installLongPressMove(el, card)

    const dot = document.createElement('span')
    dot.className = `kbn-role-chip-dot kbn-role-chip-dot-${isStale ? 'stale' : card.held ? 'held' : 'rest'}`
    dot.setAttribute('aria-hidden', 'true')

    const name = document.createElement('span')
    name.className = 'kbn-role-chip-name'
    name.textContent = card.name

    const hint = document.createElement('span')
    hint.className = 'kbn-role-chip-hint'
    let detail = ''
    if (isSleepingOnSchedule(card)) {
      const returns = card.nextLaunchAt ? formatLaunchDay(card.nextLaunchAt) : null
      hint.textContent = returns ? `↻ ${returns}` : '↻'
      const schedule = humanizeCron(card.shuttleSchedule) ?? card.shuttleSchedule
      detail = [schedule, returns && `next ${returns}`].filter(Boolean).join(' · ')
    }
    hint.hidden = hint.textContent === ''

    el.append(dot, name, hint)
    const seat = card.shuttleSeat === true && card.shuttleRole ? `seat of roles/${card.shuttleRole}` : ''
    el.title = [card.name, seat, detail, card.outcome].filter(Boolean).join(' — ')
    el.setAttribute('aria-label', `${card.name}${seat ? `, ${seat}` : ''}${isStale ? ' — waiting on origin, drag disabled' : ''}`)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return
      this.o.openDetail(card)
    })
    return el
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

  /** Halt both edge-scroll rAFs — the horizon's horizontal one and the
   *  columns' vertical one. Called on drop, on drag-leave, and by the modal on
   *  unmount so no tick outlives the board. */
  stopEdgeScroll(): void {
    this.stopAxis(this.hScroll)
    this.stopAxis(this.vScroll)
  }

  /** Install drag edge-scroll on one axis of `el`. Both axes are the same
   *  pressure ramp against the near and far edge; everything the two differ
   *  by rides on `spec`, including which stop they use — the horizontal one
   *  clears BOTH axes (it is the public `stopEdgeScroll`), the vertical one
   *  only its own. */
  private installAxisEdgeScroll(el: HTMLElement, spec: AxisScrollSpec): void {
    el.addEventListener(
      'dragover',
      (e: DragEvent) => {
        if (!spec.live()) return
        if (spec.requireOverflow && el.scrollHeight <= el.clientHeight) return
        const r = el.getBoundingClientRect()
        const pos = spec.axis === 'y' ? e.clientY : e.clientX
        const nearPressure = Math.max(0, spec.edgePx - (pos - (spec.axis === 'y' ? r.top : r.left)))
        const farPressure = Math.max(0, spec.edgePx - ((spec.axis === 'y' ? r.bottom : r.right) - pos))
        const direction = farPressure > 0 ? 1 : nearPressure > 0 ? -1 : 0
        const pressure = Math.max(nearPressure, farPressure) / spec.edgePx
        spec.state.velocity =
          direction === 0
            ? 0
            : direction * Math.max(6, Math.round(Math.pow(pressure, 1.35) * spec.maxStepPx))
        if (spec.state.velocity === 0) {
          spec.stop()
          return
        }
        spec.state.target = el
        this.startAxis(spec)
      },
      spec.capture,
    )
    el.addEventListener('dragleave', (e: DragEvent) => {
      if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return
      spec.stop()
    })
    el.addEventListener('drop', () => spec.stop())
  }

  private startAxis(spec: AxisScrollSpec): void {
    const st = spec.state
    if (st.frame !== null) return
    const tick = (): void => {
      const target = st.target
      if (!target || !spec.live() || st.velocity === 0) {
        spec.stop()
        return
      }
      if (spec.axis === 'y') target.scrollTop += st.velocity
      else target.scrollLeft += st.velocity
      st.frame = window.requestAnimationFrame(tick)
    }
    st.frame = window.requestAnimationFrame(tick)
  }

  private stopAxis(st: AxisScroll): void {
    st.velocity = 0
    st.target = null
    if (st.frame === null) return
    window.cancelAnimationFrame(st.frame)
    st.frame = null
  }

  /** True while a card drag is in flight. */
  isDragging(): boolean { return this.o.getDragSourceId() !== null }


  private installVerticalEdgeScroll(el: HTMLElement): void {
    this.installAxisEdgeScroll(el, {
      axis: 'y',
      state: this.vScroll,
      edgePx: 72,
      maxStepPx: 26,
      capture: true,
      requireOverflow: true,
      live: () => this.isDragging(),
      stop: () => this.stopAxis(this.vScroll),
    })
  }


  private installEdgeScroll(wrap: HTMLElement): void {
    this.installAxisEdgeScroll(wrap, {
      axis: 'x',
      state: this.hScroll,
      edgePx: 80,
      maxStepPx: 28,
      capture: false,
      requireOverflow: false,
      live: () => this.o.getDragSourceId() !== null,
      stop: () => this.stopEdgeScroll(),
    })
  }

  /** Install drop handlers on a section (Now, Resting, Roles). A drop outside
   *  a column header calls `commit`. */
  private installSectionDragHandlers(
    section: HTMLElement,
    spec: {
      skipColHead: boolean
      skipTarget?: string
      refusal?: (card: KanbanCard) => string | null
      commit: (card: KanbanCard) => void
    },
  ): void {
    const overHead = (e: Event): boolean =>
      (spec.skipColHead && !!(e.target as HTMLElement).closest('.kbn-col-head')) ||
      (!!spec.skipTarget && !!(e.target as HTMLElement).closest(spec.skipTarget))
    let watchingEnd = false
    const clear = (): void => {
      section.classList.remove('kbn-section-drop')
      section.removeAttribute('title')
      this.setAim(section, null)
    }
    section.addEventListener('dragover', (e) => {
      if (!this.o.getDragSourceId()) return
      if (!watchingEnd) {
        watchingEnd = true
        document.addEventListener('dragend', () => { watchingEnd = false; clear() }, { once: true })
      }
      if (overHead(e)) { clear(); return }
      const id = this.o.getDragSourceId()
      const card = id ? findCardById(this.o.getLastResponse(), id) : null
      const refusal = card ? spec.refusal?.(card) : null
      if (refusal) {
        clear()
        section.title = refusal
        this.setAim(section, refusal)
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
        return
      }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      section.classList.add('kbn-section-drop')
    })
    section.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && section.contains(e.relatedTarget as Node)) return
      clear()
    })
    section.addEventListener('drop', (e) => {
      if (overHead(e)) return
      clear()
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.o.getDragSourceId()
      this.o.setDragSourceId(null)
      this.o.stopDragAutoScroll()
      if (!fiberId) return
      e.preventDefault()
      const card = findCardById(this.o.getLastResponse(), fiberId)
      if (!card || spec.refusal?.(card)) return
      spec.commit(card)
    })
  }

  /**
   * Make an element mean the civil day `iso` for a drop — a day cell on the
   * drag horizon, or a cycle chip standing in for its opening day.
   *
   * A card lands here and gets the date.
   *
   * NOTHING IS CLAIMED THAT IS NOT TAKEN: with no drag in flight, or a past
   * day, or an id this board cannot resolve, the handlers return before
   * `preventDefault` and the event goes on to whatever is underneath.
   */
  private installTimelineDayDropHandlers(
    dropCol: HTMLElement,
    iso: string,
    aimLabel: string,
  ): void {
    const isDropEligible = (id: string): boolean => {
      const today = isoDayLocal(Date.now())
      if (iso < today) return false
      return !!findCardById(this.o.getLastResponse(), id)
    }
    /** The id this drop would act on — the card being dragged. Null when nothing eligible is in flight. */
    const heldId = (): string | null => {
      const dragSourceId = this.o.getDragSourceId()
      if (!dragSourceId) return null
      return isDropEligible(dragSourceId) ? dragSourceId : null
    }
    const setActive = (active: boolean): void => {
      dropCol.classList.toggle('kbn-timeline-dropcol-active', active)
      this.setAim(dropCol, active ? aimLabel : null)
    }
    /** What this day means for `id`, as the drop payload both paths share. */
    const dayMeaning = (id: string): { horizon: HorizonKind; due: string | null } =>
      iso === isoDayLocal(Date.now())
        ? { horizon: 'now', due: null }
        : { horizon: dayDropHorizon(this.o.getLastResponse(), id), due: iso }
    dropCol.addEventListener('dragover', (e) => {
      if (heldId() === null) return
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
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.o.getDragSourceId()
      setActive(false)
      this.o.setDragSourceId(null)
      this.o.stopDragAutoScroll()
      if (!fiberId) return
      if (!isDropEligible(fiberId)) return
      const card = findCardById(this.o.getLastResponse(), fiberId)
      if (!card) return
      const { horizon, due } = dayMeaning(card.id)
      void this.o.setSurface(card, horizon, { due })
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
    const agentName = this.agentName(card)
    const el = document.createElement('div')
    el.className = isAgentCard(card) ? 'kbn-cluster-item kbn-cluster-item-agent' : 'kbn-cluster-item kbn-cluster-item-human'
    if (sleeping) el.classList.add('kbn-cluster-item-standing')
    el.draggable = !isStale && !coarsePointer()
    el.dataset.fiberId = card.id
    el.dataset.cardUid = card.uid ?? card.id
    el.dataset.cardOrigin = card.originId
    el.setAttribute('role', 'listitem')
    // The agent is inventory, not a next move: it rides in the label and the
    // line's title, and the workspace names it, so the title gets the width.
    const who = agentName ? ` — ${agentName}` : ''
    el.setAttribute('aria-label', `${card.name}${who}`)
    el.title = `${card.name}${who}`

    if (!isStale) this.installDraggable(el, card, false)

    const glyph = stateDot(card, this.o.openDetail)
    const title = document.createElement('span')
    title.className = 'kbn-cluster-item-title'
    title.textContent = card.name
    el.append(glyph, title)


    // A verdict waits out its undo window at the line's right end.
    const end = document.createElement('span')
    end.className = 'kbn-cluster-item-verdicts'
    markVerdictHost(end, card)
    el.append(end)
    this.installRowMenu(el, card, isStale)
    installFrontierDetails(el, end, card, threadIndexFor(this.o.getLastResponse()), this.o.openDetail)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      this.o.openDetail(card)
    })
    return el
  }

  /**
   * Render one Now-surface column (Drafts / In flight / Awaiting review). The
   * column header doubles as the lifecycle-transition drop target.
   */
  private renderColumn(
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
      col.classList.remove('kbn-col-drop')
      const fiberId = e.dataTransfer?.getData('text/x-fiber-id') || this.o.getDragSourceId()
      this.o.setDragSourceId(null)
      this.o.stopDragAutoScroll()
      if (!fiberId) return
      const card = findCardById(this.o.getLastResponse(), fiberId)
      if (!card) return
      void this.o.transition(card, kind)
    }
    const dragOverColumn = (e: DragEvent): void => {
      if (!this.o.getDragSourceId()) return
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
    this.installVerticalEdgeScroll(list)
    const meeting = kind === 'inFlight' ? this.o.getMeeting?.() ?? null : null
    if (kind === 'inFlight') this.currentMeetingList = list
    if (meeting && !this.meetingHostId) list.append(this.renderMeetingCard(meeting))

    if (cards.length === 0 && ghosts.length === 0 && !meeting) {
      const empty = document.createElement('div')
      empty.className = 'kbn-empty'
      empty.setAttribute('role', 'listitem')
      empty.textContent = kind === 'drafts'
        ? (this.o.onStashClick ? 'Use Stash to create a draft. Describe what done looks like.' : 'Drafts appear here before you launch them.')
        : kind === 'inFlight'
          ? 'Drag a draft here to start its agent.'
          : 'Work returns here when its agent hands it back for review.'
      list.append(empty)
    } else {
      const appendCard = (parent: HTMLElement, card: KanbanCard): void => {
        const hostsMeeting = meeting !== null && card.id === this.meetingHostId
        const el = this.renderCard(card, kind, staleness[card.originId], {
          // A lensed column recedes what the cycle does not claim. The card
          // stays live — clickable, draggable — because a lens is a way of
          // looking, not a filter that takes the board away from you.
          dim: !hostsMeeting && lens !== null && !lens.memberIds.has(card.id),
        })
        // Every in-flight card carries its turn; Your turn draws a question heavier than an idle turn.
        if (kind === 'inFlight') el.dataset.turn = turnOf(card).turn
        if (hostsMeeting) this.hostMeeting(el, meeting)
        parent.append(el)
      }
      if (kind === 'inFlight') {
        // The read model owns order within each band, questions first in
        // Your turn. The captions name whose move each band is.
        for (const [key, label] of IN_FLIGHT_BANDS) {
          const members = cards.filter((card) => inFlightBand(card) === key)
          if (members.length === 0) continue
          const band = document.createElement('div')
          band.className = 'kbn-flight-band'
          band.dataset.flightBand = key
          band.setAttribute('role', 'listitem')
          const caption = document.createElement('h3')
          caption.className = 'kbn-flight-caption'
          caption.textContent = label
          const bandList = document.createElement('div')
          bandList.className = 'kbn-flight-band-list'
          bandList.setAttribute('role', 'list')
          bandList.setAttribute('aria-label', label)
          for (const card of members) appendCard(bandList, card)
          band.append(caption, bandList)
          list.append(band)
        }
      } else {
        for (const card of cards) appendCard(list, card)
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
   * The per-lane head action — one tinted pill at the column head's right
   * edge, naming the verb that feeds the lane (color = lane identity):
   *
   *   Drafts    → Stash `+`    (ochre)  onStashClick
   *   In flight → New idea `✶` (cobalt) onNewIdeaClick
   *
   * Returns null for a lane whose callback isn't wired (read-only context) —
   * those heads render title + count alone. Each action names its verb beside
   * the glyph and stops click propagation (the head is itself a focusable drop
   * target).
   */
  private makeColumnAction(kind: NowColumnKind): HTMLButtonElement | null {
    const spec =
      kind === 'drafts'
        ? this.o.onStashClick && {
            glyph: '+', text: 'Stash', modifier: 'drafts',
            label: 'Stash a new fiber', onClick: this.o.onStashClick,
          }
        : kind === 'inFlight'
          ? this.o.onNewIdeaClick && {
              glyph: '✶', text: 'New idea', modifier: 'inFlight',
              label: 'New idea — speak it into a card', onClick: this.o.onNewIdeaClick,
            }
          : null
    if (!spec) return null

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `kbn-col-action kbn-col-action-${spec.modifier}`
    const glyph = document.createElement('span')
    glyph.className = 'kbn-col-action-glyph'
    glyph.textContent = spec.glyph
    const text = document.createElement('span')
    text.className = 'kbn-col-action-label'
    text.textContent = spec.text
    btn.append(glyph, text)
    btn.setAttribute('aria-label', spec.label)
    btn.title = spec.label
    btn.addEventListener('click', (e) => {
      // The head is a drop target + focusable; a click on its action must not
      // bubble up to it (or to the column's open-detail / drag wiring).
      e.stopPropagation()
      spec.onClick()
    })
    return btn
  }

  /**
   * Bring the drawn meeting up to date in place. Returns false when the
   * meeting has moved onto or off a card, which only a desk render can draw.
   */
  updateMeetingPresentation(): boolean {
    const list = this.currentMeetingList
    if (!list) return true
    const meeting = this.o.getMeeting?.() ?? null
    const response = this.o.getLastResponse()
    const hostId = response ? seatMeetingHost(response.now, meeting).host?.id ?? null : null
    if (hostId !== this.meetingHostId) return false
    if (meeting && hostId) {
      const host = list.querySelector<HTMLElement>('.kbn-card--meeting')
      if (!host) return false
      this.updateMeetingBlock(host, meeting)
      return true
    }
    const current = list.querySelector<HTMLElement>('.kbn-meeting-card')
    if (!meeting) {
      current?.remove()
      if (!list.querySelector('.kbn-card, .kbn-empty')) {
        const empty = document.createElement('div')
        empty.className = 'kbn-empty'
        empty.setAttribute('role', 'listitem')
        empty.textContent = 'Drag a draft here to start its agent.'
        list.append(empty)
      }
      return true
    }
    list.querySelector('.kbn-empty')?.remove()
    if (current) this.updateMeetingBlock(current, meeting)
    else list.prepend(this.renderMeetingCard(meeting))
    return true
  }

  /** Move the mobile pager to the meeting without changing desktop layout. */
  selectInFlight(): void {
    if (!isMobileViewport()) return
    this.folioIndex = 1
    const board = this.currentMeetingList?.closest<HTMLElement>('.kbn-now-board')
    if (board) {
      board.scrollLeft = folioScrollTarget(1, board.clientWidth, NOW_COLUMN_ORDER.length)
      const strip = board.parentElement?.querySelector('.kbn-folio')
      strip?.querySelectorAll<HTMLElement>('.kbn-folio-seg').forEach((seg, index) => {
        seg.classList.toggle('kbn-folio-seg-active', index === 1)
        seg.setAttribute('aria-selected', String(index === 1))
        seg.tabIndex = index === 1 ? 0 : -1
      })
    }
  }

  updatePhoneLevel(): void {
    const phone = this.o.getPhoneMeeting?.()
    if (phone && this.currentMeetingList) paintPhoneLevel(this.currentMeetingList, phone.peak)
  }

  updateMeetingDuration(nowMs = Date.now()): void {
    for (const duration of this.currentMeetingList?.querySelectorAll<HTMLElement>('.kbn-meeting-duration:not([hidden])') ?? []) {
      const startedAt = duration.dataset.startedAt
      if (startedAt) duration.textContent = formatMeetingDuration(startedAt, nowMs)
    }
  }

  /** A meeting with no card on the desk: a capture whose scribe has not
   *  claimed yet, or a constitution that is not drawn here. */
  private renderMeetingCard(meeting: MeetingRecord): HTMLElement {
    const card = document.createElement('article')
    card.className = 'kbn-meeting-card'
    card.setAttribute('role', 'region')
    const title = document.createElement('strong')
    title.className = 'kbn-meeting-title'
    const fiber = document.createElement('div')
    fiber.className = 'kbn-meeting-fiber'
    card.append(title, fiber, this.buildMeetingBlock())
    this.updateMeetingBlock(card, meeting)
    return card
  }

  /** Fold the live meeting into the card of the fiber it belongs to. */
  private hostMeeting(el: HTMLElement, meeting: MeetingRecord): void {
    el.classList.add('kbn-card--meeting')
    el.append(this.buildMeetingBlock())
    this.updateMeetingBlock(el, meeting)
  }

  /** The recording's state, clock, transcript tail, error and controls. */
  private buildMeetingBlock(): HTMLElement {
    const block = document.createElement('div')
    block.className = 'kbn-meeting'
    // The block is the meeting's, not the card's: a click or a scroll-drag in
    // it must not open the fiber or pick the card up.
    block.addEventListener('click', (event) => event.stopPropagation())
    block.addEventListener('pointerdown', (event) => event.stopPropagation())

    const status = document.createElement('div')
    status.className = 'kbn-meeting-meta'
    const dot = document.createElement('span')
    dot.className = 'kbn-meeting-dot'
    dot.setAttribute('aria-hidden', 'true')
    const state = document.createElement('span')
    state.className = 'kbn-meeting-state'
    const duration = document.createElement('time')
    duration.className = 'kbn-meeting-duration'
    const host = document.createElement('span')
    host.className = 'kbn-meeting-host'
    status.append(dot, state, duration, host)

    const tail = document.createElement('ol')
    tail.className = 'kbn-meeting-tail'
    tail.setAttribute('aria-label', 'Live transcript')
    tail.tabIndex = 0
    tail.draggable = false
    tail.addEventListener('dragstart', (event) => { event.preventDefault(); event.stopPropagation() })

    const error = document.createElement('div')
    error.className = 'kbn-meeting-error'
    error.setAttribute('role', 'alert')
    const actions = document.createElement('div')
    actions.className = 'kbn-meeting-actions'
    block.append(status, tail, error, actions)
    return block
  }

  private updateMeetingBlock(root: HTMLElement, meeting: MeetingRecord): void {
    const actions = meetingActions(meeting, this.o.isMeetingStopRequested?.(meeting) ?? false)
    const title = meeting.title?.trim() || 'Untitled meeting'
    const hosted = root.classList.contains('kbn-card--meeting')
    for (const state of ['starting', 'loading', 'live', 'stopping', 'failed']) {
      root.classList.toggle(`kbn-meeting-${state}`, meeting.state === state)
    }
    if (!hosted) {
      root.setAttribute('aria-label', `Meeting: ${title}, ${meetingStateWord(meeting.state)}`)
      root.querySelector<HTMLElement>('.kbn-meeting-title')!.textContent = title
      const fiber = root.querySelector<HTMLElement>('.kbn-meeting-fiber')!
      fiber.textContent = meeting.fiber ? `${meeting.joined ? 'joins' : 'notes in'} ${meeting.fiber}` : ''
      fiber.title = !meeting.fiber
        ? ''
        : meeting.joined
          ? `This meeting joins the constitution ${meeting.fiber}`
          : `The scribe keeps this meeting's notes in ${meeting.fiber}`
      fiber.hidden = !meeting.fiber
    }
    const block = root.querySelector<HTMLElement>('.kbn-meeting')!
    block.setAttribute('aria-label', `Meeting ${meetingStateWord(meeting.state).toLowerCase()}: ${title}`)
    // Where the audio comes from (a phone meeting's), then where the
    // transcript is written.
    block.querySelector<HTMLElement>('.kbn-meeting-host')!.textContent =
      (meeting.phone ? 'phone mic · ' : '') + (meeting.recorder ? `records on ${meeting.recorder}` : 'recorder') +
      (meeting.mirror_host ? ` → ${meeting.mirror_host}` : '')
    block.querySelector<HTMLElement>('.kbn-meeting-state')!.textContent = meetingStateWord(meeting.state)
    const duration = block.querySelector<HTMLTimeElement>('.kbn-meeting-duration')!
    const value = meetingDuration(meeting)
    duration.dataset.startedAt = meeting.started_at ?? ''
    duration.textContent = value ?? ''
    duration.dateTime = meeting.started_at ?? ''
    duration.hidden = value === null
    paintTranscript(block.querySelector<HTMLOListElement>('.kbn-meeting-tail')!, meeting.tail)
    const error = block.querySelector<HTMLElement>('.kbn-meeting-error')!
    error.textContent = meeting.state === 'failed' ? meeting.error || 'The meeting failed.' : ''
    error.hidden = meeting.state !== 'failed'

    const phone = this.o.getPhoneMeeting?.()
    if (phone) paintPhoneMeetingControls(block, meeting, phone)
    const actionGroup = block.querySelector<HTMLElement>('.kbn-meeting-actions')!
    const actionSignature = [meeting.state, meeting.phone, actions.terminal, actions.stop, actions.stopDisabled, actions.dismiss].join(':')
    if (actionGroup.dataset.signature === actionSignature) return
    actionGroup.dataset.signature = actionSignature
    actionGroup.replaceChildren()
    const addAction = (label: string, className: string, disabled: boolean, run: () => void): void => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `kbn-meeting-action ${className}`
      button.textContent = label
      button.disabled = disabled
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        run()
      })
      actionGroup.append(button)
    }

    if ((actions.stop || actions.dismiss) && this.o.onMeetingStop) {
      addAction(actions.dismiss ? 'Dismiss' : 'Stop', 'kbn-meeting-stop', actions.stopDisabled, () => {
        const current = this.o.getMeeting?.()
        if (!current || this.o.isMeetingStopRequested?.(current)) return
        void this.o.onMeetingStop?.(current)
      })
    }
    if (actions.terminal && !meeting.phone && this.o.onMeetingTerminal) {
      addAction('Terminal', 'kbn-meeting-terminal', false, () => {
        const session = this.o.getMeeting?.()?.tmux_session
        if (session) this.o.onMeetingTerminal?.(session)
      })
    }
  }

  /**
   * Render one Desk row — a line in a thread list, not a slip of paper.
   *
   * At a glance a row carries only what decides where to look next: whose
   * hand it is in (the dot), the title, its family's counts,
   * and the action menu. The document workspace holds the
   * outcome, question, path, agent, due, warnings and the report itself.
   *
   * Clicking the row or its dot opens the constitution's chat.
   */
  private renderCard(
    card: KanbanCard,
    kind: NowColumnKind,
    originStaleness?: KanbanOriginStaleness,
    lensState: { dim?: boolean; ghost?: boolean } = {},
  ): HTMLElement {
    const isStale = originStaleness?.status === 'stale'
    const agentName = this.agentName(card)

    const el = document.createElement('div')
    el.className = `kbn-card kbn-card-${kind}${isStale ? ' kbn-card--stale' : ''}`
    if (lensState.dim) el.classList.add('kbn-card--lens-off')
    if (lensState.ghost) el.classList.add('kbn-card--lens-ghost')
    el.setAttribute('role', 'listitem')
    const ariaSuffix = isStale
      ? ` — waiting on ${originStaleness.hostname ?? card.originId}, drag disabled`
      : ''
    const lensSuffix = lensState.ghost ? ' — resting, shown for this cycle' : ''
    el.setAttribute('aria-label', `${card.name}${agentName ? ` — ${agentName}` : ''} — ${COLUMN_TITLES[kind]}${lensSuffix}${ariaSuffix}`)
    // Touch has no drag-and-drop backend, and a draggable card fights the
    // finger that is trying to scroll past it. Holding the card still opens
    // its menu, whose Move… is the touch path to the same transitions.
    el.draggable = !isStale && !coarsePointer()
    el.dataset.fiberId = card.id
    el.dataset.cardUid = card.uid ?? card.id
    el.dataset.cardOrigin = card.originId

    if (!isStale) this.installDraggable(el, card, true)

    const glyph = stateDot(card, this.o.openDetail)
    const name = document.createElement('span')
    name.className = 'kbn-card-name'
    name.textContent = card.name
    el.append(glyph, name)

    // The row's right end. A verdict given from the Desk waits out its undo
    // window here, over whatever the end was showing.
    const meta = document.createElement('div')
    meta.className = 'kbn-card-meta'
    markVerdictHost(meta, card)


    el.append(meta)
    installFrontierDetails(el, meta, card, threadIndexFor(this.o.getLastResponse()), this.o.openDetail)
    this.installRowMenu(el, card, isStale)

    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a, button, textarea')) return
      this.o.openDetail(card)
    })

    return el
  }

  /**
   * A Desk line's actions live in a context menu, not a control: right-click,
   * a long press, or the context-menu key (Shift+F10) on the focused line. Its
   * verbs are the opened card's header verbs, drawn the same way from one
   * definition (`lifecycleVerbs`).
   */
  private installRowMenu(el: HTMLElement, card: KanbanCard, stale: boolean): void {
    el.setAttribute('aria-haspopup', 'menu')
    el.addEventListener('contextmenu', event => {
      if ((event.target as HTMLElement).closest('a[href]')) return
      event.preventDefault(); event.stopPropagation()
      // Android follows a touch long press with its own contextmenu; the press already opened the menu.
      if (performance.now() - longPressedAt < 1000) return
      this.openRowMenu(el, card, stale, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined)
    })
    el.addEventListener('keydown', event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      // A sub-line names another node; the row's menu is not its menu.
      if ((event.target as HTMLElement).closest('.kbn-family-asks')) return
      event.preventDefault(); event.stopPropagation()
      this.openRowMenu(el, card, stale)
    })
    let longPressedAt = -Infinity
    attachLongPress(el, { onFire: () => { longPressedAt = performance.now(); this.openRowMenu(el, card, stale) } })
  }

  /** The line's actions: the header's verbs for this card, then what only a live worker or a held launch offers. */
  rowActions(card: KanbanCard, stale: boolean, anchor: HTMLElement): ConversationAction[] {
    const actions: ConversationAction[] = stale ? [] : lifecycleVerbsFor(card, !!this.o.onRest).map(verb => ({
      label: verbSpec(verb).label,
      dress: (item: HTMLButtonElement) => { dressVerb(item, verb) },
      run: () => {
        if (verb === 'rest') { this.o.onRest?.(card); return }
        const verdict: Verdict = verb === 'review' ? 'awaitingReview' : verb === 'temper' ? 'tempered' : 'composted'
        if (this.o.verdict) this.o.verdict(card, verdict)
        else void this.o.transition(card, verdict)
        // The menu handed focus back to the line; a verdict's undo, drawn on the line, takes it.
        if (document.activeElement === anchor) anchor.querySelector<HTMLElement>('.ws-verdict-undo button')?.focus()
      },
    }))
    if (card.held && this.o.releaseQuarantine) {
      actions.push({ label: 'Release boot quarantine', run: () => { void this.o.releaseQuarantine!(card.shuttleHost) } })
    }
    if (card.tmuxSession && this.o.openWorker) {
      actions.push({ label: 'Open terminal', run: () => this.o.openWorker!(card.tmuxSession!, card.shuttleHost) })
    }
    const move = this.o.onCardLongPress
    if (!stale && move) actions.push({ label: 'Move…', run: () => move(card, anchor) })
    return actions
  }

  private openRowMenu(el: HTMLElement, card: KanbanCard, stale: boolean, point?: { x: number; y: number }): void {
    this.closeMenu()
    this.dismissCardMenu = openActionMenu(el, this.rowActions(card, stale, el), `Actions for ${card.name}`, point)
  }

  private dismissCardMenu?: () => void
  closeMenu(): void { this.dismissCardMenu?.(); this.dismissCardMenu = undefined }

  /** Wire the long press, when the board offered somewhere for it to go.
   *  Installed on STALE cards too: what a stale card may do is the move menu's
   *  own verdict to give, not a gesture's to silently withhold. */
  private installLongPressMove(el: HTMLElement, card: KanbanCard): void {
    const longPress = this.o.onCardLongPress
    if (!longPress) return
    attachLongPress(el, { onFire: () => longPress(card, el) })
  }

  private installDraggable(el: HTMLElement, card: KanbanCard, includePlainText: boolean): void {
    el.addEventListener('dragstart', (e) => {
      this.o.setDragSourceId(card.id)
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
      this.o.setDragSourceId(null)
      this.releaseDragGhost()
      if (includePlainText) this.o.stopDragAutoScroll()
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

/**
 * Move each column's action glyph out of its head and into its folio segment.
 *
 * On a phone the segment IS the column's name — same word, same illuminated
 * initial, same count — so the head below it was saying everything twice, and
 * the mobile stylesheet hides it. The one thing the head still owned is the
 * lane action (Stash or New idea), and that belongs with the name rather than
 * floating over the first card's title.
 *
 * Only the active segment shows its action (CSS): two across a strip
 * that is also the page marks would read as a toolbar.
 *
 * Mobile only, and re-done on every render — `KanbanModal` rebuilds the Desk
 * when the viewport crosses the threshold, so the wide board always gets a
 * freshly built head with its action still in it.
 */
function adoptColumnActions(board: HTMLElement, strip: HTMLElement): void {
  const segs = strip.querySelectorAll<HTMLElement>('.kbn-folio-seg')
  const cols = board.querySelectorAll<HTMLElement>('.kbn-col')
  cols.forEach((col, i) => {
    const action = col.querySelector<HTMLElement>('.kbn-col-action')
    const seg = segs[i]
    if (action && seg) seg.append(action)
  })
}

/** The head of a Desk band (Resting) — the column head's own parts at
 *  band scale: a small-caps title and the count in mono beside it. No dropcap:
 *  the F2/F1 initial needs the column title's size to read as illumination
 *  (see `.kbn-bandhead-title`). */
function renderBandHead(label: string, count: number): HTMLElement {
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
 * Strides by CALENDAR day (`shiftCivilDay`), never by 86_400_000 ms of an
 * instant. A fixed-millisecond stride drifts an hour across a DST transition
 * and eventually skips or repeats a civil day — and a skipped column is a card
 * that VANISHES, because its due day finds no column to land on. `today` is a
 * civil day, and the strip is built from it with no zone in sight.
 */
export function buildTimelineDays(
  past: number,
  future: number,
  today: string = isoDayLocal(Date.now()),
): TimelineDay[] {
  const days: TimelineDay[] = []
  for (let offset = -past; offset <= future; offset += 1) {
    const iso = shiftCivilDay(today, offset)
    const dow = civilWeekday(iso)
    days.push({
      iso,
      label: String(Number(iso.slice(8, 10))),
      weekdayLabel: formatCivilDay(iso, { weekday: 'short' }) ?? '',
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
  if (day.isWeekend) classes.push('kbn-timeline-day-weekend')
  if (day.weekBoundary) classes.push('kbn-timeline-day-week-boundary')
  el.className = classes.join(' ')

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
  return formatCivilDay(iso, { month: 'short', day: 'numeric' }) ?? iso
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
function cycleAimLabel(target: CycleLensChip, dropDay: string): string {
  return target.running
    ? `→ resting until ${shortDayLabel(dropDay)} · later in ${target.name}`
    : `→ resting until ${shortDayLabel(dropDay)} · ${target.name} opens`
}

/** A cycle's span as a chip says it — `Aug 12 – Aug 26`, or `Aug 12 –` for a
 *  chapter still open at its right edge. Shared by the drag horizon's drop
 *  chips and the lens row, so the two never drift apart. */
function cycleChipText(span: { start: string; end: string; openEnded: boolean }): string {
  return span.openEnded
    ? `${shortDayLabel(span.start)} –`
    : `${shortDayLabel(span.start)} – ${shortDayLabel(span.end)}`
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
 * standing constitution asleep on its cron (it dispatches itself regardless of
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
function returnMs(card: KanbanCard, z: Zone): number | undefined {
  if (isSleepingOnSchedule(card)) return card.nextLaunchAt ? instantMs(card.nextLaunchAt) : undefined
  return dueSortMs(card.due, z)
}

/** Re-sort clusters already built by `clusterStashCards` so the dated half of
 *  Resting reads soonest-return-first — the ordering the containment-path
 *  clustering doesn't give you on its own. Cluster membership (and the
 *  warm/cold split) is untouched; only the order of clusters and the cards
 *  within each is affected. */
export function sortDatedByReturn(clusters: StashCluster[], z: Zone = hostZone()): StashCluster[] {
  const byReturn = (a: KanbanCard, b: KanbanCard): number =>
    ascByKey(returnMs(a, z), returnMs(b, z)) || byCreatedAtDesc(a, b)
  return clusters
    .map((c) => ({ ...c, cards: [...c.cards].sort(byReturn) }))
    .sort((a, b) => a.cold !== b.cold ? (a.cold ? 1 : -1) : byReturn(a.cards[0], b.cards[0]))
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
    c.cards.sort(byCreatedAtDesc)
  }
  out.sort((a, b) => {
    if (a.cold !== b.cold) return a.cold ? 1 : -1
    return byCreatedAtDesc(a.cards[0], b.cards[0])
  })
  return out
}

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
  return formatInstant(ms, { month: 'short', day: 'numeric' })
}

/** The `due <date>` chip on a card. Reads the value as the CIVIL DAY it names,
 *  the same way Chronicle places the card's due mark — otherwise one board
 *  would name two different days for one due, Thursday on the column and
 *  Wednesday on the chip. The day is said as a civil day, never re-parsed as
 *  an instant (see civilDay.ts). */
export function formatDue(iso: string): string {
  return formatCivilDay(dueCivilDay(iso), { month: 'short', day: 'numeric' }) ?? iso
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
function dayDropHorizon(resp: KanbanResponse | null, id: string): HorizonKind {
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
    const card = resp.now[kind].find((c) => c.id === id)
    if (card) return kind
  }
  for (const c of resp.timeline.past) {
    if (c.id === id) return c.tempered === false ? 'composted' : 'tempered'
  }
  return null
}

const NO_THREADS = new ThreadIndex([])
/** The response's thread graph: the one the read model built, or built once from its cards. */
export function threadIndexFor(resp: KanbanResponse | null): ThreadIndex {
  return resp ? responseThreadIndex(resp, () => boardCards(resp)) : NO_THREADS
}

/** Every card the response holds, once each. */
export function boardCards(resp: KanbanResponse | null): KanbanCard[] {
  if (!resp) return []
  const seen = new Set<string>()
  const out: KanbanCard[] = []
  for (const list of [
    ...NOW_COLUMN_ORDER.map((kind) => resp.now[kind]),
    resp.timeline.past,
    resp.timeline.futureDated,
    resp.stash,
    resp.roles,
    resp.threads ?? [],
  ]) {
    for (const card of list) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      out.push(card)
    }
  }
  return out
}

export function findCardById(resp: KanbanResponse | null, id: string): KanbanCard | null {
  if (!resp) return null
  for (const kind of NOW_COLUMN_ORDER) {
    const hit = resp.now[kind].find((c) => c.id === id)
    if (hit) return hit
  }
  // ANYTHING DRAWN MUST BE FINDABLE. Every list below reaches the screen —
  // `restingCards` joins `stash` and `timeline.futureDated`, the Roles band
  // draws `roles`, the past lane draws
  // itself — and a card that renders but resolves to
  // null here is a card whose every drag silently no-ops. Add a list to what the
  // board draws, add it here.
  for (const list of [
    resp.timeline.past,
    resp.timeline.futureDated,
    resp.stash,
    resp.roles,
    // Folded threads and quiet ancestors stay reachable through the rail and breadcrumbs.
    resp.threads ?? [],
  ]) {
    const hit = list.find((c) => c.id === id)
    if (hit) return hit
  }
  return null
}
