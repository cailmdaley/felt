import type { KanbanCard } from './KanbanTypes.js'
import { NEED_WORD, type FamilyNeed, type ThreadIndex } from './threads.js'
import { stateDot } from './stateDot.js'
import { workerPlateFacts } from './workspace/workerPlate.js'
import './deskFrontier.css'

/** Sub-lines a row lists before the rest fold into `+N more`. */
export const FAMILY_SUBLINES = 3
const TAIL_ORDER: readonly FamilyNeed[] = ['yours', 'review', 'working']

/** The rest of the family in words, only nonzero parts: `2 working · 1 to review`. */
export function familyTail(others: Readonly<Record<FamilyNeed, number>>): string {
  return TAIL_ORDER.filter(need => others[need] > 0).map(need => `${others[need]} ${NEED_WORD[need]}`).join(' · ')
}

/**
 * A family's Desk row, shared by desktop and phone. The row is the node that
 * set the family's column: a thread leads with a quiet crumb to its root, the
 * others asking the same of the human follow as indented sub-lines, and the
 * rest of the tree is a tail of words that opens the family page.
 */
export function installFrontierDetails(host: HTMLElement, end: HTMLElement, card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard, forceRail?: boolean) => void, now = Date.now()): void {
  const family = index.family(index.card(card))
  const ancestry = index.ancestry(card)
  if (ancestry.length) {
    const crumb = document.createElement('span'); crumb.className = 'kbn-card-crumb'
    crumb.title = ancestry.map(part => part.name).join(' › ')
    const first = ancestry[0]
    const head = document.createElement(first.card ? 'button' : 'span')
    head.className = 'kbn-card-crumb-root'
    head.textContent = first.name
    if (first.card) {
      (head as HTMLButtonElement).type = 'button'
      head.addEventListener('click', event => { event.stopPropagation(); open(first.card!, true) })
    }
    crumb.append(head, ancestry.length > 1 ? ' / … /\u00a0' : ' /\u00a0')
    const title = host.querySelector('.kbn-card-name, .kbn-cluster-item-title')
    if (title) title.prepend(crumb)
    else host.prepend(crumb)
  }
  if (family.lead !== index.card(card)) return
  const tail = familyTail(family.others)
  if (tail) {
    const count = document.createElement('button'); count.type = 'button'; count.className = 'kbn-thread-count'
    count.textContent = tail
    count.setAttribute('aria-label', `Also in this family: ${tail}; open its threads`)
    count.addEventListener('click', event => { event.stopPropagation(); open(family.root, true) })
    end.prepend(count)
  }
  const { elapsed } = workerPlateFacts(card, now)
  if (elapsed) {
    const age = document.createElement('span'); age.className = 'kbn-row-elapsed'; age.textContent = elapsed
    end.prepend(age)
  }
  const rest = family.askers.slice(1)
  if (!rest.length) return
  const list = document.createElement('div'); list.className = 'kbn-family-asks'
  list.setAttribute('role', 'list')
  for (const other of rest.slice(0, FAMILY_SUBLINES)) {
    const line = document.createElement('div'); line.className = 'kbn-family-ask'
    line.setAttribute('role', 'listitem')
    const name = document.createElement('button'); name.type = 'button'; name.className = 'kbn-family-ask-name'
    name.textContent = other.name
    name.title = [index.ancestryTitle(other), other.name].filter(Boolean).join(' › ')
    name.addEventListener('click', event => { event.stopPropagation(); open(other) })
    line.append(stateDot(other, open), name)
    const { elapsed: age } = workerPlateFacts(other, now)
    if (age) { const el = document.createElement('span'); el.className = 'kbn-row-elapsed'; el.textContent = age; line.append(el) }
    list.append(line)
  }
  if (rest.length > FAMILY_SUBLINES) {
    const more = document.createElement('button'); more.type = 'button'; more.className = 'kbn-family-more'
    more.textContent = `+${rest.length - FAMILY_SUBLINES} more`
    more.addEventListener('click', event => { event.stopPropagation(); open(family.root, true) })
    list.append(more)
  }
  host.append(list)
}
