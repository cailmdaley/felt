import type { KanbanCard } from './KanbanTypes.js'
import type { FamilyNeed, ThreadIndex } from './threads.js'
import { stateDot } from './stateDot.js'
import { workerPlateFacts } from './workspace/workerPlate.js'
import './deskFrontier.css'

/** Sub-lines a row lists before the rest fold into `+N more`. */
export const FAMILY_SUBLINES = 3

/** The rest of the family as two numbers: threads working, and threads needing the human (a turn or a verdict). */
export function familyCounts(others: Readonly<Record<FamilyNeed, number>>): { working: number; needs: number } {
  return { working: others.working, needs: others.yours + others.review }
}

/**
 * A family's Desk row, shared by desktop and phone. The row is the node that
 * set the family's column: a thread leads with a quiet crumb to its root, the
 * others asking the same of the human follow as indented sub-lines, and the
 * rest of the tree is a blue number working and an orange one needing the
 * human, which open the family page.
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
  if (family.root !== index.card(card)) host.setAttribute('aria-label', `${family.root.name} / ${host.getAttribute('aria-label') ?? card.name}`)
  const { working, needs } = familyCounts(family.others)
  if (working || needs) {
    const count = document.createElement('button'); count.type = 'button'; count.className = 'kbn-thread-count'
    const words: string[] = []
    if (working) { const n = document.createElement('span'); n.className = 'kbn-count-working'; n.textContent = String(working); count.append(n); words.push(`${working} working`) }
    if (needs) { const n = document.createElement('span'); n.className = 'kbn-count-needs'; n.textContent = String(needs); count.append(n); words.push(`${needs} needing you`) }
    count.title = `${words.join(', ')} elsewhere in this family`
    count.setAttribute('aria-label', `${count.title}; open its threads`)
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
    // A sub-line is its own node: nothing on it reaches the row's click, drag, selection or long press.
    line.addEventListener('click', event => { event.stopPropagation(); if (!(event.target as HTMLElement).closest('button')) open(other) })
    for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) line.addEventListener(type, event => event.stopPropagation())
    // No menu of its own, and not the row's: neither the row's nor the browser's.
    line.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation() })
    line.addEventListener('dragstart', event => { event.preventDefault(); event.stopPropagation() })
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
    for (const type of ['pointerdown', 'mousedown', 'touchstart'] as const) more.addEventListener(type, event => event.stopPropagation())
    more.addEventListener('click', event => { event.stopPropagation(); open(family.root, true) })
    list.append(more)
  }
  host.append(list)
}
