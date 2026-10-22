import { describe, expect, it } from 'vitest'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import type { KanbanCard } from './KanbanTypes.js'

const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard => card({ shuttleKind: 'oneshot', ...over })

describe('a thread resolves its root across hosts', () => {
  const rootCineca = thread({ id: '01ROOT', status: 'active', originId: 'cineca', feltStore: '/leonardo/loom', shuttleHost: 'cineca' })
  const rootMac = thread({ id: '01ROOT', status: 'active', originId: 'mac', feltStore: '/Users/x/loom', shuttleHost: 'cineca' })
  const child = thread({ id: '01CHILD', orchestrator: '01ROOT', status: 'active', workerState: 'running', runtimePhase: 'working', originId: 'mac', feltStore: '/Users/x/loom', shuttleHost: 'mac' })

  it('a root served only by another host still owns the thread', () => {
    const index = new ThreadIndex([rootCineca, child])
    expect(index.isOrphan(child)).toBe(false)
    expect(index.parentOf(child)?.id).toBe('01ROOT')
    expect(index.summary(rootCineca)).toMatchObject({ unfinished: 1, working: 1 })
  })
  it('every copy of the root reads the same family', () => {
    const index = new ThreadIndex([rootCineca, rootMac, child])
    expect(index.isOrphan(child)).toBe(false)
    expect(index.children(rootCineca).map(c => c.id)).toEqual(['01CHILD'])
    expect(index.children(rootMac).map(c => c.id)).toEqual(['01CHILD'])
    expect(index.summary(rootMac)).toMatchObject({ unfinished: 1, working: 1 })
  })
  it('a copy of the thread the index never saw still finds its root', () => {
    const index = new ThreadIndex([rootCineca, child])
    expect(index.isOrphan({ ...child, originId: 'cineca', feltStore: '/leonardo/loom' })).toBe(false)
  })
})
