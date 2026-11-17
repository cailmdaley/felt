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
  const lines = [...desk.querySelectorAll<HTMLElement>('.kbn-family-wait')]
  return { desk, lines, clear, openDetail, said: lines.map(line => [line.querySelector('.thread-row-slug')?.textContent ?? null, line.querySelector('.thread-row-doing')!.textContent!.trim(), !!line.querySelector('.kbn-ch-clear')]) }
}

it('draws a waiting post three levels down on its family\'s one card, its ✓ writing the clear and opening nothing', () => {
  const { lines, said, clear, openDetail } = draw(new Map([['hub/a/b/c', { id: 'p', at: Date.parse('2026-11-16T10:00:00Z'), kind: 'post', text: 'The cut is in.' }]]))
  // The newest wait first, each a thread row naming its thread.
  expect(said).toStrictEqual([['c', 'The cut is in.', true], ['hub', 'Ship it?', false]])
  lines[0].querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  expect(clear).toHaveBeenCalledExactlyOnceWith(cards[3])
  expect(openDetail).not.toHaveBeenCalled()
  lines[0].querySelector<HTMLElement>('.thread-row-doing')!.click()
  expect(openDetail).toHaveBeenLastCalledWith(cards[3])
})

it('offers no ✓ on a line whose kind the board has not read yet', () => {
  const { said } = draw(new Map([['hub/a/b/c', { id: 'p', at: Date.parse('2026-11-16T10:00:00Z') }]]))
  expect(said[0]).toStrictEqual(['c', 'waiting', false])
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
