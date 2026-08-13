/**
 * shelfLoad — the policies that keep a board of a hundred cards from becoming
 * a hundred live documents.
 *
 * The claim that matters most: a body the reader can see is NEVER taken down.
 * Everything else here is bookkeeping around that one promise.
 */

import { describe, expect, it } from 'vitest'

import {
  chooseEvictions,
  chooseLoads,
  LOAD_POLICY,
  MAX_CARDS,
  matchesQuery,
  mostRecent,
  TextCache,
} from './shelfLoad.js'

describe('chooseLoads — nearest the eye first', () => {
  const candidates = [
    { key: '/far', distance: 900 },
    { key: '/near', distance: 40 },
    { key: '/mid', distance: 300 },
  ]

  it('fills the free slots from the centre outward', () => {
    expect(chooseLoads(candidates, 2)).toEqual(['/near', '/mid'])
  })

  it('starts nothing when the loaders are all busy', () => {
    expect(chooseLoads(candidates, 0)).toEqual([])
    expect(chooseLoads(candidates, -1)).toEqual([])
  })

  it('takes everything it can when there is room to spare', () => {
    expect(chooseLoads(candidates, 99)).toHaveLength(3)
  })

  it('breaks ties on key, so the fill order never depends on Map iteration', () => {
    const tied = [
      { key: '/b', distance: 10 },
      { key: '/a', distance: 10 },
    ]
    expect(chooseLoads(tied, 1)).toEqual(['/a'])
  })
})

describe('chooseEvictions — who dies', () => {
  function live(n: number, exempt = false) {
    return Array.from({ length: n }, (_, i) => ({
      key: `/c${String(i).padStart(2, '0')}`,
      lastVisible: i, // ascending: /c00 is the least recently seen
      exempt,
    }))
  }

  it('does nothing while the board is under the cap', () => {
    expect(chooseEvictions(live(LOAD_POLICY.maxLive))).toEqual([])
  })

  it('cuts back to the low-water mark, not just to the cap — the hysteresis', () => {
    const chosen = chooseEvictions(live(LOAD_POLICY.maxLive + 1))
    expect(chosen).toHaveLength(LOAD_POLICY.maxLive + 1 - LOAD_POLICY.evictTo)
  })

  it('takes the least recently seen first', () => {
    const chosen = chooseEvictions(live(20), { maxLive: 16, evictTo: 14 })
    expect(chosen).toEqual(['/c00', '/c01', '/c02', '/c03', '/c04', '/c05'])
  })

  it('NEVER takes a card the reader can see, whatever the pressure', () => {
    const cards = [
      ...live(4).map((c) => ({ ...c, exempt: true })),
      { key: '/cold', lastVisible: 0, exempt: false },
    ]
    expect(chooseEvictions(cards, { maxLive: 2, evictTo: 1 })).toEqual(['/cold'])
  })

  it('runs over the cap rather than unloading what is on screen', () => {
    const all = live(10, true)
    expect(chooseEvictions(all, { maxLive: 2, evictTo: 1 })).toEqual([])
  })
})

describe('TextCache', () => {
  it('returns what it was given', () => {
    const cache = new TextCache()
    cache.set('/a', 'hello')
    expect(cache.get('/a')).toBe('hello')
    expect(cache.get('/b')).toBeUndefined()
  })

  it('evicts the oldest entry once it is over budget', () => {
    const cache = new TextCache(10)
    cache.set('/a', '12345')
    cache.set('/b', '12345')
    cache.set('/c', '12345') // pushes past 10 chars
    expect(cache.get('/a')).toBeUndefined()
    expect(cache.get('/c')).toBe('12345')
  })

  it('re-setting a path refreshes it rather than double-counting its bytes', () => {
    const cache = new TextCache(10)
    cache.set('/a', '12345')
    cache.set('/a', '67890')
    cache.set('/b', '12345')
    expect(cache.get('/a')).toBe('67890')
    expect(cache.get('/b')).toBe('12345')
    expect(cache.size).toBe(2)
  })

  it('keeps the newest entry even when it alone exceeds the budget', () => {
    const cache = new TextCache(4)
    cache.set('/big', 'aaaaaaaaaa')
    expect(cache.get('/big')).toBe('aaaaaaaaaa')
  })
})

describe('mostRecent — the board is a surface, not an archive', () => {
  const files = Array.from({ length: 250 }, (_, i) => ({ timestamp: i, key: `/f${i}` }))

  it('keeps the newest and drops the tail', () => {
    const kept = mostRecent(files, MAX_CARDS)
    expect(kept).toHaveLength(MAX_CARDS)
    expect(kept[0].timestamp).toBe(249)
    expect(Math.min(...kept.map((f) => f.timestamp))).toBe(250 - MAX_CARDS)
  })

  it('leaves a short list alone', () => {
    const few = files.slice(0, 3)
    expect(mostRecent(few, MAX_CARDS)).toEqual(few)
  })
})

describe('matchesQuery — recognition, not guesswork', () => {
  const file = {
    basename: 'deck.html',
    fullPath: '/home/x/projects/plainsong/deck.html',
    uid: '01KZW2W03EC8FTG55HME0D57CG',
  }

  it('matches a substring of the name, case-insensitively', () => {
    expect(matchesQuery(file, 'DECK')).toBe(true)
    expect(matchesQuery(file, 'ck.ht')).toBe(true)
  })

  it('matches the fiber and the path', () => {
    expect(matchesQuery(file, '01kzw2')).toBe(true)
    expect(matchesQuery(file, 'plainsong')).toBe(true)
  })

  it('does not guess — an unmatched query hides the card', () => {
    expect(matchesQuery(file, 'dekc')).toBe(false)
  })

  it('treats an empty or blank query as no filter at all', () => {
    expect(matchesQuery(file, '')).toBe(true)
    expect(matchesQuery(file, '   ')).toBe(true)
  })

  it('shrugs at a file with no fiber', () => {
    expect(matchesQuery({ basename: 'a.png', fullPath: '/a.png' }, 'a')).toBe(true)
    expect(matchesQuery({ basename: 'a.png', fullPath: '/a.png' }, 'shear')).toBe(false)
  })
})
