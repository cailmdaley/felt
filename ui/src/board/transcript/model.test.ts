import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TranscriptModel, segments, type Step, type Turn } from './model.js'
import type { Entry } from './records.js'

const entry: fc.Arbitrary<Entry> = fc.oneof(
  fc.record({ text: fc.string(), images: fc.nat(3), dispatch: fc.boolean(), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'prompt', ...value } as Entry)),
  fc.record({ text: fc.string(), model: fc.option(fc.constantFrom('opus', 'sonnet'), { nil: undefined }), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'text', ...value } as Entry)),
  fc.record({ text: fc.string(), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'thinking', ...value } as Entry)),
  fc.record({ id: fc.constantFrom('call-a', 'call-b'), name: fc.constantFrom('Bash', 'Read'), input: fc.anything(), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'tool', ...value } as Entry)),
  fc.record({ id: fc.constantFrom('call-a', 'call-b'), text: fc.string(), isError: fc.boolean(), images: fc.nat(2), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'result', ...value } as Entry)),
  fc.record({ label: fc.constantFrom('Skill', 'Context'), detail: fc.option(fc.string(), { nil: undefined }), text: fc.option(fc.string(), { nil: undefined }), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'event', ...value } as Entry)),
)

const snapshot = (turns: readonly Turn[]): Turn[] => JSON.parse(JSON.stringify(turns)) as Turn[]

describe('TranscriptModel', () => {
  it('folds entries before the first prompt into a null-prompt turn and attaches results by id', () => {
    const model = new TranscriptModel()
    model.append([
      { kind: 'text', text: 'preface', model: 'opus', at: 1 },
      { kind: 'tool', id: 'a', name: 'Bash', input: { command: 'pytest' }, at: 2 },
      { kind: 'result', id: 'a', text: 'ok', isError: false, images: 0, at: 3 },
      { kind: 'result', id: 'unknown', text: 'dropped', isError: false, images: 0 },
      { kind: 'prompt', text: 'Inspect the mask split.', images: 0, dispatch: false, at: 4 },
      { kind: 'text', text: 'First answer.', at: 5 },
      { kind: 'text', text: 'Last answer.', model: 'sonnet', at: 6 },
      { kind: 'tool', id: 'b', name: 'Read', input: { path: 'response.py' }, at: 7 },
      { kind: 'result', id: 'b', text: 'not found', isError: true, images: 0, at: 8 },
      { kind: 'prompt', text: 'Second prompt.', images: 1, dispatch: true, at: 9 },
    ])

    expect(model.turns).toHaveLength(3)
    expect(model.turns[0]).toMatchObject({ prompt: null, answer: 0, steps: [
      { kind: 'text', text: 'preface' },
      { kind: 'tool', id: 'a', result: { text: 'ok', isError: false, images: 0 }, version: 1 },
    ] })
    expect(model.turns[1]).toMatchObject({ prompt: { text: 'Inspect the mask split.' }, answer: 1, steps: [
      { kind: 'text', text: 'First answer.' }, { kind: 'text', text: 'Last answer.' },
      { kind: 'tool', id: 'b', result: { text: 'not found', isError: true }, version: 1 },
    ] })
    expect(model.turns[2]).toMatchObject({ prompt: { text: 'Second prompt.' }, steps: [], answer: -1 })
    expect(model.toolCounts(model.turns[1])).toEqual({ Read: 1 })
    expect(model.stats()).toEqual({ turns: 3, tools: 2, startedAt: 1, endedAt: 9, model: 'opus' })
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0, 1, 2] })
    expect(model.takeChanges()).toEqual({ reset: false, turns: [] })
  })

  it('marks a prior turn dirty when a late tool result arrives and resets cleanly', () => {
    const model = new TranscriptModel()
    model.append([
      { kind: 'prompt', text: 'Run the null test.', images: 0, dispatch: false },
      { kind: 'tool', id: 'call', name: 'Bash', input: 'pytest' },
      { kind: 'prompt', text: 'Now inspect the split.', images: 0, dispatch: false },
    ])
    model.takeChanges()
    model.append([{ kind: 'result', id: 'call', text: 'passed', isError: false, images: 0 }])
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0] })
    expect(model.turns[0].version).toBe(3)

    model.reset()
    expect(model.turns).toEqual([])
    expect(model.takeChanges()).toEqual({ reset: true, turns: [] })
    model.append([{ kind: 'prompt', text: 'Fresh session', images: 0, dispatch: false }])
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0] })
  })

  it('is invariant to splitting a record sequence across append calls', () => {
    fc.assert(fc.property(
      fc.array(entry, { maxLength: 40 }),
      fc.array(fc.boolean(), { maxLength: 40 }),
      (entries, cuts) => {
        const whole = new TranscriptModel()
        whole.append(entries)

        const chunked = new TranscriptModel()
        let start = 0
        for (let i = 0; i < entries.length; i++) {
          if (i === entries.length - 1 || cuts[i]) {
            chunked.append(entries.slice(start, i + 1))
            start = i + 1
          }
        }
        expect(snapshot(chunked.turns)).toEqual(snapshot(whole.turns))
      },
    ))
  })
})

describe('segments', () => {
  it('sets each agent message apart and folds the work between messages into runs', () => {
    const step = (kind: 'text' | 'thinking'): Step => ({ kind, text: kind })
    const tool: Step = { kind: 'tool', id: 'a', name: 'Bash', input: {}, version: 0 }
    expect(segments([])).toEqual([])
    expect(segments([step('thinking'), tool, step('text'), step('text'), tool])).toEqual([
      { kind: 'steps', start: 0, end: 2 },
      { kind: 'text', index: 2 },
      { kind: 'text', index: 3 },
      { kind: 'steps', start: 4, end: 5 },
    ])
  })

  it('covers every step exactly once, in order', () => {
    const steps = fc.array(fc.constantFrom<Step>(
      { kind: 'text', text: 't' }, { kind: 'thinking', text: 'th' }, { kind: 'tool', id: 'x', name: 'Read', input: {}, version: 0 },
    ))
    fc.assert(fc.property(steps, (list) => {
      const covered: number[] = []
      for (const part of segments(list)) {
        if (part.kind === 'text') {
          expect(list[part.index].kind).toBe('text')
          covered.push(part.index)
        } else {
          for (let i = part.start; i < part.end; i++) {
            expect(list[i].kind).not.toBe('text')
            covered.push(i)
          }
        }
      }
      expect(covered).toEqual(list.map((_, index) => index))
    }))
  })
})
