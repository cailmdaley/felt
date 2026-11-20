/**
 * The board search's pure half: what matches, in what order, what one list out
 * of two halves looks like, and what a channel's stream folds to. The debounce
 * and the DOM live in SearchPanel.ts and the views; everything decided here is
 * decided without either.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  channelHits,
  documentHits,
  excerpt,
  foldStream,
  localHits,
  matchedRows,
  mergeHits,
  parseSearchResponse,
  pieces,
  rankOf,
  saidHits,
  type SearchHit,
} from './match.js'
import { card } from '../testFixtures.js'
import type { BoardRecord } from '../boardFeed.js'
import type { Entry, Item, Station } from '../channels.js'

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
        expect(h).toMatchObject({ name: c.name || c.id, excerpt: null, onBoard: true, card: c })
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

  const board = new Map(CARDS.map((c) => [c.id, c]))

  it('folds a fiber found by both halves into one row', () => {
    const merged = mergeHits(localHits(CARDS, 'search'), remote, board)
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
    const merged = mergeHits([], remote, board)
    const old = merged.find((h) => h.id === 'ancient/constitution')
    expect(old?.onBoard).toBe(false)
  })

  it('marks a record hit as on the board when the board holds it, and gives it the card', () => {
    const merged = mergeHits([], remote, board)
    const hit = merged.find((h) => h.id === 'felt/board/search-bar')
    expect(hit?.onBoard).toBe(true)
    expect(hit?.card).toBe(CARDS[0])
  })

  it('interleaves by rank rather than clumping by origin, jumpable first on a tie', () => {
    const merged = mergeHits(localHits(CARDS, 'search'), remote, board)
    expect(merged.map((h) => h.id)).toEqual(['felt/board/search-bar', 'ancient/constitution'])
  })

  it('caps the list', () => {
    expect(mergeHits([], remote, board, 1)).toHaveLength(1)
  })

  it('is stable across the two renders one search does', () => {
    const first = mergeHits(localHits(CARDS, 'search'), [], board).map((h) => h.id)
    const second = mergeHits(localHits(CARDS, 'search'), remote, board).map((h) => h.id)
    expect(second.slice(0, first.length)).toEqual(first)
  })
})

describe('channelHits', () => {
  const channel = (name: string, title: string, members: Array<{ name: string; path: string }> = []) => ({ key: `channel:${name}`, name, title, members })
  const channels = [
    channel('lensing', 'Cosmic shear', [{ name: 'Mask validation', path: 'research/mask' }]),
    channel('mask', 'Foreground masks'),
    channel('cmbx-masks', 'Cross-correlations'),
    channel('globe', 'The globe'),
  ]

  it('ranks a channel by its own name before its chair and its members', () => {
    expect(channelHits(channels, 'mask').map(c => c.name)).toEqual(['mask', 'cmbx-masks', 'lensing'])
  })

  it('finds a channel by its chair\'s title', () => {
    expect(channelHits(channels, 'shear').map(c => c.name)).toEqual(['lensing'])
  })

  it('answers nothing for a blank query', () => {
    expect(channelHits(channels, ' ')).toEqual([])
  })
})

describe('saidHits', () => {
  const record = (id: string, over: Partial<BoardRecord>): BoardRecord => ({ id, kind: 'post', timestamp: 0, fiber: 'f1', to: { label: 'Cail' }, text: '', ...over })
  const cards = new Map([['f1', 'first'], ['f2', 'second']])

  it('finds posts, questions and closes addressed to the person, newest first, once each', () => {
    const records = [
      record('a', { text: 'The mask threshold is 5σ', timestamp: 1 }),
      record('b', { kind: 'asked', text: 'Which MASK do you want?', timestamp: 3, fiber: 'f2' }),
      record('c', { kind: 'closed', text: 'Mask settled', timestamp: 2 }),
      record('a', { text: 'The mask threshold is 5σ', timestamp: 1 }),
    ]
    expect(saidHits(records, uid => cards.get(uid), 'mask').map(hit => [hit.record.id, hit.card])).toEqual([['b', 'second'], ['c', 'first'], ['a', 'first']])
  })

  it('excerpts a long line as plain words about its match', () => {
    const text = `${'Masking clusters at **5σ** keeps 94% of the area and leaves a 0.3σ residual in the 1-halo term; '.repeat(2)}which threshold?`
    const [hit] = saidHits([record('long', { text })], uid => cards.get(uid), 'threshold')
    expect(hit.excerpt).toContain('threshold')
    expect(hit.excerpt).not.toContain('**')
    expect(hit.excerpt.length).toBeLessThanOrEqual(92)
  })

  it('matches a line by its plain words, so a query across its emphasis finds it and its excerpt holds the match', () => {
    const [hit] = saidHits([record('em', { text: 'Masking at **5σ keeps** most of the area' })], uid => cards.get(uid), 'at 5σ keeps')
    expect(hit.excerpt).toBe('Masking at 5σ keeps most of the area')
  })

  it('leaves out what a channel does not draw: a line to another thread, a handoff, and a fiber the board does not hold', () => {
    const records = [
      record('to-thread', { text: 'mask', to: { fiber: 'f2' } }),
      record('handoff', { kind: 'handed_off', text: 'mask' }),
      record('stranger', { text: 'mask', fiber: 'f9' }),
    ]
    expect(saidHits(records, uid => cards.get(uid), 'mask')).toEqual([])
  })
})

describe('documentHits', () => {
  const doc = (basename: string, title?: string, name = 'Some fiber') => ({ card: { name }, receipt: { key: basename, basename, fullPath: `/work/${basename}` }, title })
  const docs = [doc('lensing-notes.md'), doc('plot.png', 'The mask footprint'), doc('notes.md', undefined, 'Mask validation')]

  it('finds a document by its name, its declared title or its fiber\'s name, keeping the order given', () => {
    expect(documentHits(docs, key => docs.find(d => d.receipt.key === key)?.title, 'mask').map(d => d.receipt.basename)).toEqual(['plot.png', 'notes.md'])
    expect(documentHits(docs, () => undefined, 'lensing').map(d => d.receipt.basename)).toEqual(['lensing-notes.md'])
  })
})

describe('excerpt', () => {
  const words = Array.from({ length: 80 }, (_, n) => `word${n}`).join(' ')

  it('keeps short text whole, on one line', () => {
    expect(excerpt('a short\n  line', 'short')).toBe('a short line')
  })

  it('cuts long text around the first match at word edges and says where it cut', () => {
    const cut = excerpt(words, 'word40', 60)
    expect(cut).toMatch(/^….*word40.*…$/)
    expect(cut.length).toBeLessThanOrEqual(62)
    for (const part of cut.slice(1, -1).split(' ')) expect(part).toMatch(/^word\d+$/)
  })

  it('always holds the match', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 79 }), fc.integer({ min: 20, max: 200 }), (n, room) => {
      expect(excerpt(words, `word${n}`, room)).toContain(`word${n}`)
    }), { seed: 0xe4c, numRuns: 200 })
  })
})

describe('pieces', () => {
  it('marks every place the needle stands, keeping the text\'s case, and loses nothing', () => {
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom('a', 'B', 'b', ' '), maxLength: 20 }), fc.string({ unit: fc.constantFrom('a', 'b'), minLength: 1, maxLength: 3 }), (text, needle) => {
      const parts = pieces(text, needle)
      expect(parts.map(p => p.text).join('')).toBe(text)
      for (const part of parts) if (part.hit) expect(part.text.toLowerCase()).toBe(needle)
    }), { seed: 0x91ece, numRuns: 200 })
    expect(pieces('Mask and mask', 'mask')).toEqual([{ text: 'Mask', hit: true }, { text: ' and ', hit: false }, { text: 'mask', hit: true }])
  })
})

describe('foldStream', () => {
  const alpha = card({ id: 'w/alpha', name: 'Alpha' }), beta = card({ id: 'w/beta', name: 'Beta' })
  const item = (id: string, who: typeof alpha, text: string, line?: string, files: Item['files'] = []): Item => ({ kind: 'post', id, card: who, at: 0, arrived: 0, text, files, waiting: false, line })
  const station = (id: string, who: typeof alpha, what: Station['what'], line: string): Station => ({ kind: 'station', id, card: who, at: 0, what, line })
  const stream: Entry[] = [
    station('a-start', alpha, 'start', 'a:1'),
    item('a1', alpha, 'nothing here', 'a:1'),
    station('a-tick', alpha, 'tick', 'a:1'),
    item('a2', alpha, 'the mask threshold', 'a:1'),
    station('b-start', beta, 'start', 'b:1'),
    item('b1', beta, 'unrelated', 'b:1'),
    item('b2', beta, '', 'b:1', [{ fullPath: '/x/mask.png', basename: 'mask.png', timestamp: 0 }]),
    station('a-end', alpha, 'end', 'a:1'),
    item('b3', beta, 'later', 'b:1'),
  ]

  it('keeps the matches and the start and end of each life a match is on, and counts what folds between', () => {
    const folded = foldStream(stream, 'MASK')
    expect(folded.entries.map(e => e.id)).toEqual(['a-start', 'a2', 'b-start', 'b2', 'a-end'])
    expect(folded.gaps).toEqual([0, 2, 0, 1, 0, 1])
    expect(matchedRows(folded).map(e => e.id)).toEqual(['a2', 'b2'])
  })

  it('finds a thread by its name at its start', () => {
    expect(matchedRows(foldStream(stream, 'beta')).map(e => e.id)).toEqual(['b-start'])
  })

  it('loses no row: what is drawn and what is folded add up to the stream, in order', () => {
    fc.assert(fc.property(fc.constantFrom('mask', 'alpha', 'later', 'zzz', 'e'), query => {
      const folded = foldStream(stream, query)
      expect(folded.gaps).toHaveLength(folded.entries.length + 1)
      expect(folded.entries.length + folded.gaps.reduce((a, b) => a + b, 0)).toBe(stream.length)
      expect(folded.entries).toEqual(stream.filter(e => folded.entries.includes(e)))
    }), { seed: 7, numRuns: 50 })
  })
})
