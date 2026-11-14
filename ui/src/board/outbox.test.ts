import { describe, expect, it } from 'vitest'
import { composeOutbox, type HeldSpeech } from './outbox.js'
import { card } from './testFixtures.js'
import type { SentFile } from './sentFiles.js'

const now = Date.parse('2026-11-14T12:00:00Z'), reachMs = 14 * 86_400_000
const at = (ago = 0): string => new Date(now - ago).toISOString()
const ask = card({ id: 'ask', uid: 'A', status: 'active', ask: { text: 'Choose the cut?', at: at(2000) } })
const review = card({ id: 'review', uid: 'R', column: 'awaitingReview', closedAt: at(3000), outcome: 'The cut is validated.' })
const thread = card({ id: 'thread', uid: 'T', orchestrator: 'R', column: 'awaitingReview', reviewMark: { at: at(1000), note: 'Please check the plot.' } })
const files: SentFile[] = [{ uid: 'R', host: 'host', fullPath: '/plot.png', basename: 'plot.png', timestamp: now - 4000 }]
const held: HeldSpeech[] = [{ fiber_id: 'A', name: 'Speaker', n: 2, first: 'The plot is ready.', at: now - 5000 }]
const input = { cards: [ask, review, thread], files, held, dismissed: new Set<string>(), now, reachMs }

describe('composeOutbox', () => {
  it('joins all four sources, attributes files and speech, and orders newest first', () => {
    const items = composeOutbox(input)
    expect(items.map(item => [item.kind, item.fiber, item.text])).toStrictEqual([
      ['review', 'T', 'Please check the plot.'], ['ask', 'A', 'Choose the cut?'], ['review', 'R', 'The cut is validated.'], ['file', 'R', 'plot.png'], ['spoken', 'A', 'The plot is ready.'],
    ])
    expect(items.map(item => item.key)).toStrictEqual([`review:T:${at(1000)}`, `ask:A:${at(2000)}`, `review:R:${at(3000)}`, `file:host:/plot.png:${now - 4000}`, expect.stringMatching(/^spoken:A:[0-9a-z]+$/)])
    expect(items[3].name).toBe('review')
    expect(items[4].name).toBe('ask')
  })
  it('cleared asks, reviewed closes, unmarked threads and played lines leave; files remain', () => {
    expect(composeOutbox({ ...input, cards: [{ ...ask, ask: undefined }, { ...review, column: 'tempered' }, { ...thread, column: 'orchestratorReview', reviewMark: undefined }], held: [] }).map(item => item.kind)).toStrictEqual(['file'])
  })
  it('counts an ask only on an active card, and keeps a held line queued before lines carried a time', () => {
    expect(composeOutbox({ ...input, cards: [{ ...ask, status: 'closed' }], files: [], held: [] })).toHaveLength(0)
    expect(composeOutbox({ ...input, cards: [], files: [], held: [{ ...held[0], at: null }] }).map(item => [item.kind, item.at])).toStrictEqual([['spoken', now]])
  })
  it('does not mistake a Desk section heading or an orchestrator-only close for human review', () => {
    const cards = [{ ...review, deskSection: 'to-review' as const }, { ...thread, column: 'orchestratorReview' as const, reviewMark: undefined }]
    expect(composeOutbox({ ...input, cards, files: [], held: [] })).toHaveLength(0)
  })
  it('keeps the cutoff itself, excludes older items of every kind and omits dismissed keys', () => {
    const all = composeOutbox(input)
    expect(composeOutbox({ ...input, dismissed: new Set(all.map(item => item.key)) })).toHaveLength(0)
    expect(composeOutbox({ ...input, now: now + reachMs })).toHaveLength(0)
    const boundary = { ...files[0], timestamp: now - reachMs }
    expect(composeOutbox({ ...input, cards: [], files: [boundary, { ...boundary, fullPath: '/old', timestamp: boundary.timestamp - 1 }], held: [] }).map(item => item.text)).toStrictEqual(['plot.png'])
  })
  it('deduplicates mirrors and repeated feed records without hiding a new ask', () => {
    const items = composeOutbox({ ...input, cards: [ask, ask, { ...ask, ask: { text: 'Another question', at: at() } }], files: [files[0], files[0]], held: [] })
    expect(items.map(item => item.kind)).toStrictEqual(['ask', 'ask', 'file'])
  })
})
