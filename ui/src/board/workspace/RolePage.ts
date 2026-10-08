import type { KanbanCard } from '../KanbanTypes.js'
import { renderMarkdown } from '../utils.js'
import { fiberIndex, installWikilinks } from '../wikilinks.js'
import { fiberPageColumn } from './fiberPageState.js'

const ROLE_ID = /^roles\/([a-z0-9]+(?:-[a-z0-9]+)*)$/

/** The slug of a role page: a fiber at exactly `roles/<slug>`, never a holder beneath it. */
export function roleSlug(card: KanbanCard): string | null {
  return ROLE_ID.exec(card.id)?.[1] ?? null
}

type HoldColumn = ReturnType<typeof fiberPageColumn>
/** The Desk's reading order: work awaiting review, in flight, drafts, then the rest. */
const HOLD_ORDER: HoldColumn[] = ['awaitingReview', 'inFlight', 'drafts', 'scheduled', 'resting', 'cycles', 'tempered', 'composted']
const LIVE: ReadonlySet<HoldColumn> = new Set(['awaitingReview', 'inFlight', 'drafts'])
const HOLD_LABELS: Record<HoldColumn, string> = {
  awaitingReview: 'Review', inFlight: 'In flight', drafts: 'Draft', scheduled: 'Resting',
  resting: 'Resting', cycles: 'Cycle', tempered: 'Tempered', composted: 'Discarded',
}
/** Rows shown before the rest fold behind "more"; live work is always shown whole. */
const HOLDS_SHOWN = 5

/** The feed's constitutions whose roster names this role, in Desk order. */
export function roleHolds(cards: KanbanCard[], slug: string): KanbanCard[] {
  const rank = (card: KanbanCard) => HOLD_ORDER.indexOf(fiberPageColumn(card))
  return cards.filter(card => card.roles?.includes(slug)).sort((a, b) => rank(a) - rank(b))
}

/** What the page shows of each hold, so a feed poll that changes none of it leaves the page alone. */
export function holdsRevision(holds: KanbanCard[]): unknown[] {
  return holds.map(card => [card.originId, card.uid ?? card.id, card.name, card.outcome, fiberPageColumn(card)])
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
  const column = fiberPageColumn(card)
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
  const live = holds.filter(card => LIVE.has(fiberPageColumn(card))).length
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

/**
 * The holder pages `roles/<slug>/<holder>` the fiber index names, as quiet
 * links. The line stays hidden until the index lands, and for good when it
 * names none.
 */
function holdersLine(slug: string, opts: { shuttleBase: string; onFiber: (id: string) => void }): HTMLElement {
  const line = document.createElement('section')
  line.className = 'ws-role-holders'
  line.dataset.part = 'role-holders'
  line.hidden = true
  const prefix = `roles/${slug}/`
  void fiberIndex(opts.shuttleBase).then(async index => {
    const ids = index.map(row => row.id).filter(id => id.startsWith(prefix) && !id.slice(prefix.length).includes('/')).sort()
    if (ids.length === 0) return
    const names = document.createElement('span')
    names.className = 'ws-role-holder-names'
    for (const id of ids) {
      const holder = document.createElement('span')
      holder.className = 'ws-role-holder'
      const link = document.createElement('a')
      link.className = 'kbn-wikilink'
      link.dataset.fiber = id
      link.dataset.wikilinkRaw = id.slice(prefix.length)
      link.textContent = id.slice(prefix.length)
      holder.append(link)
      names.append(holder)
    }
    line.append(caption('Held by'), names)
    await installWikilinks(names, { shuttleBase: opts.shuttleBase, onOpen: opts.onFiber, exact: true })
    line.hidden = false
  }).catch(() => { /* No index, no holders: the page reads without them. */ })
  return line
}

/** A role page's ledger under its lede: who holds the role, and the constitutions it holds. */
export function buildRoleLedger(
  slug: string,
  holds: KanbanCard[],
  opts: { shuttleBase: string; onFiber: (id: string) => void; onCard: (card: KanbanCard) => void },
): HTMLElement {
  const ledger = document.createElement('div')
  ledger.className = 'ws-role-ledger'
  ledger.dataset.part = 'role-ledger'
  ledger.append(holdersLine(slug, opts))
  if (holds.length) ledger.append(holdsSection(holds, opts.onCard))
  return ledger
}
