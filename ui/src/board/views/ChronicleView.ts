/**
 * ChronicleView (hotkey 2) — the long record: what was worked on, and for how
 * long.
 *
 * THE SHAPE. Days run left to right as calendar columns (28 back, 14 ahead);
 * fibers run top to bottom as rows. A fiber is drawn as one thin ink lifeline
 * from its birth to its close (or to today), so a week of work reads as a week
 * of horizontal extent — not as seven separate marks. Activity is inked ON that
 * line, one segment per civil day, in three restrained density steps. The page
 * is a chronicle, so nothing about the future is solid: ahead of today the row
 * carries only hollow marks for what is promised (`due:`) and what is armed
 * (`nextLaunchAt`).
 *
 * TIME KINDS. Every horizontal position on this page is a CIVIL DAY column.
 * Instants (`createdAt`, `closedAt`, `nextLaunchAt`, a bucket's `m`) are placed
 * by their LOCAL day via `isoDayLocal`; a `due:` is placed by the civil day it
 * names via `dueCivilDay`. The two never mix — see ../civilDay.ts for why that
 * distinction is load-bearing rather than pedantic. Day columns come from
 * `buildTimelineDays`, which strides by calendar day, so a 23-hour DST day is
 * still exactly one column.
 *
 * THE JOIN. An activity bucket knows a session, not a fiber; the session
 * ledger is what pairs the two, and it is the only thing consulted (`./join.js`
 * carries the whole of it). THE PAGE DRAWS FIBER ROWS
 * ONLY: a bucket the ledger cannot place is not drawn. This page is about
 * fibers, and a row named after a working directory would teach its unit
 * wrong.
 *
 * ERAS. The strip above the rows carries cycles. Two gestures make one: drag
 * across days to draw a span and name it, or press `+` to SPEAK an era — a
 * paragraph about what it is, starting today and open-ended, whose span the
 * same drag grips settle later. See {@link eraName} and `openEraComposer`.
 */

import '@ui-sdk/web/autocomplete'
import { registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import { createViewEmptyState, createViewPage } from './ViewPage.js'
import {
  buildLedgerNarration,
  type LedgerNarration,
} from './join.js'
import {
  MARK_GLYPH,
  STATE_GLYPH,
  STATE_KEY_ITEMS,
  STATE_WORD,
  diffClauseEl,
  messageClause,
  type DiffTotal,
} from './vocabulary.js'
import {
  foldActiveMinutes,
  staleOrigins,
  type ActivityBucket,
  type TemporalOrigins,
} from './TemporalData.js'
import { ChronicleFeeds } from './chronicleFeeds.js'
import { buildTimelineDays, type TimelineDay } from '../KanbanSurfaces.js'
import {
  clockTime,
  civilDaySpan,
  formatCivilDay,
  formatSpanMinutes,
  instantMs,
  isoDayLocal,
  railCivilDay,
  shiftCivilDay,
  daysBetween,
} from '../civilDay.js'
import {
  planExtension,
  windowOf,
  type DayRange,
} from './chronicleWindow.js'
import {
  fetchRecordHits,
  localHits,
  mergeHits,
  type SearchHit,
} from './chronicleSearch.js'
import { fiberDocUrl } from '../utils.js'
import {
  attributeActivity,
  buildCycleBands,
  buildRows,
  type ChronicleRow,
  clamp,
  columnIndexAtX,
  type CycleBand,
  type CycleCard,
  eraName,
  fiberBodyOf,
  firstParagraph,
  groupNarration,
  idxOfDue,
  ledgerDigest,
  type NarrationGroup,
  overlayDueEdits,
  peakSpellWork,
  type PendingCycle,
  railFrac,
  retirePendingCycles,
  rowDiffTotals,
  spellHeight,
} from './chronicleModel.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import './ChronicleView.css'

// ── Window ───────────────────────────────────────────────────────────────────

/**
 * Two different spans, and the difference is the point.
 *
 * PAST_DAYS/FUTURE_DAYS are how much chronicle EXISTS — the columns built, the
 * activity window fetched. VISIBLE_PAST_DAYS/VISIBLE_FUTURE_DAYS are how much
 * of it is on screen at rest: "two weeks is plenty to show at a time". The day
 * column is sized at render so exactly that many columns fill the viewport,
 * and the rest of the record is a horizontal scroll away.
 */
const PAST_DAYS = 28
const FUTURE_DAYS = 14
const VISIBLE_PAST_DAYS = 14
const VISIBLE_FUTURE_DAYS = 7
const VISIBLE_DAYS = VISIBLE_PAST_DAYS + VISIBLE_FUTURE_DAYS + 1

/**
 * How long the hand must rest before the record is searched.
 *
 * The local half (names, ids) never waits — it is a filter over memory. This
 * governs only the daemon's body search, which is a `felt ls --body` per store:
 * ~0.6s on the live loom, cheap enough to run per pause and far too expensive
 * to run per keystroke.
 */
const SEARCH_DEBOUNCE_MS = 250

/** Bounds on the fitted day width, so a very narrow or very wide board still
 *  gets columns a day numeral fits in and marks read at. */
const DAY_W_MIN_PX = 16
const DAY_W_MAX_PX = 56

// NO ROW CAP. A row is a label and a track plus one segment per day it was
// worked, and the drawn window holds ~90 rows against ~415 shuttle fibers in
// the whole record — a few thousand elements at the extreme of scrolling back a
// year, which is nothing a grid struggles with. The chronicle IS the record;
// asking to see all of it should not be a gesture. It scrolls.
/**
 * Where today sits across the day area on the first render. This is the same
 * statement as the visible split — 14 past of 22 visible days IS 65% — so the
 * anchor and the window agree by construction rather than by coincidence.
 */
const TODAY_ANCHOR = VISIBLE_PAST_DAYS / VISIBLE_DAYS

/** Origin for a write with no card origin behind it — a cycle being created.
 *  The board is never pinned to a remote, so such a write lands on this
 *  daemon. */
const BOARD_ORIGIN = 'local'

/** The one sentence that teaches the strip's gesture. Said in three places —
 *  the gutter's tooltip, the lane's tooltip, and the hover hint — so it cannot
 *  drift into three different descriptions of one drag. */
const ERA_HINT = 'drag across days to draw an era'

/** What the `+` in the cycle gutter promises. */
const ERA_SPEAK_HINT = 'speak a new era'

/** How long a single click on a band waits to see whether it is half of a
 *  double. The platform's own double-click window; shorter drops renames on a
 *  slower hand, longer makes entering an era feel unanswered. */
const DOUBLE_CLICK_MS = 250

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** A civil day as `14 Jul`. Said as a civil day — never `new Date` on a
 *  civil day, which reads it as UTC midnight and labels it a day early west
 *  of Greenwich. */
function prettyDay(day: string): string {
  return formatCivilDay(day, { day: 'numeric', month: 'short' }) ?? day
}

/**
 * Month bearings. A civil day is `YYYY-MM-DD`, so the first of a month is a
 * string test — no Date round trip, and therefore no timezone to get wrong.
 */
function isMonthStart(day: string): boolean {
  return day.slice(8, 10) === '01'
}

/** A civil day's month, named. `long` for the sticky bearing, `short` for the
 *  inline mark at a boundary column, which is one day-column wide. */
function monthName(day: string, style: 'long' | 'short'): string {
  return formatCivilDay(day, { month: style }) ?? day.slice(0, 7)
}

/** The month bearing for a column, with the year when it is not this one —
 *  scrolling back a year should not read as scrolling back a month. */
function monthBearing(day: string, nowYear: number): string {
  const year = Number(day.slice(0, 4))
  const name = monthName(day, 'long')
  return Number.isFinite(year) && year !== nowYear ? `${name} ${year}` : name
}

/** `left` for a mark sitting in day column `idx`. */
function colLeft(idx: number): string {
  return `calc(var(--chr-day-w) * ${idx})`
}

// ── The view ─────────────────────────────────────────────────────────────────

class ChronicleView implements TemporalView {
  readonly id = 'chronicle' as const
  readonly title = 'Chronicle'
  readonly hotkey = '2'

  private root: HTMLElement | null = null
  private body: HTMLElement | null = null
  private scroller: HTMLElement | null = null
  private ctx: ViewContext | null = null

  /** The temporal data this mount holds, and the cadence it is re-read on.
   *  Replaced on unmount, so a fetch landing afterwards stores into an
   *  instance nothing reads. */
  private feeds = new ChronicleFeeds()
  private signature = ''
  private didAnchor = false
  /** The sticky month bearing in the corner cell, and what it currently says.
   *  Held so a scroll can repaint one word without touching the grid. */
  private monthEl: HTMLElement | null = null
  /** Watches the page, not the scroller: the scroller's own width is set by the
   *  page, while its CONTENT width is what we change — observing the content
   *  side could feed back on itself. */
  private resizeObserver: ResizeObserver | null = null
  private dayWidthPx = 0

  /** The cycle being drawn right now: a live drag, or a span awaiting its name.
   *  Non-null suspends rebuilds so the gesture survives a poll. */
  /**
   * Anchors are CIVIL DAYS, never column indices. The window can grow at either
   * edge while a gesture is in flight — the gesture's own auto-scroll is what
   * reaches the edge that triggers it — and a prepend shifts every index by the
   * size of the block that arrived. A day survives that; an index does not.
   */
  private draft: { fromDay: string; toDay: string; naming: boolean } | null = null
  /** An in-place editor is open (a band rename, or the face's name/intention).
   *  Stands the poll down for the same reason `draft` does: a rebuild would
   *  take the field out from under the hand mid-word. */
  private editing = false
  /** Clicks on the face's title are ignored until this instant. An in-place
   *  editor's own open and close can emit a stray click on the element it
   *  covered, and that click must not be read as a request to open a modal. */
  private gestureLockUntil = 0
  /** Cycles created this session and not yet echoed by a poll. Held so the band
   *  appears under the cursor at once rather than up to 15s later.
   *
   *  `id` arrives with the create's own response, well before the daemon's feed
   *  carries the fiber. From that moment the band is a REAL band — see
   *  {@link PendingCycle}. */
  private pendingCycles: PendingCycle[] = []
  /** Edge drags written but not yet echoed by a poll, keyed by cycle id. Held
   *  so a dragged edge stays where it was dropped instead of snapping back for
   *  the seconds until the daemon's answer comes round. */
  private cycleEdits = new Map<string, { start?: string; due?: string }>()
  /** Renames written but not yet echoed by a poll, keyed by cycle id. Same
   *  contract as {@link cycleEdits}: held until the daemon's copy agrees. */
  private cycleNames = new Map<string, string>()
  /** Due-mark drags written but not yet echoed by a poll, keyed by fiber id —
   *  the plain-fiber twin of {@link cycleEdits}. Held so a dragged due mark
   *  stays where it was dropped instead of snapping back for the seconds
   *  until the daemon's answer comes round; see `applyDueEdits`. */
  private dueEdits = new Map<string, string>()
  /** A fiber's due mark and both cycle edges share one write gate. */
  private dateWrites = new Set<string>()
  private teardownDraw: (() => void) | null = null
  /** The day columns of the current render, so a gesture handler can convert a
   *  cursor position into a civil day without threading them through. */
  private currentDays: TimelineDay[] = []
  /**
   * The day range the chronicle currently EXISTS over. Grows at both edges as
   * the viewer scrolls (see `maybeExtend`); null until the first load, which
   * seeds it from PAST_DAYS/FUTURE_DAYS around the rail's today.
   */
  private window: DayRange | null = null
  /**
   * Pixels the next render must ADD to the restored `scrollLeft`.
   *
   * A prepend inserts columns to the left of everything on screen, displacing
   * it right by exactly that much. `render()` restores `scrollLeft` as a raw
   * pixel value, so the compensation has to be applied AT the restore or there
   * is a frame where the view sits a whole block to the left of where the hand
   * left it. Consumed once, then cleared.
   */
  private pendingScrollDelta = 0
  private autoScrollTimer: number | null = null

  /** The era being read. Non-null puts the face above the grid and dims every
   *  row that had no part in the span. */
  private scopedCycleId: string | null = null
  /** Intention lines, fetched once per cycle and kept for the mount. */
  private intentions = new Map<string, string>()
  /** The scoped span's commit trail. `span` is `id:from:to`; `key` adds the
   *  sweep it was read on, so a re-render does not re-ask, a different span
   *  does, and a new sweep re-reads the span it is showing. */
  private lookback: { span: string; key: string; groups: NarrationGroup[] } | null = null
  private lookbackInFlight: string | null = null
  /** The drawn window's commit ledger joined onto the current cards — the
   *  look-back's twin at the grain of the gutter rather than an era. Rebuilt
   *  on every paint, so a card that lands on a poll picks up its commits
   *  without a fetch. */
  private windowLedger: LedgerNarration | null = null
  /** `rowDiffTotals` for the rows currently drawn — computed once per render
   *  and read by `buildRow`, so the gutter does no joining of its own. */
  private rowDiffs: Map<string, DiffTotal> = new Map()
  private onEsc: ((e: KeyboardEvent) => void) | null = null
  private autoScrollStep = 0
  /** Per-origin freshness as of the last paint — see `ChronicleFeeds.origins`. */
  private origins: TemporalOrigins = {}

  // ── Search ────────────────────────────────────────────────────────────────
  /** The head's search box, while mounted. */
  private searchBox: { root: HTMLElementTagNameMap['ui-autocomplete']; list: HTMLElement; empty: HTMLElement; hits: Map<string, SearchHit> } | null = null
  /** What is typed, trimmed. The local half re-filters on it every keystroke. */
  private searchQuery = ''
  /** The daemon's body-search answer, and the query it answers — held together
   *  so a reply that lands after the hand moved on is never shown for the
   *  wrong words. */
  private recordHits: readonly SearchHit[] = []
  private recordHitsFor = ''
  private searchTimer: number | null = null
  /** Bumps per record search, so only the newest reply may paint. */
  private searchSeq = 0
  /** The fiber the reader jumped to. Its lifeline stays lit until another jump
   *  or a cleared search — the record is long, and a highlight that faded
   *  would leave you back where you started. */
  private foundId: string | null = null

  mount(host: HTMLElement, ctx: ViewContext): void {
    const page = createViewPage(this.title)
    this.root = page.root
    this.body = page.body
    this.ctx = ctx
    // The head's right end. `titleRow` is `space-between` with an out-of-flow
    // centre, so a third child lands at the right margin without any of the
    // three moving the others.
    const tools = document.createElement('div')
    tools.className = 'chr-tools'
    tools.append(this.buildRefresh(), this.buildSearch(ctx))
    page.titleRow.append(tools)
    host.append(page.root)

    this.onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || this.scopedCycleId === null || !this.ctx) return
      e.stopPropagation() // the board closes itself on Escape; leaving an era comes first
      this.scopeTo(null, this.ctx)
    }
    document.addEventListener('keydown', this.onEsc, true)

    // Refit the columns when the board changes width. Only the CSS variable
    // moves; every mark's position is a calc() over it, so the whole chronicle
    // rescales without a rebuild.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.fitDayWidth())
      this.resizeObserver.observe(page.body)
    }
    void this.load(ctx)
  }

  /**
   * A board poll. The cards move on every one and are repainted at once; the
   * temporal feeds are re-read on their own cadence (see ./chronicleFeeds.ts),
   * so most polls cost no request at all.
   */
  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    void this.load(ctx)
  }

  unmount(): void {
    this.feeds = new ChronicleFeeds()
    this.teardownDraw?.()
    this.teardownDraw = null
    if (this.onEsc) document.removeEventListener('keydown', this.onEsc, true)
    this.onEsc = null
    this.scopedCycleId = null
    this.intentions.clear()
    this.lookback = null
    this.lookbackInFlight = null
    this.windowLedger = null
    this.stopAutoScroll()
    this.draft = null
    this.editing = false
    this.pendingCycles = []
    this.cycleEdits.clear()
    this.dueEdits.clear()
    this.cycleNames.clear()
    this.currentDays = []
    this.window = null
    this.pendingScrollDelta = 0
    this.origins = {}
    this.monthEl = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    // A search is a question about one visit, like the era scope above it: the
    // box goes with the head that held it, and a pending debounce must not fire
    // into a torn-down view.
    this.resetSearch()
    this.searchBox = null
    this.foundId = null
    this.root?.remove()
    this.root = null
    this.body = null
    this.scroller = null
    this.ctx = null
    this.signature = ''
    this.didAnchor = false
    this.dayWidthPx = 0
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * The head's search box: one input, and a list of hits under it.
   *
   * TWO CLOCKS, ONE LIST — see ./chronicleSearch.ts for the whole of that
   * argument. Names and ids come from the cards this page is already holding
   * and re-filter on the keystroke; bodies come from the daemon, debounced,
   * and are merged into the same list when they land. Nothing about the list
   * jumps as the second half arrives: the merge sorts on one rank scale, so
   * the instant answers keep their places and the body hits fall in around
   * them.
   */
  private buildSearch(mountCtx: ViewContext): HTMLElement {
    // Every handler below reads `this.ctx`, never the context this box was
    // built with: the view is mounted once and refreshed on every poll, so a
    // closure over the mount-time context would search yesterday's cards.
    const current = (): ViewContext => this.ctx ?? mountCtx

    const box = document.createElement('ui-autocomplete')
    box.className = 'chr-search'
    box.setAttribute('filter', 'false')
    box.setAttribute('modal', 'false')
    box.setAttribute('open-on-focus', '')

    const input = document.createElement('input')
    input.type = 'search'
    input.className = 'chr-search-input'
    input.placeholder = 'search the record'
    input.setAttribute('aria-label', 'Search every constitution, body text included')

    const inputPart = document.createElement('ui-autocomplete-input')
    inputPart.append(input)
    const content = document.createElement('ui-autocomplete-content')
    content.className = 'chr-search-hits'
    content.setAttribute('align', 'end')
    content.setAttribute('side-offset', '4')
    // The SDK stashes the empty part's children while there are hits, so the
    // message and its look live in one child that survives the stash.
    const empty = document.createElement('ui-autocomplete-empty')
    const emptyText = document.createElement('span')
    emptyText.className = 'chr-search-none'
    empty.append(emptyText)
    const list = document.createElement('ui-autocomplete-list')
    content.append(empty, list)
    box.append(inputPart, content)
    const hits = new Map<string, SearchHit>()
    this.searchBox = { root: box, list, empty: emptyText, hits }
    box.addEventListener('valuechange', event => {
      if (event.detail.reason === 'item-press') {
        // Choosing a record navigates without replacing the search text.
        event.preventDefault()
        const hit = hits.get(event.detail.value)
        if (hit) this.jumpTo(hit, current())
        return
      }
      this.searchQuery = event.detail.value.trim()
      // The local half is free, so it repaints on the keystroke; the record
      // half is a shell-out, so it waits for the hand to stop.
      this.paintHits(current())
      this.scheduleRecordSearch(current())
    })
    // Hits show while there is a query and the field has focus; choosing one
    // leaves them up for the next.
    box.addEventListener('openchange', event => {
      const { value, reason } = event.detail
      if (value ? !this.searchQuery : reason === 'item-press') event.preventDefault()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      // The board closes itself on Escape and the era scope leaves on it;
      // abandoning a search comes before both.
      e.stopPropagation()
      this.clearSearch(current())
      input.blur()
    })

    return box
  }

  /** Debounced record (body) search. One in flight at a time; only the newest
   *  reply may paint, so a slow store cannot overwrite a later answer. */
  private scheduleRecordSearch(ctx: ViewContext): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
    const query = this.searchQuery
    if (query.length < 2) {
      // One letter matches most of the record and costs a full walk to say so.
      this.recordHits = []
      this.recordHitsFor = ''
      return
    }
    const seq = (this.searchSeq += 1)
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null
      void fetchRecordHits(ctx.shuttleBase, query)
        .then((hits) => {
          if (seq !== this.searchSeq || this.searchQuery !== query) return
          this.recordHits = hits
          this.recordHitsFor = query
          this.paintHits(ctx)
        })
        .catch(() => {
          // The daemon could not answer. The local half already has, and a
          // list that silently keeps working on names beats an error where
          // the answers were.
        })
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Forget the query and everything derived from it, and make sure a pending
   *  debounce cannot fire into the state that follows. */
  private resetSearch(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer)
    this.searchTimer = null
    this.searchSeq += 1
    this.searchQuery = ''
    this.recordHits = []
    this.recordHitsFor = ''
  }

  private clearSearch(ctx: ViewContext): void {
    this.resetSearch()
    if (this.searchBox) this.searchBox.root.value = ''
    this.setFound(null)
    this.paintHits(ctx)
  }

  /** Draw the merged list. Pure logic lives in ./chronicleSearch.ts; this is
   *  the DOM around it. */
  private paintHits(ctx: ViewContext): void {
    const box = this.searchBox
    if (!box) return
    box.list.replaceChildren()
    box.hits.clear()
    if (!this.searchQuery) { box.root.open = false; return }

    const boardIds = new Set(ctx.cards.map((c) => c.id))
    const record = this.recordHitsFor === this.searchQuery ? this.recordHits : []
    const hits = mergeHits(localHits(ctx.cards, this.searchQuery), record, boardIds)

    box.empty.textContent =
      this.recordHitsFor === this.searchQuery ? 'nothing in the record' : 'searching the record…'
    for (const hit of hits) {
      box.hits.set(hit.id, hit)
      box.list.append(this.buildHit(hit))
    }
  }

  private buildHit(hit: SearchHit): HTMLElement {
    const el = document.createElement('ui-autocomplete-item')
    // A choice reports its label, so the label is the id a pick jumps to.
    el.setAttribute('value', hit.id)
    el.setAttribute('label', hit.id)
    el.className = `chr-hit${hit.onBoard ? '' : ' chr-hit-off'}`

    const name = document.createElement('span')
    name.className = 'chr-hit-name'
    name.textContent = hit.name

    const id = document.createElement('span')
    id.className = 'chr-hit-id'
    id.textContent = hit.id

    el.append(name, id)

    // WHY this row is in the list. An excerpt when the words were in the body
    // or the outcome — that is the whole point of asking the daemon — and
    // otherwise nothing, because "matched on its name" is visible above.
    if (hit.excerpt) {
      const why = document.createElement('span')
      why.className = 'chr-hit-why'
      why.textContent = hit.excerpt
      el.append(why)
    }

    el.title = hit.onBoard
      ? `${hit.id} — jump to its lifeline`
      : `${hit.id} — in the record, not on this board`
    return el
  }

  /**
   * What a hit does when you pick it.
   *
   * A fiber the page is DRAWING is jumped to: its lifeline is lit and scrolled
   * into view, which is the chronicle's own answer to "where is this in the
   * record". A fiber the page holds as a card but has no row for (closed long
   * before the drawn window, most often) opens its card overlay instead — the
   * same affordance a row's name click uses, and the only one that can show a
   * fiber that is not on screen. A hit the board has never heard of can do
   * neither, and says so rather than clicking dead.
   */
  private jumpTo(hit: SearchHit, ctx: ViewContext): void {
    this.setFound(hit.id)
    if (this.scrollToFound()) return
    if (ctx.cards.some((c) => c.id === hit.id)) ctx.openCard(hit.id)
  }

  /** Light the found row, and unlight whatever was lit. Survives a re-render
   *  because `render` calls back into it once the new grid is built. */
  private setFound(id: string | null): void {
    this.foundId = id
    this.paintFound()
  }

  private paintFound(): void {
    const scroller = this.scroller
    if (!scroller) return
    for (const el of scroller.querySelectorAll('.chr-found')) el.classList.remove('chr-found')
    if (this.foundId === null) return
    for (const el of this.rowElements(this.foundId)) el.classList.add('chr-found')
  }

  /** True iff there was a row to scroll to. */
  private scrollToFound(): boolean {
    if (this.foundId === null) return false
    const [first] = this.rowElements(this.foundId)
    if (!first) return false
    // Vertical only: the horizontal position is the reader's place in TIME, and
    // taking it away to centre a row would answer a question nobody asked.
    first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    return true
  }

  private rowElements(cardId: string): HTMLElement[] {
    const scroller = this.scroller
    if (!scroller) return []
    return [...scroller.querySelectorAll<HTMLElement>(`[data-fiber="${CSS.escape(cardId)}"]`)]
  }

  /**
   * Bring the held temporal data up to what the window needs, then paint.
   * `force` re-reads every feed now rather than on the cadence.
   *
   * A load whose window was grown out from under it (a scroll extension while
   * its fetches were out) does not paint: the extension's own load wants
   * chunks this one never asked for, and paints once they land.
   */
  private async load(ctx: ViewContext, force = false): Promise<void> {
    const feeds = this.feeds
    const window = this.ensureWindow(Date.now())
    await feeds.sync(ctx, window, { force })
    if (feeds !== this.feeds || window !== this.window || !this.body) return
    this.paint(this.ctx ?? ctx)
  }

  /** The day range the chronicle exists over — its own state once scrolling
   *  has grown it; the constants only seed it. */
  private ensureWindow(nowMs: number): DayRange {
    const today = railCivilDay(nowMs)
    this.window ??= windowOf(shiftCivilDay(today, -PAST_DAYS), shiftCivilDay(today, FUTURE_DAYS))
    return this.window
  }

  /** Signature check, then at most one DOM rebuild — from held data only. */
  private paint(ctx: ViewContext): void {
    const window = this.window
    if (!window) return
    // A rebuild would tear out the half-drawn band, the naming input, or an
    // open rename under the reader's cursor. The poll's data is not worth that;
    // the next one lands 15s later and the gesture is over in seconds.
    if (this.draft !== null || this.editing) return
    // Two different "now"s, and conflating them costs half a day of activity.
    // The COLUMNS are laid out around the current rail (yesterday's date
    // before 6am); the activity reaches the real present as
    // of the last sweep.
    const nowMs = Date.now()
    const today = railCivilDay(nowMs)
    const days = buildTimelineDays(
      daysBetween(window.first, today),
      daysBetween(today, window.last),
      today,
    )
    const buckets = this.feeds.buckets(window)
    this.origins = this.feeds.origins()
    const commits = this.feeds.commits
    this.windowLedger = commits
      ? buildLedgerNarration(commits.records, ctx.cards, this.feeds.sessionIndex.bySession)
      : null

    const signature = this.signatureOf(days, buckets, ctx)
    if (signature === this.signature) return
    this.signature = signature
    this.render(ctx, days, buckets)
  }

  /** Re-read everything now — the head's ↻. The board's own feed comes along,
   *  so the cards and the temporal data land as one refresh. */
  private refetch(): void {
    const ctx = this.ctx
    if (!ctx) return
    ctx.requestRefresh()
    void this.load(ctx, true)
  }

  /** The head's ↻: a glyph, spun once per press, and nothing else. */
  private buildRefresh(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chr-refresh'
    btn.textContent = '↻'
    btn.title = 'Re-read activity, sessions and commits'
    btn.setAttribute('aria-label', 'Refresh the chronicle')
    btn.addEventListener('click', () => {
      btn.classList.remove('chr-refresh-spinning')
      void btn.offsetWidth // restart the spin on a second press
      btn.classList.add('chr-refresh-spinning')
      this.refetch()
    })
    btn.addEventListener('animationend', () => btn.classList.remove('chr-refresh-spinning'))
    return btn
  }

  /**
   * A cheap fingerprint of everything the render reads.
   *
   * THE RULE: every field that can move a mark on this page appears here. A
   * field the render reads but the signature omits is a stale render nobody
   * will attribute to caching — a fiber renamed on disk kept its old label
   * until some other field happened to change, which is exactly how that bug
   * presents. So the list below is deliberately over-inclusive and is meant to
   * be extended whenever the render learns to read something new.
   *
   * Buckets contribute their count and newest stamp, which is enough — the
   * daemon only ever appends to a window.
   */
  private signatureOf(
    days: TimelineDay[],
    buckets: readonly ActivityBucket[],
    ctx: ViewContext,
  ): string {
    let latest = 0
    for (const b of buckets) if (b.m > latest) latest = b.m
    const { response, cards } = ctx
    const parts = [
      days[0].iso,
      String(buckets.length),
      String(latest),
      `scope:${this.scopedCycleId ?? ''}`,
      `ledger:${this.feeds.sessionIndex.byTmux.size}`,
      // A remote falling behind (or catching up) mutes or un-mutes whole rows.
      `stale:${staleOrigins(this.origins).join(',')}`,
      `look:${this.lookback?.key ?? ''}:${this.lookback?.groups.length ?? 0}`,
      // A ledger arrival has to repaint the gutter, and the totals themselves
      // move within one window as the day's commits land — so the sum rides
      // along, not just the key and the size.
      `diff:${this.feeds.commits?.key ?? ''}:${ledgerDigest(this.windowLedger)}`,
      `intent:${this.scopedCycleId ? (this.intentions.get(this.scopedCycleId) ?? '') : ''}`,
      // hostLabel's last two rungs.
      response.feltHost,
    ]
    // hostLabel's first rung: a hostname that lands late must repaint the notes.
    for (const originId of Object.keys(response.staleness ?? {})) {
      parts.push(`o:${originId}=${response.staleness[originId]?.hostname ?? ''}`)
    }
    // Which surface a card sits on decides whether it gets a row at all, and
    // the server owns that routing — read the lists rather than trying to
    // re-derive them from card fields and drifting when the rules change.
    for (const list of [
      response.now.drafts,
      response.now.inFlight,
      response.now.awaitingReview,
      response.timeline.futureDated,
    ]) {
      parts.push(list.map((c) => c.id).join(','))
    }
    // The cycle strip. Its own surface, so it is invisible to the per-card loop
    // below — and a band moves with its span, not just with its existence.
    for (const c of ctx.response.cycles) {
      parts.push(`y:${c.id}|${c.name}|${c.cycleStart ?? ''}|${c.due ?? ''}`)
    }
    for (const c of cards) {
      parts.push(
        [
          c.id, // row key, openCard target
          c.name, // label
          c.status, // closed
          c.createdAt, // lifeline start, sort
          c.closedAt ?? '', // close mark, lifeline end, sort
          c.modifiedAt ?? '', // sort
          c.due ?? '', // ◴
          c.nextLaunchAt ?? '', // ◐
          c.workerState ?? '', // live flag
          c.tmuxSession ?? '', // join rung 1
          c.tempered === undefined ? '' : String(c.tempered), // ✓ vs ✗
          c.originId, // host note
          c.shuttleHost ?? '', // host note
          c.uid ?? '', // join rung 2
        ].join('|'),
      )
    }
    return fnv1a(parts.join('\n'))
  }

  private render(ctx: ViewContext, days: TimelineDay[], buckets: readonly ActivityBucket[]): void {
    const body = this.body
    if (!body) return

    const scrollLeft = this.scroller?.scrollLeft ?? 0
    const scrollTop = this.scroller?.scrollTop ?? 0
    body.replaceChildren()
    this.scroller = null
    // The corner cell went with the old body; `buildCorner` hands back a new one.
    this.monthEl = null
    // The fitted width lives as an inline variable ON the scroller, and this
    // rebuild makes a new one. Forget the cached value too, or fitDayWidth sees
    // "no change" and leaves the fresh element on the CSS fallback width.
    this.dayWidthPx = 0

    this.currentDays = days
    const dayIndex = new Map(days.map((d, i) => [d.iso, i]))
    const todayIdx = days.findIndex((d) => d.isToday)
    const lastIdx = days.length - 1
    // Lay any un-echoed due-mark drag over the served cards, retiring the
    // ones the daemon has since confirmed — see `overlayDueEdits`.
    const { cards, confirmed } = overlayDueEdits(ctx.cards, this.dueEdits)
    for (const id of confirmed) this.dueEdits.delete(id)
    const attribution = attributeActivity(buckets, cards, this.feeds.sessionIndex.byTmux)
    const resolvedTodayIdx = todayIdx < 0 ? lastIdx : todayIdx
    const rows = buildRows(
      ctx.response,
      cards,
      attribution,
      dayIndex,
      resolvedTodayIdx,
      days[resolvedTodayIdx]?.iso ?? days[lastIdx]?.iso ?? '',
      this.origins,
    )

    // Joined once for the page, not once per row: the gutter only looks up.
    this.rowDiffs = this.windowLedger ? rowDiffTotals(this.windowLedger, rows) : new Map()

    if (rows.length === 0) {
      body.append(createViewEmptyState('— no hand has passed this way —'))
      return
    }

    const peak = peakSpellWork(rows)

    const bands = this.collectBands(ctx, days, dayIndex)
    // Always at least one lane: empty, the strip is the target you draw on.
    const laneCount = Math.max(1, ...bands.map((b) => b.lane + 1))

    const scroller = document.createElement('div')
    scroller.className = 'chr-scroll'

    const grid = document.createElement('div')
    grid.className = 'chr-grid'
    grid.style.gridTemplateColumns = `var(--chr-label-w) repeat(${days.length}, var(--chr-day-w))`
    grid.style.gridTemplateRows =
      `var(--chr-head-h) repeat(${laneCount}, var(--chr-cycle-h)) repeat(${rows.length}, var(--chr-row-h))`

    grid.append(this.buildCorner(rows.length), ...this.buildHead(days))
    grid.append(...this.buildWashes(days))
    grid.append(...this.buildCycleStrip(bands, laneCount, days, ctx))
    // Fiber rows start below the cycle strip.
    const era = this.scopedCycleId === null ? null : bands.find((b) => b.id === this.scopedCycleId)
    let r = laneCount
    for (let i = 0; i < rows.length; i += 1) {
      const parts = this.buildRow(rows[i], r++, days, dayIndex, peak, ctx)
      // Dimmed, never hidden: a row with no part in the era is still part of
      // the record, and removing it would make the era look emptier than it was.
      if (era && !this.rowInSpan(rows[i], era, days)) {
        for (const el of parts) el.classList.add('chr-outside')
      }
      grid.append(...parts)
    }
    if (todayIdx >= 0) grid.append(this.buildTodaySeam(todayIdx))

    scroller.append(grid)
    if (era) {
      body.append(this.buildFace(era, days, rows, buckets, ctx))
      void this.loadIntention(era.id, ctx)
    } else if (this.scopedCycleId !== null) {
      // The era left the window (its dates moved, or it was deleted). Silently
      // stop scoping rather than showing a face for a band that is not there.
      this.scopedCycleId = null
    }
    body.append(scroller)
    body.append(this.buildKey(bands.length > 0))
    this.scroller = scroller
    // The scroller is a new element every rebuild, so the listener goes on with
    // it. Passive: extension never prevents the scroll it is reacting to.
    const onScroll = (): void => {
      this.bearMonth()
      this.maybeExtend()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    this.fitDayWidth()
    this.bearMonth()
    // The grid is new; the jump the reader made is not. Re-light it.
    this.paintFound()

    // The page opens on today. Entering an era takes the grid to it instead —
    // otherwise the face describes a span that is scrolled off the page it
    // sits above.
    const anchorIdx = era ? era.startIdx : todayIdx < 0 ? lastIdx : todayIdx

    if (this.didAnchor) {
      // `scrollLeft` was captured in pixels before the rebuild; a prepend has
      // since displaced every one of those pixels rightward. Adding the delta
      // HERE — rather than after the assignment — is what makes the extension
      // invisible instead of a lurch.
      scroller.scrollLeft = scrollLeft + this.pendingScrollDelta
      scroller.scrollTop = scrollTop
    } else {
      scroller.scrollTop = scrollTop
      // An era anchors near the left edge so the whole span reads forward
      // into the viewport; today anchors where the window's own split puts it.
      this.anchorDay(scroller, anchorIdx, era ? 0.1 : TODAY_ANCHOR)
    }
    this.pendingScrollDelta = 0
  }

  /**
   * Grow the window when a scroll reaches an edge — the whole of "continuous".
   *
   * The arithmetic is `chronicleWindow`'s and is unit-tested there; this method
   * is only the plumbing. Three things it must not do, each of which would be
   * felt immediately:
   *
   *   • It DOES stand down mid-gesture, and not for the reason you would
   *     guess. The gesture sites hold civil days now, so a widened grid can no
   *     longer corrupt their arithmetic — that hazard is gone. What remains is
   *     DOM: `installDrawToCreate` and `installEdgeDrag` close over the `track`
   *     element and their ghost, and a rebuild detaches both. `dayAt(track, x)`
   *     then measures a detached rect, the ghost paints where nobody can see
   *     it, and the naming input opens on an orphan. So an extension mid-draw
   *     would leave the gesture arithmetically correct and visually dead. Until
   *     a gesture can re-acquire its track — or extension can widen the grid
   *     without a full rebuild — auto-scroll pans within the window it has and
   *     the window grows on the NEXT SCROLL after release, not on the release
   *     itself: this method only runs from a scroll event, and mouseup is not
   *     one. Harmless, since anyone who lets go at the edge is about to scroll
   *     again, but do not go hunting for a trigger on mouseup — there isn't
   *     one, by design.
   *   • It must not re-anchor. `didAnchor` stays set, or the view would snap
   *     back to today at the moment the reader is reaching away from it.
   *   • It must not double-compensate. `fitDayWidth` also adjusts `scrollLeft`,
   *     but only when the WIDTH changes, and extension changes the extent
   *     rather than the width (the fit divides by a constant VISIBLE_DAYS).
   */
  private maybeExtend(): void {
    const scroller = this.scroller
    const ctx = this.ctx
    if (!scroller || !ctx || !this.window) return
    // A half-drawn band, an open naming input or a rename in progress would be
    // torn out by the rebuild, exactly as the poll declines to do.
    if (this.draft !== null || this.editing) return

    const plan = planExtension(
      this.window,
      {
        scrollLeft: scroller.scrollLeft,
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        dayWidthPx: this.dayWidthPx,
      },
      Date.now(),
    )
    if (!plan) return

    this.window = plan.next
    this.pendingScrollDelta = plan.scrollDelta
    // The window changed, so the signature must too — otherwise `load` sees
    // identical fiber data and declines the rebuild that grows the grid.
    this.signature = ''
    void this.load(ctx)
  }

  /**
   * Size the day column so exactly {@link VISIBLE_DAYS} of them fill the space
   * beside the label gutter — two weeks back and one forward, at rest. The
   * deeper window stays where it is, one scroll to the left.
   *
   * Scroll position is carried across in DAYS rather than pixels: after a
   * resize the reader should still be looking at the same week, not at the same
   * pixel offset into a differently-scaled record.
   */
  private fitDayWidth(): void {
    const scroller = this.scroller
    if (!scroller) return
    const available = scroller.clientWidth - this.labelWidth(scroller)
    if (available <= 0) return
    const next = clamp(available / VISIBLE_DAYS, DAY_W_MIN_PX, DAY_W_MAX_PX)
    const previous = this.dayWidthPx
    if (Math.abs(next - previous) < 0.5) return
    // Read the scroll offset BEFORE the variable moves. Narrowing the columns
    // shrinks the content, and the browser clamps scrollLeft to the new maximum
    // the moment that happens — so a read afterwards reports a position the
    // reader never chose, and the carried-over week comes out wrong.
    const previousScroll = scroller.scrollLeft
    scroller.style.setProperty('--chr-day-w', `${next.toFixed(2)}px`)
    this.dayWidthPx = next
    if (previous > 0 && previousScroll > 0) {
      scroller.scrollLeft = (previousScroll / previous) * next
    }
  }

  private labelWidth(scroller: HTMLElement): number {
    return parseFloat(getComputedStyle(scroller).getPropertyValue('--chr-label-w')) || 300
  }

  /** Real cycles plus any created this session that no poll has echoed yet. A
   *  pending one drops out the moment a real card carries its name. */
  private collectBands(
    ctx: ViewContext,
    days: TimelineDay[],
    dayIndex: Map<string, number>,
  ): CycleBand[] {
    // Cycles have their own surface — they are deliberately absent from
    // `ctx.cards`, so a cycle can never be mistaken for a piece of work.
    const served: CycleCard[] = ctx.response.cycles
    this.pendingCycles = retirePendingCycles(this.pendingCycles, served)

    // Lay any un-echoed edge drag over the served card, and retire the override
    // the moment the daemon's copy agrees with it.
    const real: CycleCard[] = served.map((c) => {
      const edit = this.cycleEdits.get(c.id)
      const renamed = this.cycleNames.get(c.id)
      if (renamed !== undefined && renamed === c.name) this.cycleNames.delete(c.id)
      if (!edit && renamed === undefined) return c
      const next = {
        ...c,
        name: renamed ?? c.name,
        cycleStart: edit?.start ?? c.cycleStart,
        due: edit?.due ?? c.due,
      }
      if (edit && next.cycleStart === c.cycleStart && next.due === c.due) this.cycleEdits.delete(c.id)
      return next
    })

    const ghosts: CycleCard[] = this.pendingCycles.map((p) => ({
      id: p.id ?? `pending:${p.name}`,
      name: p.name,
      originId: BOARD_ORIGIN,
      cycleStart: p.startDay,
      // A spoken era has no end yet: `cycleSpan` runs an open-ended cycle to
      // today, which is exactly what an era you have just entered looks like.
      due: p.endDay ?? undefined,
    }))
    const bands = buildCycleBands([...real, ...ghosts], days, dayIndex)
    // Only a cycle whose create is still IN FLIGHT is pending. Once the id has
    // come back the fiber exists, so the band takes its clicks even though the
    // feed has not come round yet.
    const unsaved = new Set(this.pendingCycles.filter((p) => p.id === undefined).map((p) => p.name))
    for (const band of bands) if (unsaved.has(band.name)) band.pending = true
    return bands
  }

  /**
   * The cycle strip: one gutter cell and one full-width lane per sub-lane, with
   * the bands positioned inside. The gutter cells matter as much as the bands —
   * column 1 is the only opaque sticky column, and a lane without one lets the
   * day washes show through where a label should be.
   */
  private buildCycleStrip(
    bands: CycleBand[],
    laneCount: number,
    days: TimelineDay[],
    ctx: ViewContext,
  ): HTMLElement[] {
    const out: HTMLElement[] = []
    for (let lane = 0; lane < laneCount; lane += 1) {
      const gutter = document.createElement('div')
      gutter.className = 'chr-cycle-gutter'
      gutter.style.gridColumn = '1'
      gutter.style.gridRow = String(lane + 2)
      // Names the strip once, on the lane nearest the headers — and says, in
      // the same breath, that the strip is something you can write on.
      if (lane === 0) {
        const tag = document.createElement('span')
        tag.className = 'chr-cycle-tag'
        tag.textContent = 'cycles'
        // The `+` opens the composer, where an era is SPOKEN rather than
        // measured. The two ways of making one answer different questions: a
        // drag across the lanes says when; the composer says what.
        const plus = document.createElement('button')
        plus.type = 'button'
        plus.className = 'chr-cycle-plus'
        plus.textContent = '+'
        plus.title = ERA_SPEAK_HINT
        plus.setAttribute('aria-label', ERA_SPEAK_HINT)
        plus.addEventListener('click', (e) => {
          e.stopPropagation()
          this.openEraComposer(ctx)
        })
        gutter.append(tag, plus)
        gutter.title = ERA_HINT
      }
      out.push(gutter)

      const last = lane === laneCount - 1
      if (last) gutter.classList.add('chr-cycle-last')

      const track = document.createElement('div')
      track.className = `chr-cycle-lane${last ? ' chr-cycle-last' : ''}`
      track.style.gridColumn = `2 / span ${days.length}`
      track.style.gridRow = String(lane + 2)
      track.dataset.lane = String(lane)
      track.title = ERA_HINT
      this.installDrawToCreate(track, ctx)
      out.push(track)
    }

    // The invitation. It rides the LAST lane always — not only on an empty
    // strip, or the one gesture on this page that creates something would be
    // undiscoverable the moment you had a single cycle — right-aligned out of
    // the bands' way, and fades in when the cursor is over the strip. On an
    // empty strip it is centered, because there is nothing to keep clear of.
    const hint = document.createElement('div')
    hint.className = `chr-cycle-hint${bands.length === 0 ? ' chr-cycle-hint-empty' : ''}`
    hint.textContent = bands.length === 0 ? `· ${ERA_HINT} ·` : `· ${ERA_HINT}`
    out[(laneCount - 1) * 2 + 1]?.append(hint)

    for (const band of bands) {
      const lane = out[band.lane * 2 + 1]
      if (lane) lane.append(this.buildBand(band, ctx))
    }
    return out
  }

  /** Enter or leave an era. One at a time — overlapping cycles are read one
   *  after another, because "which era is this row part of" has no answer when
   *  two are open at once. */
  private scopeTo(id: string | null, ctx: ViewContext): void {
    this.scopedCycleId = this.scopedCycleId === id ? null : id
    this.lookback = null
    this.signature = ''
    this.didAnchor = false // re-anchor on the era, or back on today when leaving
    void this.load(ctx)
  }

  /**
   * The face: what this era was for, what it cost, and what came of it.
   *
   * Parchment, not a dashboard — one head line, a row of quiet figures, and a
   * memoir composed from the commit trail. Everything here is derived from data
   * already on the page except the intention line and the commits, which are
   * fetched once per era.
   */
  private buildFace(
    band: CycleBand,
    days: TimelineDay[],
    rows: ChronicleRow[],
    buckets: readonly ActivityBucket[],
    ctx: ViewContext,
  ): HTMLElement {
    const face = document.createElement('section')
    face.className = 'chr-face'

    const fromDay = days[band.startIdx].iso
    const toDay = days[band.endIdx].iso
    const [fromMs, toMs] = civilDaySpan(fromDay, toDay)
    const spanDays = band.endIdx - band.startIdx + 1
    const future = fromMs > Date.now()

    // ── head ────────────────────────────────────────────────────────────────
    const head = document.createElement('div')
    head.className = 'chr-face-head'
    const title = document.createElement('button')
    title.type = 'button'
    title.className = 'chr-face-title'
    title.textContent = band.name
    title.title = 'Open this cycle’s fiber · double-click to rename'
    // Same two readings as the band: a click opens the document, a double-click
    // edits the one line of it that is on this page.
    // Opening the fiber is not idempotent the way entering an era is — it puts
    // a modal over the page — so this one has to tell a single click from half
    // of a double. The wait is the double-click window, and the lock covers the
    // stray click a closing editor can emit after it.
    let titleClick: number | null = null
    title.addEventListener('click', () => {
      if (titleClick !== null || this.editing || Date.now() < this.gestureLockUntil) return
      titleClick = window.setTimeout(() => {
        titleClick = null
        if (!this.editing && Date.now() >= this.gestureLockUntil) ctx.openCard(band.id)
      }, DOUBLE_CLICK_MS)
    })
    title.addEventListener('dblclick', (e) => {
      e.preventDefault()
      if (titleClick !== null) window.clearTimeout(titleClick)
      titleClick = null
      this.openBandRename(head, title, band, ctx, 'chr-face-rename')
    })
    const when = document.createElement('span')
    when.className = 'chr-face-span'
    when.textContent = `${prettyDay(fromDay)} – ${prettyDay(toDay)} · ${spanDays}d${band.openEnd ? ' · running' : ''}`
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'chr-face-close'
    close.textContent = '✕'
    close.title = 'Leave this era (Esc)'
    close.addEventListener('click', () => this.scopeTo(null, ctx))
    head.append(title, when, close)
    face.append(head)

    // The intention, or the invitation to write one. A drawn era has no body —
    // the drag asks when, not what — and a face that simply omitted the line
    // read as a face that had failed to load. Saying the era is unwritten, and
    // where to write it, is the honest version of the same silence.
    const intent = this.intentions.get(band.id)
    if (intent) {
      const line = document.createElement('p')
      line.className = 'chr-face-intent'
      line.textContent = intent
      line.title = 'Double-click to write this era’s intention'
      line.addEventListener('dblclick', () => void this.openIntentionEditor(face, line, band, ctx))
      face.append(line)
    } else if (!band.pending) {
      const invite = document.createElement('button')
      invite.type = 'button'
      invite.className = 'chr-face-intent chr-face-intent-empty'
      invite.textContent = 'no intention written — click to say what this era is for'
      invite.title = 'Write this era’s intention'
      invite.addEventListener('click', () => void this.openIntentionEditor(face, invite, band, ctx))
      face.append(invite)
    }

    // ── figures ─────────────────────────────────────────────────────────────
    const inSpan = (idx: number | null): boolean =>
      idx !== null && idx >= band.startIdx && idx <= band.endIdx
    const touched = rows.filter((r) => this.rowInSpan(r, band, days)).length
    const faceDayIndex = new Map(days.map((d, i) => [d.iso, i]))
    const dues = ctx.cards.filter((c) => inSpan(idxOfDue(c.due, faceDayIndex))).length
    const closed = ctx.cards.filter((c) => {
      const ms = instantMs(c.closedAt)
      return ms !== undefined && ms >= fromMs && ms <= toMs
    })

    const stats = document.createElement('dl')
    stats.className = 'chr-face-stats'
    const stat = (label: string, value: string): void => {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = value
      stats.append(dt, dd)
    }
    stat('fibers touched', String(touched))
    stat('dues inside', String(dues))
    stat('closed', String(closed.length))
    // `toMs` is inclusive here and the fold's span is half-open, hence `+ 1`.
    const spend = foldActiveMinutes(buckets, { fromMs, toMs: toMs + 1 })
    // Human presence is counted in MESSAGES, not minutes. Nobody remembers an
    // era as forty minutes of steering; they remember how many times they came
    // back to it. So the two sides of the ledger are measured differently on
    // purpose — the human in turns taken, the machine in wall-clock.
    let sent = 0
    let received = 0
    for (const b of buckets) {
      // Half-open, same convention as the fold two lines up.
      if (b.m < fromMs || b.m >= toMs + 1) continue
      if (b.k === 'attention') sent += b.n
      else if (b.k === 'reply') received += b.n
    }
    stat('you', sent === 0 && received === 0 ? '—' : messageClause(sent, received))
    stat('agents', formatSpanMinutes(spend.agent, { empty: '—' }))
    face.append(stats)

    // ── the look back ───────────────────────────────────────────────────────
    // The memoir names fibers twice — once per commit group, once per close —
    // and both namings are the door to the fiber.
    const openBtn = (id: string, name: string, extra?: string): HTMLButtonElement => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = extra ? `${extra} chr-face-open` : 'chr-face-open'
      btn.textContent = name
      btn.title = `Open ${name}`
      btn.addEventListener('click', () => ctx.openCard(id))
      return btn
    }

    const memoir = document.createElement('div')
    memoir.className = 'chr-face-memoir'
    const memoirHead = document.createElement('h3')
    memoirHead.className = 'chr-face-memoir-head'
    memoirHead.textContent = 'the look back'
    memoir.append(memoirHead)

    const span = `${band.id}:${fromDay}:${toDay}`
    const key = `${span}@${this.feeds.sweptAt}`
    if (future) {
      memoir.append(this.memoirEmpty('— not yet lived —'))
    } else if (this.lookback?.span === span) {
      // A trail read on an earlier sweep stays up while the new one is asked.
      if (this.lookback.key !== key) void this.loadLookback(span, key, fromMs, toMs, ctx)
      const groups = this.lookback.groups
      if (groups.length === 0 && closed.length === 0) {
        memoir.append(this.memoirEmpty('— the era left no trail —'))
      } else {
        for (const group of groups) {
          const line = document.createElement('p')
          line.className = 'chr-face-line'
          // The ledger named the fiber, so the name opens it — no guessing.
          const fiber = openBtn(group.cardId, group.name, 'chr-face-fiber')
          const count = document.createElement('span')
          count.className = 'chr-face-count'
          count.textContent = `×${group.count}`
          line.append(fiber, count)
          // Beside the count, not after the prose: both are figures about the
          // same commits, and the subjects are a variable-length sentence that
          // would leave the numbers floating at a different place on every
          // line. Kept together, the eye reads "×7 +512 −208" as one clause and
          // then the prose. A group whose ledger recorded nothing prints none.
          const diffEl = diffClauseEl(group.insertions, group.deletions)
          if (diffEl) {
            diffEl.classList.add('chr-face-diff')
            line.append(diffEl)
          }
          line.append(document.createTextNode(` ${group.subjects.join('; ')}`))
          memoir.append(line)
        }
        for (const card of closed) {
          const line = document.createElement('p')
          line.className = 'chr-face-line chr-face-closed'
          const mark = document.createElement('span')
          mark.className = card.tempered === false ? 'chr-face-mark-x' : 'chr-face-mark-ok'
          mark.textContent = card.tempered === false ? '✗' : '✓'
          // A fiber the era closed is named here and nowhere else on the face —
          // so this is where you reach it. The whole name is the target; the
          // verdict mark stays a mark.
          const open = openBtn(card.id, card.name)
          line.append(mark, document.createTextNode(' '), open)
          memoir.append(line)
        }
      }
    } else {
      memoir.append(this.memoirEmpty('gathering the trail…'))
      void this.loadLookback(span, key, fromMs, toMs, ctx)
    }
    face.append(memoir)

    if (!future) {
      const inscribe = document.createElement('button')
      inscribe.type = 'button'
      inscribe.className = 'chr-face-inscribe'
      inscribe.textContent = 'inscribe this review'
      inscribe.addEventListener('click', () => {
        inscribe.disabled = true
        inscribe.textContent = 'inscribing…'
        void this.inscribeReview(band, memoir, ctx).then(
          () => {
            inscribe.textContent = 'inscribed'
          },
          () => {
            inscribe.disabled = false
            inscribe.textContent = 'could not inscribe'
          },
        )
      })
      face.append(inscribe)
    }
    return face
  }

  private memoirEmpty(text: string): HTMLElement {
    const el = document.createElement('p')
    el.className = 'chr-face-quiet'
    el.textContent = text
    return el
  }

  /** Did this row take any part in the era — work inside it, or something due? */
  private rowInSpan(row: ChronicleRow, band: CycleBand, days: TimelineDay[]): boolean {
    if (row.dueIdx !== null && row.dueIdx >= band.startIdx && row.dueIdx <= band.endIdx) return true
    for (let i = band.startIdx; i <= band.endIdx; i += 1) {
      const cell = row.days.get(days[i].iso)
      if (cell && (cell.agent > 0 || cell.attention > 0)) return true
    }
    return false
  }

  /** The scoped era's commit trail, joined through the held session ledger. */
  private async loadLookback(
    span: string,
    key: string,
    fromMs: number,
    toMs: number,
    ctx: ViewContext,
  ): Promise<void> {
    if (this.lookbackInFlight === key) return
    this.lookbackInFlight = key
    try {
      const commits = await ctx.commits(fromMs, toMs)
      if (this.scopedCycleId === null) return
      const ledger = buildLedgerNarration(commits.records, ctx.cards, this.feeds.sessionIndex.bySession)
      this.lookback = { span, key, groups: groupNarration(ledger, ctx.cards) }
      this.repaintNow()
    } finally {
      if (this.lookbackInFlight === key) this.lookbackInFlight = null
    }
  }

  /** The intention line, read once from the cycle fiber's body. */
  private async loadIntention(id: string, ctx: ViewContext): Promise<void> {
    if (this.intentions.has(id)) return
    this.intentions.set(id, '') // claim it, so a re-render does not re-ask
    try {
      const text = firstParagraph(fiberBodyOf(await getDaemonJson(`${fiberDocUrl(ctx.shuttleBase, id)}?body=1`)))
      if (!text) return
      this.intentions.set(id, text)
      this.repaintNow()
    } catch {
      // No intention line is a fine outcome; the face stands without one.
    }
  }

  /**
   * Rename a band in place. The name becomes an input sitting exactly where it
   * was, so the gesture never moves the reader's eye — the same discipline the
   * naming-a-new-cycle input follows.
   */
  private openBandRename(
    host: HTMLElement,
    label: HTMLElement,
    band: CycleBand,
    ctx: ViewContext,
    className = 'chr-band-rename',
  ): void {
    if (host.querySelector('.chr-band-rename, .chr-face-rename')) return
    const input = document.createElement('input')
    input.type = 'text'
    input.className = className
    input.value = band.name
    label.style.visibility = 'hidden'
    host.append(input)
    this.editInPlace(input, {
      commit: (value) => void this.renameCycle(band, value, ctx),
      done: () => {
        input.remove()
        label.style.visibility = ''
      },
    })
  }

  /**
   * Write the era's intention from the face.
   *
   * The editor opens on the WHOLE body, read fresh, because felt's `--body` is
   * a destructive overwrite — see {@link writeIntention}. So the field may hold
   * more than the one paragraph the face displays, and that is the point: what
   * you send back is everything the fiber had.
   */
  private async openIntentionEditor(
    face: HTMLElement,
    line: HTMLElement,
    band: CycleBand,
    ctx: ViewContext,
  ): Promise<void> {
    if (face.querySelector('.chr-face-intent-edit')) return
    const field = document.createElement('textarea')
    field.className = 'chr-face-intent-edit'
    field.rows = 4
    field.placeholder = 'what this era is for — its goal, what drives it, what constrains it'
    // Claim the slot before the read, so a slow daemon cannot leave the reader
    // clicking a line that is already becoming an editor.
    line.replaceWith(field)
    this.editing = true
    try {
      field.value = await this.readBody(band.id, ctx)
    } catch {
      // An unreadable body would make the write a silent erasure. Put the line
      // back and say nothing was lost.
      this.editing = false
      field.replaceWith(line)
      window.console.error('[chronicle] could not read the cycle body to edit it')
      return
    }
    this.editing = false // editInPlace claims it for the edit proper
    this.editInPlace(field, {
      commit: (value) => {
        void this.writeIntention(band, value, ctx).catch((err: unknown) => {
          window.console.error('[chronicle] could not write the intention', err)
        })
      },
      done: () => field.replaceWith(line),
    })
  }

  /**
   * The one contract every in-place editor on this page keeps: Enter commits,
   * Escape abandons, blur commits what is there, and the page stands down from
   * rebuilding until it is over.
   *
   * That last part is not a nicety. A poll rebuilds the whole grid, and a
   * rebuild under an open editor tears the element out from under the hand
   * mid-word — the same hazard `this.draft` guards for the drag gestures.
   */
  private editInPlace(
    field: HTMLInputElement | HTMLTextAreaElement,
    { commit, done }: { commit: (value: string) => void; done: () => void },
  ): void {
    this.editing = true
    this.gestureLockUntil = Date.now() + DOUBLE_CLICK_MS
    field.focus()
    field.select()
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      this.editing = false
      this.gestureLockUntil = Date.now() + DOUBLE_CLICK_MS
      done()
      if (value !== null) commit(value)
      else if (this.ctx) void this.load(this.ctx)
    }
    // Typed by hand: `field` is a union of two element types, so the overload
    // resolution hands the listener a bare Event.
    field.addEventListener('keydown', (raw: Event) => {
      const e = raw as KeyboardEvent
      // Enter commits — except in a textarea, where it is a newline and the
      // commit is Cmd/Ctrl-Enter. Prose gets to have paragraphs.
      const enterCommits = field instanceof HTMLInputElement || e.metaKey || e.ctrlKey
      if (e.key === 'Enter' && enterCommits) {
        e.preventDefault()
        finish(field.value)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
      e.stopPropagation() // the board's own hotkeys must not eat the typing
    })
    field.addEventListener('blur', () => finish(field.value))
  }

  /**
   * Rename a cycle — the band's own name, written where it lives.
   *
   * The new name is held locally until a poll agrees with it, for the same
   * reason an edge drag is: the feed is polled, and a name that snapped back
   * to the old one for a poll interval would read as a rename that failed.
   *
   * `name` is felt-NATIVE, so it goes through `felt-edit`'s own `name` key —
   * `set` refuses native keys, which is why the daemon grew one.
   */
  private async renameCycle(band: CycleBand, next: string, ctx: ViewContext): Promise<void> {
    const name = next.trim()
    if (!name || name === band.name) return
    this.cycleNames.set(band.id, name)
    // A ghost is renamed in place too, or the retirement match (by name, for a
    // create still in flight) would look for a name nothing carries.
    for (const p of this.pendingCycles) if (p.id === band.id || p.name === band.name) p.name = name
    this.repaintNow()
    try {
      await this.feltEdit(ctx, { fiber_id: band.id, origin: band.originId, name })
      ctx.requestRefresh()
    } catch (err) {
      // Put the old name back rather than leave the strip claiming a rename the
      // store never took.
      this.cycleNames.delete(band.id)
      this.repaintNow()
      window.console.error('[chronicle] could not rename cycle', err)
    }
  }

  /**
   * Write an era's intention — the fiber's body, which is where the face reads
   * it from.
   *
   * felt's `--body` is a DESTRUCTIVE overwrite, so the editor opens on the
   * WHOLE body, freshly read, and sends the whole of it back. Editing only the
   * first paragraph (which is all the face displays) and writing that would
   * silently delete everything under it.
   */
  private async writeIntention(band: CycleBand, body: string, ctx: ViewContext): Promise<void> {
    await this.feltEdit(ctx, { fiber_id: band.id, origin: band.originId, body })
    this.intentions.set(band.id, firstParagraph(body))
    this.repaintNow()
    ctx.requestRefresh()
  }

  /** Drop the render signature and repaint from the store as it now stands —
   *  how every optimistic edit and its rollback reach the surface. */
  private repaintNow(): void {
    this.signature = ''
    if (this.ctx) void this.load(this.ctx)
  }

  /** Every Chronicle write goes out as one owner-routed `felt-edit` POST;
   *  the throw is what each caller's own catch (or lack of one) hangs on. */
  private async feltEdit(ctx: ViewContext, payload: object): Promise<void> {
    await postDaemonJson(ctx.shuttleBase, '/api/v1/felt-edit', payload, 'felt-edit failed')
  }

  /** The fiber's body as it stands right now — what the intention editor opens
   *  on, so a write can send back everything it did not change. */
  private async readBody(id: string, ctx: ViewContext): Promise<string> {
    return fiberBodyOf(await getDaemonJson(`${fiberDocUrl(ctx.shuttleBase, id)}?body=1`, 'fiber read failed')) ?? ''
  }

  /**
   * Write the composed memoir onto the cycle fiber so the era keeps it.
   *
   * `outcome` is the era's LATEST READING and is replaced, never appended —
   * felt's own convention for that field. The intention is not lost: it lives
   * in the body, which is where the face reads it from.
   */
  private async inscribeReview(
    band: CycleBand,
    memoir: HTMLElement,
    ctx: ViewContext,
  ): Promise<void> {
    const text = [...memoir.querySelectorAll('.chr-face-line')]
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ')
    if (!text) throw new Error('nothing to inscribe')
    const origin = band.originId
    await this.feltEdit(ctx, { fiber_id: band.id, origin, set: { outcome: text } })
    ctx.requestRefresh()
  }

  /** The gold "now" line, as its own element so nothing can interrupt it. */
  private buildTodaySeam(todayIdx: number): HTMLElement {
    const seam = document.createElement('div')
    seam.className = 'chr-seam'
    seam.style.gridColumn = String(todayIdx + 2)
    seam.style.gridRow = '2 / -1'
    return seam
  }

  private buildBand(band: CycleBand, ctx: ViewContext): HTMLElement {
    const el = document.createElement('button')
    el.type = 'button'
    const classes = ['chr-band']
    if (band.openStart) classes.push('chr-band-open-start')
    if (band.openEnd) classes.push('chr-band-open-end')
    if (band.pending) classes.push('chr-band-pending')
    el.className = classes.join(' ')
    el.style.left = colLeft(band.startIdx)
    el.style.width = `calc(var(--chr-day-w) * ${band.endIdx - band.startIdx + 1})`
    const label = document.createElement('span')
    label.className = 'chr-band-label'
    label.textContent = band.name
    el.append(label)
    el.title = band.pending
      ? `${band.name} — saving…`
      : `${band.name} — enter this era · double-click to rename`
    if (band.id === this.scopedCycleId) el.classList.add('chr-band-scoped')
    if (!band.pending) {
      // The band means "enter this era". Opening the fiber lives on the face's
      // own title, so the two readings of a cycle — the span and the document —
      // each have their own gesture instead of competing for one click.
      //
      // A click ENTERS the era; it does not toggle. That is what lets the same
      // band also carry a double-click rename: a double-click is two clicks,
      // and against a toggle the second one leaves the era it just entered —
      // which is exactly the defect this replaced, made worse by browsers that
      // emit a stray third click as the editor opens. Entering is idempotent,
      // so any number of clicks means the same thing. Leaving keeps its two
      // deliberate ways out, the face's ✕ and Escape.
      // Same defer as the face title: entering scopes the band away and
      // load() can replace this node before the second click of a
      // double-click lands, so the click must wait out the double-click
      // window before it commits — otherwise a rename attempt loses its
      // dblclick to a click #1 that already scoped in and reloaded.
      let bandClick: number | null = null
      el.addEventListener('click', () => {
        if (bandClick !== null || this.editing || this.scopedCycleId === band.id) return
        bandClick = window.setTimeout(() => {
          bandClick = null
          if (!this.editing && this.scopedCycleId !== band.id) this.scopeTo(band.id, ctx)
        }, DOUBLE_CLICK_MS)
      })
      el.addEventListener('dblclick', (e) => {
        e.preventDefault()
        if (bandClick !== null) window.clearTimeout(bandClick)
        bandClick = null
        this.openBandRename(el, label, band, ctx)
      })
      // Only a saved cycle can be reshaped — there is nothing on disk to write
      // an edge to until the create has come back.
      for (const edge of ['start', 'due'] as const) {
        const grip = document.createElement('span')
        grip.className = `chr-grip chr-grip-${edge}`
        grip.dataset.edge = edge
        el.append(grip)
        this.installEdgeDrag(grip, el, band, edge, ctx)
      }
    }
    return el
  }

  /**
   * The document-level half of a drag gesture, shared by the three that have
   * one (edge, due mark, draw-to-create).
   *
   * The listeners go on the DOCUMENT, not the element: a drag that leaves the
   * grid must still track and still commit. The returned detach is also parked
   * on `this.teardownDraw` so `unmount()` can end a gesture mid-flight, and it
   * runs before the caller's `onUp` so an up-handler can never re-enter.
   */
  private beginDrag(
    onMove: (ev: MouseEvent) => void,
    onUp: (ev: MouseEvent) => void,
  ): () => void {
    const detach = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', up)
      this.stopAutoScroll()
    }
    const up = (ev: MouseEvent): void => {
      detach()
      onUp(ev)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', up)
    this.teardownDraw = detach
    return detach
  }

  /**
   * Drag a band's edge to move its `start:` or its `due:`.
   *
   * The band is repainted from the cursor as it moves, so the gesture reads as
   * pulling the span rather than as a request that a later poll might honour.
   * The write goes out once, on release.
   *
   * Like the draw gesture, this one closes over DOM that a rebuild replaces, so
   * `this.draft` stands down both the poll and the window extension for its
   * duration — see {@link installDrawToCreate} for why the civil-day anchors
   * are not enough on their own.
   */
  private installEdgeDrag(
    grip: HTMLElement,
    bandEl: HTMLElement,
    band: CycleBand,
    edge: 'start' | 'due',
    ctx: ViewContext,
  ): void {
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation() // not a click on the band, and not a new draw
      if (this.dateWrites.has(band.id)) return

      const lane = bandEl.parentElement
      const days = this.currentDays
      if (!lane || days.length === 0) return
      const originStart = days[band.startIdx].iso
      const originEnd = days[band.endIdx].iso
      let fromDay = originStart
      let toDay = originEnd
      this.draft = { fromDay, toDay, naming: false }
      bandEl.classList.add('chr-band-resizing')

      const paint = (): void => {
        const span = this.spanColumns(fromDay, toDay)
        if (!span) return
        bandEl.style.left = colLeft(span.lo)
        bandEl.style.width = `calc(var(--chr-day-w) * ${span.hi - span.lo + 1})`
      }

      const onMove = (ev: MouseEvent): void => {
        const day = this.dayAt(lane, ev.clientX)
        if (day !== null) {
          // An edge may not cross its partner; it stops at a one-day span.
          if (edge === 'start') fromDay = day > toDay ? toDay : day
          else toDay = day < fromDay ? fromDay : day
        }
        this.draft = { fromDay, toDay, naming: false }
        paint()
        this.autoScrollAt(ev.clientX)
      }
      const onUp = (): void => {
        this.teardownDraw = null
        this.draft = null
        bandEl.classList.remove('chr-band-resizing')
        const dropped = edge === 'start' ? fromDay : toDay
        // `originalDay`, not `origin`: in this file `origin` is the daemon a
        // write routes to, never the day the edge started on.
        const originalDay = edge === 'start' ? originStart : originEnd
        if (dropped !== originalDay) void this.writeCycleEdge(band, edge, dropped, ctx)
      }
      this.beginDrag(onMove, onUp)
    })
  }

  /** One `felt-edit` per dropped edge. `start:` is opaque frontmatter and rides
   *  `set`; `due` is felt-native and has its own field on the endpoint. */
  private async writeCycleEdge(
    band: CycleBand,
    edge: 'start' | 'due',
    day: string,
    ctx: ViewContext,
  ): Promise<void> {
    const id = band.id
    if (this.dateWrites.has(id)) return
    this.dateWrites.add(id)
    const previous = this.cycleEdits.get(id)
    this.cycleEdits.set(id, { ...previous, [edge]: day })
    this.repaintNow()

    // The CARD's origin, not the board's: a remote-owned cycle has to be
    // written where it lives, and same-host the two happen to agree.
    const origin = band.originId
    const payload =
      edge === 'start'
        ? { fiber_id: id, origin, set: { start: day } }
        : { fiber_id: id, origin, due: day }
    try {
      await this.feltEdit(ctx, payload)
      ctx.requestRefresh()
    } catch (err) {
      // Snap back rather than leave the band somewhere the fiber is not.
      if (previous) this.cycleEdits.set(id, previous)
      else this.cycleEdits.delete(id)
      this.repaintNow()
      window.console.error('[chronicle] could not move cycle edge', err)
    } finally {
      this.dateWrites.delete(id)
    }
  }

  /**
   * Drag a row's due mark to reschedule it — the plain-fiber twin of
   * {@link installEdgeDrag}, over a single point instead of two. `nextLaunchAt`
   * gets no such handler: it is Shuttle's own computation of a standing
   * role's next run (`shuttle.resolved.next_due`), not a value a
   * fiber's frontmatter carries, so there is nothing for a drag to write.
   *
   * A drag threshold is unnecessary rather than missing: a plain click drags
   * zero columns, so `dropped === originDay` and `writeDue` never fires — the
   * mark had no click behavior to protect in the first place (see the CSS:
   * `.chr-mark` is `pointer-events: none` by default, and only `.chr-due`
   * opts back in for this gesture).
   *
   * Escape reverts the mark to its origin column and ends the gesture without
   * writing, mirroring {@link openNameInput}'s own Escape-abandons. Releasing
   * outside the scroller does the same — a "drop outside cancels" rule a
   * mouse-position check gives for free where HTML5 drag-and-drop would have
   * gotten it natively.
   */
  private installDueMarkDrag(mark: HTMLElement, row: ChronicleRow, ctx: ViewContext): void {
    const cardId = row.cardId
    if (!cardId) return
    mark.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation() // not a click on the row, and not a new cycle draw
      if (this.dateWrites.has(cardId)) return

      const track = mark.parentElement
      const days = this.currentDays
      if (!track || days.length === 0 || row.dueIdx === null) return
      const originDay = days[row.dueIdx].iso
      let day = originDay
      this.draft = { fromDay: day, toDay: day, naming: false }
      mark.classList.add('chr-mark-dragging')

      const paint = (): void => {
        const idx = this.currentDays.findIndex((d) => d.iso === day)
        if (idx >= 0) mark.style.left = colLeft(idx)
      }

      const onMove = (ev: MouseEvent): void => {
        const next = this.dayAt(track, ev.clientX)
        if (next !== null) day = next
        this.draft = { fromDay: day, toDay: day, naming: false }
        paint()
        this.autoScrollAt(ev.clientX)
      }
      const cleanup = (): void => {
        endGesture()
        this.teardownDraw = null
        this.draft = null
        mark.classList.remove('chr-mark-dragging')
      }
      const onUp = (ev: MouseEvent): void => {
        const scrollerRect = this.scroller?.getBoundingClientRect()
        const droppedOutside =
          scrollerRect !== undefined &&
          (ev.clientX < scrollerRect.left ||
            ev.clientX > scrollerRect.right ||
            ev.clientY < scrollerRect.top ||
            ev.clientY > scrollerRect.bottom)
        cleanup()
        if (droppedOutside || day === originDay) {
          paint() // snap the mark back to where it actually is
          return
        }
        void this.writeDue(cardId, row.originId, day, ctx)
      }
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        day = originDay
        cleanup()
        paint()
      }
      const detach = this.beginDrag(onMove, onUp)
      document.addEventListener('keydown', onKey, true)
      // Escape is this gesture's own extra listener, so it comes off on both
      // ways out: the caller's cleanup and unmount's teardown.
      const endGesture = (): void => {
        detach()
        document.removeEventListener('keydown', onKey, true)
      }
      this.teardownDraw = endGesture
    })
  }

  /**
   * POST the dropped date through the SAME endpoint the Desk's own due edits
   * use (`/api/v1/felt-edit`, owner-routed by `origin`) — see `setSurface` in
   * KanbanModal.ts, and {@link writeCycleEdge} for this file's other caller of
   * it. No new write path: a fiber's `due:` has exactly one door, and this
   * drag knocks on it the same way a date-column drop already does.
   */
  private async writeDue(
    cardId: string,
    originId: string | undefined,
    day: string,
    ctx: ViewContext,
  ): Promise<void> {
    if (this.dateWrites.has(cardId)) return
    this.dateWrites.add(cardId)
    const previous = this.dueEdits.get(cardId)
    this.dueEdits.set(cardId, day)
    this.repaintNow()

    const origin = originId ?? BOARD_ORIGIN
    try {
      await this.feltEdit(ctx, { fiber_id: cardId, origin, due: day })
      ctx.requestRefresh()
    } catch (err) {
      // Snap back rather than leave the mark somewhere the fiber is not.
      if (previous !== undefined) this.dueEdits.set(cardId, previous)
      else this.dueEdits.delete(cardId)
      this.repaintNow()
      window.console.error('[chronicle] could not move due date', err)
    } finally {
      this.dateWrites.delete(cardId)
    }
  }

  /**
   * Drag horizontally across an empty stretch of a lane to draw a cycle.
   *
   * The move/up listeners go on the DOCUMENT, not the lane: a drag that leaves
   * the strip — upward past the headers, or off the right edge — must still
   * track and still commit, and a lane-scoped listener would drop it silently
   * mid-gesture.
   *
   * A GESTURE CANNOT SURVIVE A REBUILD, and that is why `this.draft` is a
   * stand-down signal for everything that rebuilds — `load()` returns early on
   * it, and so does the window extension. The anchors are civil days, so the
   * ARITHMETIC would survive a prepend; the DOM would not. This handler closes
   * over its lane and its ghost, and `render()` replaces both, so a rebuild
   * mid-drag leaves the gesture measuring a detached rect and painting a ghost
   * nobody can see — right in the data, invisible on the page, which is worse
   * than either failure alone.
   *
   * The accepted consequence: auto-scroll pans within the window it started
   * with, and reaching the far edge stops rather than growing the record. The
   * window grows on the next scroll after release. Making the growth continuous
   * needs the ghost to outlive a rebuild, and there is no stable parent for it
   * — `render()` clears the whole page body — so it would have to hang off the
   * page root in viewport coordinates and track scrolling itself. Three moving
   * parts to convert a correct restriction into a fragile capability.
   */
  private installDrawToCreate(track: HTMLElement, ctx: ViewContext): void {
    track.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      // A press on an existing band is a click on that band, not a new draw.
      if ((e.target as HTMLElement).closest('.chr-band, .chr-cycle-name')) return
      e.preventDefault()

      const anchor = this.dayAt(track, e.clientX)
      if (anchor === null) return
      this.draft = { fromDay: anchor, toDay: anchor, naming: false }

      const ghost = document.createElement('div')
      ghost.className = 'chr-band chr-band-ghost'
      track.append(ghost)
      // Days in, columns out, every frame — so the ghost follows the grid it is
      // drawn on even if that grid grew a block since the drag began.
      const paint = (): void => {
        if (!this.draft) return
        const span = this.spanColumns(this.draft.fromDay, this.draft.toDay)
        if (!span) return
        ghost.style.left = colLeft(span.lo)
        ghost.style.width = `calc(var(--chr-day-w) * ${span.hi - span.lo + 1})`
      }
      paint()

      const onMove = (ev: MouseEvent): void => {
        if (!this.draft || this.draft.naming) return
        const day = this.dayAt(track, ev.clientX)
        if (day !== null) this.draft.toDay = day
        paint()
        this.autoScrollAt(ev.clientX)
      }
      const onUp = (): void => {
        this.teardownDraw = null
        if (!this.draft) return
        this.draft.naming = true
        const [from, to] = [this.draft.fromDay, this.draft.toDay].sort()
        this.openNameInput(track, ghost, from, to, ctx)
      }
      // The ghost survives a normal release — `openNameInput` names the span it
      // draws — so only the teardown path discards it.
      const detach = this.beginDrag(onMove, onUp)
      this.teardownDraw = (): void => {
        detach()
        ghost.remove()
      }
    })
  }

  /**
   * Near either edge of the viewport, keep scrolling while the cursor stays
   * there — so a cycle can be drawn or stretched past what is currently on
   * screen instead of stopping at the frame. Speed rises as the cursor presses
   * further into the margin, which makes both a nudge and a long haul feel
   * controllable from the same gesture.
   */
  private autoScrollAt(clientX: number): void {
    const scroller = this.scroller
    if (!scroller) return
    const rect = scroller.getBoundingClientRect()
    const margin = 48
    const leftPress = rect.left + margin - clientX
    const rightPress = clientX - (rect.right - margin)
    const press = leftPress > 0 ? -leftPress : rightPress > 0 ? rightPress : 0
    if (press === 0) {
      this.stopAutoScroll()
      return
    }
    // The step lives on the instance, not in the closure: the cursor keeps
    // moving inside the margin, and a step captured when the timer started
    // would freeze the speed at whatever the first frame happened to be.
    this.autoScrollStep = Math.sign(press) * Math.min(24, 4 + Math.abs(press) / 3)
    if (this.autoScrollTimer !== null) return
    this.autoScrollTimer = window.setInterval(() => {
      if (!this.scroller) return this.stopAutoScroll()
      this.scroller.scrollLeft += this.autoScrollStep
    }, 16)
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer === null) return
    window.clearInterval(this.autoScrollTimer)
    this.autoScrollTimer = null
    this.autoScrollStep = 0
  }

  /** The CIVIL DAY a client-x falls on, clamped to the window. Null only when
   *  there are no columns to fall on. */
  private dayAt(track: HTMLElement, clientX: number): string | null {
    const days = this.currentDays
    if (days.length === 0) return null
    const rect = track.getBoundingClientRect()
    const dayW = this.dayWidthPx || rect.width / days.length
    return days[columnIndexAtX(clientX, rect.left, dayW, days.length)].iso
  }

  /** Two civil days as the column range they currently occupy, in order. Null
   *  when either has fallen outside the window — the caller keeps its last
   *  painted position rather than jumping to an edge. */
  private spanColumns(a: string, b: string): { lo: number; hi: number } | null {
    const days = this.currentDays
    const ia = days.findIndex((d) => d.iso === a)
    const ib = days.findIndex((d) => d.iso === b)
    if (ia < 0 || ib < 0) return null
    return { lo: Math.min(ia, ib), hi: Math.max(ia, ib) }
  }

  /** Name the span in place. Enter commits, Escape abandons; either way the
   *  ghost and the suspended-rebuild state are cleared on exactly one path. */
  private openNameInput(
    track: HTMLElement,
    ghost: HTMLElement,
    startDay: string,
    endDay: string,
    ctx: ViewContext,
  ): void {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'chr-cycle-name'
    input.placeholder = 'name this cycle'
    input.style.left = ghost.style.left
    input.style.width = `max(${ghost.style.width}, 150px)`
    track.append(input)
    this.editInPlace(input, {
      // An empty name is an abandoned draw, not a nameless cycle.
      commit: (value) => {
        const name = value.trim()
        if (name) void this.createCycle(name, startDay, endDay, ctx)
        else if (this.ctx) void this.load(this.ctx)
      },
      done: () => {
        input.remove()
        ghost.remove()
        this.draft = null
        this.teardownDraw = null
      },
    })
  }

  /**
   * The era composer — the spoken half of making a cycle.
   *
   * A drag across the strip answers "when", and then asks for a name in one
   * line. This asks the other question first: WHAT this era is — its ontology,
   * its goal, what drives it, what constrains it — as a paragraph, dictated or
   * typed. The prose becomes the fiber's body, so the era face reads the
   * intention back in the words it was entered in; the opening clause becomes
   * the band's name (see {@link eraName}).
   *
   * The span it starts with is today, open-ended, because an era you are
   * entering has no end yet. The existing edge grips settle it later, so the
   * two gestures compose rather than duplicating each other.
   *
   * It is a sheet laid between the title and the grid, not a modal: the
   * chronicle it is about stays visible underneath, and dictating into a
   * textarea wants a large, plain target with nothing to dismiss by accident.
   */
  private openEraComposer(ctx: ViewContext): void {
    const root = this.root
    if (!root || !this.body) return
    const existing = root.querySelector('.chr-era-panel')
    if (existing) {
      ;(existing.querySelector('textarea') as HTMLTextAreaElement | null)?.focus()
      return
    }

    const panel = document.createElement('div')
    panel.className = 'chr-era-panel'

    const title = document.createElement('div')
    title.className = 'chr-era-title'
    title.textContent = 'a new era'

    const area = document.createElement('textarea')
    area.className = 'chr-era-text'
    area.rows = 4
    area.placeholder =
      'What is this era? Its ontology, its goal, what drives it, what constrains it.'

    const foot = document.createElement('div')
    foot.className = 'chr-era-foot'
    const note = document.createElement('span')
    note.className = 'chr-era-note'
    note.textContent = 'begins today · open-ended · drag its edges to settle the span'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'chr-era-cancel'
    cancel.textContent = 'abandon'
    const begin = document.createElement('button')
    begin.type = 'button'
    begin.className = 'chr-era-begin'
    begin.textContent = 'begin'
    foot.append(note, cancel, begin)

    panel.append(title, area, foot)
    // Between the page title and the grid, and OUTSIDE the body: the 15s poll
    // rebuilds the body wholesale, and a composer that vanished mid-sentence
    // because a refresh landed would lose the paragraph it exists to collect.
    root.insertBefore(panel, this.body)
    area.focus()

    let settled = false
    const finish = (prose: string | null): void => {
      if (settled) return
      settled = true
      panel.remove()
      if (prose === null) return
      const name = eraName(prose)
      if (!name) return
      void this.createCycle(name, isoDayLocal(Date.now()), null, ctx, prose)
    }
    cancel.addEventListener('click', () => finish(null))
    begin.addEventListener('click', () => finish(area.value.trim() || null))
    // Enter is a newline here — the point is a paragraph, and dictation puts
    // line breaks in it. Cmd/Ctrl+Enter commits, which is the capture form's
    // gesture, so the two captures on this board are learned once.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        finish(area.value.trim() || null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
      e.stopPropagation() // the board's hotkeys must not eat the dictation
    })
  }

  /**
   * Write the cycle. ONE call, both dates: the create passes `due` and
   * `outcome` through to `felt add`, so there is no second write that could
   * fail and leave a saved, open-ended cycle nobody drew. `start` rides the
   * frontmatter as an opaque key; `due` rides it as a native one. The band
   * appears immediately — `pendingCycles` holds it until a poll returns the
   * real card.
   *
   * `endDay` may be null: a spoken era is open-ended, and its span is settled
   * later with the same drag grips that reshape any other band. `prose` carries
   * the words an era was spoken in — the first paragraph of it is what the era
   * face reads back as the intention.
   */
  private async createCycle(
    name: string,
    startDay: string,
    endDay: string | null,
    ctx: ViewContext,
    prose = '',
  ): Promise<void> {
    const held: PendingCycle = { name, startDay, endDay }
    this.pendingCycles.push(held)
    if (this.ctx) {
      this.signature = '' // the pending band is not in the signature's inputs
      void this.load(this.ctx)
    }

    // No card exists yet, so this is the board's own scope rather than a
    // fiber's — the same resolution the capture forms use.
    const origin = BOARD_ORIGIN
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `cycle-${Date.now()}`
    const id = `cycles/${slug}`

    try {
      const body = await postDaemonJson<{ id?: string } | undefined>(ctx.shuttleBase, '/api/v1/fiber/create', {
        id,
        name,
        body: prose,
        frontmatter: {
          name,
          status: 'open',
          tags: ['cycle'],
          start: startDay,
          // Omitted, not null, when the era is open-ended: `due` absent is
          // how a cycle says "still running", and a null would be a date
          // field the daemon has to interpret.
          ...(endDay === null ? {} : { due: endDay }),
        },
        origin,
      }, 'create failed')
      if (!body?.id) throw new Error('create returned no id')
      // The fiber exists now, so the band stops being a picture of a cycle and
      // becomes the cycle — clickable, enterable, its face readable — instead
      // of waiting inert for the feed to come round, which is a poll interval
      // of a band that does nothing when clicked.
      //
      // The id is the SLUG the create was given, and that is exactly right: the
      // board keys a fiber by its slug when it has one (`mapFeltJsonToFiber`
      // prefers `slug` over the ULID), so the ghost now carries the same id the
      // served card will. Adopting felt's ULID instead would look more precise
      // and be wrong — it matches no card, so entering the era would drop its
      // face the moment a poll landed.
      held.id = body.id
      this.repaintNow()
      ctx.requestRefresh()
    } catch (err) {
      // Drop the optimistic band rather than leave a cycle on screen that does
      // not exist on disk — a chronicle that shows work that never happened is
      // the one failure this page cannot afford.
      this.pendingCycles = this.pendingCycles.filter((p) => p !== held)
      this.repaintNow()
      window.console.error('[chronicle] could not create cycle', err)
    }
  }

  /**
   * Sticky top-left cell — the row-label column's own head. It carries two
   * things: the month you are currently looking at, and how many fibers are on
   * the page.
   *
   * The month is here rather than only at the boundary columns because a
   * boundary scrolls away and the question "which month am I in" does not. It
   * is the one word on this page that answers where you are.
   */
  private buildCorner(total: number): HTMLElement {
    const corner = document.createElement('div')
    corner.className = 'chr-corner'
    corner.style.gridColumn = '1'
    corner.style.gridRow = '1'
    const month = document.createElement('span')
    month.className = 'chr-corner-month'
    const count = document.createElement('span')
    count.className = 'chr-corner-count'
    count.textContent = `${total} ${total === 1 ? 'fiber' : 'fibers'}`
    corner.append(month, count)
    this.monthEl = month
    return corner
  }

  /**
   * Name the month at the left edge of the day area — the sticky bearing.
   *
   * The leftmost VISIBLE day, not the leftmost column: the gutter covers the
   * first stretch of the grid, so measuring from `scrollLeft` alone would name
   * a month the reader cannot see. Writes only when the word changes, because
   * this runs on every scroll event.
   */
  private bearMonth(): void {
    const scroller = this.scroller
    const el = this.monthEl
    if (!scroller || !el || this.currentDays.length === 0) return
    const dayW = this.dayWidthPx || 24
    const idx = clamp(
      Math.floor((scroller.scrollLeft + this.labelWidth(scroller)) / dayW),
      0,
      this.currentDays.length - 1,
    )
    const text = monthBearing(this.currentDays[idx].iso, Number(isoDayLocal(Date.now()).slice(0, 4)))
    if (el.textContent === text) return
    el.textContent = text
  }

  /**
   * The key — a caption under the grid, in the margin, naming every mark the
   * page spends.
   *
   * The GLYPHS are Chronicle's own marks in miniature: a key teaches the
   * marks you are actually looking at, and Chronicle's segment is a day, not
   * an hour.
   *
   * One entry is conditional: a page with no cycles should not explain bands —
   * a key for marks that are not on the page is the noise a key exists to
   * remove.
   */
  private buildKey(hasCycles: boolean): HTMLElement {
    const key = document.createElement('div')
    key.className = 'chr-key'

    const item = (glyph: HTMLElement, label: string): HTMLElement => {
      const el = document.createElement('span')
      el.className = 'chr-key-item'
      el.append(glyph, document.createTextNode(label))
      return el
    }
    const swatch = (cls: string): HTMLElement => {
      const el = document.createElement('span')
      el.className = cls
      return el
    }
    const glyph = (cls: string, text: string): HTMLElement => {
      const el = document.createElement('span')
      el.className = cls
      el.textContent = text
      return el
    }

    // Length first: it is the page's largest claim and the one nobody guesses.
    key.append(item(swatch('chr-key-life'), 'row spans first to last day'))
    // The pigments, in the shared words, with a ramp that teaches both axes
    // at once: a strip's PLACE is when in the day the work sat, its HEIGHT is
    // how much happened there (log-scaled to the busiest spell in view).
    const ramp = document.createElement('span')
    ramp.className = 'chr-key-ramp'
    for (const step of [1, 2, 3]) ramp.append(swatch(`chr-key-seg chr-key-seg-${step}`))
    // The strip sums agent and steering minutes alike, so it is glossed as use
    // rather than as either party's work.
    key.append(item(ramp, 'periods of use (taller = busier; busiest spell in view sets the scale)'))
    // Hollow marks: what is owed, ahead of today. Nothing solid is drawn there.
    key.append(item(glyph('chr-key-glyph chr-key-due', MARK_GLYPH.due), 'due'))
    key.append(item(glyph('chr-key-glyph chr-key-launch', MARK_GLYPH.launch), 'next launch'))
    // The state group. It also stands for the marks that END a lifeline (✓ ·
    // ✗ · ◦ are the same ink in a different place), so closure is explained
    // here and nowhere else — one gloss per mark is the rule this key keeps.
    const states = document.createElement('span')
    states.className = 'chr-key-item chr-key-states'
    for (const state of STATE_KEY_ITEMS) {
      const el = document.createElement('span')
      el.className = 'chr-key-state'
      el.append(
        glyph(`chr-key-glyph chr-state-${state}`, STATE_GLYPH[state]),
        document.createTextNode(STATE_WORD[state]),
      )
      states.append(el)
    }
    key.append(states)
    if (hasCycles) key.append(item(swatch('chr-key-band'), 'an era — click to read it'))
    return key
  }

  /** The almanac head: one label per day column, named in full on hover. */
  private buildHead(days: TimelineDay[]): HTMLElement[] {
    return days.map((day, i) => {
      const cell = document.createElement('div')
      const classes = ['chr-head']
      if (day.isToday) classes.push('chr-head-today')
      if (day.isPast) classes.push('chr-head-past')
      if (day.isWeekend) classes.push('chr-head-weekend')
      if (day.weekBoundary) classes.push('chr-head-week')
      // The first of a month takes the month's name in place of its weekday.
      // The weekday is recoverable from the column beside it; the month is not
      // recoverable from anything on the page, which is the whole complaint.
      const monthStart = isMonthStart(day.iso)
      if (monthStart) classes.push('chr-head-monthstart')
      cell.className = classes.join(' ')
      cell.style.gridColumn = String(i + 2)
      cell.style.gridRow = '1'
      cell.dataset.dayIso = day.iso

      const dow = document.createElement('span')
      dow.className = `chr-head-dow${monthStart && !day.isToday ? ' chr-head-month' : ''}`
      // A phone's day column is too narrow for a word: it shows the weekday's
      // initial, and the bearing beside the grid names the month.
      const full = document.createElement('span')
      full.className = 'chr-head-dow-full'
      full.textContent = day.isToday
        ? 'today'
        : monthStart
          ? monthName(day.iso, 'short')
          : day.weekdayLabel
      const initial = document.createElement('span')
      initial.className = 'chr-head-dow-initial'
      initial.textContent = day.weekdayLabel.slice(0, 1)
      initial.setAttribute('aria-hidden', 'true')
      dow.append(full, initial)
      const num = document.createElement('span')
      num.className = 'chr-head-num'
      num.textContent = day.label
      cell.append(dow, num)

      const spoken = formatCivilDay(day.iso, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      })
      cell.title = spoken ?? day.iso
      return cell
    })
  }

  /** The washes are one element per day spanning every row — the weekend and
   *  past tints and the vertical hairlines live here, behind the ink, so a row
   *  never has to draw its own background. */
  private buildWashes(days: TimelineDay[]): HTMLElement[] {
    return days.map((day, i) => {
      const wash = document.createElement('div')
      const classes = ['chr-wash']
      if (day.isToday) classes.push('chr-wash-today')
      if (day.isPast) classes.push('chr-wash-past')
      if (day.isWeekend) classes.push('chr-wash-weekend')
      if (day.weekBoundary) classes.push('chr-wash-week')
      // A month opens with a rule the full height of the page — the bearing you
      // cross rather than the one you read.
      if (isMonthStart(day.iso)) classes.push('chr-wash-month')
      wash.className = classes.join(' ')
      wash.style.gridColumn = String(i + 2)
      wash.style.gridRow = '2 / -1'
      return wash
    })
  }

  private buildRow(
    row: ChronicleRow,
    r: number,
    days: TimelineDay[],
    dayIndex: Map<string, number>,
    peak: number,
    ctx: ViewContext,
  ): HTMLElement[] {
    const gridRow = String(r + 2)

    // A row whose only origin is out of contact is showing last-known-good. The
    // register is the Desk's — dimmed, with the ⌛ badge — but the classes are
    // the chronicle's own: a card's stale styling is a border and a ground, and
    // a one-line row has neither. See the note in ChronicleView.css.
    const waiting = row.waitingOn !== null

    const label = document.createElement('div')
    label.className = `chr-label${row.live ? ' chr-label-live' : ''}${waiting ? ' chr-label-waiting' : ''}`
    label.style.gridColumn = '1'
    label.style.gridRow = gridRow

    // The state, ahead of the name, in the marginalia register. It is a
    // `<span>` outside the name button on purpose: the name's job is to open
    // the card, and a glyph inside it would join the click target and read as
    // part of the title in the accessibility tree.
    const state = document.createElement('span')
    state.className = `chr-state chr-state-${row.state}`
    state.textContent = STATE_GLYPH[row.state]
    state.title = STATE_WORD[row.state]
    state.setAttribute('aria-label', STATE_WORD[row.state])
    state.setAttribute('role', 'img')

    const name = document.createElement(row.cardId ? 'button' : 'span')
    name.className = 'chr-name'
    name.textContent = row.label
    name.title = row.label
    if (row.cardId) {
      const cardId = row.cardId
      ;(name as HTMLButtonElement).type = 'button'
      name.addEventListener('click', () => ctx.openCard(cardId))
    }
    // The handle the search jumps by. On BOTH halves of the row, so lighting a
    // hit lights the whole line rather than only its gutter.
    if (row.cardId) label.dataset.fiber = row.cardId

    const note = document.createElement('span')
    // The note's slot already names the owning host, so the waiting badge
    // replaces it rather than repeating it beside itself.
    note.className = row.waitingOn === null ? 'chr-note' : 'chr-note kbn-card-waiting'
    note.textContent = row.waitingOn === null ? row.note : `⌛ waiting on ${row.waitingOn}`
    if (row.waitingOn !== null) note.setAttribute('role', 'status')

    const span = document.createElement('span')
    span.className = 'chr-span'
    const spanDays = row.endIdx - row.startIdx + 1
    span.textContent = `${spanDays}d`
    span.title = `${spanDays} day${spanDays === 1 ? '' : 's'} on the chronicle`

    label.append(state, name, note, span)

    // What the ledger says this fiber changed across the drawn window, in the
    // span's own register and one step quieter — the day count is the row's
    // shape, the line count is a footnote to it. A row the ledger has nothing
    // recorded for gets NO element at all: an empty span would still take its
    // gap and pull the gutter's other figures out of column.
    const diff = row.cardId ? this.rowDiffs.get(row.cardId) : undefined
    if (diff) {
      const el = diffClauseEl(diff.insertions, diff.deletions)
      if (el) {
        el.classList.add('chr-diff')
        el.title = `${diff.insertions} inserted, ${diff.deletions} deleted — commits recorded in this window`
        label.append(el)
      }
    }

    const track = document.createElement('div')
    track.className = `chr-track${waiting ? ' chr-track-waiting' : ''}`
    if (row.cardId) track.dataset.fiber = row.cardId
    track.style.gridColumn = `2 / span ${days.length}`
    track.style.gridRow = gridRow

    const life = document.createElement('div')
    life.className = 'chr-life'
    life.style.left = colLeft(row.startIdx)
    life.style.width = `calc(var(--chr-day-w) * ${row.endIdx - row.startIdx + 1})`
    track.append(life)

    // ONE CHANNEL, but with a clock in it. Each strip is a SPELL — a
    // contiguous period of use, drawn where inside the day it actually sat —
    // so a morning sitting and an evening fan-out read as two marks with air
    // between them. Height is the spell's work, log-scaled to the busiest
    // spell in view; the human/agent split is still not a distinction
    // Chronicle draws — both kinds of minute are "work happened".
    for (const [day, spells] of row.spells) {
      const idx = dayIndex.get(day)
      if (idx === undefined) continue
      for (const sp of spells) {
        const f0 = railFrac(sp.startMs, day)
        const f1 = railFrac(sp.endMs, day)
        const h = spellHeight(sp.work, peak)
        const seg = document.createElement('div')
        seg.className = 'chr-seg'
        seg.style.left = `calc(var(--chr-day-w) * ${idx + f0})`
        // The floor width keeps a lone minute visible as a tick, not dust.
        seg.style.width = `max(2px, calc(var(--chr-day-w) * ${f1 - f0}))`
        seg.style.height = `${h}px`
        seg.style.marginTop = `${-h / 2}px`
        seg.title = `${clockTime(sp.startMs)}–${clockTime(sp.endMs)} · ${sp.minutes} active min`
        track.append(seg)
      }
    }

    const mark = (cls: string, idx: number, glyph: string, title?: string): HTMLElement => {
      const el = document.createElement('div')
      el.className = `chr-mark ${cls}`
      el.style.left = colLeft(idx)
      el.textContent = glyph
      if (title) el.title = title
      track.append(el)
      return el
    }

    if (row.closed && row.closeIdx !== null) {
      mark(`chr-end${row.closedOk ? '' : ' chr-end-discard'}`, row.closeIdx, row.closedOk ? '✓' : '✗')
    }
    // Ahead of today: promises only, never ink.
    if (row.dueIdx !== null) {
      const due = mark(
        'chr-due',
        row.dueIdx,
        MARK_GLYPH.due,
        row.cardId ? 'due — drag to reschedule' : 'due',
      )
      // A cycle's due-edge is grabbed by its own small handle; a fiber's due
      // mark IS the handle — nothing else on the row promises a future date.
      if (row.cardId) this.installDueMarkDrag(due, row, ctx)
    }
    if (row.launchIdx !== null) mark('chr-launch', row.launchIdx, MARK_GLYPH.launch, 'next launch')

    // The gutter and the days are two grid children; the row they belong to is
    // only in the reader's head. Pointing at either one lights both, which is
    // what makes a name at the left edge and a mark 900px away readable as one
    // fact. Pure CSS cannot do it — grid siblings have no selector between
    // them — so the hover is linked here, in two lines.
    const hot = (on: boolean): void => {
      label.classList.toggle('chr-label-hot', on)
      track.classList.toggle('chr-track-hot', on)
    }
    for (const el of [label, track]) {
      // Desk hover policy exception: Chronicle only tints this settled cycle; no content or geometry changes.
      el.addEventListener('mouseenter', () => hot(true))
      el.addEventListener('mouseleave', () => hot(false))
    }

    return [label, track]
  }

  /**
   * Put day column `idx` at {@link TODAY_ANCHOR} across the DAY AREA — the area
   * beside the sticky gutter, not the whole viewport. Measuring against the
   * viewport would push the day right by the gutter's width and quietly hide a
   * chunk of the recent past behind it. Runs on the first render and whenever
   * the cursor moves; otherwise a render restores whatever the reader had
   * scrolled to.
   */
  private anchorDay(scroller: HTMLElement, idx: number, fraction: number): void {
    requestAnimationFrame(() => {
      if (this.scroller !== scroller) return
      const styles = getComputedStyle(scroller)
      const dayW = parseFloat(styles.getPropertyValue('--chr-day-w')) || 24
      const labelW = this.labelWidth(scroller)
      const center = labelW + (idx + 0.5) * dayW
      const restingX = labelW + (scroller.clientWidth - labelW) * fraction
      scroller.scrollLeft = Math.max(0, center - restingX)
      this.didAnchor = true
    })
  }
}

/** FNV-1a over a string — a short, stable signature, not a hash for security. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

registerView(new ChronicleView())
