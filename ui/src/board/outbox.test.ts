import { describe, expect, it } from 'vitest'
import { COLD_MS, composeChannels, officeOf, setAsideKey, waitingOn, type HeldSpeech } from './outbox.js'
import { inFlightBand } from './KanbanReadModel.js'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'

const now = Date.parse('2026-11-14T12:00:00Z'), reachMs = 14 * 86_400_000, minute = 60_000
const at = (minutes: number): string => new Date(now - minutes * minute).toISOString()
const idle = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const, lastActivityAt: now - minutes * minute })

// The analyst office: an idle top-level with threads (one asking, one for review, one working, an editor's,
// a grandchild asking, and one under an archived thread), and a second analyst top-level at work.
const shear = card({ id: 'shear', uid: 'S', name: 'Cosmic shear', shuttleRole: 'analyst/cail', outcome: 'The null passes.', ...idle(4) })
const mask = card({ id: 'mask', uid: 'M', orchestrator: 'S', status: 'active', ask: { text: 'Keep the conservative mask?', at: at(30) } })
const cuts = card({ id: 'cuts', uid: 'C', orchestrator: 'S', column: 'awaitingReview', closedAt: at(90), outcome: 'The cut is validated.' })
const covariance = card({ id: 'covariance', uid: 'V', orchestrator: 'S', status: 'active', workerState: 'running', runtimePhase: 'working' })
const methods = card({ id: 'methods', uid: 'E', orchestrator: 'S', shuttleRole: 'editor', status: 'active', workerState: 'running', runtimePhase: 'working', outcome: 'Written up.', lastActivityAt: now - 60 * minute })
const tail = card({ id: 'tail', uid: 'T', orchestrator: 'M', status: 'active', ask: { text: 'Check the tail?', at: at(5) } })
const done = card({ id: 'done', uid: 'D', orchestrator: 'S', column: 'tempered', status: 'closed', closedAt: at(900) })
const after = card({ id: 'after', uid: 'A', orchestrator: 'D', ...idle(50) })
const lensing = card({ id: 'lensing', uid: 'L', shuttleRole: 'analyst', status: 'active', workerState: 'running', runtimePhase: 'working', lastActivityAt: now - 2 * minute })
// The vizier office: a seat alone, at the end of its turn, and a second top-level of the office asking.
const vizier = card({ id: 'life/vizier', uid: 'Z', name: 'Vizier', shuttleRole: 'vizier', shuttleSeat: true, ...idle(1) })
const deed = card({ id: 'deed', uid: 'F', shuttleRole: 'vizier', status: 'active', ask: { text: 'Sign it?', at: at(20) } })
// A top-level without an office, waiting through its thread; a quiet one.
const move = card({ id: 'move', uid: 'R', name: 'Moving house', status: 'active' })
const van = card({ id: 'van', uid: 'B', orchestrator: 'R', status: 'active', ask: { text: 'Which van?', at: at(10) } })
const score = card({ id: 'score', uid: 'Q', name: 'Second movement', status: 'active', workerState: 'running', runtimePhase: 'working' })

const files: SentFile[] = [
  { uid: 'C', host: 'local', fullPath: '/cuts.png', basename: 'cuts.png', timestamp: now - 20 * minute },
  { uid: 'Q', host: 'local', fullPath: '/score.pdf', basename: 'score.pdf', timestamp: now - 20 * minute },
  { uid: 'M', host: 'local', fullPath: '/old.png', basename: 'old.png', timestamp: now - reachMs - 1 },
]
const held: HeldSpeech[] = [{ fiber_id: 'V', name: 'covariance', n: 2, first: 'The run finished.', at: now - minute }]

type Input = Parameters<typeof composeChannels>[0]
function compose(cards: KanbanCard[], over: Partial<Input> = {}) {
  const index = new ThreadIndex(cards)
  const input: Input = { cards, parentOf: card => index.parentOf(card), names: new Map([['analyst', 'Analyst'], ['vizier', 'Vizier'], ['editor', 'Editor']]), files, held, dismissed: [], pinned: new Map(), now, reachMs }
  return composeChannels({ ...input, ...over })
}
const listed = (cards: KanbanCard[], over: Partial<Input> = {}) => compose(cards, over).filter(channel => channel.listed).map(channel => channel.key)
const all = [shear, mask, cuts, covariance, methods, tail, done, after, lensing, vizier, deed, move, van, score]

describe('composeChannels', () => {
  it('keys a channel by its top-level constitutions\' office, else by the top-level, whatever office a thread holds', () => {
    expect(officeOf('cmbx-chair/cail')).toBe('cmbx-chair')
    const channels = compose(all)
    expect(channels.map(channel => [channel.key, channel.name, channel.seat.id, channel.listed])).toStrictEqual([
      ['role:vizier', 'Vizier', 'life/vizier', true],
      ['role:analyst', 'Analyst', 'lensing', true],
      ['fiber:R', 'Moving house', 'move', true],
      ['fiber:A', 'after', 'after', true],
      ['fiber:Q', 'Second movement', 'score', false],
    ])
    const analyst = channels[1]
    expect(analyst.messages.map(message => [message.kind, message.card.id, message.text])).toStrictEqual([
      [undefined, 'covariance', ''], ['review', 'cuts', 'The cut is validated.'], [undefined, 'methods', 'Written up.'],
      ['ask', 'mask', 'Keep the conservative mask?'], ['ask', 'tail', 'Check the tail?'], ['turn', 'shear', 'The null passes.'],
    ])
    expect(analyst.newest).toBe(now - 4 * minute)
    expect(analyst.files.map(file => file.basename)).toStrictEqual(['cuts.png'])
    expect(analyst.held.map(line => line.first)).toStrictEqual(['The run finished.'])
  })

  it('lists a seat alone at the end of its turn as a channel, its own seat', () => {
    const [channel] = compose([vizier])
    expect([channel.key, channel.seat, channel.waiting, channel.messages.map(message => message.kind)]).toStrictEqual(['role:vizier', vizier, true, ['turn']])
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

  it('orders by newest wait, then the pinned quiet channels, then the ones gone cold', () => {
    const cold = card({ id: 'cold', uid: 'O', status: 'active', ask: { text: 'Still there?', at: new Date(now - COLD_MS - minute).toISOString() } })
    const channels = compose([...all, cold], { pinned: new Map([['fiber:Q', now]]) })
    expect(channels.filter(channel => channel.listed).map(channel => [channel.key, channel.waiting, channel.cold])).toStrictEqual([
      ['role:vizier', true, false], ['role:analyst', true, false], ['fiber:R', true, false], ['fiber:A', true, false], ['fiber:Q', false, false], ['fiber:O', true, true],
    ])
  })

  it('sets a channel aside until something newer waits in it; a pinned one stays, quiet', () => {
    const vizierChannel = compose(all)[0]
    const dismissed = [setAsideKey(vizierChannel)]
    expect(dismissed).toStrictEqual([`office:role:vizier:${now - minute}`])
    expect(listed(all, { dismissed })).toStrictEqual(['role:analyst', 'fiber:R', 'fiber:A'])
    expect(listed(all, { dismissed, pinned: new Map([['role:vizier', now]]) })).toStrictEqual(['role:analyst', 'fiber:R', 'fiber:A', 'role:vizier'])
    const fresh = card({ id: 'fresh', uid: 'N', shuttleRole: 'vizier', status: 'active', ask: { text: 'One more?', at: new Date(now).toISOString() } })
    expect(listed([...all, fresh], { dismissed })[0]).toBe('role:vizier')
  })

  it('counts a mirrored fiber once and drops a desk header row', () => {
    const channels = compose([move, van, { ...van, originId: 'mirror' }, { ...move, deskSection: 'waiting' as const }])
    expect(channels.map(channel => [channel.key, channel.messages.length])).toStrictEqual([['fiber:R', 1]])
  })
})
