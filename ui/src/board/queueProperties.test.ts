import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  buildDependents,
  queueDropIndex,
  queueIsLinear,
  queueRowDetachPlan,
  queueRowDropWrites,
  reorderQueueWrites,
  stackDropVerdict,
} from './KanbanRules.js'
import type { QueueGraphNode, StackCandidate } from './KanbanRules.js'

const members = fc.uniqueArray(fc.integer(), { minLength: 1, maxLength: 24 })
const asIds = (values: readonly number[]): string[] => values.map((value) => `m${value}`)
const index = (value: number, size: number): number => ((value % size) + size) % size

/** Read the semantic order represented by a single-predecessor dependency graph. */
function chain(head: string, predecessor: ReadonlyMap<string, string>): string[] {
  const dependents = buildDependents([...predecessor].map(([id, parent]) => ({ id, dependsOn: [parent] })))
  const ordered: string[] = []
  let current = head
  const seen = new Set([head])
  for (;;) {
    const next = dependents.get(current) ?? []
    if (next.length === 0) return ordered
    expect(next, `queue after ${current} must have one successor`).toHaveLength(1)
    current = next[0]
    expect(seen.has(current), `queue must stay acyclic at ${current}`).toBe(false)
    seen.add(current)
    ordered.push(current)
  }
}

function predecessors(head: string, queue: readonly string[]): Map<string, string> {
  return new Map(queue.map((id, i) => [id, i === 0 ? head : queue[i - 1]]))
}

describe('queue drag laws over generated chains', () => {
  it('rewires every generated reorder to exactly the requested sequence', () => {
    fc.assert(fc.property(
      members.filter((values) => values.length >= 2), fc.integer(), fc.integer(),
      (values, fromSeed, toSeed) => {
      const head = 'head'
      const queue = asIds(values)
      const from = index(fromSeed, queue.length)
      let to = index(toSeed, queue.length)
      if (to === from) to = (to + 1) % queue.length

      const expected = [...queue]
      const [item] = expected.splice(from, 1)
      expected.splice(to, 0, item)
      const actualPredecessors = predecessors(head, queue)
      for (const write of reorderQueueWrites(head, queue, from, to)) {
        expect(actualPredecessors.get(write.fiberId), 'write must name a known member').toBeDefined()
        actualPredecessors.set(write.fiberId, write.newDep)
      }

      expect(chain(head, actualPredecessors)).toEqual(expected)
      expect(actualPredecessors.size, 'identity preserved').toBe(queue.length)
      }), { seed: 0x51a7cafe, numRuns: 1500 },
    )
  })

  it('detaches a generated row by graph edges, preserving every scalar branch', () => {
    const children = fc.array(fc.constantFrom<'scalar' | 'list'>('scalar', 'list'), { maxLength: 20 })
    fc.assert(fc.property(children, (shapes) => {
      const sourceId = 'queued-review'
      const previousId = 'old-head'
      const candidates: QueueGraphNode[] = [
        { id: sourceId, dependsOn: [previousId], dependsOnShape: 'scalar' },
        ...shapes.map((shape, i) => ({
          id: `child-${i}`,
          dependsOn: shape === 'scalar' ? [sourceId] : [sourceId, `hand-edge-${i}`],
          dependsOnShape: shape,
        })),
      ]
      const scalarChildren = shapes.flatMap((shape, i) => shape === 'scalar' ? [`child-${i}`] : [])
      const listChildren = shapes.flatMap((shape, i) => shape === 'list' ? [`child-${i}`] : [])
      const before = new Map(candidates.map((node) => [node.id, [...(node.dependsOn ?? [])]]))
      const plan = queueRowDetachPlan(sourceId, previousId, candidates)

      expect(plan.writes.map((write) => write.fiberId).sort()).toEqual([...scalarChildren].sort())
      expect(plan.protectedIds.sort()).toEqual([...listChildren].sort())
      const after = new Map(before)
      for (const write of plan.writes) after.set(write.fiberId, [write.newDep])
      expect(after.get(sourceId)).toEqual(before.get(sourceId)) // Caller applies the destination's own write.
      for (const id of scalarChildren) expect(after.get(id)).toEqual([previousId])
      for (const id of listChildren) expect(after.get(id)).toEqual(before.get(id))
      expect(after.size).toBe(candidates.length)
    }), { seed: 0x0badf00d, numRuns: 1000 })
  })

  it('moves a row from branch-shaped graphs without absorbing scalar siblings', () => {
    const children = fc.array(fc.constantFrom<'scalar' | 'list'>('scalar', 'list'), { maxLength: 20 })
    fc.assert(fc.property(children, (shapes) => {
      const sourceId = 'queued-review'
      const previousId = 'old-head'
      const tailId = 'in-flight-tail'
      const childIds = shapes.map((_, i) => `child-${i}`)
      const candidates: QueueGraphNode[] = [
        { id: sourceId, dependsOn: [previousId], dependsOnShape: 'scalar' },
        ...shapes.map((shape, i) => ({
          id: childIds[i],
          dependsOn: shape === 'scalar' ? [sourceId] : [sourceId, `hand-edge-${i}`],
          dependsOnShape: shape,
        })),
        // Deeper descendants must keep their own edges while direct scalar
        // children are handed back to the source's previous card.
        ...shapes.map((_, i) => ({
          id: `grandchild-${i}`,
          dependsOn: [childIds[i]],
          dependsOnShape: 'scalar' as const,
        })),
      ]
      const scalarChildren = childIds.filter((_, i) => shapes[i] === 'scalar')
      const listedChildren = childIds.filter((_, i) => shapes[i] === 'list')
      const before = new Map(candidates.map((node) => [node.id, [...(node.dependsOn ?? [])]]))
      const plan = queueRowDropWrites(sourceId, previousId, candidates, tailId)

      expect(plan.writes.at(-1)).toEqual({ fiberId: sourceId, newDep: tailId })
      expect(plan.writes.slice(0, -1).map((write) => write.fiberId).sort()).toEqual([...scalarChildren].sort())
      expect(plan.protectedIds.sort()).toEqual([...listedChildren].sort())

      const after = new Map(before)
      for (const write of plan.writes) after.set(write.fiberId, [write.newDep])
      expect(after.get(sourceId)).toEqual([tailId])
      for (const id of scalarChildren) expect(after.get(id)).toEqual([previousId])
      for (const id of listedChildren) expect(after.get(id)).toEqual(before.get(id))
      for (const node of candidates.filter((candidate) => candidate.id.startsWith('grandchild-'))) {
        expect(after.get(node.id)).toEqual(before.get(node.id))
      }
      expect(after.size).toBe(candidates.length)
    }), { seed: 0xfaceb00c, numRuns: 1000 })
  })

  it('only enables array reorder for the actual scalar chain, never a branch or list', () => {
    fc.assert(fc.property(members, (values) => {
      const head = 'head'
      const queue = asIds(values)
      const linear: QueueGraphNode[] = queue.map((id, i) => ({
        id,
        dependsOn: [i === 0 ? head : queue[i - 1]],
        dependsOnShape: 'scalar',
      }))
      expect(queueIsLinear(head, queue, linear)).toBe(true)

      if (queue.length > 1) {
        const branched = linear.map((node, i) => i === 1 ? { ...node, dependsOn: [head] } : node)
        expect(queueIsLinear(head, queue, branched)).toBe(false)
      }
      expect(queueIsLinear(head, queue, linear.map((node) => ({ ...node, dependsOnShape: 'list' })))).toBe(false)
    }), { seed: 0xc001d00d, numRuns: 1000 })
  })

  it('accepts queued sources across lifecycle states when dropped on an independent live or review card', () => {
    const states = fc.constantFrom<Pick<StackCandidate, 'status' | 'tempered'>>(
      { status: 'open' },
      { status: 'active' },
      { status: 'closed' }, // Awaiting review.
      { status: 'closed', tempered: true },
      { status: 'closed', tempered: false },
    )
    fc.assert(fc.property(states, states, (sourceState, targetState) => {
      const source: StackCandidate = {
        id: 'queued-row', ...sourceState,
        dependsOn: ['awaiting-head'], dependsOnShape: 'scalar',
      }
      const target: StackCandidate = { id: 'destination-card', ...targetState }
      const dependents = buildDependents([{ id: source.id, dependsOn: source.dependsOn }])
      expect(stackDropVerdict(source, target, dependents)).toEqual({ ok: true, tail: target.id })
    }), { seed: 0x1a2b3c4d, numRuns: 300 })
  })

  it('preserves membership, order, and acyclicity through sequences of reorders and cross-queue drops', () => {
    const lengths = fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 2, maxLength: 4 })
    const operations = fc.array(fc.record({
      kind: fc.constantFrom<'reorder' | 'move'>('reorder', 'move'),
      sourceQueue: fc.nat(),
      destinationQueue: fc.nat(),
      member: fc.nat(),
      target: fc.nat(),
      position: fc.nat(),
    }), { maxLength: 50 })

    fc.assert(fc.property(lengths, operations, (queueLengths, ops) => {
      const heads = queueLengths.map((_, i) => `head-${i}`)
      const queues = queueLengths.map((length, q) =>
        Array.from({ length }, (_, i) => `q${q}-m${i}`),
      )
      const nodes = new Map<string, QueueGraphNode & StackCandidate>()
      for (let q = 0; q < queues.length; q += 1) {
        queues[q].forEach((id, i) => nodes.set(id, {
          id,
          status: (q + i) % 2 === 0 ? 'open' : 'closed',
          dependsOn: [i === 0 ? heads[q] : queues[q][i - 1]],
          dependsOnShape: 'scalar',
        }))
      }

      const currentEdges = (): Map<string, string> => new Map(
        [...nodes.values()].map((node) => [node.id, node.dependsOn![0]]),
      )
      const graphNodes = (): QueueGraphNode[] => [...nodes.values()]
      const assertModel = (): void => {
        const all = queues.flat()
        expect(new Set(all).size, 'no duplicate card identity').toBe(all.length)
        expect(nodes.size, 'no identity lost').toBe(all.length)
        for (let q = 0; q < queues.length; q += 1) {
          expect(queueIsLinear(heads[q], queues[q], graphNodes())).toBe(true)
          expect(chain(heads[q], currentEdges())).toEqual(queues[q])
        }
      }

      assertModel()
      for (const op of ops) {
        const fromQueue = index(op.sourceQueue, queues.length)
        const toQueue = index(op.destinationQueue, queues.length)
        const sourceOrder = queues[fromQueue]
        if (op.kind === 'reorder') {
          if (sourceOrder.length < 2) continue
          const from = index(op.member, sourceOrder.length)
          let to = index(op.position, sourceOrder.length)
          if (from === to) to = (to + 1) % sourceOrder.length
          for (const write of reorderQueueWrites(heads[fromQueue], sourceOrder, from, to)) {
            const node = nodes.get(write.fiberId)!
            nodes.set(write.fiberId, { ...node, dependsOn: [write.newDep] })
          }
          const [moved] = sourceOrder.splice(from, 1)
          sourceOrder.splice(to, 0, moved)
        } else {
          if (fromQueue === toQueue || sourceOrder.length === 0) continue
          const destination = queues[toQueue]
          const from = index(op.member, sourceOrder.length)
          const targetPosition = index(op.target, destination.length + 1)
          const targetId = targetPosition === 0 ? heads[toQueue] : destination[targetPosition - 1]
          const tailId = destination.at(-1) ?? heads[toQueue]
          const sourceId = sourceOrder[from]
          const source = nodes.get(sourceId)!
          const target: StackCandidate = {
            id: targetId,
            status: targetId.startsWith('head-') ? 'active' : nodes.get(targetId)!.status,
          }
          const dependents = buildDependents(graphNodes().map(({ id, dependsOn }) => ({ id, dependsOn })))
          const verdict = stackDropVerdict(source, target, dependents)
          expect(verdict).toEqual({ ok: true, tail: tailId })
          if (!verdict.ok) continue

          const previousId = source.dependsOn![0]
          const plan = queueRowDropWrites(sourceId, previousId, graphNodes(), verdict.tail)
          for (const write of plan.writes) {
            const node = nodes.get(write.fiberId)!
            nodes.set(write.fiberId, { ...node, dependsOn: [write.newDep] })
          }
          sourceOrder.splice(from, 1)
          destination.push(sourceId)
        }
        assertModel()
      }
    }), { seed: 0x600d5eed, numRuns: 350 })
  })

  it('leaves a same-queue self or descendant drop unchanged', () => {
    fc.assert(fc.property(members, fc.integer(), fc.integer(), (values, sourceSeed, targetSeed) => {
      const head = 'head'
      const queue = asIds(values)
      const sourceIndex = index(sourceSeed, queue.length)
      const descendantIndex = sourceIndex + index(targetSeed, queue.length - sourceIndex)
      const candidates: StackCandidate[] = queue.map((id, i) => ({
        id,
        status: i === sourceIndex ? 'closed' : 'active',
        dependsOn: [i === 0 ? head : queue[i - 1]],
        dependsOnShape: 'scalar',
      }))
      const dependents = buildDependents(candidates.map(({ id, dependsOn }) => ({ id, dependsOn })))
      const before = candidates.map((candidate) => ({ ...candidate, dependsOn: [...candidate.dependsOn!] }))
      expect(stackDropVerdict(candidates[sourceIndex], candidates[descendantIndex], dependents).ok).toBe(false)
      expect(candidates).toEqual(before)
    }), { seed: 0xf00dface, numRuns: 600 })
  })

  it('maps each insertion gap to the same final order as lifting then inserting', () => {
    fc.assert(fc.property(members, fc.integer(), fc.integer(), (values, fromSeed, gapSeed) => {
      const queue = asIds(values)
      const from = index(fromSeed, queue.length)
      const insertAt = index(gapSeed, queue.length + 1)
      const expected = [...queue]
      const [item] = expected.splice(from, 1)
      expected.splice(insertAt > from ? insertAt - 1 : insertAt, 0, item)

      const to = queueDropIndex(from, insertAt)
      const actual = [...queue]
      const [moved] = actual.splice(from, 1)
      actual.splice(to, 0, moved)
      expect(actual).toEqual(expected)
    }), { seed: 0xdecafbad, numRuns: 1500 })
  })
})
