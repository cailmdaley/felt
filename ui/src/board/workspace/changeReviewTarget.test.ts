import { expect, it } from 'vitest'
import { changeReviewTarget } from './changeReviewTarget.js'

it('resolves the exact holding directory on the document owner, not an ancestor or another host', () => {
  const cards = [
    { id: 'parent', originId: 'h', fiberDir: '/store', workerState: 'running' as const },
    { id: 'wrong-host', originId: 'other', fiberDir: '/store/target', workerState: 'running' as const },
    { id: 'holding', originId: 'h', fiberDir: '/store/target', workerState: undefined },
  ]
  const result = changeReviewTarget({ owner: 'h', path: '/store/target/sub/../read.change.json' }, cards)
  expect(result?.card.id).toBe('holding'); expect(result?.live).toBe(false)
  expect(changeReviewTarget({ owner: 'h', path: '/store/unknown/read.change.json' }, cards)).toBeUndefined()
})
