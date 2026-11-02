// @vitest-environment jsdom
import { expect, it } from 'vitest'
import fc from 'fast-check'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex, threadKey } from '../threads.js'
import { renderThreadTree, shelfOf, threadTree, type TreeNode } from './ThreadTree.js'

const dates = ['', '2026-11-02T09:00:00-08:00', '2026-11-02T10:00:00+01:00', '2026-11-02T09:00:00Z', '2026-11-02T17:00:00Z', '2026-11-01T23:00:00-08:00']
const spec = fc.array(fc.record({ parent: fc.nat(), age: fc.integer({ min: 0, max: 5 }), state: fc.integer({ min: 0, max: 4 }) }), { minLength: 1, maxLength: 30 })
const make = (rows: Array<{ parent: number; age: number; state: number }>): KanbanCard[] => {
  const root = card({ id: 'root', name: 'root', createdAt: '' })
  return [root, ...rows.map((row, i) => card({
    id: `n${i}`, name: `name${i % 3}`, orchestrator: i === 0 ? root.id : (row.parent % (i + 1) === 0 ? root.id : `n${row.parent % (i + 1) - 1}`),
    createdAt: dates[row.age],
    ...(row.state === 0 ? { status: 'closed', tempered: true } : row.state === 1 ? { status: 'closed' } : row.state === 2 ? { status: 'active', ask: { text: 'Question?', at: '2026-01-01T00:00:00Z' } } : row.state === 3 ? { status: 'active' } : { status: 'open' }),
  }))]
}
const flatten = (node: TreeNode): TreeNode[] => [node, ...node.children.flatMap(flatten)]
const run = { seed: 712849, numRuns: 200 }

it('orders mixed offsets by instant and puts absent timestamps last', () => {
  const root = card({ id: 'root' })
  const west = card({ id: 'west', orchestrator: root.id, createdAt: '2026-11-02T09:00:00-08:00' })
  const east = card({ id: 'east', orchestrator: root.id, createdAt: '2026-11-02T10:00:00+01:00' })
  const missing = card({ id: 'missing', orchestrator: root.id, createdAt: '' })
  expect(threadTree(new ThreadIndex([root, west, missing, east]), root).children.map(n => n.card.id)).toEqual(['east', 'west', 'missing'])
})

it('keeps every node once in creation-ordered ancestry, independent of state', () => {
  fc.assert(fc.property(spec, rows => {
    const cards = make(rows), index = new ThreadIndex(cards), root = cards[0]
    const tree = threadTree(index, root), nodes = flatten(tree)
    expect(nodes).toHaveLength(cards.length)
    expect(new Set(nodes.map(n => threadKey(n.card))).size).toBe(cards.length)
    const positions = new Map(nodes.map((n, i) => [threadKey(n.card), i]))
    for (const node of nodes) {
      const parent = index.parentOf(node.card)
      if (parent) {
        const p = nodes[positions.get(threadKey(parent))!]!
        expect(positions.get(threadKey(parent))!).toBeLessThan(positions.get(threadKey(node.card))!)
        expect(node.depth).toBe(p.depth + 1)
      }
      const epoch = (c: KanbanCard) => c.createdAt ? Date.parse(c.createdAt) : Number.POSITIVE_INFINITY
      const sorted = [...node.children].sort((a, b) => (epoch(a.card) - epoch(b.card)) || a.card.name.localeCompare(b.card.name) || threadKey(a.card).localeCompare(threadKey(b.card)))
      expect(node.children.map(n => threadKey(n.card))).toEqual(sorted.map(n => threadKey(n.card)))
    }
    const changed = cards.map((c, i) => ({ ...c, status: i % 2 ? 'closed' : 'active', tempered: i % 2 === 1, ask: undefined }))
    expect(flatten(threadTree(new ThreadIndex(changed), changed[0])).map(n => threadKey(n.card))).toEqual(nodes.map(n => threadKey(n.card)))
  }), run)
})

it('keeps threads in play in the tree and shelves the other resting, then archived, threads below it', () => {
  fc.assert(fc.property(spec, rows => {
    const cards = make(rows), index = new ThreadIndex(cards), root = cards[0]
    const container = document.createElement('div')
    container.append(...renderThreadTree(index, root, root, c => {
      const row = document.createElement('div'); row.className = 'kbn-thread-row'; row.dataset.id = c.id; return row
    }))
    expect(container.querySelectorAll('.kbn-thread-row')).toHaveLength(cards.length)
    const quiet = (c: KanbanCard) => shelfOf(index, c) !== 'tree'
    const context = (c: KanbanCard) => index.subtree(c).some(child => !quiet(child))
    for (const c of cards) {
      const row = container.querySelector<HTMLElement>(`[data-id="${c.id}"]`)!
      const shelf = row.closest<HTMLDetailsElement>('details')?.dataset.threadDetails
      if (c === root || !quiet(c) || context(c)) expect(shelf).toBeUndefined()
      else expect(shelf).toBe(shelfOf(index, c))
    }
    for (const shelf of container.querySelectorAll<HTMLDetailsElement>('details')) expect(shelf.open).toBe(shelf.dataset.threadDetails === 'resting')
    const order = [...container.querySelectorAll('details')].map(el => el.dataset.threadDetails)
    expect(order).toEqual(['resting', 'archived'].filter(s => order.includes(s)))
    expect(container.querySelector('.ws-tree-attention')).toBeNull()
  }), { ...run, numRuns: 100 })
})
