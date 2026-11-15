import { describe, expect, it } from 'vitest'
import { RECENT_MS, arranged, channelLines, clearKey, clearsOf, continues, composeChannels, composeMessages, hideKey, liveness, railOrder, reordered, setAsideKey, showKey, threadOf, unclearKey, unpinKey, waitsSince, type BoardRecord, type Channel } from './channels.js'
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
      ['channel:unions', 'UNIONS', true, ['pando/unions', 'east-unions', 'west-unions', 'pando/unions/modes']],
      ['channel:vizier', 'Vizier', true, ['life/vizier', 'loom/email/morning-post']],
      ['fiber:R', 'Moving house', false, ['van']],
      ['fiber:O', 'Old notes', false, ['old']],
    ])
    expect(named(channels, 'role:analyst').title).toBe('Analyst · the shear desk')
    expect(named(channels, 'channel:unions').families).toStrictEqual(['U'])
  })

  it('follows the orchestrator link, not where a fiber is filed, and a thread\'s own channel wins', () => {
    // Filed under UNIONS but orchestrated by the vizier: it speaks in Vizier.
    const errand = card({ id: 'pando/unions/errand', uid: 'E', orchestrator: 'Z', status: 'active' })
    const paper = card({ id: 'pando/unions/paper', uid: 'Q', orchestrator: 'U', shuttleChannel: 'SPT', status: 'active' })
    const channels = compose([...all, errand, paper])
    expect(named(channels, 'channel:vizier').members.map(member => member.id)).toContain('pando/unions/errand')
    expect(named(channels, 'channel:spt').members.map(member => member.id)).toStrictEqual(['pando/unions/paper'])
  })

  it('merges an office into the channel that shares its charter name', () => {
    // The vizier's errand carries no channel; its office's charter is named "Vizier", so it speaks in Vizier.
    const errand = card({ id: 'life/errand', uid: 'V', name: 'Errand', shuttleRole: 'vizier', status: 'active' })
    const channels = compose([...all, errand], { names: new Map([['analyst', 'Analyst · the shear desk'], ['vizier', 'Vizier · first point of contact']]) })
    expect(channels.filter(channel => channel.name === 'Vizier')).toHaveLength(1)
    expect(named(channels, 'channel:vizier').title).toBe('Vizier')
    expect(named(channels, 'channel:vizier').members.map(member => member.id)).toContain('life/errand')
  })

  it('chairs a channel with its topmost seat, a non-standing one first, then the most recently active', () => {
    const channels = compose(all)
    expect(named(channels, 'channel:unions').seat.id).toBe('pando/unions')
    expect(named(channels, 'channel:vizier').seat.id).toBe('life/vizier')
    // Without a seat, the most recently active top-level.
    const lone = card({ id: 'lone', uid: 'L', shuttleChannel: 'French', ...working(40) })
    const lesson = card({ id: 'lesson', uid: 'L2', orchestrator: 'L', ...working(1) })
    expect(named(compose([lone, lesson]), 'channel:french').seat.id).toBe('lone')
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

  it('hides a channel until a later show or something waiting after the hide', () => {
    const hide = (dismissed: string[], cards = all) => named(compose(cards, { dismissed }), 'role:analyst')
    expect([hide([]).hidden, hide([]).listed]).toStrictEqual([0, true])
    expect([hide([hideKey('role:analyst', now - minute)]).hidden, hide([hideKey('role:analyst', now - minute)]).listed]).toStrictEqual([now - minute, false])
    // Pinned, it is still out of the rail.
    expect(named(compose(all, { dismissed: [hideKey('role:analyst', now - minute)], pinned: new Map([['role:analyst', now]]) }), 'role:analyst').listed).toBe(false)
    expect(hide([hideKey('role:analyst', now - 2 * minute), showKey('role:analyst', now - minute)]).hidden).toBe(0)
    expect(hide([showKey('role:analyst', now - 2 * minute), hideKey('role:analyst', now - minute)]).hidden).toBe(now - minute)
    // A wait older than the hide keeps it hidden; one that began after brings it back.
    const asking = (minutes: number) => [...all.filter(each => each !== shear), { ...shear, status: 'active' as const, ask: { text: 'Which mask?', at: at(minutes) } }]
    expect(hide([hideKey('role:analyst', now - 5 * minute)], asking(10)).hidden).toBe(now - 5 * minute)
    const back = hide([hideKey('role:analyst', now - 5 * minute)], asking(1))
    expect([back.hidden, back.waiting, back.listed]).toStrictEqual([0, true, true])
  })

  it('waits on what is addressed to the human: an open ask or a close for review, never a worker idle at the end of its turn', () => {
    const turns = [
      card({ id: 'idle', uid: 'I1', ...idle(3) }),
      card({ id: 'blocked', uid: 'I2', status: 'active', workerState: 'blocked', lastActivityAt: now - minute }),
      card({ id: 'prompt', uid: 'I3', status: 'active', workerState: 'running', runtimePhase: 'attention', lastActivityAt: now - minute }),
      card({ id: 'asking', uid: 'I4', ...idle(3), ask: { text: 'Which mask?', at: at(4) } }),
    ]
    // The Desk still puts the idle three in Your turn; none of them waits on the human here.
    expect(turns.filter(card => card.column === 'inFlight' && inFlightBand(card) === 'yourTurn').map(card => card.id)).toEqual(expect.arrayContaining(['idle', 'blocked', 'prompt']))
    expect(turns.map(waitsSince)).toStrictEqual([0, 0, 0, now - 4 * minute])
    expect(waitsSince(card({ id: 'review', column: 'awaitingReview', closedAt: at(90) }))).toBe(now - 90 * minute)
  })
})

describe('the rail\'s order', () => {
  const keys = (channels: Channel[]) => channels.map(channel => channel.key)
  // Moving house, UNIONS (its thread asks) and Vizier (its chair is idle) wait on the human; the van's ask is the newest.
  const channels = compose(all)

  it('puts the channels an order does not name first, as composed, then the order\'s', () => {
    expect(keys(arranged(channels, []))).toStrictEqual(['role:analyst', 'channel:unions', 'channel:vizier', 'fiber:R', 'fiber:O'])
    expect(keys(arranged(channels, ['fiber:O', 'channel:vizier', 'channel:gone', 'role:analyst']))).toStrictEqual(['channel:unions', 'fiber:R', 'fiber:O', 'channel:vizier', 'role:analyst'])
  })

  it('floats what waits on the human, the newest wait first, above the human\'s order', () => {
    // The vizier's chair, idle at the end of its turn, waits on no one.
    expect(channels.filter(channel => channel.waiting).map(channel => [channel.key, channel.newest])).toStrictEqual([['channel:unions', now - 20 * minute], ['fiber:R', now - 10 * minute]])
    expect(keys(railOrder(channels, ['fiber:O', 'channel:vizier', 'role:analyst', 'fiber:R', 'channel:unions']))).toStrictEqual(['fiber:R', 'channel:unions', 'fiber:O', 'channel:vizier', 'role:analyst'])
    // Set aside, a wait no longer floats.
    const aside = compose(all, { dismissed: [setAsideKey(named(channels, 'fiber:R'))] })
    expect(keys(railOrder(aside, ['fiber:O', 'fiber:R', 'role:analyst']))).toStrictEqual(['channel:unions', 'channel:vizier', 'fiber:O', 'fiber:R', 'role:analyst'])
  })

  it('rearranges only the channels shown, every other keeping its place', () => {
    const order = ['role:analyst', 'fiber:R', 'channel:unions', 'fiber:O', 'channel:vizier']
    // Shown: analyst, unions, vizier (fiber:R waits, fiber:O is out of the rail); vizier is dragged to the top.
    expect(reordered(order, ['channel:vizier', 'role:analyst', 'channel:unions'])).toStrictEqual(['channel:vizier', 'fiber:R', 'role:analyst', 'fiber:O', 'channel:unions'])
    expect(reordered(order, [])).toStrictEqual(order)
  })
})

describe('composeMessages', () => {
  const record = (over: Partial<BoardRecord> & Pick<BoardRecord, 'id' | 'kind'>, minutes: number): BoardRecord => ({ timestamp: now - minutes * minute, originName: 'local', ...over })
  const cuts = card({ id: 'cuts', uid: 'C', name: 'Depth cuts', orchestrator: 'U', column: 'awaitingReview', closedAt: at(15), reviewMark: { note: 'The plot is attached.', at: at(15) }, outcome: 'Validated.' })
  const stuck = card({ id: 'stuck', uid: 'K', name: 'Stuck', orchestrator: 'U', status: 'active', workerState: 'blocked', launchError: 'No allocation left.', lastActivityAt: now - 3 * minute })
  const quiet = card({ id: 'quiet', uid: 'Y', name: 'Quiet', orchestrator: 'U', ...working(1), outcome: 'Running the chains.' })
  const cards = [unions, east, west, modes, cuts, stuck, quiet]
  const channel = named(compose(cards), 'channel:unions')
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
    record({ id: 'brd-human-6', kind: 'human', fiber: 'F', by: { label: 'Sam' }, text: 'me: how is the run going?' }, 50),
    record({ id: 'brd-human-7', kind: 'human', fiber: 'U', by: { label: 'Sam' }, text: 'Keep going.' }, 5),
    record({ id: 'r8', kind: 'message', fiber: 'F', by: { fiber: 'U', session: 'shuttle://h/claude/1' }, to: { fiber: 'F' }, text: 'Rerun with the new mask.' }, 45),
    record({ id: 'r9', kind: 'message', fiber: 'N', by: { label: 'external' }, text: 'Job 6400 finished.' }, 80),
    record({ id: 'r10', kind: 'answered', fiber: 'W', by: { label: 'Sam' }, text: 'Q: Which mask? — A: The conservative one.' }, 25),
    record({ id: 'r11', kind: 'post', fiber: 'Elsewhere', by: { fiber: 'Elsewhere' }, text: 'Not a member.' }, 3),
  ]
  const messages = composeMessages({ channel, records, files, now, reachMs, tapestry: { path: '/unions/tapestry.html', at: now - 2 * minute, title: 'UNIONS, as it stands', lede: 'S8 is measured.' } })
  const stream = messages.filter(message => !message.quiet)

  it('reads the stream oldest first: posts with their files, asks, reviews, the human\'s lines to the chair, files alone, the tapestry', () => {
    expect(stream.map(message => [message.kind, message.card.id, message.text, message.waiting, message.files.map(file => file.basename)])).toStrictEqual([
      ['file', 'east-unions', '', false, ['chains.md']],
      ['post', 'west-unions', 'S8 is in; the plot and the log are attached.', false, ['s8.png', 'run.log']],
      ['ask', 'pando/unions/modes', 'Open the PR?', true, []],
      ['review', 'cuts', 'The plot is attached.', true, ['cut.png']],
      ['reply', 'pando/unions', 'Keep going.', false, []],
      ['turn', 'stuck', 'No allocation left.', false, []],
      ['tapestry', 'pando/unions', 'S8 is measured.', false, []],
    ])
    // A worker with nothing to say is not in the stream; its outcome stays on its card.
    expect(messages.some(message => message.card.id === 'quiet')).toBe(false)
  })

  it('keeps a worker\'s thread: the human\'s lines to it, what others wrote to it, and its lifecycle', () => {
    expect(threadOf(messages, west).map(message => [message.kind, message.human, message.quiet, message.from?.id ?? message.label ?? ''])).toStrictEqual([
      ['reply', true, true, ''], ['chat', false, true, 'pando/unions'], ['post', false, false, ''],
    ])
    expect(threadOf(messages, east).map(message => [message.kind, message.quiet, message.label ?? ''])).toStrictEqual([
      ['file', false, ''], ['closed', true, ''], ['handed_off', true, ''], ['chat', true, 'external'],
    ])
    // The answer to a question in the worker's own chat is the human's, in its thread.
    expect(threadOf(messages, modes).filter(message => message.human).map(message => [message.text, message.quiet])).toStrictEqual([['The conservative one.', true]])
    // A worker that wrote to another keeps that line in its own thread too.
    expect(threadOf(messages, unions).map(message => message.kind)).toStrictEqual(['chat', 'reply', 'tapestry'])
  })

  it('puts a card\'s open ask in the stream when the board holds none, and marks only the newest asked record', () => {
    const again = composeMessages({ channel, records: [...records, record({ id: 'r12', kind: 'asked', fiber: 'W', by: { fiber: 'W' }, text: 'Open the PR? (long question, cut by the board…' }, 18)], files: [], now, reachMs })
    expect(again.filter(message => message.kind === 'ask').map(message => [message.id, message.waiting])).toStrictEqual([['r2', false], ['r12', true]])
    const bare = composeMessages({ channel, records: [], files: [], now, reachMs })
    expect(bare.filter(message => message.waiting).map(message => [message.kind, message.card.id, message.at])).toStrictEqual([
      ['ask', 'pando/unions/modes', now - 20 * minute], ['review', 'cuts', now - 15 * minute],
    ])
  })

  it('keeps the channel short: each thread once, the chair\'s too, its latest, marked when it waits, with its thread; the human\'s words to the chair stand', () => {
    const later = record({ id: 'r13', kind: 'post', fiber: 'W', by: { fiber: 'W' }, text: 'Drafted the PR body meanwhile.' }, 8)
    const lines = channelLines(composeMessages({ channel, records: [...records, later], files, now, reachMs, tapestry: { path: '/t.html', at: now - 2 * minute, title: 'T', lede: '' } }))
    expect(lines.map(line => [line.message.kind, line.message.card.id, line.waiting, line.replies, line.last])).toStrictEqual([
      ['file', 'east-unions', false, 3, now - 80 * minute],
      ['post', 'west-unions', false, 2, now - 40 * minute],
      ['review', 'cuts', true, 0, now - 15 * minute],
      ['post', 'pando/unions/modes', true, 2, now - 8 * minute],
      ['reply', 'pando/unions', false, 0, now - 5 * minute],
      ['turn', 'stuck', false, 0, now - 3 * minute],
      ['tapestry', 'pando/unions', false, 2, now - 2 * minute],
    ])
  })

  it('gives each worker\'s line its ✓: a close for review tempers, an ask has none, anything else clears; the human\'s lines have none', () => {
    const stream = channelLines(composeMessages({ channel, records, files, now, reachMs, tapestry: { path: '/t.html', at: now - 2 * minute, title: 'T', lede: '' } }))
    expect(stream.map(line => [line.message.kind, line.message.card.id, line.act])).toStrictEqual([
      ['file', 'east-unions', 'clear'],
      ['post', 'west-unions', 'clear'],
      ['ask', 'pando/unions/modes', undefined],
      ['review', 'cuts', 'temper'],
      ['reply', 'pando/unions', undefined],
      ['turn', 'stuck', 'clear'],
      ['tapestry', 'pando/unions', 'clear'],
    ])
  })

  it('clears a line while its message is no newer than its thread\'s clear; the thread saying more, or an undo, brings it back', () => {
    const west40 = now - 40 * minute
    const linesWith = (dismissed: string[], more: BoardRecord[] = []) =>
      channelLines(composeMessages({ channel, records: [...records, ...more], files, now, reachMs }), clearsOf(dismissed))
    const cleared = (dismissed: string[], more: BoardRecord[] = []) =>
      linesWith(dismissed, more).filter(line => line.cleared).map(line => line.message.card.id)
    expect(cleared([])).toStrictEqual([])
    expect(cleared([clearKey('F', west40)])).toStrictEqual(['west-unions'])
    // An older clear does not reach a newer message.
    expect(cleared([clearKey('F', west40 - 1)])).toStrictEqual([])
    // The thread says something newer: back.
    expect(cleared([clearKey('F', west40)], [record({ id: 'r14', kind: 'post', fiber: 'F', by: { fiber: 'F' }, text: 'One more plot.' }, 4)])).toStrictEqual([])
    // An undo voids the clears up to it; a clear above the undo stands again.
    expect(cleared([clearKey('F', west40), unclearKey('F', west40)])).toStrictEqual([])
    expect(cleared([clearKey('F', west40), unclearKey('F', west40), clearKey('F', west40 + 1)])).toStrictEqual(['west-unions'])
    // A clear never takes away what waits: the ask and the review stand.
    expect(cleared([clearKey('W', now), clearKey('C', now)])).toStrictEqual([])
    // Clear records leave the channel's waiting and rail alone.
    const plain = compose(all), withClears = compose(all, { dismissed: [clearKey('W', now), clearKey('U', now)] })
    expect(withClears.map(each => [each.key, each.waiting, each.newest, each.listed])).toStrictEqual(plain.map(each => [each.key, each.waiting, each.newest, each.listed]))
  })

  it('names each worker\'s liveness', () => {
    expect([west, modes, cuts, stuck, unions, card({ id: 'rest', status: 'open' }), card({ id: 'gone', column: 'tempered', status: 'closed' })].map(liveness))
      // Stopped or idle at the end of a turn, a worker waits on no one: it rests.
      .toStrictEqual(['working', 'waiting', 'waiting', 'resting', 'resting', 'resting', 'closed'])
  })
})

describe('the shapes live channels hold', () => {
  const record = (over: Partial<BoardRecord> & Pick<BoardRecord, 'id' | 'kind'>, minutes: number): BoardRecord => ({ timestamp: now - minutes * minute, originName: 'local', ...over })
  const send = (uid: string, path: string, minutes: number, host = 'local'): SentFile => ({ uid, host, fullPath: path, basename: path.split('/').at(-1)!, timestamp: now - minutes * minute })
  // The Mill: a seated chair; a worker that posted, sent its screenshot, closed itself, and was tempered by another session.
  const mill = card({ id: 'mill', uid: 'M', name: 'The Mill', shuttleChannel: 'The Mill', shuttleSeat: true, ...idle(5) })
  const outbox = card({ id: 'mill/outbox', uid: 'O1', name: 'An outbox', orchestrator: 'M', column: 'tempered', status: 'closed', closedAt: at(60) })
  const desk = card({ id: 'mill/desk', uid: 'D1', name: 'UI desk', orchestrator: 'M', ...working(1) })
  const channel = named(compose([mill, outbox, desk]), 'channel:the mill')
  const lines = (records: BoardRecord[], files: SentFile[] = [], cards?: KanbanCard[]) => {
    const messages = composeMessages({ channel, records, files, cards, now, reachMs })
    return { messages, lines: channelLines(messages) }
  }

  it('keeps every close out of the stream: a worker\'s line is its last post, with the files it sent before closing', () => {
    const { messages, lines: stream } = lines([
      record({ id: 'p', kind: 'post', fiber: 'O1', by: { fiber: 'O1' }, text: 'Done; the phone shot is attached.' }, 70),
      record({ id: 'c1', kind: 'closed', fiber: 'O1', by: { fiber: 'O1' } }, 62),
      record({ id: 'c2', kind: 'closed', fiber: 'O1', by: { fiber: 'M' }, verdict: 'tempered' }, 60),
    ], [send('O1', '/shots/phone.png', 63)])
    expect(stream.map(line => [line.message.kind, line.message.text, line.message.files.map(file => file.basename), line.replies])).toStrictEqual([
      ['post', 'Done; the phone shot is attached.', ['phone.png'], 2],
    ])
    expect(messages.filter(message => message.kind === 'closed').map(message => [message.text, message.quiet])).toStrictEqual([['', true], ['tempered', true]])
  })

  it('makes a burst of files from one sender one message, and a path sent again since its post a message of its own', () => {
    const { lines: stream } = lines([
      record({ id: 'p', kind: 'post', fiber: 'D1', by: { fiber: 'D1' }, text: 'Before and after.', files: ['/shots/before.png'] }, 120),
    ], [
      send('M', '/shots/a.png', 30), send('M', '/shots/b.png', 29.5), send('M', '/shots/c.png', 29),
      send('D1', '/shots/before.png', 120), send('D1', '/shots/before.png', 10),
      // The same home-directory path on two clusters is two files.
      send('M', '/home/u/fig.png', 2, 'cluster-a'), send('M', '/home/u/fig.png', 2, 'cluster-b'),
    ])
    expect(stream.map(line => [line.message.card.id, line.message.kind, line.message.files.map(file => `${file.host}:${file.basename}`)])).toStrictEqual([
      ['mill/desk', 'file', ['local:before.png']],
      ['mill', 'file', ['cluster-b:fig.png', 'cluster-a:fig.png']],
    ])
  })

  it('names a sender from another channel, and a session no fiber answers for by its host', () => {
    const hub = card({ id: 'hub', uid: 'H', name: 'UNIONS hub', shuttleChannel: 'UNIONS' })
    const { messages } = lines([
      record({ id: 'm1', kind: 'message', fiber: 'D1', by: { fiber: 'H', session: 'shuttle://h/claude/1' }, text: 'Context before you start.' }, 20),
      record({ id: 'm2', kind: 'message', fiber: 'D1', by: { session: 'shuttle://cluster-a/claude/2' }, text: 'Numbers from the release.' }, 10),
      record({ id: 'm3', kind: 'message', fiber: 'D1', by: { fiber: 'GONE', session: 'shuttle://h/claude/3' }, actor: 'felt/debug', text: 'Landing a change.' }, 5),
    ], [], [mill, outbox, desk, hub])
    expect(messages.map(message => [message.from?.name ?? message.label, message.card.id])).toStrictEqual([
      ['UNIONS hub', 'mill/desk'], ['a session on cluster-a', 'mill/desk'], ['felt/debug', 'mill/desk'],
    ])
  })

  it('makes the human\'s board line to the chair a channel line, keeps their other board lines in the thread, and leaves terminal and spoken lines to Rex', () => {
    const { messages, lines: stream } = lines([
      record({ id: 'brd-human-1', kind: 'human', fiber: 'M', by: { label: 'Sam' }, text: 'Ship it.' }, 9),
      record({ id: 'brd-01TERMINAL', kind: 'human', fiber: 'M', by: { label: 'Sam' }, text: 'typed at the terminal' }, 8),
      record({ id: 's1', kind: 'spoken', fiber: 'D1', by: { label: 'Sam' }, text: 'said aloud' }, 7),
      record({ id: 'brd-human-2', kind: 'human', fiber: 'D1', by: { label: 'Sam' }, text: 'Thread reply.' }, 6),
    ])
    expect(messages.map(message => [message.text, message.human, message.quiet])).toStrictEqual([
      ['Ship it.', true, false], ['Thread reply.', true, true],
    ])
    expect(stream.map(line => line.message.text)).toStrictEqual(['Ship it.'])
  })

  it('judges what is new by when it arrived here, not by its writer\'s clock', () => {
    const { messages } = lines([record({ id: 'late', kind: 'post', fiber: 'D1', by: { fiber: 'D1' }, received_at: now - minute, text: 'From a cluster.' }, 90)])
    expect([messages[0].at, messages[0].arrived]).toStrictEqual([now - 90 * minute, now - minute])
  })

  it('names the run a message continues: one sender, within ten minutes', () => {
    const { messages } = lines([
      record({ id: 'a', kind: 'post', fiber: 'D1', by: { fiber: 'D1' }, text: 'one' }, 30),
      record({ id: 'b', kind: 'post', fiber: 'D1', by: { fiber: 'D1' }, text: 'two' }, 25),
      record({ id: 'c', kind: 'post', fiber: 'D1', by: { fiber: 'D1' }, text: 'three' }, 10),
      record({ id: 'brd-human-d', kind: 'human', fiber: 'D1', by: { label: 'Sam' }, text: 'four' }, 9),
    ])
    expect(messages.map((message, index) => continues(messages[index - 1], message))).toStrictEqual([false, true, false, false])
  })
})

describe('what waits on the human, as live channels hold it', () => {
  // SPT on the live board: its paper chair and a thread both idle at the end of their turns, nothing asked, nothing for review.
  const paper = card({ id: 'spt/paper', uid: 'SP', name: 'Polarization paper', shuttleChannel: 'SPT', shuttleSeat: true, ...idle(40) })
  const bins = card({ id: 'spt/paper/bins', uid: 'SB', name: 'Bin correlations', orchestrator: 'SP', ...idle(12) })
  // UNIONS beside it: a thread closed for review.
  const review = card({ id: 'pando/unions/review', uid: 'UR', name: 'Covariance', orchestrator: 'U', column: 'awaitingReview', closedAt: at(30), reviewMark: { note: 'Validated.', at: at(30) } })

  it('neither marks nor floats a channel whose workers are only idle, and keeps it hidden when one goes idle after the hide', () => {
    const channels = compose([unions, review, paper, bins])
    expect(channels.map(channel => [channel.name, channel.waiting])).toStrictEqual([['SPT', false], ['UNIONS', true]])
    expect(railOrder(channels, ['channel:spt', 'channel:unions']).map(channel => channel.name)).toStrictEqual(['UNIONS', 'SPT'])
    const hidden = named(compose([unions, review, paper, bins], { dismissed: [hideKey('channel:spt', now - 60 * minute)] }), 'channel:spt')
    expect([hidden.hidden, hidden.listed]).toStrictEqual([now - 60 * minute, false])
  })
})

describe('a channel\'s key', () => {
  it('stays the office\'s until a charter name joins it to a channel, and a thread with closed ancestors takes the channel filed above it', () => {
    const errand = card({ id: 'life/errand', uid: 'V', name: 'Errand', shuttleRole: 'first-contact', status: 'active' })
    const keys = (names: Map<string, string>) => compose([...all, errand], { names }).map(channel => channel.key)
    expect(keys(new Map())).toContain('role:first-contact')
    expect(keys(new Map([['first-contact', 'Vizier · first point of contact']]))).not.toContain('role:first-contact')
    // The Lightcone desk is tempered; its live thread, under ancestors closed or absent, has no orchestrator.
    const lightcone = card({ id: 'lc/desk', uid: 'LD', name: 'Lightcone desk', shuttleChannel: 'Lightcone', shuttleRole: 'lightcone-desk', column: 'tempered', status: 'closed' })
    const glass = card({ id: 'lc/desk/paper-ii/run/glass-mocks', uid: 'G', name: 'Glass mocks', ...working(3) })
    const unit = card({ id: 'lc/desk/unit-tests', uid: 'T', name: 'Unit tests', status: 'open' })
    const near = card({ id: 'lc/desktop', uid: 'X', name: 'Not under the desk', ...working(3) })
    const channels = compose([lightcone, glass, unit, near])
    expect(named(channels, 'channel:lightcone').members.map(member => member.id)).toStrictEqual(['lc/desk/paper-ii/run/glass-mocks', 'lc/desk/unit-tests'])
    expect(named(channels, 'channel:lightcone').name).toBe('Lightcone')
    expect(named(channels, 'fiber:X').members.map(member => member.id)).toStrictEqual(['lc/desktop'])
  })
})
