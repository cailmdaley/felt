import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'
import { threadState } from './threads.js'

export interface HeldSpeech {
  fiber_id: string
  name: string
  n: number
  first: string
  at: number
}
interface Item {
  key: string
  name: string
  text: string
  at: number
  fiber?: string
  card?: KanbanCard
}
export type OutboxItem =
  | (Item & { kind: 'ask' | 'review' | 'spoken'; card?: KanbanCard })
  | (Item & { kind: 'file'; file: SentFile })

/** What the fleet deliberately addressed to the human, within the board's reach. */
export function composeOutbox(input: {
  cards: readonly KanbanCard[]
  files: readonly SentFile[]
  held: readonly HeldSpeech[]
  dismissed: ReadonlySet<string>
  now: number
  reachMs: number
}): OutboxItem[] {
  const { cards, files, held, dismissed, now, reachMs } = input
  const items = new Map<string, OutboxItem>()
  const add = (item: OutboxItem): void => {
    if (Number.isFinite(item.at) && item.at >= now - reachMs && !dismissed.has(item.key) && !items.has(item.key)) items.set(item.key, item)
  }
  const real = cards.filter(card => !card.deskSection)
  for (const card of real) {
    const fiber = card.uid ?? card.id
    const base = { fiber, card, name: card.name }
    if (card.ask) add({ ...base, kind: 'ask', key: `ask:${fiber}:${card.ask.at}`, text: card.ask.text, at: Date.parse(card.ask.at) })
    if (threadState(card) === 'to-review') {
      const at = card.reviewMark?.at ?? card.closedAt ?? ''
      add({ ...base, kind: 'review', key: `review:${fiber}:${at}`, text: card.reviewMark?.note || card.outcome || '', at: Date.parse(at) })
    }
  }
  for (const file of files) {
    const card = file.uid ? real.find(card => (card.uid ?? card.id) === file.uid) : undefined
    add({ kind: 'file', key: `file:${file.host ?? ''}:${file.fullPath}:${file.timestamp}`, name: card?.name ?? file.sessionId ?? file.host ?? 'Unattributed file', text: file.basename, at: file.timestamp, fiber: card?.uid ?? file.uid, card, file })
  }
  for (const speech of held) {
    const card = real.find(card => (card.uid ?? card.id) === speech.fiber_id || card.id === speech.fiber_id)
    add({ kind: 'spoken', key: `spoken:${speech.fiber_id}:${digest(speech.first)}`, name: card?.name ?? speech.name, text: speech.first, at: speech.at, fiber: card?.uid ?? speech.fiber_id, card })
  }
  return [...items.values()].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
}

/** A short stable digest, so a key stays well inside a board record's text limit. */
function digest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(36)
}
