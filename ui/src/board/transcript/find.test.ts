// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  containsAll, findMatches, hitLocation, markTerms, nearestMatch, projectName, queryTerms,
  searchTranscripts, snippetPieces, snippetTerms, termPattern, unmark,
} from './find.js'
import { ago } from '../civilDay.js'
import type { Turn } from './model.js'

const turn = (index: number, prompt: string | null, texts: Array<[string, number?]> = []): Turn => ({
  index,
  prompt: prompt === null ? null : { kind: 'prompt', text: prompt, images: 0, dispatch: false },
  steps: texts.map(([text, at]) => ({ kind: 'text' as const, text, ...(at === undefined ? {} : { at }) })),
  answer: -1,
  version: 0,
})

describe('local find', () => {
  it('folds case, splits on whitespace and drops duplicates', () => {
    expect(queryTerms('  VMPZ  vmpz Convention ')).toEqual(['vmpz', 'convention'])
    expect(queryTerms('   ')).toEqual([])
  })

  it('needs every term, in any order, in one message', () => {
    expect(containsAll('The convention for VMPZ', ['vmpz', 'convention'])).toBe(true)
    expect(containsAll('only convention', ['vmpz', 'convention'])).toBe(false)
    expect(containsAll('anything', [])).toBe(false)
  })

  it('lists matching prompts and agent texts in the order they were said', () => {
    const turns = [
      turn(0, 'fix the vmpz convention', [['working on it'], ['the VMPZ convention is fixed', 5]]),
      turn(1, 'thanks', [['vmpz again, with convention', 9]]),
    ]
    expect(findMatches(turns, ['vmpz', 'convention'])).toEqual([
      { turn: 0 }, { turn: 0, step: 1, at: 5 }, { turn: 1, step: 0, at: 9 },
    ])
    expect(findMatches(turns, [])).toEqual([])
  })

  it('picks the match nearest a time, the first without one', () => {
    const matches = [{ turn: 0, at: 10 }, { turn: 1, at: 100 }, { turn: 2, at: 400 }]
    expect(nearestMatch(matches, 120)).toBe(1)
    expect(nearestMatch(matches, undefined)).toBe(0)
    expect(nearestMatch([], 5)).toBe(-1)
  })
})

describe('marking', () => {
  it('wraps every occurrence without disturbing the markup and gives it back', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>The <em>VMPZ</em> convention; a vmpz rule.</p>'
    const before = root.innerHTML
    const pattern = termPattern(['vmpz', 'convention'])!
    expect(markTerms(root, pattern, 'hit')).toBe(3)
    expect(root.querySelectorAll('mark.hit')).toHaveLength(3)
    expect(root.querySelector('em mark')?.textContent).toBe('VMPZ')
    unmark(root, 'hit')
    expect(root.innerHTML).toBe(before)
  })

  it('escapes regular-expression syntax in a term', () => {
    const root = document.createElement('div')
    root.textContent = 'a (b) c.d'
    expect(markTerms(root, termPattern(['(b)', 'c.d'])!, 'hit')).toBe(2)
  })

  it('prefers the longer term where two overlap', () => {
    const root = document.createElement('div')
    root.textContent = 'convention'
    markTerms(root, termPattern(['con', 'convention'])!, 'hit')
    expect(root.querySelector('mark')?.textContent).toBe('convention')
  })
})

describe('hits', () => {
  it('reads « » spans as matched pieces and as terms', () => {
    expect(snippetPieces('…we fixed the «VMPZ» «convention» as…')).toEqual([
      { text: '…we fixed the ', hit: false }, { text: 'VMPZ', hit: true }, { text: ' ', hit: false },
      { text: 'convention', hit: true }, { text: ' as…', hit: false },
    ])
    expect(snippetTerms('the «VMPZ» «convention» as «vmpz»')).toEqual(['vmpz', 'convention'])
  })

  it('names ages, projects and file positions', () => {
    const now = Date.parse('2026-10-24T12:00:00Z')
    expect(ago(now - 20_000, now)).toBe('just now')
    expect(ago(now - 5 * 3_600_000, now)).toBe('5h ago')
    expect(ago(now - 3 * 86_400_000, now)).toBe('3d ago')
    expect(projectName('/Users/x/dev/felt/')).toBe('felt')
    expect(projectName('')).toBe('')
    expect(hitLocation({ path: '/a/b.jsonl', line: 812 })).toBe('/a/b.jsonl:812')
    expect(hitLocation({ path: '/a/b.jsonl', line: 0 })).toBe('/a/b.jsonl')
  })
})

describe('the search route', () => {
  const reply = (status: number, body: unknown): typeof fetch =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }))

  it('sends each filter as its own parameter and normalizes the document', async () => {
    const send = reply(200, {
      query: 'vmpz',
      index: { sessions: 2, messages: 9, updated_at: '2026-10-24T09:12:00Z' },
      hits: [
        { session: 's1', harness: 'claude', project: '/x/felt', path: '/p.jsonl', line: 3, timestamp: '2026-10-22T14:03:11Z', role: 'user', score: 12.7, matches: 4, snippet: 'the «vmpz»', fibers: [{ id: 'a/b', name: 'B' }, { nope: 1 }] },
        { harness: 'pi' },
      ],
      errors: ['session ledger unavailable'],
    })
    const result = await searchTranscripts('http://d:4000/', 'vmpz convention', { session: ['s1', 's2'], fiber: 'a/b', since: '30d', harness: 'claude', limit: 5 }, { fetch: send })
    const url = new URL(String(vi.mocked(send).mock.calls[0][0]))
    expect(url.origin + url.pathname).toBe('http://d:4000/api/v1/transcripts/search')
    expect(url.searchParams.get('q')).toBe('vmpz convention')
    expect(url.searchParams.getAll('session')).toEqual(['s1', 's2'])
    expect([...['fiber', 'since', 'harness', 'limit']].map((k) => url.searchParams.get(k))).toEqual(['a/b', '30d', 'claude', '5'])
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({ session: 's1', line: 3, matches: 4, fibers: [{ id: 'a/b', name: 'B' }] })
    expect(result.errors).toEqual(['session ledger unavailable'])
  })

  it('turns the daemon\'s error document into the thrown message', async () => {
    await expect(searchTranscripts('', 'x', {}, { fetch: reply(502, { error: 'shuttle transcript search exited 3', detail: 'index is corrupt\nmore' }) }))
      .rejects.toThrow('shuttle transcript search exited 3 — index is corrupt')
    await expect(searchTranscripts('', 'x', {}, { fetch: reply(200, { nothing: true }) })).rejects.toThrow('without hits')
  })
})
