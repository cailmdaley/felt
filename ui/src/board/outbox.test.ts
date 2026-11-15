import { describe, expect, it } from 'vitest'
import { composeAudience, setAsideKey, type HeldSpeech } from './outbox.js'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'

const now = Date.parse('2026-11-14T12:00:00Z'), reachMs = 14 * 86_400_000, minute = 60_000
const at = (minutes: number): string => new Date(now - minutes * minute).toISOString()

// The analyst office: a seat, a thread asking, a closed thread for review, a working thread, and a grandchild with no role.
const seat = card({ id: 'roles-seat', uid: 'S', name: 'Analyst seat', status: 'open', shuttleRole: 'analyst', shuttleSeat: true })
const asking = card({ id: 'mask', uid: 'M', status: 'active', shuttleRole: 'analyst', ask: { text: 'Keep the conservative mask?', at: at(30) } })
const review = card({ id: 'cuts', uid: 'C', orchestrator: 'S', column: 'awaitingReview', closedAt: at(90), outcome: 'The cut is validated.' })
const working = card({ id: 'covariance', uid: 'V', orchestrator: 'S', status: 'active', workerState: 'running', runtimePhase: 'working' })
const grandchild = card({ id: 'tail', uid: 'T', orchestrator: 'M', status: 'active', ask: { text: 'Check the tail?', at: at(5) } })
// A root constitution with no office anywhere up its tree, whose thread asks.
const root = card({ id: 'move', uid: 'R', name: 'Moving house', status: 'active' })
const rootThread = card({ id: 'boxes', uid: 'B', orchestrator: 'R', status: 'active', ask: { text: 'Which van?', at: at(10) } })
// An office with nothing blocked stays silent.
const quiet = card({ id: 'score', uid: 'Q', status: 'active', shuttleRole: 'composer', workerState: 'running', runtimePhase: 'working' })

const files: SentFile[] = [
  { uid: 'C', host: 'local', fullPath: '/cuts.png', basename: 'cuts.png', timestamp: now - 20 * minute },
  { uid: 'Q', host: 'local', fullPath: '/score.pdf', basename: 'score.pdf', timestamp: now - 20 * minute },
  { uid: 'M', host: 'local', fullPath: '/old.png', basename: 'old.png', timestamp: now - reachMs - 1 },
]
const held: HeldSpeech[] = [{ fiber_id: 'V', name: 'covariance', n: 2, first: 'The run finished.', at: now - minute }]

function compose(cards: KanbanCard[], over: Partial<Parameters<typeof composeAudience>[0]> = {}) {
  const index = new ThreadIndex(cards)
  return composeAudience({ cards, parentOf: card => index.parentOf(card), names: new Map([['analyst', 'Analyst · sound results']]), files, held, dismissed: [], now, reachMs, ...over })
}
const all = [seat, asking, review, working, grandchild, root, rootThread, quiet]

describe('composeAudience', () => {
  it('groups by role, else the nearest ancestor\'s, else the root, and admits only offices blocked on the human', () => {
    const offices = compose(all)
    expect(offices.map(office => [office.key, office.name, office.seat?.id])).toStrictEqual([
      ['role:analyst', 'Analyst · sound results', 'roles-seat'],
      ['fiber:R', 'Moving house', 'move'],
    ])
    const [analyst, move] = offices
    expect(analyst.blocks.map(block => [block.kind, block.card.id, block.text])).toStrictEqual([
      ['review', 'cuts', 'The cut is validated.'], ['ask', 'mask', 'Keep the conservative mask?'], ['ask', 'tail', 'Check the tail?'],
    ])
    expect([analyst.since, analyst.newest]).toStrictEqual([now - 90 * minute, now - 5 * minute])
    expect(analyst.threads.map(card => card.id)).toStrictEqual(['covariance'])
    expect(analyst.files.map(file => file.basename)).toStrictEqual(['cuts.png'])
    expect(analyst.held.map(line => line.first)).toStrictEqual(['The run finished.'])
    expect(move.blocks.map(block => block.card.id)).toStrictEqual(['boxes'])
  })
  it('orders offices by how long they have waited', () => {
    const early = { ...rootThread, ask: { text: 'Which van?', at: at(600) } }
    expect(compose([...all.filter(card => card !== rootThread), early]).map(office => office.key)).toStrictEqual(['fiber:R', 'role:analyst'])
  })
  it('reuses the item predicates: an ask only on an active card, a review only awaiting the human', () => {
    const cards = [seat, { ...asking, status: 'closed', column: 'tempered' as const }, { ...review, column: 'orchestratorReview' as const }, { ...review, uid: 'D', id: 'desk-copy', deskSection: 'to-review' as const }]
    expect(compose(cards)).toStrictEqual([])
    const marked = card({ id: 'marked', uid: 'K', orchestrator: 'S', column: 'awaitingReview', reviewMark: { note: 'Look at the plot.', at: at(3) } })
    expect(compose([seat, marked])[0].blocks.map(block => [block.kind, block.text, block.at])).toStrictEqual([['review', 'Look at the plot.', now - 3 * minute]])
  })
  it('sets an office aside until something newer blocks in it', () => {
    const [analyst] = compose(all)
    const dismissed = [setAsideKey(analyst)]
    expect(compose(all, { dismissed }).map(office => office.key)).toStrictEqual(['fiber:R'])
    const answered = all.map(card => card === grandchild ? { ...card, ask: undefined } : card)
    expect(compose(answered, { dismissed }).map(office => office.key)).toStrictEqual(['fiber:R'])
    const fresh = card({ id: 'fresh', uid: 'F', status: 'active', shuttleRole: 'analyst', ask: { text: 'One more?', at: at(1) } })
    expect(compose([...all, fresh], { dismissed }).map(office => office.key)).toStrictEqual(['role:analyst', 'fiber:R'])
  })
  it('names an office without a charter by its slug, and counts a mirrored fiber once', () => {
    const offices = compose([asking, { ...asking, originId: 'local' }], { names: new Map() })
    expect(offices.map(office => [office.name, office.blocks.length, office.seat])).toStrictEqual([['analyst', 1, undefined]])
  })
})
