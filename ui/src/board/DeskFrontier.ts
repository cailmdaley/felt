import type { KanbanCard } from './KanbanTypes.js'
import type { ThreadIndex } from './threads.js'
import './deskFrontier.css'

/** Shared by desktop and phone: ancestry navigates, the count opens the rail. */
export function installFrontierDetails(host: HTMLElement, end: HTMLElement, card: KanbanCard, index: ThreadIndex, open: (card: KanbanCard, forceRail?: boolean) => void): void {
  const ancestry = index.ancestry(card)
  if (ancestry.length) {
    const line = document.createElement('div'); line.className = 'kbn-card-ancestry'
    for (const ancestor of ancestry) {
      const part = document.createElement(ancestor.card ? 'button' : 'span')
      part.textContent = ancestor.name
      if (ancestor.card) {
        (part as HTMLButtonElement).type = 'button'
        part.addEventListener('click', event => { event.stopPropagation(); open(ancestor.card!) })
      }
      line.append(part, ' › ')
    }
    host.prepend(line)
  }
  const { awakeDescendants: n, waitingDescendants: waiting } = index.awakeCounts(card)
  if (!n) return
  const count = document.createElement('button'); count.type = 'button'; count.className = 'kbn-thread-count'
  count.textContent = `${n}${waiting ? ` · ${waiting} waiting` : ''}`
  count.classList.toggle('kbn-thread-count-waiting', waiting > 0)
  count.setAttribute('aria-label', `${n} awake descendants${waiting ? `, ${waiting} waiting on you` : ''}; open threads`)
  count.addEventListener('click', event => { event.stopPropagation(); open(card, true) })
  end.prepend(count)
}
