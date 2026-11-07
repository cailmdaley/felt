import { expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { familyModel, type MapFeeds } from './model.js'

const now = 1_800_000_000_000, hour = 3_600_000
const noFeeds: MapFeeds = { marks: () => undefined, files: () => [] }
const running = (phase: string, age: number): Partial<KanbanCard> => ({ status: 'active', workerState: 'running', runtimePhase: phase as KanbanCard['runtimePhase'], lastActivityAt: now - age * hour, workerStartedAt: now - 100 * hour })
const thread = (id: string, over: Partial<KanbanCard>): KanbanCard => card({ id, orchestrator: 'hub', createdAt: new Date(now - 200 * hour).toISOString(), ...over })
const model = (cards: KanbanCard[], feeds = noFeeds) => {
  const index = new ThreadIndex(cards)
  return familyModel(index, cards[0], cards[0], feeds, now)
}
const root = card({ id: 'hub', createdAt: new Date(now - 300 * hour).toISOString() })

it('orders attention by kind, then newest first within a kind', () => {
  const m = model([root,
    thread('hub/working', running('working', .1)),
    thread('hub/turn-old', running('waiting', 9)),
    thread('hub/turn-new', running('waiting', 2)),
    thread('hub/review', { status: 'closed', closedAt: new Date(now - hour).toISOString() }),
    thread('hub/new', running('working', 5)),
    thread('hub/blocked', { ...running('working', 1), launchError: 'no container' }),
    thread('hub/question-old', { ...running('working', 1), ask: { text: 'Older?', at: new Date(now - 5 * hour).toISOString() } }),
    thread('hub/question-new', { status: 'active', ask: { text: 'Newer?', at: new Date(now - 4 * hour).toISOString() } }),
  ], { ...noFeeds, files: thread => thread.id === 'hub/new' ? [{ key: 'k', name: 'a.html', at: now - 5 * hour, unread: true }] : [] })
  expect(m.attention.map(t => t.card.id.slice(4))).toEqual(['question-old', 'question-new', 'blocked', 'new', 'turn-new', 'turn-old', 'review', 'working'])
  expect(m.attention[0].rank).toBe(0)
  expect(m.attention[1].note).toBe('Newer?')
})
it('stops calling a thread new once its files are seen, and keeps a seen file from outranking a verdict', () => {
  const files = (unread: boolean): MapFeeds => ({ ...noFeeds, files: () => [{ key: 'k', name: 'a.html', at: now - hour, unread }] })
  const m = (unread: boolean) => model([root, thread('hub/t', running('waiting', 1))], files(unread))
  expect(m(true).attention.map(t => t.standing)).toContain('new')
  expect(m(false).attention.map(t => t.standing)).not.toContain('new')
})
it('sets drafts and resting aside as counts, and a discarded thread is never to review', () => {
  const m = model([root,
    thread('hub/draft', { status: 'open' }),
    thread('hub/rest', { status: 'open', effectiveHorizon: 'stashed' }),
    thread('hub/discarded', { status: 'closed', tempered: false, closedAt: new Date(now - hour).toISOString() }),
    thread('hub/tempered-old', { status: 'closed', tempered: true, createdAt: new Date(now - 950 * hour).toISOString(), closedAt: new Date(now - 900 * hour).toISOString() }),
    thread('hub/tempered', { status: 'closed', tempered: true, closedAt: new Date(now - 2 * hour).toISOString() }),
  ])
  expect(m.attention).toEqual([])
  expect(m.aside).toEqual({ drafts: 1, resting: 1, archived: 1 })
  expect(m.threads.get(m.order[0].key)!.standing).toBe('quiet')
  expect(m.order.map(t => t.card.id)).toEqual(['hub/discarded', 'hub/tempered', 'hub'])
})
it('keeps an aside ancestor drawn while work hangs beneath it', () => {
  const m = model([root, thread('hub/rest', { status: 'open', effectiveHorizon: 'stashed' }), { ...thread('hub/rest/work', running('working', 1)), orchestrator: 'hub/rest' }])
  const rest = [...m.threads.values()].find(t => t.card.id === 'hub/rest')!
  expect(rest.standing).toBe('aside')
  expect(rest.rank).toBeGreaterThanOrEqual(0)
  expect(m.attention.map(t => t.card.id)).toEqual(['hub/rest/work'])
  expect(m.threads.get(m.attention[0].parent!)).toBe(rest)
})
it('takes the last move from every source it knows, never past now', () => {
  const m = model([root, thread('hub/t', running('working', 50))], {
    marks: () => ({ launches: [now - 40 * hour], commits: [now - 3 * hour] }),
    files: () => [{ key: 'k', name: 'a', at: now - 7 * hour, unread: false }],
  })
  expect(m.attention[0].lastMove).toBe(now - 3 * hour)
  expect(m.attention[0].depth).toBe(1)
})
it('uses the index copy of the followed root for family attention', () => {
  const raw = card({ id: 'hub', ...running('waiting', 1), ask: { text: 'Which?', at: new Date(now - hour).toISOString() } })
  const index = new ThreadIndex([{ ...raw, followed: true }])
  const result = familyModel(index, raw, raw, noFeeds, now)
  expect(result.counts.question).toBe(0)
  expect(result.counts.turn).toBe(0)
  expect(result.root.standing).toBe('working')
})
it('names the open thread when the family holds it', () => {
  const child = thread('hub/t', running('working', 1)), index = new ThreadIndex([root, child])
  expect(familyModel(index, root, child, noFeeds, now).current).toBe(familyModel(index, root, child, noFeeds, now).attention[0].key)
})
it('reads an in-flight thread with no worker as what it is, ahead of finished work', () => {
  const m = model([root,
    thread('hub/armed', { status: 'active' }),
    thread('hub/stopped', { status: 'active', dispatchedAt: new Date(now - 9 * hour).toISOString() }),
    thread('hub/held', { status: 'active', held: true }),
    thread('hub/done', { status: 'closed', tempered: true, closedAt: new Date(now - hour).toISOString() }),
  ])
  const word = (id: string): string => [...m.threads.values()].find(t => t.card.id === id)!.word
  expect(word('hub/armed')).toBe('armed')
  expect(word('hub/stopped')).toBe('stopped')
  expect(word('hub/held')).toBe('held')
  expect(m.attention).toEqual([])
  expect(m.order.at(-2)!.card.id).toBe('hub/done')
  expect(m.order.filter(t => t.standing === 'still').length).toBe(3)
})
it('keeps a draft with a launch error a draft count', () => {
  const m = model([root, thread('hub/draft', { status: 'open', launchError: 'no container' })])
  expect(m.counts.blocked).toBe(0)
  expect(m.aside.drafts).toBe(1)
})
it('shows a closed thread\'s outcome, not the ask it left behind', () => {
  const m = model([root, thread('hub/closed', { status: 'closed', closedAt: new Date(now - 9 * hour).toISOString(), outcome: 'Landed', ask: { text: 'Leftover?', at: new Date(now - 2 * hour).toISOString() } })])
  const closed = [...m.threads.values()].find(t => t.card.id === 'hub/closed')!
  expect(closed.note).toBe('Landed')
  expect(closed.lastMove).toBe(now - 9 * hour)
})
