import { describe, expect, it } from 'vitest'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import { mapFeltJsonToFiber } from './KanbanFiber.js'
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

describe('orchestrator resolves against uids when ids are slugs', () => {
  const parentFiber = mapFeltJsonToFiber({ id: '01HZPARENT0000000000000000', slug: 'science/cmbx', uid: '01HZPARENT0000000000000000', status: 'active' })!
  const childFiber = mapFeltJsonToFiber({ id: '01HZCHILD00000000000000000', slug: 'science/cmbx/child', uid: '01HZCHILD00000000000000000', status: 'active' })!
  const parent = thread({ id: parentFiber.id, uid: parentFiber.uid, status: 'active' })
  const child = thread({ id: childFiber.id, uid: childFiber.uid, orchestrator: parentFiber.uid, status: 'active', workerState: 'running', runtimePhase: 'working' })
  it('the child finds its slug-identified parent', () => {
    expect(parent.id).toBe('science/cmbx')
    const index = new ThreadIndex([parent, child])
    expect(index.isOrphan(child)).toBe(false)
    expect(index.parentOf(child)?.id).toBe('science/cmbx')
    expect(index.summary(parent)).toMatchObject({ unfinished: 1, working: 1 })
  })
})
