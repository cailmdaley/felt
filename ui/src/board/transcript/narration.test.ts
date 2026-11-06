import { describe, expect, it, vi } from 'vitest'
import { TranscriptFeed } from './feed.js'
import { TranscriptModel, segments } from './model.js'
import { normalizeRecord, type Entry } from './records.js'
import source from './fixtures/claude-thinking-narration.jsonl?raw'

const records = source.trim().split('\n').map(line => JSON.parse(line) as unknown)
const fullRead = records.flatMap(record => normalizeRecord(record))

const UPDATE = "I'm fixing the fifteen-second delay: the patch noise sits above the silence threshold, so a run will now close on its last bin.\n\n"
const LONE_UPDATE = 'The threshold change holds on the north patch; I am running the south patch next.\n\n'
const ANSWER = 'Splits now close on their last bin, in under a second on every patch.'

function field(number: number, payload: number[]): number[] {
  return [number * 8 + 2, ...(payload.length < 128 ? [payload.length] : [payload.length & 127 | 128, payload.length >> 7]), ...payload]
}

const ascii = (text: string): number[] => [...new TextEncoder().encode(text)]
const base64 = (bytes: number[]): string => btoa(String.fromCharCode(...bytes))
const envelope = (kind: string, padding = 12): number[] => [0x08, 0x04, ...field(2, [
  ...field(1, [0x08, 0x13, 0x18, 0x02, 0x38, 0x01, ...field(8, ascii(kind))]),
  ...field(2, new Array<number>(padding).fill(0)),
])]

function readsAs(signature: string | undefined): string {
  const entries = normalizeRecord({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'A sentence.', signature }] } })
  expect(entries).toHaveLength(1)
  return entries[0].kind
}

function modelOf(entries: readonly Entry[]): TranscriptModel {
  const model = new TranscriptModel()
  model.append(entries)
  return model
}

describe('Claude thinking blocks the terminal shows as messages', () => {
  it('reads each stored block by its own tag, keeping the order of the record', () => {
    expect(fullRead.filter(entry => entry.kind !== 'usage' && entry.kind !== 'result').map(entry => [entry.kind, 'text' in entry ? entry.text : undefined])).toEqual([
      ['prompt', 'Why does the mask split take fifteen seconds to close?'],
      ['thinking', "I'm working out where the delay comes from: the split waits for a quiet stretch, so the threshold decides when it ends."],
      ['text', UPDATE],
      ['tool', undefined],
      ['text', LONE_UPDATE],
      ['tool', undefined],
      ['thinking', 'The south patch closes as quickly, so the threshold is not patch dependent.'],
      ['thinking', 'I should check the log before I call this finished.'],
      ['tool', undefined],
      ['thinking', 'The first of two untagged blocks.'],
      ['thinking', 'The second of two untagged blocks.'],
      ['tool', undefined],
      ['tool', undefined],
      ['thinking', 'Everything closes promptly, so I can report.'],
      ['text', ANSWER],
    ])
  })

  it('carries the model and time of the record, as any assistant text does', () => {
    expect(fullRead.find(entry => entry.kind === 'text')).toEqual({
      kind: 'text', text: UPDATE, narration: true, model: 'claude-opus-5-5', at: Date.parse('2026-11-06T15:20:05.000Z'),
    })
  })

  it('takes the tag from its one field, whatever length the signature runs to', () => {
    expect(readsAs(base64(envelope('narration')))).toBe('text')
    expect(readsAs(base64(envelope('narration', 4096)))).toBe('text')
    expect(readsAs(base64(envelope('thinking', 4096)))).toBe('thinking')
  })

  it('reads anything but that tag as reasoning', () => {
    const inPayload = [0x08, 0x04, ...field(2, [...field(1, [0x08, 0x13]), ...field(2, ascii('narration'))])]
    const truncated = envelope('narration').slice(0, 12)
    const shortFixed = [...envelope('narration'), 0x09, 0x00]
    const unknownWire = [...envelope('narration'), 0x0b]
    for (const signature of [undefined, '', 'opaque', 'not base64!', base64(inPayload), base64(truncated), base64(shortFixed), base64(unknownWire), base64(envelope('narrations'))]) {
      expect(readsAs(signature), String(signature)).toBe('thinking')
    }
  })

  it('leaves the turn\'s answer on its last message, not on an update', () => {
    const model = modelOf(fullRead)
    const [turn] = model.turns
    expect(turn.steps[turn.answer]).toMatchObject({ kind: 'text', text: ANSWER })

    const interrupted = modelOf(fullRead.slice(0, fullRead.findIndex(entry => entry.kind === 'text' && entry.text === ANSWER)))
    expect(interrupted.turns[0].answer).toBe(-1)
    interrupted.setSentFiles([{ kind: 'sent-file', id: 'sent-1', sessionId: 's', files: [], at: Date.parse('2026-11-06T15:20:06.000Z') }])
    expect(interrupted.turns[0].steps).toContainEqual(expect.objectContaining({ kind: 'sent-file' }))
    expect(interrupted.turns[0].answer).toBe(-1)
  })

  it('lays an update out as a row between runs of steps', () => {
    const [turn] = modelOf(fullRead).turns
    expect(segments(turn.steps).slice(0, 4).map(segment => segment.kind)).toEqual(['steps', 'text', 'steps', 'text'])
  })
})

describe('reading narration through the feed', () => {
  async function read(cuts: number[]): Promise<{ entries: Entry[]; kinds: string[] }> {
    const bytes = new TextEncoder().encode(source)
    const parts = [...cuts, bytes.byteLength].map((end, index, ends) => bytes.slice(ends[index - 1] ?? 0, end))
    let next = 0
    const entries: Entry[] = []
    const kinds: string[] = []
    const reader = new TranscriptFeed({
      shuttleBase: 'http://localhost:4000/',
      session: 'a3edf873-cb1c-40ab-a891-f26f5333b320',
      fetch: vi.fn(async (input: RequestInfo | URL) => String(input).includes('/messages?')
        ? Response.json({ messages: [], cursor: '0' })
        : new Response(parts[next++], { headers: { 'x-transcript-offset': '0' } })),
      onEntries: batch => {
        entries.push(...batch)
        kinds.push(...batch.map(entry => `${entry.kind}:${'text' in entry ? entry.text : ''}`))
      },
      onReset: () => {},
      onStatus: () => {},
    })
    for (let index = 0; index < parts.length; index++) await reader.read()
    return { entries, kinds }
  }

  it('gives one row at a time what a full read gives, and never passes an update through as thinking', async () => {
    const rowEnds = source.split('\n').slice(0, -1).reduce<number[]>((ends, line) => [...ends, (ends.at(-1) ?? 0) + new TextEncoder().encode(line).byteLength + 1], []).slice(0, -1)
    const { entries, kinds } = await read(rowEnds)
    expect(entries).toEqual(fullRead)
    expect(kinds).not.toContain(`thinking:${UPDATE}`)
    expect(kinds).not.toContain(`thinking:${LONE_UPDATE}`)
  })

  it('holds a row split between reads until it is whole', async () => {
    const update = new TextEncoder().encode(source.slice(0, source.indexOf('fifteen-second'))).byteLength
    expect((await read([update])).entries).toEqual(fullRead)
  })
})
