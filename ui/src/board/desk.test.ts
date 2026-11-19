// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { Wait } from './boardFeed.js'
import { deskOrder } from './deskOrdering.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanCard } from './KanbanTypes.js'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'

afterEach(() => { document.body.replaceChildren() })

const node = (id: string, over: Partial<KanbanCard> = {}): KanbanCard =>
  card({ id, uid: id, shuttleKind: 'oneshot', status: 'active', orchestrator: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : undefined, ...over })
const cards = [node('hub', { ask: { text: 'Ship it?', at: '2026-11-15T10:00:00Z' } }), node('hub/a'), node('hub/a/b'), node('hub/a/b/c')]
function draw(waits: Map<string, Wait>, clear = vi.fn(), openDetail = vi.fn()) {
  const index = new ThreadIndex(cards)
  const desk = new KanbanSurfaceRenderer({ waits: () => waits, openDetail, clear }).renderDesk(deskOrder(index, waits), index)
  document.body.append(desk)
  const lines = [...desk.querySelectorAll<HTMLElement>('.kbn-family-top, .kbn-family-wait')]
  return { desk, lines, clear, openDetail, said: lines.map(line => [line.querySelector('.thread-row-slug')?.textContent ?? null, line.querySelector('.thread-row-doing')!.textContent!.trim(), !!line.querySelector('.kbn-ch-clear')]) }
}

it('draws a waiting post three levels down on its family\'s one card, its ✓ writing the clear and opening nothing', () => {
  const { lines, said, clear, openDetail } = draw(new Map([['hub/a/b/c', { id: 'p', at: Date.parse('2026-11-16T10:00:00Z'), kind: 'post', text: 'The cut is in.' }]]))
  // The top-level's own line heads the card; under it each member that waits, a thread row naming its thread.
  expect(said).toStrictEqual([['hub', 'Ship it?', false], ['c', 'The cut is in.', true]])
  lines[1].querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  expect(clear).toHaveBeenCalledExactlyOnceWith(cards[3])
  expect(openDetail).not.toHaveBeenCalled()
  lines[1].querySelector<HTMLElement>('.thread-row-doing')!.click()
  expect(openDetail).toHaveBeenLastCalledWith(cards[3])
})

it('offers no ✓ on a line whose kind the board has not read yet', () => {
  const { said } = draw(new Map([['hub/a/b/c', { id: 'p', at: Date.parse('2026-11-16T10:00:00Z') }]]))
  expect(said[1]).toStrictEqual(['c', 'waiting', false])
})

it('draws the three columns, then the shelf of three, each named, a shelf card without the word its section already says', () => {
  const quiet = [node('plan', { status: 'open' }), node('later', { status: 'open', effectiveHorizon: 'stashed' }), node('referee', { status: 'open', shuttleSeat: true, shuttleRole: 'referee' }), node('watch', { status: 'open', shuttleKind: 'standing', effectiveHorizon: 'stashed' }), node('chair', { status: 'open', shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'chair', effectiveHorizon: 'stashed' })]
  const index = new ThreadIndex(quiet)
  const desk = new KanbanSurfaceRenderer({ waits: () => new Map(), openDetail: vi.fn(), clear: vi.fn() }).renderDesk(deskOrder(index, new Map()), index)
  const titles = (scope: string) => [...desk.querySelectorAll(`${scope} > .kbn-col`)].map(col => col.querySelector('.kbn-col-title')!.textContent)
  expect(titles('.kbn-now-board')).toStrictEqual(['Waiting on you', 'Working', 'Awaiting review'])
  expect(titles('.kbn-desk-shelf')).toStrictEqual(['Drafts', 'Resting', 'Roles & standing'])
  const meta = (id: string) => desk.querySelector(`.kbn-family[data-card-uid="${id}"] .kbn-family-meta`)!.textContent
  // A standing seat at rest says its schedule is paused.
  expect([meta('plan'), meta('later'), meta('referee'), meta('watch'), meta('chair')]).toStrictEqual(['', '', '', 'paused', 'paused'])
})

it('heads a family with its top-level\'s own waiting line, the working count beside it, and never repeats it below', () => {
  const lone = [node('move', { ask: { text: 'Which van?', at: '2026-11-15T10:00:00Z' } }), node('trip', { ask: { text: 'Which train?', at: '2026-11-15T09:00:00Z' } }), node('trip/bags', { workerState: 'running', runtimePhase: 'working' })]
  const index = new ThreadIndex(lone)
  const desk = new KanbanSurfaceRenderer({ waits: () => new Map(), openDetail: vi.fn(), clear: vi.fn() }).renderDesk(deskOrder(index, new Map()), index)
  const move = desk.querySelector<HTMLElement>('.kbn-family[data-card-uid="move"]')!
  expect([move.querySelector('.kbn-family-head'), move.querySelectorAll('[data-card-uid]').length]).toStrictEqual([null, 0])
  expect([...move.querySelectorAll('.thread-row')].map(row => [row.querySelector('.thread-row-slug')!.textContent, row.querySelector('.thread-row-doing')!.textContent])).toStrictEqual([['move', 'Which van?']])
  // With a thread working under it, the same head counts it after its age, and no line below repeats the top-level.
  const trip = desk.querySelector<HTMLElement>('.kbn-family[data-card-uid="trip"]')!
  const head = trip.querySelector<HTMLElement>(':scope > .kbn-family-top')!
  expect([...head.children].map(part => part.classList.contains('thread-row-age') ? 'age' : part.className.split(' ')[0])).toStrictEqual(['constitution-state-dot', 'thread-row-slug', 'thread-row-doing', 'age', 'kbn-family-meta'])
  expect([head.querySelector('.thread-row-slug')!.textContent, head.querySelector('.kbn-family-meta')!.textContent, trip.querySelectorAll('.kbn-family-wait, .kbn-family-head').length]).toStrictEqual(['trip', '1 working', 0])
  // A top-level that does not wait keeps the plain head, its waiting members below.
  const base = new ThreadIndex([node('base', { workerState: 'running', runtimePhase: 'working' }), node('base/a')])
  const posted = new Map([['base/a', { id: 'p', at: 1, kind: 'post' as const, text: 'In.' }]])
  const plain = new KanbanSurfaceRenderer({ waits: () => posted, openDetail: vi.fn(), clear: vi.fn() }).renderDesk(deskOrder(base, posted), base)
  expect([plain.querySelector('.kbn-family-top'), plain.querySelector('.kbn-family-head .kbn-family-name')!.textContent, [...plain.querySelectorAll('.kbn-family-wait .thread-row-slug')].map(each => each.textContent)]).toStrictEqual([null, 'base', ['a']])
})

it('keeps a lone waiting post\'s ✓ on its one row: the ✓ clears and opens nothing, the row opens the constitution', () => {
  const memo = node('memo')
  const index = new ThreadIndex([memo])
  const waits = new Map([['memo', { id: 'm', at: Date.parse('2026-11-16T10:00:00Z'), kind: 'post' as const, text: 'The memo is sent.' }]])
  const clear = vi.fn(), openDetail = vi.fn()
  const desk = new KanbanSurfaceRenderer({ waits: () => waits, openDetail, clear }).renderDesk(deskOrder(index, waits), index)
  const row = desk.querySelector<HTMLElement>('.kbn-family[data-card-uid="memo"] > .kbn-family-top')!
  row.querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  expect([clear.mock.calls, openDetail.mock.calls.length]).toStrictEqual([[[memo]], 0])
  row.querySelector<HTMLElement>('.thread-row-doing')!.click()
  expect(openDetail).toHaveBeenCalledExactlyOnceWith(memo)
})
