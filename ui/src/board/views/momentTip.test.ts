import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureFetch, ok } from '../testFixtures.js'

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
  placeTip,
  renderExcerptMarkdown,
  reconcileRows,
  rowCount,
  pickMark,
  renderTip,
  SLOT_PHRASE,
  type MomentWords,
  type SlotTip,
  type SlotTipRow,
} from './momentTip.js'

/**
 * THE WORDS ON HOVER, from wire to slip of paper.
 *
 * Three things are worth pinning here, and they are the three ways this feature
 * can lie. The wire parser must not admit a half-excerpt. The loader must not
 * paint an answer onto a mark the pointer has left, and must not go to the
 * network for a mark that has no transcript behind it. And the renderer must
 * say nothing at all when nothing was recovered — never an invented sentence,
 * and no longer a gloss explaining its own limitation either.
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

  it('never lets a wire total sit below the list it is a total of', () => {
    // A daemon disagreeing with itself — an `excerpt_count` under-reporting the
    // excerpts it actually sent, a `tool_count` of zero over three real lines —
    // loses to the list, because the list is the thing that is actually here.
    const result = parseMoment(
      {
        host: 'ada',
        excerpts: [excerpt(), excerpt({ text: 'second' })],
        excerpt_count: 1,
        tool_lines: ['Bash — a', 'Bash — b', 'Bash — c'],
        tool_count: 0,
      },
      empty,
    )
    expect(result.excerptCount).toBe(2)
    expect(result.toolCount).toBe(3)
  })
})

describe('the moment fetcher', () => {
  it('asks the named host for the session and window', async () => {
    const calls = captureFetch(ok({ host: 'kelvin', excerpts: [excerpt()] }))

    const result = await createTemporalFetchers('').moment('sess-1', 10, 70, 'kelvin')

    expect(result.excerpts).toHaveLength(1)
    const params = calls[0].params
    expect(params.get('from_ms')).toBe('10')
    expect(params.get('to_ms')).toBe('70')
    expect(params.get('host')).toBe('kelvin')
    // Deliberately NOT /moment/composite: a transcript is a file on one
    // machine, not a feed to merge.
    expect(calls[0].url).not.toContain('composite')
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
  const source = { session: 'sess-1', host: 'ada', spoke: false }

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

  it('falls back to the legacy tool string of a wordless mark, and carries it ALONGSIDE real words too', async () => {
    // "Never over real words" was the OLD rule — a precedence that dropped the
    // tool report client-side the moment a minute had anything to say. That
    // precedence is gone (see the loader's `load` and the module doc): a
    // minute that spoke and also ran calls is two facts, and both travel.
    vi.useFakeTimers()
    const { loader } = loaderOver([
      { host: 'ada', excerpts: [], tools: 'Bash ×2 · Read' },
      { host: 'ada', excerpts: [excerpt()], tools: 'Bash' },
    ])
    const seen: MomentWords[] = []

    loader.request('slot-1', [source], 0, 60_000, (words) => seen.push(words))
    await vi.advanceTimersByTimeAsync(200)
    expect(seen[0]).toEqual({
      excerpts: [],
      excerptTotal: 0,
      toolLines: [],
      toolTotal: 0,
      toolsText: 'Bash ×2 · Read',
    })

    // The second answer has words AND a legacy tool string — both are shown.
    loader.request('slot-2', [source], 60_000, 120_000, (words) => seen.push(words))
    await vi.advanceTimersByTimeAsync(200)
    expect(seen[1].toolsText).toBe('Bash')
    expect(seen[1].excerpts).toHaveLength(1)
  })

  it('carries the excerpts AND the tool lines from one answer — the old code dropped the tools whenever there were words', async () => {
    // The precedence bug this pins: a minute that said anything at all used to
    // lose its tool report on the floor, client-side, after the daemon had
    // gone to the trouble of sending both.
    vi.useFakeTimers()
    const loader = new MomentLoader(async () => ({
      host: 'ada',
      excerpts: [excerpt({ text: 'on it' })],
      toolLines: ['Bash — run the tests', 'Read — momentTip.ts'],
      toolCount: 2,
    }), 150)
    let words: MomentWords | undefined

    loader.request('slot-1', [source], 0, 60_000, (w) => {
      words = w
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(words?.excerpts.map((e) => e.text)).toEqual(['on it'])
    expect(words?.toolLines).toEqual(['Bash — run the tests', 'Read — momentTip.ts'])
    expect(words?.toolTotal).toBe(2)
  })

  it('carries the tools of a wordless mark ALONGSIDE a note about a host that is down — the note is about missing WORDS, not missing tools', async () => {
    // The old precedence made tools and the note mutually exclusive. The note
    // now stays conditional only on whether EXCERPTS came back — see the
    // `empty` guard in `load` — so a wordless slot with tools from one host
    // and a note about another host's absence shows both.
    vi.useFakeTimers()
    const loader = new MomentLoader(async (session) => {
      return session === 'down'
        ? { host: 'kelvin', excerpts: [], note: 'words live on kelvin' }
        : { host: 'ada', excerpts: [], tools: 'Edit · Bash' }
    }, 150)
    let words: MomentWords | undefined

    loader.request(
      'slot-1',
      [{ session: 'down', host: 'kelvin', spoke: false }, source],
      0,
      60_000,
      (w) => {
        words = w
      },
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(words).toEqual({
      excerpts: [],
      excerptTotal: 0,
      toolLines: [],
      toolTotal: 0,
      toolsText: 'Edit · Bash',
      note: 'words live on kelvin',
    })
  })

  it('merges several sources in time order and keeps a note only when nothing was read', async () => {
    vi.useFakeTimers()
    const loader = new MomentLoader(async (session) => {
      return session === 'a'
        ? { host: 'ada', excerpts: [excerpt({ at_ms: 5_000, text: 'later' })] }
        : { host: 'bo', excerpts: [], note: 'words live on bo' }
    }, 0)

    let words: MomentWords = { excerpts: [], excerptTotal: 0, toolLines: [], toolTotal: 0 }
    loader.request(
      'slot-1',
      [
        { session: 'a', host: 'ada', spoke: false },
        { session: 'b', host: 'bo', spoke: false },
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

describe('the spine and the words say the same thing', () => {
  // THE BUG THIS PINS, seen live on Week: a 4-minute slot pooled four sessions,
  // the red spine was drawn off the one that spoke, and the fetch cap — which
  // cut in ARRIVAL order — spent itself on two that had only worked. The slip
  // showed agent prose and a tool line under a spine claiming a human message.
  // On a real day (2026-08-13) that was 16 of the 90 spined slots.
  //
  // The invariant, at the two places it can break: the session behind a spine
  // is always fetched, and a human sentence always survives the excerpt cap.

  it('asks the session that SPOKE, even when it arrived after the cap would have cut', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const loader = new MomentLoader(async (session) => {
      asked.push(session)
      return session === 'sess-spoke'
        ? { host: 'ada', excerpts: [excerpt({ text: 'try the other tack' })] }
        : { host: 'ada', excerpts: [], tools: 'Bash ×12 · Read' }
    }, 0)

    let words: MomentWords = { excerpts: [], excerptTotal: 0, toolLines: [], toolTotal: 0 }
    loader.request(
      'slot-1',
      [
        { session: 'busy-a', host: 'ada', spoke: false },
        { session: 'busy-b', host: 'ada', spoke: false },
        { session: 'busy-c', host: 'ada', spoke: false },
        { session: 'busy-d', host: 'ada', spoke: false },
        { session: 'sess-spoke', host: 'ada', spoke: true },
      ],
      0,
      240_000,
      (w) => {
        words = w
      },
    )
    await vi.advanceTimersByTimeAsync(10)

    expect(asked).toContain('sess-spoke')
    // The cap still holds — a hover is not allowed to fan out over the lot.
    expect(asked.length).toBeLessThanOrEqual(4)
    // And the words are there, not swallowed by the tool line: a slip under a
    // spine shows the sentence. (The busy sessions' legacy tool string still
    // rides along too — see "carries the tools … ALONGSIDE" above — but the
    // spine's own promise is about the excerpt, which is what this pins.)
    expect(words.excerpts.map((e) => e.text)).toEqual(['try the other tack'])
  })

  it('PINNED asks every source, not just the hover budget — a pin may not drop a session with nothing on the slip to say so', async () => {
    // Same shape as the cap test above, but with `full: true`: a busy slot
    // pooling five sessions is routine on Week (a 4-minute slot), and the
    // hover's 4-source budget exists to keep a SWEEP cheap. A pin is a
    // deliberate request to see everything, and the daemon's own caps
    // (`@full_cap` / `@full_tool_lines_cap` in moment.ex) are the backstop for
    // that — the client must not cut the source list on top of them, because a
    // dropped source here has no total to disagree with and the slip would
    // simply show less than it claims to hold.
    vi.useFakeTimers()
    const asked: string[] = []
    const loader = new MomentLoader(async (session, _fromMs, _toMs, _host, full) => {
      asked.push(session)
      expect(full).toBe(true)
      return { host: 'ada', excerpts: [excerpt({ text: `from ${session}` })] }
    }, 0)

    let words: MomentWords = { excerpts: [], excerptTotal: 0, toolLines: [], toolTotal: 0 }
    loader.request(
      'slot-1',
      [
        { session: 'busy-a', host: 'ada', spoke: false },
        { session: 'busy-b', host: 'ada', spoke: false },
        { session: 'busy-c', host: 'ada', spoke: false },
        { session: 'busy-d', host: 'ada', spoke: false },
        { session: 'busy-e', host: 'ada', spoke: false },
      ],
      0,
      240_000,
      (w) => {
        words = w
      },
      true,
    )
    await vi.advanceTimersByTimeAsync(10)

    expect(asked).toHaveLength(5)
    expect(words.excerpts).toHaveLength(5)
  })

  it('keeps the human sentence when the window holds more excerpts than the slip', async () => {
    vi.useFakeTimers()
    // Six agent lines land first, the person types at the end of the window.
    // Cutting in time order dropped exactly that sentence.
    const agentLines = Array.from({ length: 6 }, (_, i) =>
      excerpt({ at_ms: 1_000 + i, role: 'assistant', text: `agent ${i}` }),
    )
    const loader = new MomentLoader(async (session) => {
      return session === 'sess-spoke'
        ? { host: 'ada', excerpts: [excerpt({ at_ms: 200_000, text: 'stop, wrong file' })] }
        : { host: 'ada', excerpts: agentLines }
    }, 0)

    let words: MomentWords = { excerpts: [], excerptTotal: 0, toolLines: [], toolTotal: 0 }
    loader.request(
      'slot-1',
      [
        { session: 'busy-a', host: 'ada', spoke: false },
        { session: 'sess-spoke', host: 'ada', spoke: true },
      ],
      0,
      240_000,
      (w) => {
        words = w
      },
    )
    await vi.advanceTimersByTimeAsync(10)

    expect(words.excerpts.map((e) => e.text)).toContain('stop, wrong file')
    // Still a conversation to read: the survivors stay in the order they were
    // said, with the human sentence last because that is when it was typed.
    expect(words.excerpts).toHaveLength(6)
    expect(words.excerpts.map((e) => e.at_ms)).toEqual(
      [...words.excerpts.map((e) => e.at_ms)].sort((a, b) => a - b),
    )
  })

  it('does not mistake a delegation report for a person', async () => {
    // A subagent's report is a `user` record and nobody typed it. Reserving it
    // over real prose would only move the lie.
    vi.useFakeTimers()
    const loader = new MomentLoader(async () => ({
      host: 'ada',
      excerpts: [
        ...Array.from({ length: 6 }, (_, i) =>
          excerpt({ at_ms: 1_000 + i, role: 'user', kind: 'return', text: `report ${i}` }),
        ),
        excerpt({ at_ms: 200_000, text: 'nice, ship it' }),
      ],
    }), 0)

    let words: MomentWords = { excerpts: [], excerptTotal: 0, toolLines: [], toolTotal: 0 }
    loader.request('slot-1', [{ session: 'a', host: 'ada', spoke: true }], 0, 240_000, (w) => {
      words = w
    })
    await vi.advanceTimersByTimeAsync(10)

    expect(words.excerpts.map((e) => e.text)).toContain('nice, ship it')
  })
})

describe('dedupeSources', () => {
  it('folds `spoke` as an OR — a session that worked and also spoke, spoke', () => {
    expect(
      dedupeSources([
        { session: 'a', host: 'ada', spoke: false },
        { session: 'a', host: 'ada', spoke: true },
      ]),
    ).toEqual([{ session: 'a', host: 'ada', spoke: true }])
  })


  it('keeps one entry per session-and-host and drops the unpaired minutes', () => {
    expect(
      dedupeSources([
        { session: 'a', host: 'ada', spoke: false },
        null,
        { session: 'a', host: 'ada', spoke: false },
        { session: 'a', host: 'bo', spoke: false },
      ]),
    ).toEqual([
      { session: 'a', host: 'ada', spoke: false },
      { session: 'a', host: 'bo', spoke: false },
    ])
  })
})

describe('rowCount — the ×N a row of this kind is allowed to print', () => {
  it('refuses agent a count of any size — its n tallies harness hook events, not messages the slip can show', () => {
    expect(rowCount('agent', 1)).toBeUndefined()
    expect(rowCount('agent', 7)).toBeUndefined()
    expect(rowCount('agent', 14)).toBeUndefined()
  })

  it('allows attention and reply a count, because their n tallies a message the transcript can join', () => {
    expect(rowCount('attention', 3)).toBe(3)
    expect(rowCount('reply', 2)).toBe(2)
  })

  it('refuses a count of one on either — "×1" would dress up an ordinary single message as measured', () => {
    expect(rowCount('attention', 1)).toBeUndefined()
    expect(rowCount('reply', 1)).toBeUndefined()
  })
})

describe('reconcileRows — the honest gap between a register word and its message', () => {
  const replyRow = (): SlotTipRow => ({ kind: 'reply', phrase: 'agent replied', where: '', shuttle: false })
  const attentionRow = (): SlotTipRow => ({ kind: 'attention', phrase: 'you', where: '', shuttle: false })

  it('adds nothing before the transcript has answered — "no text recorded" about a fetch still in flight would be a guess', () => {
    expect(reconcileRows([replyRow()], { resolved: false })).toEqual([replyRow()])
    expect(reconcileRows([replyRow()], {})).toEqual([replyRow()])
  })

  it('marks a reply row "no text recorded" once resolved with no assistant prose among the excerpts', () => {
    const out = reconcileRows([replyRow()], { resolved: true, said: { items: [], total: 0 } })
    expect(out[0].note).toBe('no text recorded')
  })

  it('leaves the row alone once its own message IS among the excerpts', () => {
    const said = { items: [{ at_ms: 0, role: 'assistant' as const, text: 'done' }], total: 1 }
    expect(reconcileRows([replyRow()], { resolved: true, said })[0].note).toBeUndefined()
    const spoken = { items: [{ at_ms: 0, role: 'user' as const, text: 'go' }], total: 1 }
    expect(reconcileRows([attentionRow()], { resolved: true, said: spoken })[0].note).toBeUndefined()
  })

  it('does not credit a delegation report to the reply row — only prose answers the `stop` event a reply row records', () => {
    const said = {
      items: [{ at_ms: 0, role: 'assistant' as const, text: 'go look', kind: 'spawn' as const }],
      total: 1,
    }
    expect(reconcileRows([replyRow()], { resolved: true, said })[0].note).toBe('no text recorded')
  })

  it('leaves an agent row alone either way — it names no message for the gap to be honest about', () => {
    const row: SlotTipRow = { kind: 'agent', phrase: 'agent working', where: '', shuttle: false }
    expect(reconcileRows([row], { resolved: true, said: { items: [], total: 0 } })).toEqual([row])
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
  /** The register class the slip sets on its own host — `kbn-tip-owed` for an
   *  obligation. Modelled rather than stubbed away because it is the one thing
   *  `renderTip` writes OUTSIDE the subtree it rebuilds. */
  readonly classes = new Set<string>()
  readonly classList = {
    toggle: (name: string, on: boolean): void => {
      if (on) this.classes.add(name)
      else this.classes.delete(name)
    },
  }
  /** The excerpt text is markdown now, so the card sets HTML rather than
   *  appending a text node — see `renderExcerptMarkdown`. */
  innerHTML = ''
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

  it('names each kind as a complete claim on its own — no noun waiting for a ×N that never joined it', () => {
    // `agent` used to be a bare noun ('tool call') printed above a ×N that came
    // from the activity plane's per-minute EVENT tally — a `pre_tool_use` and
    // its `post_tool_use` count as two, so the number was never a count of
    // calls at all. `reply` used to say only 'agent', losing the fact that a
    // turn had FINISHED. Both now say what the mark actually witnesses.
    expect(SLOT_PHRASE).toEqual({ attention: 'you', agent: 'agent working', reply: 'agent replied' })
  })

  it('puts label and timestamp on one header line, above the words — never mixed in with them', () => {
    vi.stubGlobal('document', fakeDocument())
    const host = new FakeNode()
    const tip: SlotTip = {
      time: '14:32–14:36',
      rows: [],
      said: { items: [baseExcerpt({})], total: 1 },
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
    expect(text.innerHTML).toBe('<p>run the null tests</p>')
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
      renderTip(host as unknown as HTMLElement, {
        time: '', rows: [], said: { items: detail, total: detail.length },
      })
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
    renderTip(host as unknown as HTMLElement, {
      time: '', rows: [], said: { items: detail, total: detail.length },
    })

    const said = host.children.find((c) => c.className.includes('kbn-tip-said'))!
    const head = said.children[0].children[0]
    const [label, who, when] = head.children
    expect(label.textContent).toBe('→ spawn')
    expect(who.className).toBe('kbn-tip-who')
    expect(who.textContent).toBe('chart-hand')
    expect(when.className).toBe('kbn-tip-when')
  })

  it('says NOTHING when nothing was recovered — the card states facts, and a fact nobody has is not one', () => {
    vi.stubGlobal('document', fakeDocument())
    const host = new FakeNode()
    renderTip(host as unknown as HTMLElement, { time: '', rows: [] })
    expect(host.children.find((c) => c.className.includes('kbn-tip-note'))).toBeUndefined()
  })

  it('still says WHERE the words are, which is a fact about the fleet rather than a gloss', () => {
    vi.stubGlobal('document', fakeDocument())
    const host = new FakeNode()
    renderTip(host as unknown as HTMLElement, {
      time: '', rows: [], note: 'words live on basalt-login-02',
    })
    const foot = host.children.find((c) => c.className.includes('kbn-tip-note'))!
    expect(foot.textContent).toBe('words live on basalt-login-02')
  })

  it('draws the tools ALONGSIDE the words, not instead of them — the legacy string form, with no head', () => {
    vi.stubGlobal('document', fakeDocument())
    const host = new FakeNode()
    renderTip(host as unknown as HTMLElement, {
      time: '', rows: [],
      said: { items: [baseExcerpt({ role: 'assistant', text: 'on it' })], total: 1 },
      // `toolsText` is the OLDER single-string form, from a daemon that sends
      // no `tool_lines` — drawn with no head because nothing here knows how
      // many calls it stands for.
      toolsText: 'Bash — run the tests\nRead — DayView.ts',
    })
    expect(host.children.find((c) => c.className.includes('kbn-tip-said'))).toBeDefined()
    const tools = host.children.find((c) => c.className.includes('kbn-tip-tools'))!
    expect(tools.children.find((c) => c.className === 'kbn-tip-sechead')).toBeUndefined()
    expect(tools.children.map((r) => r.textContent)).toEqual([
      'Bash — run the tests',
      'Read — DayView.ts',
    ])
  })

  it('heads a complete tools section with its own ×N, and says nothing over a single call', () => {
    vi.stubGlobal('document', fakeDocument())
    const many = new FakeNode()
    renderTip(many as unknown as HTMLElement, {
      time: '', rows: [],
      tools: { items: ['Bash — a', 'Read — b'], total: 2 },
    })
    const manyTools = many.children.find((c) => c.className.includes('kbn-tip-tools'))!
    expect(manyTools.children[0].className).toBe('kbn-tip-sechead')
    expect(manyTools.children[0].textContent).toBe('tool calls ×2')

    const one = new FakeNode()
    renderTip(one as unknown as HTMLElement, {
      time: '', rows: [],
      tools: { items: ['Bash — a'], total: 1 },
    })
    const oneTools = one.children.find((c) => c.className.includes('kbn-tip-tools'))!
    expect(oneTools.children.find((c) => c.className === 'kbn-tip-sechead')).toBeUndefined()
  })

  it('says "showing K of N" when a section is cut, and drops the pin invitation once pinned', () => {
    // A cut section must be honest about the gap — "showing 6 of 34" rather than
    // letting six items sit under a claim of thirty-four — and a PINNED slip,
    // where every section already shows everything it has, must not go on
    // inviting a pin for more.
    vi.stubGlobal('document', fakeDocument())
    const unpinned = new FakeNode()
    renderTip(unpinned as unknown as HTMLElement, {
      time: '', rows: [],
      tools: { items: ['a', 'b', 'c', 'd', 'e', 'f'], total: 34 },
    })
    const unpinnedHead = unpinned.children
      .find((c) => c.className.includes('kbn-tip-tools'))!.children[0]
    expect(unpinnedHead.textContent).toBe('showing 6 of 34 tool calls · click to pin for all')

    const pinned = new FakeNode()
    renderTip(pinned as unknown as HTMLElement, {
      time: '', rows: [],
      tools: { items: ['a', 'b', 'c', 'd', 'e', 'f'], total: 34 },
      pinned: true,
    })
    const pinnedHead = pinned.children
      .find((c) => c.className.includes('kbn-tip-tools'))!.children[0]
    expect(pinnedHead.textContent).toBe('showing 6 of 34 tool calls')
  })
})

describe('placeTip — the slip hangs off the anchor, and flips before the edge', () => {
  const box = { width: 1000, height: 300 } as DOMRect
  const fakeTip = () => {
    const flipped = { on: false }
    return {
      style: {} as Record<string, string>,
      classList: { toggle: (_: string, on: boolean) => void (flipped.on = on) },
      flipped,
    }
  }
  const place = (anchorX: number, topPx = 40) => {
    const tip = fakeTip()
    placeTip(tip as unknown as HTMLElement, box, anchorX, topPx)
    return tip
  }

  it('hangs to the right of an early anchor, with the gap between', () => {
    const tip = place(100)
    expect(tip.flipped.on).toBe(false)
    expect(tip.style.left).toBe('109px')
    expect(tip.style.right).toBe('auto')
    expect(tip.style.top).toBe('40px')
  })

  it('flips past 62% of the box so a late mark does not push it off the sheet', () => {
    const tip = place(700)
    expect(tip.flipped.on).toBe(true)
    expect(tip.style.left).toBe('auto')
    // Measured from the box's right edge: 1000 - 700 + 9.
    expect(tip.style.right).toBe('309px')
  })

  it('does not flip exactly on the fraction — the threshold is strictly past it', () => {
    expect(place(620).flipped.on).toBe(false)
    expect(place(621).flipped.on).toBe(true)
  })
})

describe('renderExcerptMarkdown — the transcript, as it was written', () => {
  const md = renderExcerptMarkdown

  it('renders bold, emphasis and inline code', () => {
    expect(md('**bold**')).toBe('<p><strong>bold</strong></p>')
    expect(md('*soft*')).toBe('<p><em>soft</em></p>')
    expect(md('`code`')).toBe('<p><code>code</code></p>')
    expect(md('__bold__')).toBe('<p><strong>bold</strong></p>')
  })

  it('keeps markup inside a code span literal — backticks quote, they do not format', () => {
    expect(md('`**not bold**`')).toBe('<p><code>**not bold**</code></p>')
  })

  it('leaves snake_case and dunders alone — an underscore mid-word is not emphasis', () => {
    expect(md('call snake_case_name now')).toBe('<p>call snake_case_name now</p>')
  })

  it('renders a link as its text, styled but inert — a slip that vanishes is no place for a navigation target', () => {
    expect(md('see [the report](https://example.com/r)')).toBe(
      '<p>see <span class="kbn-tip-md-link">the report</span></p>',
    )
  })

  it('ESCAPES HTML BEFORE ANY MARKUP IS INTRODUCED, so recorded text can never become a tag', () => {
    expect(md('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
    expect(md('<img src=x onerror="boom">')).not.toContain('<img')
    expect(md('a & b')).toBe('<p>a &amp; b</p>')
  })

  it('escapes inside a code span too', () => {
    expect(md('`<b>`')).toBe('<p><code>&lt;b&gt;</code></p>')
  })

  it('cannot be tricked into emitting a tag through a link target', () => {
    expect(md('[x](javascript:alert(1))')).not.toContain('href')
  })

  it('splits paragraphs on blank lines and joins a hard-wrapped one', () => {
    expect(md('one\ntwo\n\nthree')).toBe('<p>one\ntwo</p><p>three</p>')
  })

  it('renders bullet and numbered lists, which a pinned report brings back', () => {
    expect(md('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(md('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })

  it('takes a fenced code block whole, blank lines and all', () => {
    expect(md('```ts\nconst a = 1\n\nconst b = 2\n```')).toBe(
      '<pre><code>const a = 1\n\nconst b = 2\n</code></pre>',
    )
  })

  it('keeps prose either side of a fence', () => {
    expect(md('before\n\n```\nx\n```\n\nafter')).toBe(
      '<p>before</p><pre><code>x\n</code></pre><p>after</p>',
    )
  })

  it('is empty for empty text, rather than an empty paragraph', () => {
    expect(md('')).toBe('')
    expect(md('   \n  ')).toBe('')
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

  it('counts tool calls that landed AFTER the last word, summed across every minute since — and how many MINUTES that span, its own honest unit', () => {
    const { toolsAfter } = lastExchange([
      mark(10, { attention: 1 }), mark(11, { reply: 1 }),
      mark(12, { agent: 4 }), mark(15, { agent: 6 }),
    ])
    // count (10) is a tally of harness hook events, kept because it is what
    // the activity plane recorded; minutes (2) is the figure a slip may
    // actually print — two marks, each one minute, since the last word.
    expect(toolsAfter).toEqual({ atMs: 15 * M, count: 10, minutes: 2 })
  })

  it('reports no trailing calls when the words were the last thing to happen', () => {
    expect(lastExchange([mark(9, { agent: 5 }), mark(10, { reply: 1 })]).toolsAfter).toBeNull()
  })

  it('reports a lane that only ever worked as tool calls and no turns at all', () => {
    const out = lastExchange([mark(3, { agent: 2 }), mark(7, { agent: 5 })])
    expect(out.turns).toEqual([])
    expect(out.toolsAfter).toEqual({ atMs: 7 * M, count: 7, minutes: 2 })
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
