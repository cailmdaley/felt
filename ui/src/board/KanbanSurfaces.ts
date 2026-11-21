import '@ui-sdk/web/tabs'
import { markVerdictHost } from './workspace/Verdicts.js'
import { clearable, quietWord, type Waits } from './attention.js'
import { dueCivilDay, formatCivilDay } from './civilDay.js'
import { DESK_COLUMNS, DESK_FOLIO_NAME, DESK_SECTION_TITLE, DESK_SECTIONS, type DeskFamily, type DeskOrder, type DeskSection, type FamilyWait } from './deskOrdering.js'
import { activeFolioIndex, folioScrollTarget } from './deskMobile.js'
import type { KanbanCard } from './KanbanTypes.js'
import { isMobileViewport } from './mobile.js'
import { stateDot } from './stateDot.js'
import { threadRow } from './elements/threadRow.js'
import { rowLabel } from './threadOutline.js'
import type { ThreadIndex } from './threads.js'
import './desk.css'

const EMPTY: Readonly<Record<DeskSection, string>> = {
  waiting: 'Nothing waits on you.',
  working: 'No worker is running.',
  review: 'Nothing awaits review.',
  drafts: 'No drafts.',
  resting: 'Nothing is resting.',
  roles: 'No seats or schedules.',
}
/** The faint word a shelf's own name already says. */
const SAID: Partial<Record<DeskSection, string>> = { drafts: 'draft', resting: 'resting', roles: 'seat' }

export interface DeskRendererOptions {
  /** What waits on the human, by fiber. */
  waits: () => Waits
  /** Opens a constitution's view, as a click on it does. */
  openDetail: (card: KanbanCard) => void
  /** Clears a waiting post by hand. */
  clear: (card: KanbanCard) => void
  /** Stash a new draft: the Desk head's `+`. */
  onStashClick?: () => void
  /** Capture an idea: the Desk head's `✶`. */
  onNewIdeaClick?: () => void
}

/**
 * The Desk: three columns, Waiting on you, Working and Awaiting review, and
 * under them a shelf of three, Drafts, Resting and Roles & standing; each a
 * list of family cards, every family once, in its section (`deskOrder`). The
 * two ways to make something new stand in column heads: `+` in Waiting on
 * you's, `✶` in Working's. On a phone the columns are leaves of a pager under
 * a folio of three tabs, which carries both, and the shelf stands below it. Nothing on it is dragged, and it has no context menu: a
 * card or a line opens a constitution's view, and a waiting post's ✓ clears it.
 */
export class KanbanSurfaceRenderer {
  /** Which leaf of the phone's pager is showing, held across redraws. */
  private folioIndex = 0
  private readonly o: DeskRendererOptions

  constructor(options: DeskRendererOptions) {
    this.o = options
  }

  renderDesk(order: DeskOrder, index: ThreadIndex): HTMLElement {
    const desk = document.createElement('div')
    desk.className = 'kbn-desk-sections'
    const section = document.createElement('section')
    section.className = 'kbn-section kbn-section-now'
    section.setAttribute('role', 'region')
    section.setAttribute('aria-label', 'The desk')
    const board = document.createElement('div')
    board.className = 'kbn-now-board'
    for (const column of DESK_COLUMNS) board.append(this.column(column, order.sections[column], index))
    const head = document.createElement('div')
    head.className = 'kbn-desk-head'
    const folio = this.folio(board, DESK_COLUMNS.map(column => order.sections[column].length))
    head.append(folio, ...this.actions(['draft', 'idea']))
    section.append(head, board)
    const shelf = document.createElement('div')
    shelf.className = 'kbn-desk-shelf'
    for (const each of DESK_SECTIONS) if (!DESK_COLUMNS.includes(each)) shelf.append(this.column(each, order.sections[each], index))
    desk.append(section, shelf)
    this.pager(board, folio)
    return desk
  }

  /** The `+` (`draft`) and `✶` (`idea`) buttons asked for, those with a handler. */
  private actions(which: readonly ('draft' | 'idea')[]): HTMLButtonElement[] {
    const make = (glyph: string, modifier: string, label: string, run?: () => void): HTMLButtonElement[] => {
      if (!run) return []
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `kbn-col-action kbn-col-action-${modifier}`
      button.textContent = glyph
      button.title = label
      button.setAttribute('aria-label', label)
      button.addEventListener('click', run)
      return [button]
    }
    return which.flatMap(kind => kind === 'draft'
      ? make('+', 'draft', 'Stash a new draft', this.o.onStashClick)
      : make('✶', 'idea', 'New idea — speak it into a card', this.o.onNewIdeaClick))
  }

  private column(column: DeskSection, families: DeskFamily[], index: ThreadIndex): HTMLElement {
    const title = DESK_SECTION_TITLE[column]
    const col = document.createElement('section')
    col.className = `kbn-col kbn-col-${column}`
    col.dataset.column = column
    col.setAttribute('role', 'region')
    col.setAttribute('aria-label', `${title} (${families.length})`)
    const head = document.createElement('div')
    head.className = 'kbn-col-head'
    const label = document.createElement('div')
    label.className = 'kbn-col-head-label'
    const name = document.createElement('h2')
    name.className = 'kbn-col-title'
    appendCappedText(name, title)
    const count = document.createElement('span')
    count.className = 'kbn-col-count'
    count.textContent = String(families.length)
    label.append(name, count)
    head.append(label, ...this.actions(column === 'waiting' ? ['draft'] : column === 'working' ? ['idea'] : []))
    const list = document.createElement('div')
    list.className = 'kbn-col-list'
    list.setAttribute('role', 'list')
    if (!families.length) {
      const empty = document.createElement('div')
      empty.className = 'kbn-empty'
      empty.setAttribute('role', 'listitem')
      empty.textContent = EMPTY[column]
      list.append(empty)
    }
    for (const family of families) list.append(this.family(family, index))
    col.append(head, list)
    return col
  }

  /**
   * One family, headed by its top-level: while the top-level waits, its own
   * thread row (what it wants, how long ago, a post's ✓, its undo window);
   * otherwise its dot and slug, or a quiet one's faint word. Beside either,
   * how many of its members work. Under the head, every other member that
   * waits on the human, one line each. A line opens that member's view;
   * anywhere else on the card opens the top-level's.
   */
  private family(family: DeskFamily, index: ThreadIndex): HTMLElement {
    const { root } = family, waits = this.o.waits()
    const card = document.createElement('div')
    card.className = 'kbn-family'
    card.dataset.attention = family.attention
    card.dataset.section = family.section
    card.setAttribute('role', 'listitem')
    card.title = root.name
    identify(card, root)
    card.setAttribute('aria-label', `${root.name}, ${DESK_SECTION_TITLE[family.section].toLowerCase()}`)
    card.addEventListener('click', event => {
      if ((event.target as Element).closest('button, a')) return
      const line = (event.target as Element).closest<HTMLElement>('.kbn-family-wait')
      const wait = line && family.waits.find(each => fiber(each.card) === line.dataset.cardUid)
      this.o.openDetail(wait ? wait.card : root)
    })
    const meta = document.createElement('span')
    meta.className = 'kbn-family-meta'
    // A family of one says nothing its dot does not; a larger one counts its workers.
    const word = family.attention === 'quiet' ? quietWord(root) : ''
    meta.textContent = family.attention === 'quiet' ? (word === SAID[family.section] ? '' : family.section === 'resting' ? word.replace(/^resting /, '') : word) : family.working && index.children(root).length ? `${family.working} working` : ''
    const own = family.waits.find(wait => wait.card === root)
    if (own) {
      const head = this.row(own)
      head.classList.add('kbn-family-top')
      if (meta.textContent) head.querySelector('.thread-row-age')!.after(meta)
      card.append(head)
    } else {
      const head = document.createElement('div')
      head.className = 'kbn-family-head'
      const name = document.createElement('span')
      name.className = 'kbn-family-name'
      name.textContent = rowLabel(index, root)
      head.append(stateDot(root, waits, this.o.openDetail), name, meta)
      // A verdict given from the keys waits out its undo window on the line it names.
      markVerdictHost(head, root)
      card.append(head)
    }
    const members = family.waits.filter(wait => wait !== own)
    if (members.length) {
      const lines = document.createElement('div')
      lines.className = 'kbn-family-waits'
      lines.append(...members.map(wait => this.line(wait)))
      card.append(lines)
    }
    return card
  }

  /** A member that waits, as a line of its family's card that opens it. */
  private line(wait: FamilyWait): HTMLElement {
    const line = this.row(wait)
    line.classList.add('kbn-family-wait')
    line.dataset.deskLine = ''
    identify(line, wait.card)
    return line
  }

  /**
   * A member that waits, as a thread row (elements/threadRow.ts: dot, slug,
   * what it wants, how long ago), a post's ✓, and the member's undo window.
   */
  private row({ card, want }: FamilyWait): HTMLElement {
    const line = threadRow(card, { waits: this.o.waits(), now: Date.now() })
    line.dataset.kind = want.kind
    markVerdictHost(line, card)
    if (clearable(want)) {
      const clear = document.createElement('button')
      clear.type = 'button'
      clear.className = 'kbn-ch-clear'
      clear.textContent = '✓'
      clear.title = 'Clear: read, nothing to answer'
      clear.setAttribute('aria-label', `Clear ${card.name}'s post`)
      clear.addEventListener('click', () => { clear.disabled = true; this.o.clear(card) })
      line.append(clear)
    }
    return line
  }

  /**
   * The phone's folio: one tab per column, its name and count. Above 700px
   * the three columns are all on screen and the strip has no box.
   */
  private folio(board: HTMLElement, counts: number[]): HTMLElementTagNameMap['ui-tabs'] {
    const strip = document.createElement('ui-tabs')
    strip.className = 'kbn-folio'
    strip.setAttribute('default-value', String(this.folioIndex))
    strip.addEventListener('valuechange', event => {
      board.scrollTo({ left: folioScrollTarget(Number(event.detail.value), board.clientWidth, DESK_COLUMNS.length), behavior: 'smooth' })
    })
    const list = document.createElement('ui-tabs-list')
    list.className = 'kbn-folio-tabs'
    list.setAttribute('aria-label', 'Which column is showing')
    strip.append(list)
    DESK_COLUMNS.forEach((column, i) => {
      const seg = document.createElement('div')
      seg.className = `kbn-folio-seg kbn-col-${column}`
      seg.dataset.folio = String(i)
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'kbn-folio-tab'
      tab.setAttribute('aria-label', `${DESK_SECTION_TITLE[column]} (${counts[i]})`)
      const name = document.createElement('span')
      name.className = 'kbn-folio-name'
      name.textContent = DESK_FOLIO_NAME[column] ?? DESK_SECTION_TITLE[column]
      const count = document.createElement('span')
      count.className = 'kbn-folio-count'
      count.textContent = String(counts[i])
      tab.append(name, count)
      const part = document.createElement('ui-tabs-tab')
      part.setAttribute('value', String(i))
      part.append(tab)
      seg.append(part)
      list.append(seg)
    })
    return strip
  }

  /** The strip follows the pager's scroll, and the pager comes back to its leaf across a redraw. */
  private pager(board: HTMLElement, strip: HTMLElementTagNameMap['ui-tabs']): void {
    const segs = [...strip.querySelectorAll<HTMLElement>('.kbn-folio-seg')]
    const paint = (index: number): void => {
      segs.forEach((seg, i) => seg.classList.toggle('kbn-folio-seg-active', i === index))
      strip.value = String(index)
    }
    const follow = (): void => {
      this.folioIndex = activeFolioIndex(board.scrollLeft, board.clientWidth, segs.length)
      paint(this.folioIndex)
    }
    paint(this.folioIndex)
    board.addEventListener('scroll', follow, { passive: true })
    if (this.folioIndex > 0 && isMobileViewport()) {
      const wanted = this.folioIndex
      window.requestAnimationFrame(() => {
        if (board.isConnected && board.clientWidth > 0) board.scrollLeft = folioScrollTarget(wanted, board.clientWidth, segs.length)
        follow()
      })
    }
  }
}

const fiber = (card: KanbanCard): string => card.uid ?? card.id
/** What the Desk's keys and the reader's return find a drawn constitution by. */
function identify(el: HTMLElement, card: KanbanCard): void {
  el.dataset.cardUid = fiber(card)
  el.dataset.cardOrigin = card.originId
  el.dataset.fiberId = card.id
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

/** The `due <date>` chip on a card. Reads the value as the CIVIL DAY it names,
 *  never re-parsed as an instant (see civilDay.ts), so the chip agrees with
 *  the date written on the fiber across every timezone. */
export function formatDue(iso: string): string {
  return formatCivilDay(dueCivilDay(iso), { month: 'short', day: 'numeric' }) ?? iso
}
