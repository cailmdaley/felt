/**
 * The Chronicle search's pure half: what matches, in what order, and what one
 * list out of two halves looks like. The debounce and the DOM live in
 * ChronicleView.ts; everything decided here is decided without either.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
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
  // A two-letter alphabet in both cases, so a short query lands on names and
  // ids often, as exact, prefix and substring matches all at once.
  const text = (chars: string[], min: number) =>
    fc.array(fc.constantFrom(...chars), { minLength: min, maxLength: 5 }).map((cs) => cs.join(''))
  const cards = fc.uniqueArray(
    fc.record({ id: text(['a', 'b', '/'], 1), name: text(['a', 'b', 'A', 'B', ' '], 0) }),
    { selector: (c) => c.id, maxLength: 8 },
  )
  const query = fc.tuple(text([' '], 0), text(['a', 'b', 'A', 'B'], 1), text([' '], 0))
    .map(([before, q, after]) => before + q + after)

  it('finds every card whose name or id holds the query, says where, and ranks tighter matches first', () => {
    fc.assert(fc.property(cards, query, (deck, q) => {
      const needle = q.trim().toLowerCase()
      const hits = localHits(deck, q)
      const byId = new Map(deck.map((c) => [c.id, c]))

      const holds = (s: string) => s.toLowerCase().includes(needle)
      expect(new Set(hits.map((h) => h.id))).toEqual(
        new Set(deck.filter((c) => holds(c.name) || holds(c.id)).map((c) => c.id)))
      for (const h of hits) {
        const c = byId.get(h.id)!
        expect(h.where).toEqual([...(holds(c.name) ? ['name'] : []), ...(holds(c.id) ? ['id'] : [])])
        expect(h).toMatchObject({ name: c.name || c.id, excerpt: null, onBoard: true })
      }
      // Each kind of match sits above every looser one: the hits that match
      // exactly, then those that at least open their name with the query, then
      // those that at least hold it in their name, each form a head of the list.
      const exact = (c: { id: string; name: string }) => c.name.toLowerCase() === needle || c.id.toLowerCase() === needle
      const opensName = (c: { id: string; name: string }) => exact(c) || c.name.toLowerCase().startsWith(needle)
      const inName = (c: { id: string; name: string }) => opensName(c) || holds(c.name)
      for (const [kind, matches] of [['exact', exact], ['name prefix', opensName], ['name', inName]] as const) {
        const flags = hits.map((h) => matches(byId.get(h.id)!))
        expect(flags, `${kind} matches lead`).toEqual([...flags].sort((a, b) => Number(b) - Number(a)))
      }
      // Case and surrounding space are not part of the question.
      expect(localHits(deck, `  ${q.toUpperCase()} `)).toEqual(hits)
    }), { seed: 0x5ea2c4, numRuns: 200 })
  })

  it('matches name and id, and says which', () => {
    const [hit] = localHits(CARDS, 'search')
    expect(hit.id).toBe('felt/board/search-bar')
    expect(hit.where).toEqual(['name', 'id'])
    expect(hit.onBoard).toBe(true)
  })

  it('ranks an exact name above a prefix above a substring', () => {
    const cards = [
      { id: 'a/one', name: 'poller clock' },
      { id: 'a/two', name: 'poller' },
      { id: 'a/three', name: 'the poller weeps' },
    ]
    expect(localHits(cards, 'poller').map((h) => h.id)).toEqual(['a/two', 'a/one', 'a/three'])
  })

  it('answers nothing for a blank query rather than everything', () => {
    expect(localHits(CARDS, '   ')).toEqual([])
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
