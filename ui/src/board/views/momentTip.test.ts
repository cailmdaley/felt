import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTemporalFetchers, parseMoment, type MomentResult } from './TemporalData.js'
import {
  dedupeSources,
  MomentLoader,
  SLOT_NO_TEXT_NOTE,
  type MomentWords,
} from './momentTip.js'

/**
 * THE WORDS ON HOVER, from wire to slip of paper.
 *
 * Three things are worth pinning here, and they are the three ways this feature
 * can lie. The wire parser must not admit a half-excerpt. The loader must not
 * paint an answer onto a mark the pointer has left, and must not go to the
 * network for a mark that has no transcript behind it. And the renderer must
 * keep saying {@link SLOT_NO_TEXT_NOTE} whenever nothing was recovered — the
 * one sentence this whole feature exists to stop being necessary, and the one
 * it must never replace with an invention.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const excerpt = (over: Record<string, unknown> = {}) => ({
  at_ms: 1_000,
  role: 'user' as const,
  text: 'run the null tests',
  ...over,
})

describe('parseMoment', () => {
  const empty: MomentResult = { host: '', excerpts: [] }

  it('reads a well-formed moment', () => {
    const result = parseMoment({ host: 'ada', excerpts: [excerpt()] }, empty)
    expect(result.host).toBe('ada')
    expect(result.excerpts).toEqual([
      { at_ms: 1_000, role: 'user', text: 'run the null tests', kind: 'prose', name: null },
    ])
    expect(result.note).toBeUndefined()
  })

  it('reads the delegation register, and an unknown kind reads as prose', () => {
    const result = parseMoment(
      {
        host: 'ada',
        excerpts: [
          excerpt({ kind: 'spawn', name: 'chart-hand', text: 'go and look' }),
          excerpt({ kind: 'return', name: 'chart-hand', text: 'here is what I found' }),
          excerpt({ kind: 'semaphore', text: 'not a register anyone draws' }),
        ],
      },
      empty,
    )
    expect(result.excerpts.map((e) => [e.kind, e.name])).toEqual([
      ['spawn', 'chart-hand'],
      ['return', 'chart-hand'],
      ['prose', null],
    ])
  })

  it('reads a daemon that predates the registers as prose throughout', () => {
    const result = parseMoment({ host: 'ada', excerpts: [excerpt()] }, empty)
    expect(result.excerpts[0].kind).toBe('prose')
    expect(result.excerpts[0].name).toBeNull()
  })

  it('drops an excerpt with no text, no role, or a role nobody speaks', () => {
    const result = parseMoment(
      {
        host: 'ada',
        excerpts: [
          excerpt({ text: '   ' }),
          excerpt({ role: null }),
          excerpt({ role: 'system' }),
          'not an excerpt at all',
          excerpt({ text: 'the one good line' }),
        ],
      },
      empty,
    )
    expect(result.excerpts.map((e) => e.text)).toEqual(['the one good line'])
  })

  it('carries the note that says where unreachable words live', () => {
    const result = parseMoment(
      { host: 'kelvin', excerpts: [], note: 'words live on kelvin' },
      empty,
    )
    expect(result.note).toBe('words live on kelvin')
  })

  it('falls back whole on a body that is not a moment', () => {
    expect(parseMoment('nope', empty)).toBe(empty)
    expect(parseMoment({ host: 'ada' }, empty).excerpts).toEqual([])
  })
})

describe('the moment fetcher', () => {
  const okJson = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  it('asks the named host for the session and window', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return okJson({ host: 'kelvin', excerpts: [excerpt()] })
    })

    const result = await createTemporalFetchers('').moment('sess-1', 10, 70, 'kelvin')

    expect(result.excerpts).toHaveLength(1)
    const params = new URL(urls[0], 'http://daemon.test').searchParams
    expect(params.get('session')).toBe('sess-1')
    expect(params.get('from_ms')).toBe('10')
    expect(params.get('to_ms')).toBe('70')
    expect(params.get('host')).toBe('kelvin')
    // Deliberately NOT /moment/composite: a transcript is a file on one
    // machine, not a feed to merge.
    expect(urls[0]).not.toContain('composite')
  })

  it('degrades a failure to empty rather than rejecting — the caller is a tooltip', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    await expect(createTemporalFetchers('').moment('sess-1', 0, 60)).resolves.toEqual({
      host: '',
      excerpts: [],
    })

    vi.stubGlobal('fetch', async () => {
      throw new Error('tunnel down')
    })
    await expect(createTemporalFetchers('').moment('sess-1', 0, 60)).resolves.toEqual({
      host: '',
      excerpts: [],
    })
  })
})

describe('parseMoment — the tool line', () => {
  const empty: MomentResult = { host: '', excerpts: [] }

  it('reads the tools field a wordless minute carries', () => {
    expect(parseMoment({ host: 'ada', excerpts: [], tools: 'Bash ×2 · Read' }, empty).tools).toBe(
      'Bash ×2 · Read',
    )
  })

  it('drops a tools field that is not a usable string', () => {
    expect(parseMoment({ host: 'ada', excerpts: [], tools: '  ' }, empty).tools).toBeUndefined()
    expect(parseMoment({ host: 'ada', excerpts: [], tools: 42 }, empty).tools).toBeUndefined()
    expect(parseMoment({ host: 'ada', excerpts: [] }, empty).tools).toBeUndefined()
  })

  it('keeps the newlines of a per-call listing intact — they are what tells the two shapes apart', () => {
    const line = 'Bash — run the tests\nRead — momentTip.ts'
    expect(parseMoment({ host: 'ada', excerpts: [], tools: line }, empty).tools).toBe(line)
  })
})

describe('MomentLoader', () => {
  const source = { session: 'sess-1', host: 'ada' }

  const loaderOver = (results: MomentResult[]): { loader: MomentLoader; calls: number[] } => {
    const calls: number[] = []
    let next = 0
    const loader = new MomentLoader(async (_session, fromMs) => {
      calls.push(fromMs)
      return results[Math.min(next++, results.length - 1)]
    }, 150)
    return { loader, calls }
  }

  it('debounces, then caches — a re-hover paints from peek with no second fetch', async () => {
    vi.useFakeTimers()
    const { loader, calls } = loaderOver([{ host: 'ada', excerpts: [excerpt()] }])
    const seen: string[] = []

    loader.request('slot-1', [source], 0, 60_000, (words) => seen.push(words.excerpts[0].text))
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)

    expect(calls).toEqual([0])
    expect(seen).toEqual(['run the null tests'])
    expect(loader.peek('slot-1')?.excerpts).toHaveLength(1)

    loader.request('slot-1', [source], 0, 60_000, () => seen.push('again'))
    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual([0])
    expect(seen).toEqual(['run the null tests'])
  })

  it('fetches again with full for a pin, and caches the two answers apart', async () => {
    // The excerpts are cut on the DAEMON, so a pin cannot recover the rest of a
    // sentence by relaxing its CSS — it has to ask again. And the two answers
    // are two different answers about one minute: sharing a cache slot would
    // serve the pinned slip the hover's cut text (or worse, the reverse).
    vi.useFakeTimers()
    const asked: boolean[] = []
    const loader = new MomentLoader(async (_session, _fromMs, _toMs, _host, full) => {
      asked.push(full === true)
      return {
        host: 'ada',
        excerpts: [{ at_ms: 0, role: 'user' as const, text: full ? 'the whole thing' : 'the wh…' }],
      }
    }, 150)

    const seen: string[] = []
    loader.request('slot-1', [source], 0, 60_000, (w) => seen.push(w.excerpts[0].text))
    await vi.advanceTimersByTimeAsync(200)
    expect(asked).toEqual([false])
    expect(seen).toEqual(['the wh…'])

    loader.request('slot-1', [source], 0, 60_000, (w) => seen.push(w.excerpts[0].text), true)
    await vi.advanceTimersByTimeAsync(200)
    expect(asked).toEqual([false, true])
    expect(seen).toEqual(['the wh…', 'the whole thing'])

    // Both are remembered, each under its own key.
    expect(loader.peek('slot-1')?.excerpts[0].text).toBe('the wh…')
    expect(loader.peek('slot-1', true)?.excerpts[0].text).toBe('the whole thing')
  })

  it('peeks the brief answer for a pin whose full text has not arrived yet', async () => {
    // What makes pinning a mark you were already reading repaint rather than
    // blank: the words on screen stay while the untruncated ones are fetched.
    vi.useFakeTimers()
    const { loader } = loaderOver([{ host: 'ada', excerpts: [excerpt()] }])

    loader.request('slot-1', [source], 0, 60_000, () => {})
    await vi.advanceTimersByTimeAsync(200)
    expect(loader.peek('slot-1', true)?.excerpts[0].text).toBe('run the null tests')
  })

  it('asks for nothing while a pointer sweeps across marks', async () => {
    vi.useFakeTimers()
    const { loader, calls } = loaderOver([{ host: 'ada', excerpts: [] }])

    for (let i = 0; i < 20; i += 1) {
      loader.request(`slot-${i}`, [source], i * 60_000, i * 60_000 + 60_000, () => {})
      await vi.advanceTimersByTimeAsync(20)
    }
    expect(calls).toEqual([])

    await vi.advanceTimersByTimeAsync(200)
    expect(calls).toEqual([19 * 60_000])
  })

  it('never paints an answer for a mark the pointer has left', async () => {
    vi.useFakeTimers()
    const { loader } = loaderOver([{ host: 'ada', excerpts: [excerpt()] }])
    let painted = 0

    loader.request('slot-1', [source], 0, 60_000, () => {
      painted += 1
    })
    loader.cancel()
    await vi.advanceTimersByTimeAsync(500)
    expect(painted).toBe(0)
  })

  it('goes nowhere for a mark with no transcript behind it', async () => {
    vi.useFakeTimers()
    const { loader, calls } = loaderOver([{ host: 'ada', excerpts: [] }])
    loader.request('slot-1', [], 0, 60_000, () => {})
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toEqual([])
    expect(loader.peek('slot-1')).toBeUndefined()
  })

  it('falls back to the tools of a wordless mark, and never over real words', async () => {
    vi.useFakeTimers()
    const { loader } = loaderOver([
      { host: 'ada', excerpts: [], tools: 'Bash ×2 · Read' },
      { host: 'ada', excerpts: [excerpt()], tools: 'Bash' },
    ])
    const seen: MomentWords[] = []

    loader.request('slot-1', [source], 0, 60_000, (words) => seen.push(words))
    await vi.advanceTimersByTimeAsync(200)
    expect(seen[0]).toEqual({ excerpts: [], tools: 'Bash ×2 · Read' })

    // The second answer has words. The daemon should not have sent tools with
    // them, but if anything ever does, the words are what the tooltip shows.
    loader.request('slot-2', [source], 60_000, 120_000, (words) => seen.push(words))
    await vi.advanceTimersByTimeAsync(200)
    expect(seen[1].tools).toBeUndefined()
    expect(seen[1].excerpts).toHaveLength(1)
  })

  it('prefers the tools of a wordless mark to a note about a host that is down', async () => {
    vi.useFakeTimers()
    const loader = new MomentLoader(async (session) => {
      return session === 'down'
        ? { host: 'kelvin', excerpts: [], note: 'words live on kelvin' }
        : { host: 'ada', excerpts: [], tools: 'Edit · Bash' }
    }, 150)
    let words: MomentWords | undefined

    loader.request(
      'slot-1',
      [{ session: 'down', host: 'kelvin' }, source],
      0,
      60_000,
      (w) => {
        words = w
      },
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(words).toEqual({ excerpts: [], tools: 'Edit · Bash' })
  })

  it('merges several sources in time order and keeps a note only when nothing was read', async () => {
    vi.useFakeTimers()
    const loader = new MomentLoader(async (session) => {
      return session === 'a'
        ? { host: 'ada', excerpts: [excerpt({ at_ms: 5_000, text: 'later' })] }
        : { host: 'bo', excerpts: [], note: 'words live on bo' }
    }, 0)

    let words: MomentWords = { excerpts: [] }
    loader.request(
      'slot-1',
      [
        { session: 'a', host: 'ada' },
        { session: 'b', host: 'bo' },
      ],
      0,
      60_000,
      (w) => {
        words = w
      },
    )
    await vi.advanceTimersByTimeAsync(10)

    expect(words.excerpts.map((e) => e.text)).toEqual(['later'])
    // One host answered; that is a better thing to say than "the other is down".
    expect(words.note).toBeUndefined()
  })
})

describe('dedupeSources', () => {
  it('keeps one entry per session-and-host and drops the unpaired minutes', () => {
    expect(
      dedupeSources([
        { session: 'a', host: 'ada' },
        null,
        { session: 'a', host: 'ada' },
        { session: 'a', host: 'bo' },
      ]),
    ).toEqual([
      { session: 'a', host: 'ada' },
      { session: 'a', host: 'bo' },
    ])
  })
})

// `renderTip` itself is not covered here: this suite runs in node with no DOM,
// as every UI suite in this package does, and adding a DOM environment for one
// subtree would be a heavier change than the drawing it tests. What IS covered
// is everything the drawing reads — the parse, the loader, and the note that
// stands whenever the words did not come back.
