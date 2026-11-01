// @vitest-environment jsdom
import { expect, it } from 'vitest'
import fc from 'fast-check'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex, threadKey } from '../threads.js'
import { renderThreadTree, threadTree, type TreeNode } from './ThreadTree.js'

const spec = fc.array(fc.record({ parent: fc.nat(), age: fc.integer({ min: 0, max: 5 }), state: fc.integer({ min: 0, max: 4 }) }), { minLength: 1, maxLength: 30 })
const make = (rows: Array<{ parent: number; age: number; state: number }>): KanbanCard[] => {
  const root = card({ id: 'root', name: 'root', createdAt: '' })
  return [root, ...rows.map((row, i) => card({
    id: `n${i}`, name: `name${i % 3}`, orchestrator: i === 0 ? root.id : (row.parent % (i + 1) === 0 ? root.id : `n${row.parent % (i + 1) - 1}`),
    createdAt: row.age ? `2026-01-0${row.age}T00:00:00Z` : '',
    ...(row.state === 0 ? { status: 'closed', tempered: true } : row.state === 1 ? { status: 'closed' } : row.state === 2 ? { status: 'active', ask: { text: 'Question?', at: '2026-01-01T00:00:00Z' } } : row.state === 3 ? { status: 'active' } : { status: 'open' }),
  }))]
}
const flatten = (node: TreeNode): TreeNode[] => [node, ...node.children.flatMap(flatten)]
const run = { seed: 712849, numRuns: 200 }

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
      const sorted = [...node.children].sort((a, b) => a.card.createdAt.localeCompare(b.card.createdAt) || a.card.name.localeCompare(b.card.name) || threadKey(a.card).localeCompare(threadKey(b.card)))
      expect(node.children.map(n => threadKey(n.card))).toEqual(sorted.map(n => threadKey(n.card)))
    }
    const changed = cards.map((c, i) => ({ ...c, status: i % 2 ? 'closed' : 'active', tempered: i % 2 === 1, ask: undefined }))
    expect(flatten(threadTree(new ThreadIndex(changed), changed[0])).map(n => threadKey(n.card))).toEqual(nodes.map(n => threadKey(n.card)))
  }), run)
})

it('places archived children in their parent disclosure and bubbles the most urgent folded descendant', () => {
  fc.assert(fc.property(spec, rows => {
    const cards = make(rows), index = new ThreadIndex(cards), root = cards[0]
    const container = document.createElement('div')
    container.append(...renderThreadTree(index, root, root, c => {
      const row = document.createElement('div'); row.className = 'kbn-thread-row'; row.dataset.id = c.id; return row
    }))
    expect(container.querySelectorAll('.kbn-thread-row')).toHaveLength(cards.length)
    for (const parent of cards) {
      const archived = index.children(parent).filter(c => index.state(c) === 'archived')
      const group = [...container.querySelectorAll<HTMLDetailsElement>('details')].find(el => el.dataset.threadDetails === threadKey(parent))
      expect(Boolean(group)).toBe(archived.length > 0)
      if (!group) continue
      for (const child of archived) {
        const row = group.querySelector<HTMLElement>(`[data-id="${child.id}"]`)
        expect(row?.closest('details')).toBe(group)
      }
      const folded = archived.flatMap(child => [child, ...index.subtree(child)])
      const states = folded.map(c => index.state(c))
      const expected = states.includes('waiting') ? 'waiting' : states.includes('to-review') ? 'to-review' : undefined
      expect(group.querySelector<HTMLElement>(':scope > summary .ws-tree-attention')?.dataset.state).toBe(expected)
    }
  }), { ...run, numRuns: 100 })
})
