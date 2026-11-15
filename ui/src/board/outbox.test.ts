import { describe, expect, it } from 'vitest'
import { COLD_MS, composeChannels, setAsideKey, waitingOn, type HeldSpeech } from './outbox.js'
import { inFlightBand } from './KanbanReadModel.js'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'

const now = Date.parse('2026-11-14T12:00:00Z'), reachMs = 14 * 86_400_000, minute = 60_000
const at = (minutes: number): string => new Date(now - minutes * minute).toISOString()
const idle = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const, lastActivityAt: now - minutes * minute })

// The shear family: an idle orchestrator with a role, a thread asking, a closed thread for review,
// a working thread, and a grandchild that asks; a thread under it was archived, and its child still hangs from it.
const shear = card({ id: 'shear', uid: 'S', name: 'Cosmic shear', shuttleRole: 'analyst', outcome: 'The null passes.', ...idle(4) })
const mask = card({ id: 'mask', uid: 'M', orchestrator: 'S', status: 'active', ask: { text: 'Keep the conservative mask?', at: at(30) } })
const cuts = card({ id: 'cuts', uid: 'C', orchestrator: 'S', column: 'awaitingReview', closedAt: at(90), outcome: 'The cut is validated.' })
const covariance = card({ id: 'covariance', uid: 'V', orchestrator: 'S', status: 'active', workerState: 'running', runtimePhase: 'working' })
const tail = card({ id: 'tail', uid: 'T', orchestrator: 'M', status: 'active', ask: { text: 'Check the tail?', at: at(5) } })
const done = card({ id: 'done', uid: 'D', orchestrator: 'S', column: 'tempered', status: 'closed', closedAt: at(900) })
const after = card({ id: 'after', uid: 'A', orchestrator: 'D', ...idle(50) })
// A family that waits only on its thread, and a quiet one.
const move = card({ id: 'move', uid: 'R', name: 'Moving house', status: 'active' })
const van = card({ id: 'van', uid: 'B', orchestrator: 'R', status: 'active', ask: { text: 'Which van?', at: at(10) } })
const score = card({ id: 'score', uid: 'Q', status: 'active', workerState: 'running', runtimePhase: 'working' })

const files: SentFile[] = [
  { uid: 'C', host: 'local', fullPath: '/cuts.png', basename: 'cuts.png', timestamp: now - 20 * minute },
  { uid: 'Q', host: 'local', fullPath: '/score.pdf', basename: 'score.pdf', timestamp: now - 20 * minute },
  { uid: 'M', host: 'local', fullPath: '/old.png', basename: 'old.png', timestamp: now - reachMs - 1 },
]
const held: HeldSpeech[] = [{ fiber_id: 'V', name: 'covariance', n: 2, first: 'The run finished.', at: now - minute }]

function compose(cards: KanbanCard[], over: Partial<Parameters<typeof composeChannels>[0]> = {}) {
  const index = new ThreadIndex(cards)
  return composeChannels({ cards, parentOf: card => index.parentOf(card), names: new Map([['analyst', 'Analyst · sound results']]), files, held, dismissed: [], now, reachMs, ...over })
}
const all = [shear, mask, cuts, covariance, tail, done, after, move, van, score]

describe('composeChannels', () => {
  it('gathers a family under its topmost live ancestor and lists it only while something in it waits', () => {
    const channels = compose(all)
    expect(channels.map(channel => [channel.key, channel.root.name, channel.role])).toStrictEqual([
      ['S', 'Cosmic shear', 'Analyst · sound results'],
      ['R', 'Moving house', undefined],
      ['A', 'after', undefined],
    ])
    const [family] = channels
    expect(family.waiting.map(item => [item.kind, item.card.id, item.text])).toStrictEqual([
      ['turn', 'shear', 'The null passes.'], ['ask', 'tail', 'Check the tail?'], ['ask', 'mask', 'Keep the conservative mask?'], ['review', 'cuts', 'The cut is validated.'],
    ])
    expect(family.newest).toBe(now - 4 * minute)
    expect(family.threads.map(card => card.id)).toStrictEqual(['covariance'])
    expect(family.files.map(file => file.basename)).toStrictEqual(['cuts.png'])
    expect(family.held.map(line => line.first)).toStrictEqual(['The run finished.'])
  })

  it('waits on exactly the cards the Desk puts in Your turn, with asks and reviews beside them', () => {
    const turns = [
      card({ id: 'idle', uid: 'I1', ...idle(3) }),
      card({ id: 'blocked', uid: 'I2', status: 'active', workerState: 'blocked', lastActivityAt: now - minute }),
      card({ id: 'prompt', uid: 'I3', status: 'active', workerState: 'running', runtimePhase: 'attention', lastActivityAt: now - minute }),
      card({ id: 'working', uid: 'I4', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      card({ id: 'followed', uid: 'I5', ...idle(3), followed: true }),
      card({ id: 'unstarted', uid: 'I6', status: 'active' }),
    ]
    const yours = turns.filter(card => card.column === 'inFlight' && inFlightBand(card) === 'yourTurn').map(card => card.id)
    expect(yours).toStrictEqual(['idle', 'blocked', 'prompt'])
    expect(turns.filter(card => waitingOn(card)).map(card => card.id)).toStrictEqual(yours)
    expect(turns.map(card => waitingOn(card)?.kind)).toStrictEqual(['turn', 'turn', 'ask', undefined, undefined, undefined])
    // An ask counts only on an active card; a review only when it waits on the human, a mark's note first.
    expect(waitingOn({ ...mask, status: 'closed', column: 'tempered' })).toBeUndefined()
    expect(waitingOn({ ...cuts, column: 'orchestratorReview' })).toBeUndefined()
    expect(waitingOn({ ...cuts, reviewMark: { note: 'Look at the plot.', at: at(3) } })).toMatchObject({ kind: 'review', text: 'Look at the plot.', at: now - 90 * minute })
  })

  it('orders channels by their newest wait and shelves the ones gone cold', () => {
    const cold = card({ id: 'cold', uid: 'O', status: 'active', ask: { text: 'Still there?', at: new Date(now - COLD_MS - minute).toISOString() } })
    const channels = compose([...all, cold])
    expect(channels.map(channel => [channel.key, channel.cold])).toStrictEqual([['S', false], ['R', false], ['A', false], ['O', true]])
    const sooner = { ...van, ask: { text: 'Which van?', at: at(1) } }
    expect(compose([...all.filter(card => card !== van), sooner]).map(channel => channel.key)).toStrictEqual(['R', 'S', 'A'])
  })

  it('sets a channel aside until something newer waits in it', () => {
    const [family] = compose(all)
    const dismissed = [setAsideKey(family)]
    expect(dismissed).toStrictEqual([`office:fiber:S:${now - 4 * minute}`])
    expect(compose(all, { dismissed }).map(channel => channel.key)).toStrictEqual(['R', 'A'])
    const fresh = card({ id: 'fresh', uid: 'F', orchestrator: 'S', status: 'active', ask: { text: 'One more?', at: at(1) } })
    expect(compose([...all, fresh], { dismissed }).map(channel => channel.key)).toStrictEqual(['S', 'R', 'A'])
  })

  it('counts a mirrored fiber once and drops a desk header row', () => {
    const channels = compose([move, van, { ...van, originId: 'mirror' }, { ...move, deskSection: 'waiting' as const }])
    expect(channels.map(channel => [channel.key, channel.waiting.length])).toStrictEqual([['R', 1]])
  })
})
