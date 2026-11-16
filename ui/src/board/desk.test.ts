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
  return { desk, lines, clear, openDetail, said: lines.map(line => [line.querySelector('.kbn-family-wait-slug')?.textContent ?? null, line.querySelector('.kbn-family-want')!.textContent!.trim(), !!line.querySelector('.kbn-ch-clear')]) }
}

it('draws a waiting post three levels down on its family\'s one card, its ✓ writing the clear and opening nothing', () => {
  const { lines, said, clear, openDetail } = draw(new Map([['hub/a/b/c', { id: 'p', at: Date.parse('2026-11-16T10:00:00Z'), kind: 'post', text: 'The cut is in.' }]]))
  // The newest wait first; the top-level's own want stands without its slug.
  expect(said).toStrictEqual([['c', 'The cut is in.', true], [null, 'Ship it?', false]])
  lines[0].querySelector<HTMLButtonElement>('.kbn-ch-clear')!.click()
  expect(clear).toHaveBeenCalledExactlyOnceWith(cards[3])
  expect(openDetail).not.toHaveBeenCalled()
  lines[0].querySelector<HTMLElement>('.kbn-family-want')!.click()
  expect(openDetail).toHaveBeenLastCalledWith(cards[3])
})

it('offers no ✓ on a line whose kind the board has not read yet', () => {
  const { said } = draw(new Map([['hub/a/b/c', { id: 'p', at: Date.parse('2026-11-16T10:00:00Z') }]]))
  expect(said[0]).toStrictEqual(['c', 'waiting', false])
})
