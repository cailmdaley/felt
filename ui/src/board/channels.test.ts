import { describe, expect, it } from 'vitest'
import { RECENT_MS, arranged, clearLineKey, clearedLines, composeChannels, composeStream, hideKey, lineIds, railOrder, reordered, sendId, showKey, unclearLineKey, unpinKey, type Channel, type Entry, type Item } from './channels.js'
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
// An office without a channel; a lone top-level; one idle for more than a week.
const shear = card({ id: 'shear', uid: 'S', name: 'Cosmic shear', shuttleRole: 'analyst', ...working(5) })
const van = card({ id: 'van', uid: 'R', name: 'Moving house', status: 'active', ask: { text: 'Which van?', at: at(10) } })
const old = card({ id: 'old', uid: 'O', name: 'Old notes', status: 'open', modifiedAt: new Date(now - RECENT_MS - day).toISOString() })

const all = [unions, east, west, modes, vizier, post, shear, van, old]
type Input = Parameters<typeof composeChannels>[0]
function compose(cards: KanbanCard[], over: Partial<Input> = {}): Channel[] {
  const index = new ThreadIndex(cards)
  return composeChannels({ cards, parentOf: card => index.parentOf(card), names: new Map([['analyst', 'Analyst · the shear desk']]), dismissed: [], pinned: new Map(), waits: new Map(), now, ...over })
}
const named = (channels: Channel[], key: string): Channel => channels.find(channel => channel.key === key)!

describe('composeChannels', () => {
  it('groups by shuttle.channel, inherited through the orchestrator, else by office, else by top-level; chaired channels first by name', () => {
    const channels = compose(all)
    expect(channels.map(channel => [channel.key, channel.name, channel.chaired, channel.members.map(member => member.id)])).toStrictEqual([
      ['role:analyst', 'analyst', true, ['shear']],
      ['channel:unions', 'unions', true, ['pando/unions', 'east-unions', 'west-unions', 'pando/unions/modes']],
      ['channel:vizier', 'vizier', true, ['life/vizier', 'loom/email/morning-post']],
      ['fiber:O', 'old', false, ['old']],
      ['fiber:R', 'van', false, ['van']],
    ])
    expect(named(channels, 'fiber:R').title).toBe('Moving house')
    expect(named(channels, 'role:analyst').title).toBe('Analyst · the shear desk')
    expect(named(channels, 'channel:unions').families).toStrictEqual(['U'])
  })

  it('names a seatless office for its office, retaining the eldest top-level as chair', () => {
    const elder = card({ id: 'life/fee', uid: 'I1', name: 'Fee and mission', shuttleRole: 'intendant', createdAt: at(600) })
    const younger = card({ id: 'life/travel', uid: 'I2', shuttleRole: 'intendant', createdAt: at(60) })
    const office = named(compose([younger, elder], { names: new Map([['intendant', 'Intendant · missions']]) }), 'role:intendant')
    expect([office.name, office.title, office.seat]).toStrictEqual(['intendant', 'Intendant · missions', elder])
    expect(named(compose([elder], { names: new Map() }), 'role:intendant').title).toBe('intendant')
    const seat = card({ id: 'life/office-chair', uid: 'I3', name: 'Office chair', shuttleRole: 'intendant', shuttleSeat: true })
    const seated = named(compose([elder, seat]), 'role:intendant')
    expect([seated.name, seated.title, seated.seat]).toStrictEqual(['office-chair', 'Office chair', seat])
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
    expect(channels.filter(channel => channel.name === 'vizier')).toHaveLength(1)
    expect(named(channels, 'channel:vizier').title).toBe('Vizier')
    expect(named(channels, 'channel:vizier').members.map(member => member.id)).toContain('life/errand')
  })

  it('chairs a channel with its topmost seat, a non-standing one first, then the eldest, so its name holds still', () => {
    const channels = compose(all)
    expect(named(channels, 'channel:unions').seat.id).toBe('pando/unions')
    expect(named(channels, 'channel:vizier').seat.id).toBe('life/vizier')
    // Without a seat, a top-level, never a thread under it.
    const lone = card({ id: 'lone', uid: 'L', shuttleChannel: 'French', ...working(40) })
    const lesson = card({ id: 'lesson', uid: 'L2', orchestrator: 'L', ...working(1) })
    expect(named(compose([lone, lesson]), 'channel:french').seat.id).toBe('lone')
    // Two top-levels: the elder chairs, however recently the younger was active.
    const elder = card({ id: 'spt/edfs', uid: 'E1', shuttleChannel: 'SPT', createdAt: at(600), ...idle(300) })
    const younger = card({ id: 'spt/pol', uid: 'E2', shuttleChannel: 'SPT', createdAt: at(60), ...working(1) })
    expect(named(compose([younger, elder]), 'channel:spt').name).toBe('edfs')
  })

  it('lists a channel waiting, pinned, or active within a week, the same on every device', () => {
    const listed = (over: Partial<Input> = {}) => compose(all, over).filter(channel => channel.listed).map(channel => channel.key)
    expect(listed()).not.toContain('fiber:O')
    expect(listed({ pinned: new Map([['fiber:O', now - 2 * day]]) })).toContain('fiber:O')
    expect(listed({ pinned: new Map([['fiber:O', now - 2 * day]]), dismissed: [unpinKey('fiber:O', now - day)] })).not.toContain('fiber:O')
    const moving = named(compose(all), 'fiber:R')
    expect([moving.waiting, moving.newest, moving.listed]).toStrictEqual([true, now - 10 * minute, true])
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

  it('waits on what is addressed to the human: an open ask, a harness prompt, a blocked turn or a close for review, never a worker idle at the end of its turn', () => {
    const turns = [
      card({ id: 'idle', uid: 'I1', ...idle(3) }),
      card({ id: 'blocked', uid: 'I2', status: 'active', workerState: 'blocked', lastActivityAt: now - minute }),
      card({ id: 'prompt', uid: 'I3', status: 'active', workerState: 'running', runtimePhase: 'attention', lastActivityAt: now - minute }),
      card({ id: 'asking', uid: 'I4', ...idle(3), ask: { text: 'Which mask?', at: at(4) } }),
      card({ id: 'review', uid: 'I5', status: 'closed', column: 'awaitingReview', closedAt: at(90) }),
    ]
    const waiting = Object.fromEntries(compose(turns).map(channel => [channel.name, channel.waiting && channel.newest]))
    expect(waiting).toStrictEqual({ idle: false, blocked: now - minute, prompt: now - minute, asking: now - 4 * minute, review: now - 90 * minute })
  })

  it('waits where the daemon says a member\'s line waits on the human, and brings a hidden channel back for it', () => {
    const hidden = { dismissed: [hideKey('role:analyst', now - 60 * minute)] }
    expect(named(compose(all, hidden), 'role:analyst').hidden).toBe(now - 60 * minute)
    const shearDesk = named(compose(all, { ...hidden, waits: new Map([['S', { id: 's1', at: now - 5 * minute }]]) }), 'role:analyst')
    expect([shearDesk.waiting, shearDesk.newest, shearDesk.hidden, shearDesk.listed]).toStrictEqual([true, now - 5 * minute, 0, true])
  })
})

describe('the rail\'s order', () => {
  const keys = (channels: Channel[]) => channels.map(channel => channel.key)
  // Moving house, UNIONS (its thread asks) and Vizier (its chair is idle) wait on the human; the van's ask is the newest.
  const channels = compose(all)

  it('puts the channels an order does not name first, as composed, then the order\'s', () => {
    expect(keys(arranged(channels, []))).toStrictEqual(['role:analyst', 'channel:unions', 'channel:vizier', 'fiber:O', 'fiber:R'])
    expect(keys(arranged(channels, ['fiber:O', 'channel:vizier', 'channel:gone', 'role:analyst']))).toStrictEqual(['channel:unions', 'fiber:R', 'fiber:O', 'channel:vizier', 'role:analyst'])
  })

  it('floats what waits on the human, the newest wait first, above the human\'s order', () => {
    // The vizier's chair, idle at the end of its turn, waits on no one.
    expect(channels.filter(channel => channel.waiting).map(channel => [channel.key, channel.newest])).toStrictEqual([['channel:unions', now - 20 * minute], ['fiber:R', now - 10 * minute]])
    expect(keys(railOrder(channels, ['fiber:O', 'channel:vizier', 'role:analyst', 'fiber:R', 'channel:unions']))).toStrictEqual(['fiber:R', 'channel:unions', 'fiber:O', 'channel:vizier', 'role:analyst'])
  })

  it('rearranges only the channels shown, every other keeping its place', () => {
    const order = ['role:analyst', 'fiber:R', 'channel:unions', 'fiber:O', 'channel:vizier']
    // Shown: analyst, unions, vizier (fiber:R waits, fiber:O is out of the rail); vizier is dragged to the top.
    expect(reordered(order, ['channel:vizier', 'role:analyst', 'channel:unions'])).toStrictEqual(['channel:vizier', 'fiber:R', 'role:analyst', 'fiber:O', 'channel:unions'])
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
  const streamOf = (over: Partial<Parameters<typeof composeStream>[0]> = {}) =>
    composeStream({ channel, records, files, waits, launches: card => launches.get(card.uid!) ?? [], cleared: new Map(), now, reachMs, ...over })
  const stream = (over: Partial<Parameters<typeof composeStream>[0]> = {}): Entry[] => streamOf(over).entries
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

  it('counts a thread running though the human cleared all it said, and not one that said nothing in reach', () => {
    const plan = stream().find((entry): entry is Item => entry.kind === 'file' && entry.card === chair)!
    expect(streamOf().running).toContain(chair)
    const cleared = streamOf({ cleared: clearedLines(lineIds(plan).map(id => clearLineKey(id, now))) })
    expect([cleared.entries.some(entry => entry.card === chair), cleared.running.includes(chair)]).toStrictEqual([false, true])
    expect(streamOf({ files: files.filter(file => file.uid !== 'C') }).running).not.toContain(chair)
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
    expect(channels.map(channel => [channel.name, channel.waiting])).toStrictEqual([['paper', false], ['unions', true]])
    expect(railOrder(channels, ['channel:spt', 'channel:unions']).map(channel => channel.name)).toStrictEqual(['unions', 'paper'])
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
    // Its chair is its live member: the tempered desk speaks for no one.
    expect(named(channels, 'channel:lightcone').name).toBe('glass-mocks')
    expect(named(channels, 'fiber:X').members.map(member => member.id)).toStrictEqual(['lc/desktop'])
  })
})

describe('a thread\'s lives', () => {
  const hub = card({ id: 'pando/unions', uid: 'U', name: 'UNIONS', shuttleChannel: 'UNIONS', shuttleSeat: true, ...idle(1) })
  const thread = card({ id: 'pando/unions/bring-425', uid: 'T', name: 'Bring 425', orchestrator: 'U', ...working(1) })
  const channel = named(compose([hub, thread]), 'channel:unions')
  const record = (id: string, kind: string, fiber: string, minutes: number, over: Partial<BoardRecord> = {}): BoardRecord => ({ id, kind, fiber, by: { fiber }, timestamp: now - minutes * minute, ...over })
  const stations = (records: BoardRecord[], launches: Record<string, number[]>) =>
    composeStream({ channel, records, files: [], waits: new Map(), launches: each => (launches[each.uid!] ?? []).map(minutes => now - minutes * minute), cleared: new Map(), now, reachMs }).entries
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
