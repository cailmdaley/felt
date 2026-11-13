import type { DeskColumn, KanbanCard } from '../KanbanTypes.js'
import { DESK_COLUMN_TITLE } from '../KanbanSurfaces.js'
import { renderMarkdown } from '../utils.js'
import { daemonFetch } from '../daemonApi.js'

/**
 * An office and its charter's id (`roles/<slug>`, or `<mount>/roles/<slug>`
 * in a repository linked in at the store's top level), as `GET /api/v1/roles`
 * lists them. The daemon reads the charter rule where it can see the links;
 * the board takes its answer rather than guessing from a path.
 */
export interface Charter { slug: string; id: string }

/** One catalogue fetch per daemon base. A failed fetch is dropped so the next reader retries. */
const catalogues = new Map<string, Promise<Charter[]>>()

/** The daemon's charter catalogue. */
export function charters(shuttleBase: string): Promise<Charter[]> {
  const hit = catalogues.get(shuttleBase)
  if (hit) return hit
  const load = daemonFetch(`${shuttleBase}/api/v1/roles`).then(async response => {
    if (!response.ok) throw new Error(await response.text())
    return await response.json() as Charter[]
  }).catch((error: unknown) => {
    catalogues.delete(shuttleBase)
    throw error
  })
  catalogues.set(shuttleBase, load)
  return load
}

/** Whether a fiber could be a charter, so a page asks for the catalogue only when it might be one. */
export function mayBeCharter(card: KanbanCard): boolean {
  return /(^|\/)roles\/[^/]+$/.test(card.id)
}

/** The office whose charter this card is, if it is one. */
export function roleSlug(card: KanbanCard, catalogue: readonly Charter[]): string | null {
  return catalogue.find(charter => charter.id === card.id)?.slug ?? null
}

/** The id of an office's charter in the catalogue. */
export function charterId(slug: string, catalogue: readonly Charter[]): string | null {
  return catalogue.find(charter => charter.slug === slug)?.id ?? null
}

/** The Desk's reading order: work awaiting review, in flight, drafts, then the rest. */
const HOLD_ORDER: DeskColumn[] = ['awaitingReview', 'inFlight', 'roles', 'drafts', 'orchestratorReview', 'resting', 'tempered', 'composted']
const LIVE: ReadonlySet<DeskColumn> = new Set(['awaitingReview', 'inFlight', 'drafts'])
/** Rows shown before the rest fold behind "more"; live work is always shown whole. */
const HOLDS_SHOWN = 5

/** The feed's constitutions assigned to this office, in Desk order. */
export function roleHolds(cards: KanbanCard[], slug: string): KanbanCard[] {
  const rank = (card: KanbanCard) => HOLD_ORDER.indexOf(card.column)
  return cards
    .filter(card => card.shuttleRole === slug)
    .sort((a, b) => rank(a) - rank(b))
}

/** What the page shows of each hold, so a feed poll that changes none of it leaves the page alone. */
export function holdsRevision(holds: KanbanCard[]): unknown[] {
  return holds.map(card => [card.originId, card.uid ?? card.id, card.name, card.outcome, card.column])
}

function caption(text: string): HTMLElement {
  // A caption in the status line's register, not a prose heading a theme restyles.
  const el = document.createElement('div')
  el.className = 'ws-role-caption'
  el.setAttribute('role', 'heading')
  el.setAttribute('aria-level', '2')
  el.textContent = text
  return el
}

function plainOutcome(outcome: string): string {
  const template = document.createElement('template')
  template.innerHTML = renderMarkdown(outcome)
  return template.content.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function holdRow(card: KanbanCard, onCard: (card: KanbanCard) => void): HTMLElement {
  const column = card.column
  const item = document.createElement('li')
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'ws-role-hold'
  row.dataset.column = column
  row.title = card.id
  const dot = document.createElement('span')
  dot.className = 'ws-role-dot'
  dot.setAttribute('aria-hidden', 'true')
  const name = document.createElement('span')
  name.className = 'ws-role-hold-name'
  name.textContent = card.name
  const state = document.createElement('span')
  state.className = 'ws-role-hold-column'
  state.textContent = DESK_COLUMN_TITLE[column]
  row.append(dot, name, state)
  const outcome = card.outcome ? plainOutcome(card.outcome) : ''
  if (outcome) {
    const line = document.createElement('span')
    line.className = 'ws-role-hold-outcome'
    line.textContent = outcome
    row.append(line)
  }
  row.addEventListener('click', () => onCard(card))
  item.append(row)
  return item
}

function holdsSection(holds: KanbanCard[], onCard: (card: KanbanCard) => void): HTMLElement {
  const section = document.createElement('section')
  section.className = 'ws-role-holds'
  section.dataset.part = 'role-holds'
  const list = document.createElement('ol')
  list.className = 'ws-role-hold-list'
  const live = holds.filter(card => LIVE.has(card.column)).length
  const shown = Math.max(live, HOLDS_SHOWN)
  list.append(...holds.slice(0, shown).map(card => holdRow(card, onCard)))
  section.append(caption('Holds'), list)
  const rest = holds.slice(shown)
  if (rest.length) {
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'ws-role-more'
    more.textContent = `${rest.length} more`
    more.addEventListener('click', () => {
      list.append(...rest.map(card => holdRow(card, onCard)))
      more.remove()
    })
    section.append(more)
  }
  return section
}

/** A role charter's assigned constitutions under its lede. */
export function buildRoleLedger(
  holds: KanbanCard[],
  opts: { onCard: (card: KanbanCard) => void },
): HTMLElement {
  const ledger = document.createElement('div')
  ledger.className = 'ws-role-ledger'
  ledger.dataset.part = 'role-ledger'
  if (holds.length) ledger.append(holdsSection(holds, opts.onCard))
  return ledger
}
