/**
 * What a resting constitution waits for (`shuttle.blocked_on`, written by
 * `shuttle rest --until`): a fiber's uid, or free text. It orders nothing; it
 * is a quiet line that says "⏸ until <name>".
 *
 * A uid names a constitution on the board when the thread index holds it, and
 * then the name is a chip that opens it. Any other fiber is named from the
 * daemon's fiber index once that lands; text reads as itself.
 */

import type { KanbanCard } from './KanbanTypes.js'
import type { ThreadIndex } from './threads.js'
import { fiberIndex } from './wikilinks.js'
import './blockedOn.css'

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i
const BASE = (import.meta.env.VITE_SHUTTLE_BASE as string | undefined) ?? ''

export interface Until {
  /** The name it reads as now. */
  text: string
  /** The constitution it names, when the board holds it. */
  card?: KanbanCard
  /** The stored fiber reference, when it names a fiber rather than text. */
  ref?: string
}

/** What `card` rests until, named from the board; null when it waits for nothing. */
export function untilOf(card: Pick<KanbanCard, 'shuttleBlockedOn'>, index?: ThreadIndex | null): Until | null {
  const raw = card.shuttleBlockedOn
  if (!raw) return null
  if (!ULID.test(raw) && !raw.includes('/')) return { text: raw }
  const named = index?.fiber(raw)
  if (named) return { text: named.name, card: named, ref: raw }
  return { text: raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : '…', ref: raw }
}

/** The current name of a fiber the board does not hold, from the daemon's fiber index. */
export async function nameRef(ref: string, shuttleBase = BASE): Promise<string | null> {
  try {
    const rows = await fiberIndex(shuttleBase)
    const upper = ref.toUpperCase()
    return rows.find(r => r.uid?.toUpperCase() === upper || r.id === ref)?.name ?? null
  } catch {
    return null
  }
}

/** The state-line words: "⏸ until <name>". */
export const untilWords = (until: Until): string => `⏸ until ${until.text}`

/**
 * The muted one-line "⏸ until <name>". A constitution on the board is a chip
 * that opens it; a fiber off the board is named when the index lands.
 */
export function untilLine(until: Until, open?: (card: KanbanCard) => void): HTMLElement {
  const line = document.createElement('span')
  line.className = 'kbn-until'
  line.append('⏸ until ')
  const name = document.createElement('span')
  name.className = 'kbn-until-name'
  name.textContent = until.text
  line.title = `Resting until ${until.text}`
  if (until.card && open) {
    const target = until.card
    name.classList.add('kbn-until-chip')
    name.setAttribute('role', 'link')
    name.title = `Open ${target.name}`
    name.addEventListener('click', event => { event.stopPropagation(); open(target) })
    name.addEventListener('pointerdown', event => event.stopPropagation())
  } else if (until.ref && !until.card) {
    void nameRef(until.ref).then(found => {
      if (!found) { if (name.textContent === '…') name.textContent = until.ref!; return }
      name.textContent = found
      line.title = `Resting until ${found}`
    })
  }
  line.append(name)
  return line
}
