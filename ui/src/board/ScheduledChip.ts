import type { KanbanCard } from './KanbanTypes.js'
import { hostZone, scheduledTime } from './civilDay.js'
import './scheduledChip.css'

/** Pending delayed publications, including overdue ones, from the owner. */
export function scheduledChip(card: Pick<KanbanCard, 'scheduledMessages'>): HTMLElement | null {
  const entries = [...(card.scheduledMessages ?? [])].sort((a, b) => a.not_before.localeCompare(b.not_before))
  if (!entries.length) return null
  const z = hostZone()
  const details = document.createElement('details'); details.className = 'kbn-scheduled'
  const summary = document.createElement('summary')
  summary.textContent = `${entries.length} scheduled · ${scheduledTime(Date.parse(entries[0].not_before), z)}`
  const lines = entries.map(e => `${scheduledTime(Date.parse(e.not_before), z)} · ${e.from || 'shuttle'}: ${e.text}`)
  summary.title = lines.join('\n')
  const body = document.createElement('div'); body.className = 'kbn-scheduled-lines'
  body.textContent = lines.join('\n')
  details.append(summary, body)
  for (const event of ['click', 'pointerdown', 'mousedown', 'keydown', 'touchstart']) details.addEventListener(event, e => e.stopPropagation())
  return details
}
