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
    expect(outline([...asks, work]).rows.map(c => c.id)).toEqual(['hub', 'review-0', 'review-1', 'review-2', 'work'])
    expect(outline([...asks, work]).more).toBe(2)
    expect(outline([...asks, work], folds, work).rows.map(c => c.id)).toEqual(['hub', 'work'])
    expect(folds).toEqual({ root: { collapsed: true } })
  })
  it('reveals the fresh feed copy of a current page hidden by a fold', () => {
    const live = child('work', { status: 'active' })
    const stale = { ...live, status: 'closed' }
    expect(outline([live], { root: { collapsed: true } }, stale).rows[1]).toBe(live)
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
  it('every nested request is reachable by one More, with Your turn before review', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 2, maxLength: 60 }), states => {
      const context = child('context', { uid: 'context', tempered: true })
      // Reviews arrive before asks; every request is a grandchild, not a direct child.
      const requests = [...states, false, true].sort((a, b) => Number(a) - Number(b)).map((waiting, n) => child(`request-${n}`, {
        orchestrator: 'context', ...(waiting ? { status: 'active', ask: { text: 'choose', at: '2026-01-01T00:00:00Z' } } : {}),
      }))
      const before = outline([context, ...requests]), after = outline([context, ...requests], { root: { more: true } })
      expect(after.asks).toHaveLength(requests.length)
      for (const request of requests) expect(after.rows).toContain(request)
      expect(before.rows.length).toBeLessThanOrEqual(5)
      const order = after.asks.map(c => c.status === 'active' ? 0 : 1)
      expect(order).toEqual([...order].sort())
    }), { seed: 4104, numRuns: 200 })
  })
  it('never folds a lone extra ask or a lone working row', () => {
    const asks = Array.from({ length: 4 }, (_, n) => child(`review-${n}`))
    const work = child('work', { status: 'active' })
    const family = outline([...asks, work])
    expect(family.more).toBe(0)
    expect(family.rows).toEqual([root, ...asks, work])
  })
  it('places a root at its own Desk position, not its earlier lead', () => {
    const ask = child('ask', { status: 'active', ask: { text: 'choose', at: '' } })
    const lone = card({ id: 'lone', status: 'active' })
    const desk = [ask, lone, root]
    expect(sidebarOutline(new ThreadIndex([root, ask, lone]), desk, undefined, {}).map(f => f.root)).toEqual([lone, root])
  })
  it('Find includes a draft in a family absent from the Desk', () => {
    const quiet = card({ id: 'quiet', uid: 'quiet', status: 'closed', tempered: true })
    const draft = child('draft', { orchestrator: 'quiet', status: 'open' })
    const families = sidebarOutline(new ThreadIndex([root, quiet, draft]), [root], undefined, {}, 'draft')
    expect(families.flatMap(f => f.rows)).toContain(draft)
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
