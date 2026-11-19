import { describe, expect, it } from 'vitest'
import { MISC, RECENT_MS, arranged, bygone, clearLineKey, clearedLines, composeChannels, composeStream, hideKey, lineIds, railOrder, reordered, runningIn, sendId, showKey, unclearLineKey, unpinKey, type Channel, type Entry, type Item } from './channels.js'
import type { BoardRecord, Wait } from './boardFeed.js'
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
// Three that name no channel: one in an office, one that waits, one idle for more than a week.
const shear = card({ id: 'shear', uid: 'S', name: 'Cosmic shear', shuttleRole: 'analyst', ...working(5) })
const van = card({ id: 'van', uid: 'R', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(10) } })
const old = card({ id: 'old', uid: 'O', name: 'Old notes', status: 'open', modifiedAt: new Date(now - RECENT_MS - day).toISOString() })

const all = [unions, east, west, modes, vizier, post, shear, van, old]
type Input = Parameters<typeof composeChannels>[0]
function compose(cards: KanbanCard[], over: Partial<Input> = {}): Channel[] {
  const index = new ThreadIndex(cards)
  return composeChannels({ cards, parentOf: card => index.parentOf(card), dismissed: [], pinned: new Map(), waits: new Map(), now, ...over })
}
const named = (channels: Channel[], key: string): Channel => channels.find(channel => channel.key === key)!

describe('composeChannels', () => {
  it('groups by shuttle.channel, inherited through the orchestrator; everything else speaks in misc, at the foot', () => {
    const channels = compose(all)
    expect(channels.map(channel => [channel.key, channel.name, channel.misc, channel.members.map(member => member.id)])).toStrictEqual([
      ['channel:unions', 'unions', false, ['pando/unions', 'east-unions', 'west-unions', 'pando/unions/modes']],
      ['channel:vizier', 'vizier', false, ['life/vizier', 'loom/email/morning-post']],
      [MISC, 'misc', true, ['shear', 'van', 'old']],
    ])
    expect(named(channels, 'channel:unions').families).toStrictEqual(['U'])
    // The catch-all has no chair; it reads the families of what in it waits or was recently active, not the week-old notes.
    const misc = named(channels, MISC)
    expect([misc.seat, misc.spelling, misc.families]).toStrictEqual([undefined, '', ['S', 'R']])
  })

  it('takes a constitution that names misc into the catch-all, however it spells it', () => {
    const odd = card({ id: 'odd', uid: 'M', shuttleChannel: 'Misc', ...working(3) })
    const channels = compose([...all, odd])
    expect(channels.filter(channel => channel.name === 'misc').map(channel => channel.key)).toStrictEqual([MISC])
    expect(named(channels, MISC).members.map(member => member.id)).toContain('odd')
  })

  it('keeps each channel\'s spelling and the constitutions that declare it, closed ones too, for a move to it and its archiving', () => {
    const closed = card({ id: 'life/vizier-old', uid: 'Z0', shuttleChannel: 'Vizier', status: 'closed', column: 'tempered' })
    const vizierChannel = named(compose([...all, closed]), 'channel:vizier')
    expect([vizierChannel.spelling, vizierChannel.declarers.map(each => each.id)]).toStrictEqual(['Vizier', ['life/vizier', 'loom/email/morning-post', 'life/vizier-old']])
    // A thread that inherits it is a member, not a declarer.
    expect(named(compose(all), 'channel:unions').declarers.map(each => each.id)).toStrictEqual(['pando/unions'])
  })

  it('never makes a channel of an office or a lone top-level', () => {
    const errand = card({ id: 'life/errand', uid: 'V', name: 'Errand', shuttleRole: 'vizier', status: 'active', ask: { text: 'Book it?', at: at(3) } })
    const channels = compose([...all, errand])
    expect(channels.map(channel => channel.key)).toStrictEqual(['channel:unions', 'channel:vizier', MISC])
    expect(named(channels, MISC).members.map(member => member.id)).toContain('life/errand')
    expect([bygone('role:analyst'), bygone('fiber:R'), bygone('channel:vizier'), bygone(MISC)]).toStrictEqual([true, true, false, false])
  })

  it('follows the orchestrator link, not where a fiber is filed, and a thread\'s own channel wins', () => {
    // Filed under UNIONS but orchestrated by the vizier: it speaks in Vizier.
    const errand = card({ id: 'pando/unions/errand', uid: 'E', orchestrator: 'Z', status: 'active' })
    const paper = card({ id: 'pando/unions/paper', uid: 'Q', orchestrator: 'U', shuttleChannel: 'SPT', status: 'active' })
    const channels = compose([...all, errand, paper])
    expect(named(channels, 'channel:vizier').members.map(member => member.id)).toContain('pando/unions/errand')
    expect(named(channels, 'channel:spt').members.map(member => member.id)).toStrictEqual(['pando/unions/paper'])
  })

  it('chairs a channel with its topmost seat, a non-standing one first, then the eldest, so its name holds still', () => {
    const channels = compose(all)
    expect(named(channels, 'channel:unions').seat!.id).toBe('pando/unions')
    expect(named(channels, 'channel:vizier').seat!.id).toBe('life/vizier')
    // Without a seat, a top-level, never a thread under it.
    const lone = card({ id: 'lone', uid: 'L', shuttleChannel: 'French', ...working(40) })
    const lesson = card({ id: 'lesson', uid: 'L2', orchestrator: 'L', ...working(1) })
    expect(named(compose([lone, lesson]), 'channel:french').seat!.id).toBe('lone')
    // Two top-levels: the elder chairs, however recently the younger was active.
    const elder = card({ id: 'spt/edfs', uid: 'E1', shuttleChannel: 'SPT', createdAt: at(600), ...idle(300) })
    const younger = card({ id: 'spt/pol', uid: 'E2', shuttleChannel: 'SPT', createdAt: at(60), ...working(1) })
    expect(named(compose([younger, elder]), 'channel:spt').seat!.id).toBe('spt/edfs')
  })

  it('writes a named channel as its name, lowercased with hyphens for spaces, whoever chairs it', () => {
    const mill = card({ id: 'felt', uid: 'M1', name: 'Felt', shuttleChannel: 'The Mill', shuttleSeat: true, ...working(2) })
    const channel = named(compose([mill]), 'channel:the mill')
    expect([channel.name, channel.title, channel.seat]).toStrictEqual(['the-mill', 'Felt', mill])
  })

  it('lists a channel waiting, pinned, or active within a week, the same on every device', () => {
    const quiet = card({ id: 'notes', uid: 'Q1', shuttleChannel: 'Notes', status: 'open', modifiedAt: new Date(now - RECENT_MS - day).toISOString() })
    const listed = (over: Partial<Input> = {}) => compose([...all, quiet], over).filter(channel => channel.listed).map(channel => channel.key)
    expect(listed()).not.toContain('channel:notes')
    expect(listed({ pinned: new Map([['channel:notes', now - 2 * day]]) })).toContain('channel:notes')
    expect(listed({ pinned: new Map([['channel:notes', now - 2 * day]]), dismissed: [unpinKey('channel:notes', now - day)] })).not.toContain('channel:notes')
  })

  it('lists the catch-all only while something in it waits or was recently active, never for a pin or a draft', () => {
    const draft = card({ id: 'trip', uid: 'D', name: 'Check in', column: 'drafts', modifiedAt: at(60) })
    const isListed = (cards: KanbanCard[], over: Partial<Input> = {}) => named(compose(cards, over), MISC).listed
    expect(isListed([old])).toBe(false)
    expect(isListed([old, draft])).toBe(false)
    expect(isListed([old], { pinned: new Map([[MISC, now - day]]) })).toBe(false)
    expect(isListed([old, draft], { waits: new Map([['D', { id: 'd1', at: now - minute }]]) })).toBe(true)
    expect(isListed([old, card({ id: 'bags', uid: 'D2', ...working(5) })])).toBe(true)
    const moving = named(compose(all), MISC)
    expect([moving.waiting, moving.newest, moving.listed]).toStrictEqual([true, now - 10 * minute, true])
  })

  it('leaves out a channel of drafts however recently they were touched, unless it is pinned or something in it waits', () => {
    const draft = card({ id: 'trip', uid: 'D', name: 'Check in', shuttleChannel: 'Travel', column: 'drafts', modifiedAt: at(60) })
    const isListed = (cards: KanbanCard[], over: Partial<Input> = {}) => named(compose(cards, over), 'channel:travel').listed
    expect(isListed([draft])).toBe(false)
    expect(isListed([draft], { pinned: new Map([['channel:travel', now - day]]) })).toBe(true)
    expect(isListed([draft], { waits: new Map([['D', { id: 'd1', at: now - minute }]]) })).toBe(true)
    // A thread under it past its draft lists the channel.
    expect(isListed([draft, card({ id: 'trip/bags', uid: 'D2', orchestrator: 'D', ...working(5) })])).toBe(true)
  })

  it('hides a channel until a later show or something waiting after the hide', () => {
    const hide = (dismissed: string[], cards = all) => named(compose(cards, { dismissed }), MISC)
    expect([hide([]).hidden, hide([]).listed]).toStrictEqual([0, true])
    expect([hide([hideKey(MISC, now - minute)]).hidden, hide([hideKey(MISC, now - minute)]).listed]).toStrictEqual([now - minute, false])
    // Pinned, it is still out of the rail.
    expect(named(compose(all, { dismissed: [hideKey(MISC, now - minute)], pinned: new Map([[MISC, now]]) }), MISC).listed).toBe(false)
    expect(hide([hideKey(MISC, now - 2 * minute), showKey(MISC, now - minute)]).hidden).toBe(0)
    expect(hide([showKey(MISC, now - 2 * minute), hideKey(MISC, now - minute)]).hidden).toBe(now - minute)
    // A wait older than the hide keeps it hidden; one that began after brings it back.
    const asking = (minutes: number) => [...all.filter(each => each !== shear), { ...shear, status: 'active' as const, ask: { text: 'Which mask?', at: at(minutes) } }]
    expect(hide([hideKey(MISC, now - 5 * minute)], asking(10)).hidden).toBe(now - 5 * minute)
    const back = hide([hideKey(MISC, now - 5 * minute)], asking(1))
    expect([back.hidden, back.waiting, back.listed]).toStrictEqual([0, true, true])
  })

  it('waits on what is addressed to the human: an open ask, a harness prompt, a blocked turn or a close for review, never a worker idle at the end of its turn', () => {
    const turns = [
      card({ id: 'idle', uid: 'I1', shuttleChannel: 'idle', ...idle(3) }),
      card({ id: 'blocked', uid: 'I2', shuttleChannel: 'blocked', status: 'active', workerState: 'blocked', lastActivityAt: now - minute }),
      card({ id: 'prompt', uid: 'I3', shuttleChannel: 'prompt', status: 'active', workerState: 'running', runtimePhase: 'attention', lastActivityAt: now - minute }),
      card({ id: 'asking', uid: 'I4', shuttleChannel: 'asking', ...idle(3), ask: { text: 'Which mask?', at: at(4) } }),
      card({ id: 'review', uid: 'I5', shuttleChannel: 'review', status: 'closed', column: 'awaitingReview', closedAt: at(90) }),
    ]
    const waiting = Object.fromEntries(compose(turns).map(channel => [channel.name, channel.waiting && channel.newest]))
    expect(waiting).toStrictEqual({ idle: false, blocked: now - minute, prompt: now - minute, asking: now - 4 * minute, review: now - 90 * minute })
  })

  it('waits where the daemon says a member\'s line waits on the human, and brings a hidden channel back for it', () => {
    const hidden = { dismissed: [hideKey(MISC, now - 60 * minute)] }
    expect(named(compose(all.filter(each => each !== van), hidden), MISC).hidden).toBe(now - 60 * minute)
    const shearDesk = named(compose(all.filter(each => each !== van), { ...hidden, waits: new Map([['S', { id: 's1', at: now - 5 * minute }]]) }), MISC)
    expect([shearDesk.waiting, shearDesk.newest, shearDesk.hidden, shearDesk.listed]).toStrictEqual([true, now - 5 * minute, 0, true])
  })
})

describe('the rail\'s order', () => {
  const keys = (channels: Channel[]) => channels.map(channel => channel.key)
  const spt = card({ id: 'spt', uid: 'T', shuttleChannel: 'SPT', ...working(3) })
  // UNIONS (its thread asks) and misc (the van asks, the newer wait) wait on the human; SPT and Vizier do not.
  const channels = compose([...all, spt])

  it('puts the named channels an order does not name first, as composed, then the order\'s, and leaves the catch-all out of it', () => {
    expect(keys(arranged(channels, []))).toStrictEqual(['channel:spt', 'channel:unions', 'channel:vizier', MISC])
    expect(keys(arranged(channels, ['channel:vizier', 'channel:gone', 'channel:spt']))).toStrictEqual(['channel:unions', MISC, 'channel:vizier', 'channel:spt'])
  })

  it('floats what waits on the human, the newest wait first, above the human\'s order, and keeps the catch-all at the foot', () => {
    expect(channels.filter(channel => channel.waiting).map(channel => [channel.key, channel.newest])).toStrictEqual([['channel:unions', now - 20 * minute], [MISC, now - 10 * minute]])
    expect(keys(railOrder(channels, ['channel:vizier', MISC, 'channel:spt', 'channel:unions']))).toStrictEqual(['channel:unions', 'channel:vizier', 'channel:spt', MISC])
  })

  it('rearranges only the channels shown, every other keeping its place', () => {
    const order = ['channel:unions', 'fiber:R', 'channel:unions', 'fiber:O', 'channel:vizier']
    // Shown: analyst, unions, vizier (fiber:R waits, fiber:O is out of the rail); vizier is dragged to the top.
    expect(reordered(order, ['channel:vizier', 'channel:unions', 'channel:unions'])).toStrictEqual(['channel:vizier', 'fiber:R', 'channel:unions', 'fiber:O', 'channel:unions'])
    expect(reordered(order, [])).toStrictEqual(order)
  })
})

describe('composeStream', () => {
  // cmbx: a chair, a thread that sent a deck twice and posted a plot to the human, one asking its chair, one closed and marked for review, one at work saying nothing.
  const chair = card({ id: 'cmbx', uid: 'C', name: 'cmbx chair', shuttleChannel: 'cmbx', shuttleSeat: true, ...idle(9) })
  const kappa = card({ id: 'cmbx/kappa', uid: 'K', name: 'κ × tSZ', orchestrator: 'C', ...working(4) })
  const mask = card({ id: 'cmbx/mask', uid: 'M', name: 'Mask', orchestrator: 'C', status: 'active', ask: { text: 'Which threshold?', at: at(22) } })
  const cov = card({ id: 'cmbx/cov', uid: 'V', name: 'Covariance', orchestrator: 'C', column: 'awaitingReview', status: 'closed', closedAt: at(48), outcome: 'Validated against 2000 simulations.', reviewMark: { note: 'Validated to 4%.', at: at(47) } })
  const beam = card({ id: 'cmbx/beam', uid: 'B', name: 'Beam', orchestrator: 'C', ...working(2) })
  const channel = named(compose([chair, kappa, mask, cov, beam]), 'channel:cmbx')
  const human = { label: 'Sam' }, up = { fiber: 'C' }
  const record = (id: string, kind: string, fiber: string, minutes: number, over: Partial<BoardRecord> = {}): BoardRecord => ({ id, kind, fiber, by: { fiber }, timestamp: now - minutes * minute, ...over })
  const send = (uid: string, name: string, minutes: number, caption?: string): SentFile => ({ fullPath: `/w/${uid}/${name}`, basename: name, uid, host: 'h', timestamp: now - minutes * minute, caption })
  const records = [
    record('r1', 'post', 'K', 120, { to: up, text: 'First pass.' }),
    record('r2', 'asked', 'M', 22, { to: up, text: 'Which threshold?' }),
    record('r3', 'closed', 'V', 48, { to: up, text: 'Validated against 2000 simulations.' }),
    record('r3m', 'closed', 'V', 47, { to: human, text: 'Validated to 4%.' }),
    record('r4', 'handed_off', 'B', 15),
    record('r5', 'message', 'K', 100, { by: { fiber: 'C' }, to: { fiber: 'K' }, text: 'Use the new beam.' }),
    record('r6', 'human', 'C', 10, { by: human, text: 'Thanks.' }),
    record('r7', 'post', 'K', 30, { to: human, text: 'κ×tSZ at 9σ.', files: ['/w/K/spectrum.svg'] }),
  ]
  const files = [send('K', 'deck.html', 120, 'First pass.'), send('K', 'deck.html', 33, 'The final deck.'), send('K', 'spectrum.svg', 30, '9σ.'), send('C', 'plan.md', 300)]
  const launches = new Map([['K', [now - 60 * minute]], ['B', [now - 35 * minute]]])
  const waits = new Map([['V', { id: 'r3m', at: now - 20 * minute }]])
  const stream = (over: Partial<Parameters<typeof composeStream>[0]> = {}): Entry[] =>
    composeStream({ channel, records, files, waits, launches: card => launches.get(card.uid!) ?? [], cleared: new Map(), now, reachMs, ...over })
  const said = (entries: Entry[]) => entries.map(entry => entry.kind === 'station' ? [entry.card.id, entry.what, ...entry.end ? [entry.end] : []] : [entry.card.id, entry.kind, entry.text, entry.waiting])

  it('holds everything addressed to the human, with its threads\' lives as stations between, oldest first', () => {
    expect(said(stream())).toStrictEqual([
      // Sent without a caption, it says nothing: its file names itself.
      ['cmbx', 'file', '', false],
      // Every send is a line: the deck's first pass, hours before its final one.
      ['cmbx/kappa', 'file', 'First pass.', false],
      ['cmbx/kappa', 'start'],
      // Closed to its chair, then marked for the human's review: an item with its note, and one end after it.
      ['cmbx/cov', 'close', 'Validated to 4%.', true],
      ['cmbx/cov', 'end', 'closed'],
      ['cmbx/beam', 'start'],
      // The deck, sent alone, at its newest send; then the post to the human, carrying the plot it attached, which is not also a send of its own.
      ['cmbx/kappa', 'file', 'The final deck.', false],
      ['cmbx/kappa', 'post', 'κ×tSZ at 9σ.', false],
      // Asked of its chair, the open question is the card's.
      ['cmbx/mask', 'ask', 'Which threshold?', true],
      ['cmbx/beam', 'tick'],
    ])
    // Each item said within a life is on its line. A thread that said something in reach with no station there runs in from before it,
    // as the chair and the asking mask do; the deck's first pass came before the expert's launch and is on no line.
    expect(stream().flatMap(entry => entry.kind === 'station' ? [] : [[entry.card.id, entry.line]])).toStrictEqual([
      ['cmbx', 'C:0'], ['cmbx/kappa', undefined], ['cmbx/cov', 'V:0'], ['cmbx/kappa', 'K:0'], ['cmbx/kappa', 'K:0'], ['cmbx/mask', 'M:0'],
    ])
    // Closed or at rest, such a thread has stopped: it draws no line.
    const stopped = stream({ channel: { ...channel, everyone: channel.everyone.map(each => each === mask ? { ...mask, column: 'resting' as const } : each) } })
    expect(stopped.find(entry => entry.kind !== 'station' && entry.card.id === 'cmbx/mask')?.line).toBeUndefined()
    const post = stream().find(entry => entry.kind === 'post')
    expect(post?.kind === 'post' && post.files.map(file => [file.basename, file.caption])).toStrictEqual([['spectrum.svg', '9σ.']])
  })

  it('draws every send as a line, a worker\'s sends close together as one item with a path sent twice in it at its newest', () => {
    const sends = (over: Partial<Parameters<typeof composeStream>[0]> = {}) => stream({ records: records.filter(each => each.id !== 'r7'), ...over }).flatMap(entry => entry.kind === 'file' && entry.card === kappa ? [[entry.text, entry.files.map(file => file.basename)]] : [])
    expect(sends()).toStrictEqual([['First pass.', ['deck.html']], ['The final deck. · 9σ.', ['deck.html', 'spectrum.svg']]])
    expect(sends({ files: [...files, send('K', 'deck.html', 31, 'The final deck, fixed.')] })).toStrictEqual([['First pass.', ['deck.html']], ['The final deck, fixed. · 9σ.', ['deck.html', 'spectrum.svg']]])
  })

  it('clears a file item by naming each send it showed: a send it did not name shows, and the item goes when none is left', () => {
    const quiet = records.filter(each => each.id !== 'r7'), nulls = send('K', 'nulls.md', 28, 'The nulls.')
    const burst = stream({ records: quiet }).find((entry): entry is Item => entry.kind === 'file' && entry.card === kappa && entry.files.length > 1)!
    const shown = (over: Partial<Parameters<typeof composeStream>[0]>) => stream({ records: quiet, files: [...files, nulls], ...over })
      .flatMap(entry => entry.kind === 'file' && entry.card === kappa ? [[entry.id, entry.files.map(file => file.basename)]] : [])
    const cleared = (...dismissed: string[][]) => ({ cleared: clearedLines(dismissed.flat()) })
    const first = lineIds(burst).map(id => clearLineKey(id, now - 27 * minute))
    // Sent before the clear but read after it, the nulls were never seen: they show, in the burst they joined, which takes their name.
    expect(shown(cleared(first))).toStrictEqual([[expect.any(String), ['deck.html']], [sendId(nulls), ['nulls.md']]])
    // One device clears the burst, another the nulls; the first undoes its clear, and the nulls stay cleared.
    const second = [clearLineKey(sendId(nulls), now - 26 * minute)], undo = lineIds(burst).map(id => unclearLineKey(id, now - 25 * minute))
    expect(shown(cleared(first, second, undo)).at(-1)).toStrictEqual([burst.id, ['deck.html', 'spectrum.svg']])
    expect(shown(cleared(first, second))).toHaveLength(1)
    // The burst's first send leaving the board's reach leaves the rest cleared.
    expect(shown({ ...cleared(first, second), reachMs: 32 * minute })).toStrictEqual([])
  })

  it('applies clears before it draws a path sent twice at its newest: the older send shows once the newer is cleared, and a ✓ names both', () => {
    const quiet = records.filter(each => each.id !== 'r7'), fixed = send('K', 'deck.html', 31)
    const kappas = (over: Partial<Parameters<typeof composeStream>[0]> = {}) => stream({ records: quiet, files: [...files, fixed], ...over })
      .filter((entry): entry is Item => entry.kind === 'file' && entry.card === kappa)
    const burst = kappas().at(-1)!
    // Sent again without a caption, the deck keeps the one it was given.
    expect([burst.text, burst.files.map(file => file.timestamp)]).toStrictEqual(['The final deck. · 9σ.', [fixed.timestamp, files[2].timestamp]])
    expect(lineIds(burst)).toStrictEqual([files[1], fixed, files[2]].map(sendId))
    const newer = kappas({ cleared: clearedLines([clearLineKey(sendId(fixed), now)]) }).at(-1)!
    expect(newer.files.map(file => file.timestamp)).toStrictEqual([files[1].timestamp, files[2].timestamp])
    expect(kappas({ cleared: clearedLines(lineIds(burst).map(id => clearLineKey(id, now))) }).map(item => item.text)).toStrictEqual(['First pass.'])
  })

  it('gives an attached file the send of it nearest its line in time, leaving an earlier send of it its own line', () => {
    const early = send('K', 'spectrum.svg', 38, 'An early cut.')
    const entries = stream({ files: [early, ...files] })
    const post = entries.find((entry): entry is Item => entry.kind === 'post')!
    expect(post.files.map(file => file.timestamp)).toStrictEqual([now - 30 * minute])
    expect(entries.some(entry => entry.kind === 'file' && entry.files.includes(early))).toBe(true)
  })

  it('counts as running the threads with a live worker, once each, whatever the stream holds of their lives', () => {
    // A standing thread between runs, whose last run re-armed it with no rest or close, and a draft: no worker, not running.
    const weekly = card({ id: 'cmbx/weekly', uid: 'W', orchestrator: 'C', status: 'active', shuttleKind: 'standing' })
    const draft = card({ id: 'cmbx/draft', uid: 'D', orchestrator: 'C', status: 'open' })
    // A worker whose life ended at a close it made, still live: running.
    const closer = card({ id: 'cmbx/closer', uid: 'L', orchestrator: 'C', ...working(1), status: 'closed' })
    const all = { ...channel, everyone: [...channel.everyone, weekly, draft, closer, { ...kappa }] }
    expect(runningIn(all).map(each => each.id).sort()).toStrictEqual(['cmbx', 'cmbx/beam', 'cmbx/closer', 'cmbx/kappa'])
  })

  it('keeps out what was not addressed to the human: posts and closes to others, the human\'s lines, workers\' messages to each other', () => {
    const entries = stream()
    expect(entries.some(entry => ['r1', 'r2', 'r3', 'r5', 'r6'].includes(entry.id) && entry.kind !== 'station')).toBe(false)
    // A close to another ends its line; a temper after it is the same end, shaped as a temper.
    const done = [record('r8', 'closed', 'B', 5, { to: up }), record('r8t', 'closed', 'B', 4, { verdict: 'tempered' })]
    expect(said(stream({ records: [...records, ...done] })).slice(-1)).toStrictEqual([['cmbx/beam', 'end', 'tempered']])
  })

  it('waits where the feed says a question or close waits, else where a card waits', () => {
    // Without a line the daemon names, the card's close for review is its own item.
    const review = stream({ records: records.filter(each => each.id !== 'r3m'), waits: new Map() }).find(entry => entry.card === cov && entry.kind !== 'station')
    expect(review && review.kind !== 'station' && [review.kind, review.text, review.waiting]).toStrictEqual(['close', 'Validated to 4%.', true])
    // A question to the human that the daemon names is the item, not the card's copy of it.
    const asked = [...records, record('r9', 'asked', 'M', 21, { to: human, text: 'Which threshold, 5σ or 3σ?' })]
    const ask = stream({ records: asked, waits: new Map([['M', { id: 'r9', at: now - 21 * minute }]]) }).find(entry => entry.card === mask)
    expect(ask && ask.kind !== 'station' && [ask.id, ask.waiting]).toStrictEqual(['r9', true])
    expect(stream({ files: [...files, send('M', 'mask.svg', 1)] }).find(entry => entry.card === mask)?.kind).toBe('ask')
    // A post the daemon names waits, and only a post can be cleared by hand (the feed knows its kind once it holds the record).
    const posted = stream({ waits: new Map<string, Wait>([...waits, ['K', { id: 'r7', at: now - 30 * minute, kind: 'post' }]]) })
    expect(posted.flatMap(entry => entry.kind === 'station' ? [] : [[entry.id, entry.waiting, entry.clears]])).toStrictEqual([
      [expect.any(String), false, undefined], [expect.any(String), false, undefined], ['r3m', true, undefined], [expect.any(String), false, undefined], ['r7', true, 'K'], [expect.any(String), true, undefined],
    ])
    // A line whose record is not read yet waits, and is not offered a clear until it is known to be a post.
    const unread = stream({ records: records.filter(each => each.id !== 'r7'), waits: new Map([...waits, ['K', { id: 'r7', at: now - 30 * minute }]]) })
    const kappaItem = unread.find(entry => entry.kind === 'post' && entry.card === kappa)
    expect(kappaItem && kappaItem.kind !== 'station' && [kappaItem.waiting, kappaItem.clears]).toStrictEqual([true, undefined])
  })

  it('leaves out a line the human cleared, until a later undo brings it back', () => {
    const ids = (dismissed: string[]) => stream({ cleared: clearedLines(dismissed) }).flatMap(entry => entry.kind === 'station' ? [] : [entry.id])
    const all = ids([]), file = all.find(id => id.startsWith('file:'))!
    expect(ids([clearLineKey('r7', 5), clearLineKey(file, 5)])).toStrictEqual(all.filter(id => id !== 'r7' && id !== file))
    expect(ids([clearLineKey('r7', 5), unclearLineKey('r7', 6)])).toStrictEqual(all)
    expect(ids([clearLineKey('r7', 5), unclearLineKey('r7', 6), clearLineKey('r7', 7)])).toStrictEqual(all.filter(id => id !== 'r7'))
  })

  it('leaves a closing post to the card\'s outcome rather than its words', () => {
    const closed = card({ ...cov, id: 'cmbx/cov', reviewMark: undefined, orchestrator: undefined, shuttleChannel: 'cmbx' })
    const lone = named(compose([chair, closed]), 'channel:cmbx')
    const item = stream({ channel: lone, records: [record('c1', 'closed', 'V', 40, { to: human, text: 'Validated against 2000 simulations.' })], waits: new Map([['V', { id: 'c1', at: now - 40 * minute }]]) }).find(entry => entry.card === closed)
    expect(item && item.kind !== 'station' && [item.kind, item.text, item.waiting]).toStrictEqual(['close', '', true])
  })

  it('judges what is new by when it arrived here, and leaves what fell out of the board\'s reach', () => {
    const late = record('r11', 'asked', 'M', 30, { to: human, text: 'Which threshold?', received_at: now - minute })
    const item = stream({ records: [late], waits: new Map([['M', { id: 'r11', at: now - 30 * minute }]]) }).find(entry => entry.card === mask)
    expect(item && item.kind !== 'station' && [item.at, item.arrived]).toStrictEqual([now - 30 * minute, now - minute])
    expect(said(stream({ reachMs: 40 * minute })).map(entry => entry[0])).not.toContain('cmbx')
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
    expect(channels.map(channel => [channel.name, channel.waiting])).toStrictEqual([['spt', false], ['unions', true]])
    expect(railOrder(channels, ['channel:spt', 'channel:unions']).map(channel => channel.name)).toStrictEqual(['unions', 'spt'])
    const hidden = named(compose([unions, review, paper, bins], { dismissed: [hideKey('channel:spt', now - 60 * minute)] }), 'channel:spt')
    expect([hidden.hidden, hidden.listed]).toStrictEqual([now - 60 * minute, false])
  })
})

describe('a channel\'s key', () => {
  it('takes the channel filed above a thread whose ancestors are closed or absent', () => {
    // The Lightcone desk is tempered; its live thread, under ancestors closed or absent, has no orchestrator.
    const lightcone = card({ id: 'lc/desk', uid: 'LD', name: 'Lightcone desk', shuttleChannel: 'Lightcone', shuttleRole: 'lightcone-desk', column: 'tempered', status: 'closed' })
    const glass = card({ id: 'lc/desk/paper-ii/run/glass-mocks', uid: 'G', name: 'Glass mocks', ...working(3) })
    const unit = card({ id: 'lc/desk/unit-tests', uid: 'T', name: 'Unit tests', status: 'open' })
    const near = card({ id: 'lc/desktop', uid: 'X', name: 'Not under the desk', ...working(3) })
    const channels = compose([lightcone, glass, unit, near])
    expect(named(channels, 'channel:lightcone').members.map(member => member.id)).toStrictEqual(['lc/desk/paper-ii/run/glass-mocks', 'lc/desk/unit-tests'])
    // Its chair is its live member: the tempered desk speaks for no one.
    expect(named(channels, 'channel:lightcone').seat!.id).toBe('lc/desk/paper-ii/run/glass-mocks')
    expect(named(channels, 'channel:lightcone').name).toBe('lightcone')
    expect(named(channels, MISC).members.map(member => member.id)).toStrictEqual(['lc/desktop'])
  })
})

describe('a thread\'s lives', () => {
  const hub = card({ id: 'pando/unions', uid: 'U', name: 'UNIONS', shuttleChannel: 'UNIONS', shuttleSeat: true, ...idle(1) })
  const thread = card({ id: 'pando/unions/bring-425', uid: 'T', name: 'Bring 425', orchestrator: 'U', ...working(1) })
  const channel = named(compose([hub, thread]), 'channel:unions')
  const record = (id: string, kind: string, fiber: string, minutes: number, over: Partial<BoardRecord> = {}): BoardRecord => ({ id, kind, fiber, by: { fiber }, timestamp: now - minutes * minute, ...over })
  const stations = (records: BoardRecord[], launches: Record<string, number[]>) =>
    composeStream({ channel, records, files: [], waits: new Map(), launches: each => (launches[each.uid!] ?? []).map(minutes => now - minutes * minute), cleared: new Map(), now, reachMs })
      .flatMap(entry => entry.kind === 'station' ? [[entry.card.uid, entry.what, entry.line, ...entry.end ? [entry.end] : []]] : [])

  it('starts once per run however often its session is resumed, ticks a handoff, and starts again only after it ended', () => {
    // The hub as the board read it on 16 Nov: launched, resumed and resumed again, handed off, closed, launched again.
    expect(stations([record('h1', 'handed_off', 'U', 200), record('c1', 'closed', 'U', 100, { to: { label: 'Cail' } })], { U: [300, 260, 259, 240, 199, 30] })).toStrictEqual([
      ['U', 'start', 'U:0'], ['U', 'tick', 'U:0'], ['U', 'end', 'U:0', 'closed'], ['U', 'start', 'U:1'],
    ])
  })

  it('ends a life before a launch at the same instant starts the next', () => {
    expect(stations([record('c1', 'closed', 'T', 50, { to: { fiber: 'U' } })], { T: [80, 50] })).toStrictEqual([
      ['T', 'start', 'T:0'], ['T', 'end', 'T:0', 'closed'], ['T', 'start', 'T:1'],
    ])
  })

  it('runs in from the stream\'s top when its start is out of reach, and ends where its last verdict came', () => {
    expect(stations([record('h1', 'handed_off', 'T', 50), record('c1', 'closed', 'T', 40, { to: { fiber: 'U' } }), record('c2', 'closed', 'T', 39, { verdict: 'discarded' })], {})).toStrictEqual([
      ['T', 'tick', 'T:0'], ['T', 'end', 'T:0', 'discarded'],
    ])
  })

  it('ends a life at a rest, which a later launch follows with a new one; a rest after an end moves nothing', () => {
    // A seat between runs: launched, rested, launched again and still running.
    expect(stations([record('r1', 'rested', 'U', 100)], { U: [200, 30] })).toStrictEqual([
      ['U', 'start', 'U:0'], ['U', 'end', 'U:0', 'rested'], ['U', 'start', 'U:1'],
    ])
    expect(stations([record('c1', 'closed', 'T', 60, { to: { fiber: 'U' } }), record('r1', 'rested', 'T', 50)], { T: [80] })).toStrictEqual([
      ['T', 'start', 'T:0'], ['T', 'end', 'T:0', 'closed'],
    ])
  })
})
