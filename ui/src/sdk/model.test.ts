import { describe, expect, it } from 'vitest'
import { attentionOf, buildFamilyTree, doingOf, groupPosts, isWaiting, isWorking, kindWord, offersFor, relativeAge } from './model'
import type { ShuttleFiber, ShuttleFiberDoc, ShuttlePostItem } from './types'

const AT = Date.parse('2026-11-20T12:00:00Z')
const fiber = (patch: Partial<ShuttleFiber> = {}, doc: Partial<ShuttleFiberDoc> = {}): ShuttleFiber => ({
  fiber: { id: 'work/task', uid: 'U-task', name: 'Task', status: 'active', modified_at: '2026-11-20T12:00:00Z', ...doc },
  origin: 'here', felt_store: '/s', path: 'work/task.md', column: 'in_flight', turn: 'none', ...patch,
})
const ask = { ask: { text: 'Which bin edges?', at: '2026-11-20T13:00:00Z' } }

describe('attention', () => {
  it('waits on an open question, a prompt, a block or a close for review', () => {
    expect(attentionOf(fiber({}, { shuttle: ask }))).toBe('waiting')
    expect(attentionOf(fiber({ turn: 'question', runtime: { state: 'running' } }))).toBe('waiting')
    expect(attentionOf(fiber({ turn: 'blocked' }))).toBe('waiting')
    expect(attentionOf(fiber({ column: 'awaiting_review' }, { status: 'closed' }))).toBe('waiting')
  })

  it('works with a live worker that asks nothing, and is quiet otherwise', () => {
    expect(attentionOf(fiber({ turn: 'idle', runtime: { state: 'running' } }))).toBe('working')
    expect(isWorking(fiber({ runtime: { state: 'running' } }))).toBe(true)
    expect(attentionOf(fiber({ column: 'resting' }, { status: 'open' }))).toBe('quiet')
  })

  it('lets a verdict settle everything, and counts a question only while armed', () => {
    expect(isWaiting(fiber({ column: 'tempered', turn: 'question' }, { status: 'closed', shuttle: ask }))).toBe(false)
    expect(isWaiting(fiber({ column: 'drafts' }, { status: 'open', shuttle: ask }))).toBe(false)
  })
})

describe('doingOf', () => {
  it('says what it asks first, then why it is blocked, then its outcome, then its word', () => {
    expect(doingOf(fiber({}, { shuttle: ask, outcome: 'done' }))).toEqual({ text: 'Which bin edges?', at: Date.parse(ask.ask.at) })
    expect(doingOf(fiber({ turn: 'blocked', dispatch_error: 'no project dir' }))).toEqual({ text: 'no project dir', at: AT })
    expect(doingOf(fiber({}, { outcome: 'Fit  the\n model' }))).toEqual({ text: 'Fit the model', at: AT })
    expect(doingOf(fiber({ column: 'drafts' }, { status: 'open' })).text).toBe('draft')
    expect(doingOf(fiber({ turn: 'working', runtime: { state: 'running', started_at: AT + 5 } }))).toEqual({ text: 'working', at: AT + 5 })
  })
})

describe('offersFor', () => {
  const verbs = (row: ShuttleFiber) => offersFor(row).map(offer => offer.verb)

  it('offers what each column can do next', () => {
    expect(verbs(fiber())).toEqual(['review', 'rest', 'temper', 'discard'])
    expect(verbs(fiber({ column: 'awaiting_review' }, { status: 'closed' }))).toEqual(['temper', 'discard', 'reopen'])
    expect(verbs(fiber({ column: 'drafts' }, { status: 'open' }))).toEqual(['resume', 'discard'])
    expect(verbs(fiber({ column: 'resting' }, { status: 'open' }))).toEqual(['resume', 'discard'])
    expect(verbs(fiber({ column: 'roles' }))).toEqual(['rest'])
    expect(verbs(fiber({ column: 'tempered' }, { status: 'closed' }))).toEqual(['reopen'])
  })

  it('rests a standing fiber as its schedule’s pause, and tempers its run only while it waits on the human', () => {
    const standing = (patch: Partial<ShuttleFiber>, doc: Partial<ShuttleFiberDoc> = {}, more: object = {}) =>
      offersFor(fiber(patch, { shuttle: { kind: 'standing', ...more }, ...doc })).map(offer => [offer.verb, offer.label, offer.request?.action])
    const temper = ['temper', 'Temper run', 'close'], pause = ['rest', 'Pause schedule', 'rest'], retire = ['discard', 'Retire', 'close']
    expect(standing({ runtime: { state: 'running' } })).toEqual([temper, pause, retire, ['kill', 'Stop worker', undefined]])
    expect(standing({}, {}, ask)).toEqual([temper, pause, retire, ['ask-clear', 'Clear question', 'ask-clear']])
    expect(standing({ column: 'resting' })).toEqual([pause, retire])
    expect(standing({})).toEqual([pause, retire])
    expect(standing({ column: 'resting' }, { status: 'open' })).toEqual([['resume', 'Resume schedule', 'resume'], retire])
    expect(standing({ column: 'awaiting_review' }, { status: 'closed' })).toEqual([])
    expect(standing({ column: 'discarded' }, { status: 'closed' })).toEqual([['reopen', 'Reopen', 'reopen']])
  })

  it('names a pulsed seat’s rest as its schedule’s', () => {
    const seat = { seat: true, pulse: { every: '59m' } }
    expect(offersFor(fiber({}, { shuttle: seat })).map(offer => offer.label)).toEqual(['Close for review', 'Pause schedule', 'Temper', 'Discard'])
    expect(offersFor(fiber({ column: 'roles' }, { status: 'open', shuttle: seat })).map(offer => offer.label)).toEqual(['Resume schedule'])
  })

  it('carries each verb’s request and marks what ends the work', () => {
    const byVerb = Object.fromEntries(offersFor(fiber({ runtime: { state: 'running' } })).map(offer => [offer.verb, offer]))
    expect(byVerb.temper.request).toEqual({ action: 'close', tempered: true })
    expect(byVerb.discard).toMatchObject({ request: { action: 'close', tempered: false }, destructive: true })
    expect(byVerb.review.request).toEqual({ action: 'close' })
    expect(byVerb.kill).toEqual({ verb: 'kill', label: 'Stop worker', destructive: true })
  })
})

describe('buildFamilyTree', () => {
  const at = (id: string, orchestrator: string | null = null, origin = 'here'): ShuttleFiber =>
    ({ ...fiber({ orchestrator, origin }, { id, uid: `U-${id}`, name: id }) })

  it('nests threads under their orchestrators, keeping feed order', () => {
    const tree = buildFamilyTree([at('a'), at('a/x', 'a'), at('b'), at('a/x/y', 'U-a/x'), at('a/z', 'a')])
    const shape = (nodes: ReturnType<typeof buildFamilyTree>): unknown => nodes.map(node => [node.fiber.fiber.id, shape(node.children)])
    expect(shape(tree)).toEqual([['a', [['a/x', [['a/x/y', []]]], ['a/z', []]]], ['b', []]])
  })

  it('prefers an orchestrator on the same host, and roots a thread whose orchestrator is absent', () => {
    const tree = buildFamilyTree([at('a', null, 'one'), at('a', null, 'two'), at('a/x', 'a', 'two'), at('lost', 'gone')])
    expect(tree.map(node => [node.fiber.origin, node.children.length])).toEqual([['one', 0], ['two', 1], ['here', 0]])
  })

  it('survives a cycle', () => {
    expect(buildFamilyTree([at('a', 'b'), at('b', 'a')]).length).toBeGreaterThan(0)
  })
})

describe('the stream', () => {
  const item = (id: string, kind: ShuttlePostItem['kind'], at: number, row = fiber()): ShuttlePostItem => ({ id, fiber: row, kind, text: id, at })

  it('names only what a line asks of the human', () => {
    expect(kindWord(item('1', 'ask', 0))).toBe('asks')
    expect(kindWord(item('1', 'close', 0, fiber({ column: 'awaiting_review' })))).toBe('for review')
    expect(kindWord(item('1', 'close', 0, fiber({ column: 'tempered' })))).toBe('closed')
    expect(kindWord(item('1', 'post', 0))).toBe('')
  })

  it('groups close lines of one thread that ask nothing', () => {
    const other = fiber({}, { id: 'work/other', uid: 'U-other' })
    const grouped = groupPosts([item('1', 'post', 0), item('2', 'post', 60_000), item('3', 'ask', 90_000), item('4', 'post', 400_000), item('5', 'file', 410_000, other), item('6', 'post', 420_000)])
    expect(grouped.map(each => each.grouped)).toEqual([false, true, false, false, false, false])
    expect(groupPosts([item('1', 'post', 0), item('2', 'post', 60_000)], 30_000).map(each => each.grouped)).toEqual([false, false])
  })

  it('reads ages in one grammar, without a zone', () => {
    expect(relativeAge(AT - 30_000, AT)).toBe('now')
    expect(relativeAge(AT - 12 * 60_000, AT)).toBe('12m ago')
    expect(relativeAge(AT - 5 * 3_600_000, AT, { short: true })).toBe('5h')
    expect(relativeAge(AT - 3 * 86_400_000, AT)).toBe('3d ago')
    expect(relativeAge(AT + 60_000, AT)).toBe('now')
    expect(relativeAge(0, AT)).toBe('')
  })
})
