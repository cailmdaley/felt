import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { sidebarOutline, SidebarPreferences, rootIdentity, SIDEBAR_STORAGE } from './SidebarOutline.js'

const root = card({ id: 'hub', uid: 'root', status: 'active' })
const child = (id: string, extra = {}) => card({ id, orchestrator: 'root', status: 'closed', ...extra })
const outline = (cards: ReturnType<typeof card>[], folds = {}, current?: ReturnType<typeof card>, query = '') => sidebarOutline(new ThreadIndex([root, ...cards]), [root], current, folds, query)[0]

describe('sidebar family outline', () => {
  it('keeps three requests, folds the rest and work, and reveals a current page without changing preferences', () => {
    const asks = Array.from({ length: 5 }, (_, n) => child(`review-${n}`))
    const work = child('work', { status: 'active' })
    const folds = { [rootIdentity(root)]: { collapsed: true } }
    expect(outline([...asks, work]).rows.map(c => c.id)).toEqual(['hub', 'review-0', 'review-1', 'review-2'])
    expect(outline([...asks, work]).more).toBe(2)
    expect(outline([...asks, work], folds, work).rows.map(c => c.id)).toEqual(['hub', 'work'])
    expect(folds).toEqual({ root: { collapsed: true } })
  })
  it('keeps a non-working ancestor as context of working descendants', () => {
    const mid = child('mid', { uid: 'mid', tempered: true })
    const work = child('work', { orchestrator: 'mid', status: 'active' })
    expect(outline([mid, work], { root: { working: true } }).working.map(row => [row.card.id, row.depth])).toEqual([['mid', 1], ['work', 2]])
  })
  it('Find includes quiet descendants and roots under every fold', () => {
    const draft = child('draft', { status: 'open' })
    expect(outline([draft], { root: { collapsed: true } }, undefined, 'draft').rows.map(c => c.id)).toEqual(['hub', 'draft'])
  })
  it('every request under an expanded root is reachable by at most one more toggle', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 60 }), states => {
      const requests = states.map((waiting, n) => child(`request-${n}`, waiting ? { status: 'active', ask: { text: 'choose', at: '2026-01-01T00:00:00Z' } } : {}))
      const before = outline(requests), after = outline(requests, { root: { more: true } })
      for (const request of requests) expect(after.rows).toContain(request)
      expect(before.rows.length).toBeLessThanOrEqual(4)
    }), { seed: 4104, numRuns: 200 })
  })
  it('remembers explicit folds by uid and tolerates unavailable or malformed storage', () => {
    let value: string | null = null
    const storage = { getItem: () => value, setItem: (key: string, next: string) => { expect(key).toBe(SIDEBAR_STORAGE); value = next } }
    const prefs = new SidebarPreferences(storage)
    prefs.toggle(root, 'collapsed'); prefs.toggle(root, 'working'); prefs.toggle(root, 'more')
    expect(new SidebarPreferences(storage).folds).toEqual({ root: { collapsed: true, working: true, more: true } })
    value = '{'
    expect(new SidebarPreferences(storage).folds).toEqual({})
    const unavailable = new SidebarPreferences({ getItem: () => { throw Error() }, setItem: () => { throw Error() } })
    expect(() => unavailable.toggle(root, 'more')).not.toThrow()
  })
})
