import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createTemporalFetchers,
  parseMoment,
  type MomentExcerpt,
  type MomentResult,
} from './TemporalData.js'
import {
  clockTime,
  dedupeSources,
  MomentLoader,
  lastExchange,
  pickMark,
  renderTip,
  SLOT_NO_TEXT_NOTE,
  SLOT_PHRASE,
  type MomentWords,
  type SlotTip,
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

// ── `renderTip`'s markup ────────────────────────────────────────────────────
//
// This suite runs in node with no DOM, as every UI suite in this package
// does — so `renderTip`'s two structural promises (a one-line header above
// the words, and the class that carries who spoke) are checked against a
// minimal fake element rather than pulling in a DOM environment for one
// subtree. The fake tracks exactly what the assertions need: tag, className,
// textContent, and the children `append` was given, in order.

class FakeNode {
  className = ''
  textContent = ''
  readonly children: FakeNode[] = []
  append(...nodes: Array<FakeNode | { textContent: string }>): void {
    for (const node of nodes) this.children.push(node as FakeNode)
  }
}

function fakeDocument() {
  return {
    createElement: () => new FakeNode(),
    createTextNode: (text: string) => ({ textContent: text }),
  }
}

const EXCERPT_AT_MS = 12 * 60_000 + 34_000
const baseExcerpt = (over: Partial<MomentExcerpt>): MomentExcerpt => ({
  at_ms: EXCERPT_AT_MS,
  role: 'user',
  text: 'run the null tests',
  ...over,
})

describe('renderTip — the excerpt cards', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renamed the tool-call register and kept short labels for the rest', () => {
    expect(SLOT_PHRASE).toEqual({ attention: 'you', agent: 'tool call', reply: 'agent' })
  })

  it('puts label and timestamp on one header line, above the words — never mixed in with them', () => {
    vi.stubGlobal('document', fakeDocument())
    const host = new FakeNode()
    const tip: SlotTip = {
      time: '14:32–14:36',
      rows: [],
      detail: [baseExcerpt({})],
    }

    renderTip(host as unknown as HTMLElement, tip)

    const said = host.children.find((c) => c.className.includes('kbn-tip-said'))!
    const line = said.children[0]
    expect(line.className).toContain('kbn-tip-line-user')

    const [head, text] = line.children
    expect(head.className).toBe('kbn-tip-line-head')
    const [label, when] = head.children
    expect(label.className).toBe('kbn-tip-label')
    expect(label.textContent).toBe('you')
    expect(when.className).toBe('kbn-tip-when')
    expect(when.textContent).toBe(clockTime(EXCERPT_AT_MS))

    expect(text.className).toBe('kbn-tip-text')
    expect(text.children[0].textContent).toBe('run the null tests')
  })

  it('carries who spoke in the line class and label — colour does the rest in CSS', () => {
    vi.stubGlobal('document', fakeDocument())

    const cases: Array<[MomentExcerpt[], string, string]> = [
      [[baseExcerpt({ role: 'user' })], 'kbn-tip-line-user', 'you'],
      [[baseExcerpt({ role: 'assistant' })], 'kbn-tip-line-assistant', 'agent'],
      [[baseExcerpt({ role: 'notification' })], 'kbn-tip-line-notification', 'note'],
      [
        [baseExcerpt({ role: 'assistant', kind: 'spawn', name: 'chart-hand', text: 'go look' })],
        'kbn-tip-deleg-spawn',
        '→ spawn',
      ],
      [
        [baseExcerpt({ role: 'assistant', kind: 'return', name: 'chart-hand', text: 'found it' })],
        'kbn-tip-deleg-return',
        '← return',
      ],
    ]

    for (const [detail, expectedClass, expectedLabel] of cases) {
      const host = new FakeNode()
      renderTip(host as unknown as HTMLElement, { time: '', rows: [], detail })
      const said = host.children.find((c) => c.className.includes('kbn-tip-said'))!
      const line = said.children[0]
      const head = line.children[0]
      expect(line.className).toContain(expectedClass)
      expect(head.children[0].textContent).toBe(expectedLabel)
    }
  })

  it('names the other agent on a delegation line, once, without disturbing the timestamp', () => {
    vi.stubGlobal('document', fakeDocument())
    const host = new FakeNode()
    const detail = [
      baseExcerpt({ kind: 'spawn', name: 'chart-hand', text: 'go and look' }),
    ]
    renderTip(host as unknown as HTMLElement, { time: '', rows: [], detail })

    const said = host.children.find((c) => c.className.includes('kbn-tip-said'))!
    const head = said.children[0].children[0]
    const [label, who, when] = head.children
    expect(label.textContent).toBe('→ spawn')
    expect(who.className).toBe('kbn-tip-who')
    expect(who.textContent).toBe('chart-hand')
    expect(when.className).toBe('kbn-tip-when')
  })

  it('falls to the note, still under the shared section rule, when nothing was said', () => {
    vi.stubGlobal('document', fakeDocument())
    const host = new FakeNode()
    renderTip(host as unknown as HTMLElement, { time: '', rows: [] })
    const foot = host.children.find((c) => c.className.includes('kbn-tip-note'))!
    expect(foot.className).toBe('kbn-tip-note kbn-tip-section')
    expect(foot.textContent).toBe(SLOT_NO_TEXT_NOTE)
  })
})

describe('lastExchange — the order is the content', () => {
  const M = 60_000
  const mark = (min: number, kinds: Record<string, number>) => ({
    atMs: min * M,
    kinds: Object.entries(kinds).map(([kind, count]) => ({ kind: kind as 'agent', count })),
  })

  it('reports you-then-agent when the agent got the last word — it answered', () => {
    const { turns } = lastExchange([mark(10, { attention: 1 }), mark(12, { reply: 1 })])
    expect(turns.map((t) => t.kind)).toEqual(['attention', 'reply'])
    expect(turns[1].atMs).toBe(12 * M)
  })

  it('reports agent-then-you when YOU got the last word — it is being waited on', () => {
    const { turns } = lastExchange([mark(10, { reply: 1 }), mark(12, { attention: 1 })])
    expect(turns.map((t) => t.kind)).toEqual(['reply', 'attention'])
  })

  it('takes the LAST of each side, not the first, however many came before', () => {
    const { turns } = lastExchange([
      mark(1, { attention: 1 }), mark(2, { reply: 1 }),
      mark(30, { attention: 1 }), mark(31, { reply: 1 }),
      mark(40, { attention: 1 }),
    ])
    expect(turns.map((t) => [t.kind, t.atMs / M])).toEqual([['reply', 31], ['attention', 40]])
  })

  it('carries one turn when only one side ever spoke', () => {
    expect(lastExchange([mark(5, { attention: 3 })]).turns.map((t) => t.kind)).toEqual(['attention'])
  })

  it('counts tool calls that landed AFTER the last word, summed across every minute since', () => {
    const { toolsAfter } = lastExchange([
      mark(10, { attention: 1 }), mark(11, { reply: 1 }),
      mark(12, { agent: 4 }), mark(15, { agent: 6 }),
    ])
    expect(toolsAfter).toEqual({ atMs: 15 * M, count: 10 })
  })

  it('reports no trailing calls when the words were the last thing to happen', () => {
    expect(lastExchange([mark(9, { agent: 5 }), mark(10, { reply: 1 })]).toolsAfter).toBeNull()
  })

  it('reports a lane that only ever worked as tool calls and no turns at all', () => {
    const out = lastExchange([mark(3, { agent: 2 }), mark(7, { agent: 5 })])
    expect(out.turns).toEqual([])
    expect(out.toolsAfter).toEqual({ atMs: 7 * M, count: 7 })
  })

  it('ignores a kind recorded with a zero count rather than treating it as a turn', () => {
    expect(lastExchange([mark(4, { attention: 0 })]).turns).toEqual([])
  })

  it('is empty for a lane with no marks', () => {
    expect(lastExchange([])).toEqual({ turns: [], toolsAfter: null })
  })
})

describe('pickMark — the rail catches the pointer out in the empty paper', () => {
  // Three marks at 100, 200 and 300 pixels, with a 9-pixel snap.
  const marks = [100, 200, 300]
  const pick = (x: number) => pickMark(marks, x, 9)

  it('reports the mark under the pointer as an ordinary hover, unmagnetized', () => {
    expect(pick(200)).toEqual({ index: 1, magnetized: false })
  })

  it('snaps to the nearest mark within the snap radius, still unmagnetized', () => {
    expect(pick(206)).toEqual({ index: 1, magnetized: false })
    expect(pick(94)).toEqual({ index: 0, magnetized: false })
  })

  it('answers nothing in the empty paper BETWEEN two marks — there the blank really is an absence of anything to say', () => {
    expect(pick(150)).toBeNull()
  })

  it('answers nothing left of the first mark: "the earliest thing here" is not a question anybody asks', () => {
    expect(pick(20)).toBeNull()
  })

  it('MAGNETIZES anywhere right of the last mark, however far out', () => {
    expect(pick(400)).toEqual({ index: 2, magnetized: true })
    expect(pick(99_999)).toEqual({ index: 2, magnetized: true })
  })

  it('hands the two zones over to each other with no gap and no overlap at the snap radius', () => {
    // Inside the radius the ordinary snap owns it; one pixel further out the
    // magnet does. Every x past the last mark resolves to the last mark.
    expect(pick(309)).toEqual({ index: 2, magnetized: false })
    expect(pick(310)).toEqual({ index: 2, magnetized: true })
  })

  it('magnetizes to the RIGHTMOST mark, not the last one handed in', () => {
    expect(pickMark([300, 100, 200], 400, 9)).toEqual({ index: 0, magnetized: true })
  })

  it('answers nothing at all for a lane with no marks — there is no last moment to catch', () => {
    expect(pickMark([], 400, 9)).toBeNull()
  })

  it('still magnetizes when the lane holds exactly one mark', () => {
    expect(pickMark([100], 400, 9)).toEqual({ index: 0, magnetized: true })
  })
})

// What is covered above is the drawing's structure; what is covered in the
// rest of this file is everything it reads to get there — the parse, the
// loader, and the note that stands whenever the words did not come back.
