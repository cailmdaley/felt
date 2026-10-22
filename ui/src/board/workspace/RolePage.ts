import type { KanbanCard } from '../KanbanTypes.js'
import { renderMarkdown } from '../utils.js'
import { deskColumn } from '../deskColumn.js'

const ROLE_ID = /^roles\/([a-z0-9]+(?:-[a-z0-9]+)*)$/

/** The slug of a role charter at exactly `roles/<slug>`. */
export function roleSlug(card: KanbanCard): string | null {
  return ROLE_ID.exec(card.id)?.[1] ?? null
}

type HoldColumn = ReturnType<typeof deskColumn>
/** The Desk's reading order: work awaiting review, in flight, drafts, then the rest. */
const HOLD_ORDER: HoldColumn[] = ['awaitingReview', 'inFlight', 'roles', 'drafts', 'scheduled', 'resting', 'cycles', 'tempered', 'composted']
const LIVE: ReadonlySet<HoldColumn> = new Set(['awaitingReview', 'inFlight', 'drafts'])
const HOLD_LABELS: Record<HoldColumn, string> = {
  awaitingReview: 'Review', inFlight: 'In flight', roles: 'Seat', drafts: 'Draft', scheduled: 'Resting',
  resting: 'Resting', cycles: 'Cycle', tempered: 'Tempered', composted: 'Discarded',
}
/** Rows shown before the rest fold behind "more"; live work is always shown whole. */
const HOLDS_SHOWN = 5

/** The feed's constitutions assigned to this office, in Desk order. */
export function roleHolds(cards: KanbanCard[], slug: string): KanbanCard[] {
  const rank = (card: KanbanCard) => HOLD_ORDER.indexOf(deskColumn(card))
  return cards
    .filter(card => card.shuttleRole === slug)
    .sort((a, b) => rank(a) - rank(b))
}

/** What the page shows of each hold, so a feed poll that changes none of it leaves the page alone. */
export function holdsRevision(holds: KanbanCard[]): unknown[] {
  return holds.map(card => [card.originId, card.uid ?? card.id, card.name, card.outcome, deskColumn(card)])
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
  const column = deskColumn(card)
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
  state.textContent = HOLD_LABELS[column]
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
  const live = holds.filter(card => LIVE.has(deskColumn(card))).length
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
