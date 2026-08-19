/**
 * The Chronicle search's pure half: what matches, in what order, and what one
 * list out of two halves looks like. The debounce and the DOM live in
 * ChronicleView.ts; everything decided here is decided without either.
 */

import { describe, expect, it } from 'vitest'
import {
  localHits,
  mergeHits,
  parseSearchResponse,
  rankOf,
  type SearchHit,
} from './chronicleSearch.js'

const CARDS = [
  { id: 'felt/board/search-bar', name: 'search bar for the chronicle' },
  { id: 'felt/board/rails', name: 'day rails' },
  { id: 'felt/daemon/poller', name: 'poller clock' },
]

describe('localHits', () => {
  it('matches name and id, and says which', () => {
    const [hit] = localHits(CARDS, 'search')
    expect(hit.id).toBe('felt/board/search-bar')
    expect(hit.where).toEqual(['name', 'id'])
    expect(hit.onBoard).toBe(true)
  })

  it('matches on the id alone', () => {
    expect(localHits(CARDS, 'daemon').map((h) => h.id)).toEqual(['felt/daemon/poller'])
  })

  it('is case-insensitive and ignores surrounding space', () => {
    expect(localHits(CARDS, '  RAILS ').map((h) => h.id)).toEqual(['felt/board/rails'])
  })

  it('answers nothing for a blank query rather than everything', () => {
    expect(localHits(CARDS, '   ')).toEqual([])
  })

  it('ranks an exact name above a prefix above a substring', () => {
    const cards = [
      { id: 'a/one', name: 'poller clock' },
      { id: 'a/two', name: 'poller' },
      { id: 'a/three', name: 'the poller weeps' },
    ]
    expect(localHits(cards, 'poller').map((h) => h.id)).toEqual(['a/two', 'a/one', 'a/three'])
  })
})

describe('rankOf', () => {
  it('puts a body-only match last', () => {
    expect(rankOf(['body'], 'unrelated', 'x/y', 'q')).toBe(5)
  })

  it('reads an exact id as an exact match even when the name differs', () => {
    expect(rankOf(['id'], 'something else', 'felt/board/rails', 'felt/board/rails')).toBe(0)
  })
})

describe('parseSearchResponse', () => {
  it('reads the wire and drops rows with no id', () => {
    const hits = parseSearchResponse({
      results: [
        { id: 'a/b', name: 'A B', where: ['body', 'nonsense'], excerpt: '…found…', rank: 5 },
        { name: 'no id' },
      ],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].where).toEqual(['body'])
    expect(hits[0].excerpt).toBe('…found…')
    expect(hits[0].onBoard).toBe(false)
  })

  it('survives a shape it has never seen', () => {
    expect(parseSearchResponse(null)).toEqual([])
    expect(parseSearchResponse({ results: 'nope' })).toEqual([])
  })
})

describe('mergeHits', () => {
  const remote: SearchHit[] = [
    {
      id: 'felt/board/search-bar',
      name: 'search bar for the chronicle',
      where: ['body'],
      excerpt: '…the search input…',
      rank: 5,
      onBoard: false,
      status: 'closed',
    },
    {
      id: 'ancient/constitution',
      name: 'the search that came before',
      where: ['name', 'body'],
      excerpt: '…searched then too…',
      rank: 2,
      onBoard: false,
      status: 'closed',
    },
  ]

  const boardIds = new Set(CARDS.map((c) => c.id))

  it('folds a fiber found by both halves into one row', () => {
    const merged = mergeHits(localHits(CARDS, 'search'), remote, boardIds)
    const rows = merged.filter((h) => h.id === 'felt/board/search-bar')
    expect(rows).toHaveLength(1)
    // The local half keeps the better rank (a name prefix beats a body
    // mention) and the board knowledge; the record half contributes the
    // excerpt and the fields it alone saw.
    expect(rows[0].rank).toBe(1)
    expect(rows[0].onBoard).toBe(true)
    expect(rows[0].excerpt).toBe('…the search input…')
    expect(rows[0].where).toEqual(['name', 'id', 'body'])
  })

  it('keeps a record-only hit, marked as not on the board', () => {
    const merged = mergeHits([], remote, boardIds)
    const old = merged.find((h) => h.id === 'ancient/constitution')
    expect(old?.onBoard).toBe(false)
  })

  it('marks a record hit as on the board when the board holds it', () => {
    const merged = mergeHits([], remote, boardIds)
    expect(merged.find((h) => h.id === 'felt/board/search-bar')?.onBoard).toBe(true)
  })

  it('interleaves by rank rather than clumping by origin, jumpable first on a tie', () => {
    const merged = mergeHits(localHits(CARDS, 'search'), remote, boardIds)
    expect(merged.map((h) => h.id)).toEqual(['felt/board/search-bar', 'ancient/constitution'])
  })

  it('caps the list', () => {
    expect(mergeHits([], remote, boardIds, 1)).toHaveLength(1)
  })

  it('is stable across the two renders one search does', () => {
    const first = mergeHits(localHits(CARDS, 'search'), [], boardIds).map((h) => h.id)
    const second = mergeHits(localHits(CARDS, 'search'), remote, boardIds).map((h) => h.id)
    expect(second.slice(0, first.length)).toEqual(first)
  })
})
