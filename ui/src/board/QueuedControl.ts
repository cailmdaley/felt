import type { KanbanCard } from './KanbanTypes.js'
import { queueMemberNote, queuedChipLabel } from './KanbanRules.js'

/** Desk's queue peek, shared by every surface that draws a queue head. */
export function queuedControl(
  card: KanbanCard,
  ids: readonly string[],
  members: readonly (KanbanCard | null | undefined)[],
  open: (card: KanbanCard) => void,
): { chip: HTMLButtonElement; list: HTMLOListElement } {
  const names = members.map((member, i) => member?.name ?? ids[i])
  const notes = members.map(member => member ? queueMemberNote(member) : null)
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'kbn-card-queued'
  chip.textContent = queuedChipLabel(ids.length)
  chip.setAttribute('aria-expanded', 'false')
  chip.setAttribute('aria-label', `${ids.length} card${ids.length === 1 ? '' : 's'} queued behind ${card.name} — show them`)
  chip.title = `Waiting on this one, in order: ${names.map((name, i) => notes[i] ? `${name} (${notes[i]})` : name).join(' → ')}`
  const list = document.createElement('ol')
  list.className = 'kbn-card-queued-list'
  list.hidden = true
  names.forEach((name, i) => {
    const row = document.createElement('li')
    row.className = 'kbn-card-queued-row'
    row.textContent = name
    const note = notes[i]
    if (note) {
      row.classList.add('kbn-card-queued-row--settled', note === 'awaiting review' ? 'kbn-card-queued-row--review' : 'kbn-card-queued-row--discarded')
      const suffix = document.createElement('span')
      suffix.className = 'kbn-card-queued-note'
      suffix.textContent = ` · ${note}`
      row.append(suffix)
    }
    row.title = `Open “${name}”${note ? ` (${note})` : ''}.`
    const member = members[i]
    if (member) {
      row.dataset.cardUid = member.uid ?? member.id
      row.dataset.cardOrigin = member.originId
    }
    row.tabIndex = 0
    row.setAttribute('role', 'button')
    row.addEventListener('click', event => {
      event.stopPropagation()
      if (member) open(member)
    })
    row.addEventListener('keydown', event => {
      if (!['Enter', ' '].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      if (!event.repeat && member) open(member)
    })
    list.append(row)
  })
  chip.addEventListener('click', event => {
    event.stopPropagation()
    list.hidden = !list.hidden
    chip.setAttribute('aria-expanded', String(!list.hidden))
  })
  return { chip, list }
}
