import { describe, expect, it } from 'vitest'
import { RECENT_MS, channelLines, composeChannels, composeMessages, liveness, setAsideKey, threadOf, unpinKey, waitsSince, type BoardRecord, type Channel } from './channels.js'
import { inFlightBand } from './KanbanReadModel.js'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import type { KanbanCard } from './KanbanTypes.js'
import type { SentFile } from './sentFiles.js'

const now = Date.parse('2026-11-14T12:00:00Z'), reachMs = 14 * 86_400_000, minute = 60_000, day = 86_400_000
const at = (minutes: number): string => new Date(now - minutes * minute).toISOString()
const idle = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const, lastActivityAt: now - minutes * minute })
const working = (minutes: number) => ({ status: 'active' as const, workerState: 'running' as const, runtimePhase: 'working' as const, lastActivityAt: now - minutes * minute })

// UNIONS: a seated chair with two seated hubs under it, and a thread under a hub that names no channel of its own.
const unions = card({ id: 'pando/unions', uid: 'U', name: 'UNIONS', shuttleChannel: 'UNIONS', shuttleSeat: true, ...idle(30) })
const east = card({ id: 'east-unions', uid: 'N', orchestrator: 'U', shuttleSeat: true, shuttleKind: 'standing', ...working(2) })
const west = card({ id: 'west-unions', uid: 'F', orchestrator: 'U', shuttleSeat: true, ...working(1) })
const modes = card({ id: 'pando/unions/modes', uid: 'W', name: 'n(z) modes', orchestrator: 'F', status: 'active', ask: { text: 'Open the PR?', at: at(20) } })
// Vizier: two seats, one standing and fresher; the oneshot one chairs.
const vizier = card({ id: 'life/vizier', uid: 'Z', name: 'Vizier', shuttleChannel: 'Vizier', shuttleSeat: true, shuttleRole: 'vizier', ...idle(50) })
const post = card({ id: 'loom/email/morning-post', uid: 'P', name: 'Morning post', shuttleChannel: 'Vizier', shuttleSeat: true, shuttleKind: 'standing', ...working(1) })
// An office without a channel; a lone top-level; one idle for more than a week.
const shear = card({ id: 'shear', uid: 'S', name: 'Cosmic shear', shuttleRole: 'analyst', ...working(5) })
const van = card({ id: 'van', uid: 'R', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(10) } })
const old = card({ id: 'old', uid: 'O', name: 'Old notes', status: 'open', modifiedAt: new Date(now - RECENT_MS - day).toISOString() })

const all = [unions, east, west, modes, vizier, post, shear, van, old]
type Input = Parameters<typeof composeChannels>[0]
function compose(cards: KanbanCard[], over: Partial<Input> = {}): Channel[] {
  const index = new ThreadIndex(cards)
  return composeChannels({ cards, parentOf: card => index.parentOf(card), names: new Map([['analyst', 'Analyst · the shear desk']]), dismissed: [], pinned: new Map(), opened: () => -Infinity, now, ...over })
}
const named = (channels: Channel[], key: string): Channel => channels.find(channel => channel.key === key)!

describe('composeChannels', () => {
  it('groups by shuttle.channel, inherited through the orchestrator, else by office, else by top-level; chaired channels first by name', () => {
    const channels = compose(all)
    expect(channels.map(channel => [channel.key, channel.name, channel.chaired, channel.members.map(member => member.id)])).toStrictEqual([
      ['role:analyst', 'Analyst', true, ['shear']],
      ['channel:UNIONS', 'UNIONS', true, ['pando/unions', 'east-unions', 'west-unions', 'pando/unions/modes']],
      ['channel:Vizier', 'Vizier', true, ['life/vizier', 'loom/email/morning-post']],
      ['fiber:R', 'Moving house', false, ['van']],
      ['fiber:O', 'Old notes', false, ['old']],
    ])
    expect(named(channels, 'role:analyst').title).toBe('Analyst · the shear desk')
    expect(named(channels, 'channel:UNIONS').families).toStrictEqual(['U'])
  })

  it('follows the orchestrator link, not where a fiber is filed, and a thread\'s own channel wins', () => {
    // Filed under UNIONS but orchestrated by the vizier: it speaks in Vizier.
    const errand = card({ id: 'pando/unions/errand', uid: 'E', orchestrator: 'Z', status: 'active' })
    const paper = card({ id: 'pando/unions/paper', uid: 'Q', orchestrator: 'U', shuttleChannel: 'SPT', status: 'active' })
    const channels = compose([...all, errand, paper])
    expect(named(channels, 'channel:Vizier').members.map(member => member.id)).toContain('pando/unions/errand')
    expect(named(channels, 'channel:SPT').members.map(member => member.id)).toStrictEqual(['pando/unions/paper'])
  })

  it('chairs a channel with its topmost seat, a non-standing one first, then the most recently active', () => {
    const channels = compose(all)
    expect(named(channels, 'channel:UNIONS').seat.id).toBe('pando/unions')
    expect(named(channels, 'channel:Vizier').seat.id).toBe('life/vizier')
    // Without a seat, the most recently active top-level.
    const lone = card({ id: 'lone', uid: 'L', shuttleChannel: 'French', ...working(40) })
    const lesson = card({ id: 'lesson', uid: 'L2', orchestrator: 'L', ...working(1) })
    expect(named(compose([lone, lesson]), 'channel:French').seat.id).toBe('lone')
  })

  it('lists a channel waiting, pinned, or opened or active within a week; a set-aside clears its waiting mark', () => {
    const listed = (over: Partial<Input> = {}) => compose(all, over).filter(channel => channel.listed).map(channel => channel.key)
    expect(listed()).not.toContain('fiber:O')
    expect(listed({ opened: key => key === 'fiber:O' ? now - day : -Infinity })).toContain('fiber:O')
    expect(listed({ pinned: new Map([['fiber:O', now - 2 * day]]) })).toContain('fiber:O')
    expect(listed({ pinned: new Map([['fiber:O', now - 2 * day]]), dismissed: [unpinKey('fiber:O', now - day)] })).not.toContain('fiber:O')
    const moving = named(compose(all), 'fiber:R')
    expect([moving.waiting, moving.newest]).toStrictEqual([true, now - 10 * minute])
    expect(setAsideKey(moving)).toBe(`office:fiber:R:${now - 10 * minute}`)
    const aside = named(compose(all, { dismissed: [setAsideKey(moving)] }), 'fiber:R')
    // Set aside and idle for weeks, it leaves the rail until something new waits in it.
    expect([aside.waiting, aside.listed]).toStrictEqual([false, false])
    // A newer wait brings the mark back.
    const again = named(compose([...all.filter(each => each !== van), { ...van, ask: { text: 'And the boxes?', at: at(1) } }], { dismissed: [setAsideKey(moving)] }), 'fiber:R')
    expect(again.waiting).toBe(true)
  })

  it('waits on exactly the cards the Desk puts in Your turn, with asks and reviews beside them', () => {
    const turns = [
      card({ id: 'idle', uid: 'I1', ...idle(3) }),
      card({ id: 'blocked', uid: 'I2', status: 'active', workerState: 'blocked', lastActivityAt: now - minute }),
      card({ id: 'prompt', uid: 'I3', status: 'active', workerState: 'running', runtimePhase: 'attention', lastActivityAt: now - minute }),
      card({ id: 'working', uid: 'I4', ...working(1) }),
      card({ id: 'followed', uid: 'I5', ...idle(3), followed: true }),
      card({ id: 'unstarted', uid: 'I6', status: 'active' }),
    ]
    const yours = turns.filter(card => card.column === 'inFlight' && inFlightBand(card) === 'yourTurn').map(card => card.id)
    expect(yours).toStrictEqual(['idle', 'blocked', 'prompt'])
    expect(turns.filter(card => waitsSince(card) > 0).map(card => card.id)).toStrictEqual(yours)
    expect(waitsSince(card({ id: 'review', column: 'awaitingReview', closedAt: at(90) }))).toBe(now - 90 * minute)
  })
})

describe('composeMessages', () => {
  const record = (over: Partial<BoardRecord> & Pick<BoardRecord, 'id' | 'kind'>, minutes: number): BoardRecord => ({ timestamp: now - minutes * minute, ...over })
  const cuts = card({ id: 'cuts', uid: 'C', name: 'Depth cuts', orchestrator: 'U', column: 'awaitingReview', closedAt: at(15), reviewMark: { note: 'The plot is attached.', at: at(15) }, outcome: 'Validated.' })
  const stuck = card({ id: 'stuck', uid: 'K', name: 'Stuck', orchestrator: 'U', status: 'active', workerState: 'blocked', launchError: 'No allocation left.', lastActivityAt: now - 3 * minute })
  const quiet = card({ id: 'quiet', uid: 'Y', name: 'Quiet', orchestrator: 'U', ...working(1), outcome: 'Running the chains.' })
  const cards = [unions, east, west, modes, cuts, stuck, quiet]
  const channel = named(compose(cards), 'channel:UNIONS')
  const files: SentFile[] = [
    { uid: 'F', host: 'local', fullPath: '/west/run.log', basename: 'run.log', timestamp: now - 40 * minute },
    { uid: 'F', host: 'local', fullPath: '/west/s8.png', basename: 's8.png', timestamp: now - 40 * minute },
    { uid: 'C', host: 'local', fullPath: '/cuts/cut.png', basename: 'cut.png', timestamp: now - 16 * minute },
    { uid: 'N', host: 'local', fullPath: '/east/chains.md', basename: 'chains.md', timestamp: now - 300 * minute },
    { uid: 'N', host: 'local', fullPath: '/east/old.md', basename: 'old.md', timestamp: now - reachMs - 1 },
  ]
  const records: BoardRecord[] = [
    record({ id: 'r1', kind: 'post', fiber: 'F', by: { fiber: 'F' }, text: 'S8 is in; the plot and the log are attached.', files: ['/west/s8.png', '/west/run.log'] }, 40),
    record({ id: 'r2', kind: 'asked', fiber: 'W', by: { fiber: 'W' }, text: 'Open the PR?' }, 20),
    record({ id: 'r3', kind: 'closed', fiber: 'C', by: { fiber: 'C' } }, 15),
    record({ id: 'r4', kind: 'closed', fiber: 'N', by: { fiber: 'N' } }, 100),
    record({ id: 'r5', kind: 'handed_off', fiber: 'N', by: { fiber: 'N' } }, 90),
    record({ id: 'r6', kind: 'human', fiber: 'F', by: { label: 'Sam' }, text: 'me: how is the run going?' }, 50),
    record({ id: 'r7', kind: 'message', fiber: 'U', by: { label: 'human' }, text: 'Keep going.' }, 5),
    record({ id: 'r8', kind: 'message', fiber: 'F', by: { fiber: 'U', session: 'shuttle://h/claude/1' }, to: { fiber: 'F' }, text: 'Rerun with the new mask.' }, 45),
    record({ id: 'r9', kind: 'message', fiber: 'N', by: { label: 'external' }, text: 'Job 6400 finished.' }, 80),
    record({ id: 'r10', kind: 'answered', fiber: 'W', by: { label: 'Sam' }, text: 'Q: Which mask? — A: The conservative one.' }, 25),
    record({ id: 'r11', kind: 'post', fiber: 'Elsewhere', by: { fiber: 'Elsewhere' }, text: 'Not a member.' }, 3),
  ]
  const messages = composeMessages({ channel, records, files, now, reachMs, tapestry: { path: '/unions/tapestry.html', at: now - 2 * minute, title: 'UNIONS, as it stands', lede: 'S8 is measured.' } })
  const stream = messages.filter(message => !message.quiet)

  it('reads the stream oldest first: posts with their files, asks, reviews, the human\'s replies, files alone, the tapestry', () => {
    expect(stream.map(message => [message.kind, message.card.id, message.text, message.waiting, message.files.map(file => file.basename)])).toStrictEqual([
      ['file', 'east-unions', '', false, ['chains.md']],
      ['handed_off', 'east-unions', '', false, []],
      ['post', 'west-unions', 'S8 is in; the plot and the log are attached.', false, ['s8.png', 'run.log']],
      ['reply', 'pando/unions/modes', 'The conservative one.', false, []],
      ['ask', 'pando/unions/modes', 'Open the PR?', true, []],
      ['review', 'cuts', 'The plot is attached.', true, ['cut.png']],
      ['reply', 'pando/unions', 'Keep going.', false, []],
      ['turn', 'stuck', 'No allocation left.', true, []],
      ['tapestry', 'pando/unions', 'S8 is measured.', false, []],
    ])
    expect(stream.filter(message => message.human).map(message => message.card.id)).toStrictEqual(['pando/unions/modes', 'pando/unions'])
    // A worker with nothing to say is not in the stream; its outcome stays on its card.
    expect(messages.some(message => message.card.id === 'quiet')).toBe(false)
  })

  it('keeps a worker\'s thread: its chat with the human, what others wrote to it, and its plain closes', () => {
    expect(threadOf(messages, west).map(message => [message.kind, message.human, message.from?.id ?? message.label ?? ''])).toStrictEqual([
      ['reply', true, ''], ['chat', false, 'pando/unions'], ['post', false, ''],
    ])
    expect(threadOf(messages, east).map(message => [message.kind, message.quiet, message.label ?? ''])).toStrictEqual([
      ['file', false, ''], ['closed', true, ''], ['handed_off', false, ''], ['chat', true, 'external'],
    ])
    // A worker that wrote to another keeps that line in its own thread too.
    expect(threadOf(messages, unions).map(message => message.kind)).toStrictEqual(['chat', 'reply', 'tapestry'])
  })

  it('puts a card\'s open ask in the stream when the board holds none, and marks only the newest asked record', () => {
    const again = composeMessages({ channel, records: [...records, record({ id: 'r12', kind: 'asked', fiber: 'W', by: { fiber: 'W' }, text: 'Open the PR? (long question, cut by the board…' }, 18)], files: [], now, reachMs })
    expect(again.filter(message => message.kind === 'ask').map(message => [message.id, message.waiting])).toStrictEqual([['r2', false], ['r12', true]])
    const bare = composeMessages({ channel, records: [], files: [], now, reachMs })
    expect(bare.filter(message => message.waiting).map(message => [message.kind, message.card.id, message.at])).toStrictEqual([
      ['review', 'cuts', now - 15 * minute], ['ask', 'pando/unions/modes', now - 20 * minute], ['turn', 'stuck', now - 3 * minute],
    ].sort((a, b) => (a[2] as number) - (b[2] as number)))
  })

  it('keeps the channel short: the chair\'s every line, and each other worker once, its wait else its latest, with its thread', () => {
    const later = record({ id: 'r13', kind: 'post', fiber: 'W', by: { fiber: 'W' }, text: 'Drafted the PR body meanwhile.' }, 8)
    const lines = channelLines(composeMessages({ channel, records: [...records, later], files, now, reachMs, tapestry: { path: '/t.html', at: now - 2 * minute, title: 'T', lede: '' } }), channel)
    expect(lines.map(line => [line.message.kind, line.message.card.id, line.replies, line.last])).toStrictEqual([
      ['file', 'east-unions', 3, now - 80 * minute],
      ['post', 'west-unions', 2, now - 40 * minute],
      ['ask', 'pando/unions/modes', 2, now - 8 * minute],
      ['review', 'cuts', 0, now - 15 * minute],
      ['reply', 'pando/unions', 0, now - 5 * minute],
      ['turn', 'stuck', 0, now - 3 * minute],
      ['tapestry', 'pando/unions', 0, now - 2 * minute],
    ])
  })

  it('names each worker\'s liveness', () => {
    expect([west, modes, cuts, stuck, unions, card({ id: 'rest', status: 'open' }), card({ id: 'gone', column: 'tempered', status: 'closed' })].map(liveness))
      .toStrictEqual(['working', 'waiting', 'waiting', 'waiting', 'waiting', 'resting', 'closed'])
  })
})
