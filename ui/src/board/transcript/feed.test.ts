import { describe, expect, it, vi } from 'vitest'
import { TranscriptFeed, type FeedStatus } from './feed.js'
import type { Entry } from './records.js'

const session = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
const jsonLine = (text: string): string => `${JSON.stringify({ type: 'user', message: { content: text } })}\n`
const response = (body: BodyInit | null, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers })
const offsetFrom = (url: string): number => Number(new URL(url).searchParams.get('offset'))
type EntriesMock = ReturnType<typeof vi.fn<(entries: Entry[]) => void>>
type ResetMock = ReturnType<typeof vi.fn<() => void>>
type StatusMock = ReturnType<typeof vi.fn<(status: FeedStatus, detail?: string) => void>>
type ReplaceMock = ReturnType<typeof vi.fn<(record: number, entries: Entry[]) => void>>

const entriesFrom = (onEntries: EntriesMock): Entry[] => onEntries.mock.calls.flatMap(([entries]) => entries)

function feed(fetcher: typeof fetch, extra: { onEntries?: EntriesMock; onReset?: ResetMock; onStatus?: StatusMock; onReplaceRecord?: ReplaceMock; provenance?: boolean } = {}) {
  const onEntries = extra.onEntries ?? vi.fn<(entries: Entry[]) => void>()
  const onReset = extra.onReset ?? vi.fn<() => void>()
  const onStatus = extra.onStatus ?? vi.fn<(status: FeedStatus, detail?: string) => void>()
  const reader = new TranscriptFeed({
    shuttleBase: 'http://localhost:4000/',
    session,
    host: 'candide',
    fetch: extra.provenance ? fetcher : (input, init) => String(input).includes('/messages?')
      ? Promise.resolve(Response.json({ messages: [], cursor: '0' }))
      : fetcher(input, init),
    onEntries,
    onReplaceRecord: extra.onReplaceRecord,
    onReset,
    onStatus,
  })
  return { reader, onEntries, onReset, onStatus }
}

describe('TranscriptFeed', () => {
  it('preserves a multibyte UTF-8 character split across byte reads', async () => {
    const bytes = new TextEncoder().encode(jsonLine('shear α is stable'))
    const alpha = bytes.indexOf(0xce)
    const parts = [bytes.slice(0, alpha + 1), bytes.slice(alpha + 1)]
    let call = 0
    const requests: string[] = []
    const { reader, onEntries } = feed(async (input) => {
      const url = String(input)
      requests.push(url)
      const offset = offsetFrom(url)
      const part = parts[call++]
      return response(part, 200, { 'x-transcript-offset': String(offset) })
    })

    expect(await reader.read()).toBe(true)
    expect(await reader.read()).toBe(true)
    expect(requests.map(offsetFrom)).toEqual([0, parts[0].byteLength])
    expect(entriesFrom(onEntries)).toEqual([{ kind: 'prompt', text: 'shear α is stable', images: 0, dispatch: false }])
    reader.dispose()
  })

  it('buffers a JSON line split across reads and counts bytes for the next offset', async () => {
    const line = jsonLine('Inspect the response bins.')
    const parts = [new TextEncoder().encode(line.slice(0, 35)), new TextEncoder().encode(line.slice(35))]
    let call = 0
    const requests: string[] = []
    const { reader, onEntries } = feed(async (input) => {
      const url = String(input)
      requests.push(url)
      return response(parts[call++], 200, { 'x-transcript-offset': String(offsetFrom(url)) })
    })

    expect(await reader.read()).toBe(true)
    expect(onEntries).not.toHaveBeenCalled()
    expect(await reader.read()).toBe(true)
    expect(requests.map(offsetFrom)).toEqual([0, parts[0].byteLength])
    expect(entriesFrom(onEntries)).toEqual([{ kind: 'prompt', text: 'Inspect the response bins.', images: 0, dispatch: false }])
    reader.dispose()
  })

  it('uses byte lengths for offsets across three reads', async () => {
    const bytes = new TextEncoder().encode(`${jsonLine('first')}${jsonLine('second')}`)
    const parts = [bytes.slice(0, 17), bytes.slice(17, 61), bytes.slice(61)]
    const requests: string[] = []
    let call = 0
    const { reader, onEntries } = feed(async (input) => {
      const url = String(input)
      requests.push(url)
      return response(parts[call++], 200, { 'x-transcript-offset': String(offsetFrom(url)) })
    })

    for (let i = 0; i < 3; i++) await reader.read()
    expect(requests.map(offsetFrom)).toEqual([0, parts[0].byteLength, parts[0].byteLength + parts[1].byteLength])
    expect(entriesFrom(onEntries).map((entry) => entry.kind === 'prompt' ? entry.text : '')).toEqual(['first', 'second'])
    reader.dispose()
  })

  it('resets and treats a whole-file response without an offset header as a fresh file', async () => {
    const bytes = new TextEncoder().encode(jsonLine('one complete record'))
    const offsets: number[] = []
    const { reader, onEntries, onReset } = feed(async (input) => {
      offsets.push(offsetFrom(String(input)))
      return response(bytes)
    })

    await reader.read()
    await reader.read()
    expect(offsets).toEqual([0, bytes.byteLength])
    expect(onReset).toHaveBeenCalledOnce()
    expect(entriesFrom(onEntries).map((entry) => entry.kind)).toEqual(['prompt', 'prompt'])
    reader.dispose()
  })

  it('resets once on 416 and retries from byte zero', async () => {
    const offsets: number[] = []
    const body = new TextEncoder().encode(jsonLine('re-read from the beginning'))
    const { reader, onEntries, onReset } = feed(async (input) => {
      const offset = offsetFrom(String(input))
      offsets.push(offset)
      return offsets.length === 1
        ? response(null, 416)
        : response(body, 200, { 'x-transcript-offset': String(offset) })
    })

    expect(await reader.read()).toBe(true)
    expect(offsets).toEqual([0, 0])
    expect(onReset).toHaveBeenCalledOnce()
    expect(entriesFrom(onEntries)).toMatchObject([{ kind: 'prompt', text: 're-read from the beginning' }])
    reader.dispose()
  })

  it.each([
    [404, 'missing', undefined],
    [409, 'pending', undefined],
    [503, 'unreachable', 'candide'],
    [500, 'error', 'HTTP 500'],
  ] as Array<[number, FeedStatus, string | undefined]>)('maps HTTP %i to %s', async (status, expected, detail) => {
    const { reader, onStatus } = feed(async () => response(JSON.stringify({ host: 'candide' }), status, { 'Content-Type': 'application/json' }))
    expect(await reader.read()).toBe(false)
    if (detail === undefined) expect(onStatus).toHaveBeenLastCalledWith(expected)
    else expect(onStatus).toHaveBeenLastCalledWith(expected, detail)
    reader.dispose()
  })

  it('reports network failures and stops callbacks after disposal', async () => {
    const failed = feed(async () => { throw new Error('offline') })
    expect(await failed.reader.read()).toBe(false)
    expect(failed.onStatus).toHaveBeenLastCalledWith('error', 'offline')
    failed.reader.dispose()

    let resolve!: (value: Response) => void
    const pending = new Promise<Response>((yes) => { resolve = yes })
    const stopped = feed(() => pending)
    const read = stopped.reader.read()
    stopped.reader.dispose()
    resolve(response(new TextEncoder().encode(jsonLine('too late'))))
    expect(await read).toBe(false)
    expect(stopped.onEntries).not.toHaveBeenCalled()
    expect(stopped.onStatus).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight request and includes host and no-store cache policy', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>((yes) => { resolve = yes })
    const fetcher = vi.fn<typeof fetch>(() => pending)
    const { reader } = feed(fetcher)
    const first = reader.read()
    const second = reader.read()
    expect(second).toBe(first)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][0]).toContain(`session=${session}&offset=0&host=candide`)
    expect(fetcher.mock.calls[0][1]).toEqual({ cache: 'no-store' })
    resolve(response(new Uint8Array()))
    await first
    reader.dispose()
  })

  it('does not parse JSONL again on 239 unchanged byte-offset reads', async () => {
    const body = new TextEncoder().encode(jsonLine('the transcript remains unchanged'))
    const parse = vi.spyOn(JSON, 'parse')
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const offset = offsetFrom(String(input))
      return response(offset === 0 ? body : new Uint8Array(), 200, { 'x-transcript-offset': String(offset) })
    })
    const { reader, onEntries } = feed(fetcher)
    expect(await reader.read()).toBe(true)
    expect(parse).toHaveBeenCalledTimes(2)
    for (let tick = 0; tick < 239; tick++) expect(await reader.read()).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(240)
    expect(parse).toHaveBeenCalledTimes(2)
    expect(entriesFrom(onEntries)).toEqual([{ kind: 'prompt', text: 'the transcript remains unchanged', images: 0, dispatch: false }])
    reader.dispose()
  })
})

describe('TranscriptFeed stream', () => {
  const sse = (body: string): Response => response(body, 200, { 'content-type': 'text/event-stream; charset=utf-8' })

  it('parses arbitrary byte splits, CRLF and UTF-8 and commits the event id', async () => {
    const line = jsonLine('shear α').trimEnd()
    const wire = new TextEncoder().encode(`: open\r\nid: 123\r\ndata: ${line}\r\n\r\n`)
    const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of wire) c.enqueue(Uint8Array.of(byte)); c.close() } })
    const requests: string[] = []
    const { reader, onEntries } = feed(async (input) => {
      requests.push(String(input))
      return requests.length === 1 ? response(stream, 200, { 'content-type': 'text/event-stream' }) : response(new Uint8Array(), 200, { 'x-transcript-offset': '123' })
    })
    expect(await reader.stream()).toBe('closed')
    await reader.read()
    expect(offsetFrom(requests[1])).toBe(123)
    expect(entriesFrom(onEntries)).toMatchObject([{ kind: 'prompt', text: 'shear α' }])
  })

  it('scans a multi-megabyte partial SSE line only once across chunks', async () => {
    const text = 'x'.repeat(2 * 1024 * 1024)
    const wire = new TextEncoder().encode(`id: 99\ndata: ${jsonLine(text).trimEnd()}\n\n`)
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      for (let i = 0; i < wire.length; i += 4096) c.enqueue(wire.slice(i, i + 4096))
      c.close()
    } })
    const { reader, onEntries } = feed(async () => response(stream, 200, { 'content-type': 'text/event-stream' }))
    let scanned = 0
    const exec = RegExp.prototype.exec
    const scan = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, input: string) {
      if (this.source === '[\\r\\n]') scanned += input.length - this.lastIndex
      return exec.call(this, input)
    })
    try {
      expect(await reader.stream()).toBe('closed')
      expect(entriesFrom(onEntries)).toMatchObject([{ text }])
      expect(scanned).toBeGreaterThan(wire.length / 2)
      expect(scanned).toBeLessThan(wire.length * 2)
    } finally { scan.mockRestore(); reader.dispose() }
  })

  it('dispatches a CR-only event whose last delimiter is at EOF', async () => {
    const { reader, onEntries } = feed(async () => sse(`id: 99\rdata: ${jsonLine('CR only').trimEnd()}\r\r`))
    expect(await reader.stream()).toBe('closed')
    expect(entriesFrom(onEntries)).toMatchObject([{ text: 'CR only' }])
  })

  it('shares the raw decoding time budget across byte chunks', async () => {
    let time = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => { time += 4; return time })
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const body = new TextEncoder().encode(Array.from({ length: 5 }, () => jsonLine('x'.repeat(65_000))).join(''))
    const { reader } = feed(async () => response(body, 200, { 'x-transcript-offset': '0' }))
    try {
      await reader.read()
      expect(timer).toHaveBeenCalled()
    } finally { clock.mockRestore(); timer.mockRestore() }
  })

  it('resumes a partial raw line at the last complete byte boundary', async () => {
    const first = jsonLine('first')
    const second = jsonLine('second α')
    const boundary = new TextEncoder().encode(first).length
    const total = new TextEncoder().encode(first + second).length
    const requests: string[] = []
    const { reader, onEntries } = feed(async (input) => {
      requests.push(String(input))
      return requests.length === 1
        ? response(new TextEncoder().encode(first + second.slice(0, 15)), 200, { 'x-transcript-offset': '0' })
        : sse(`id: ${total}\ndata: ${second.trimEnd()}\n\n`)
    })
    await reader.read()
    expect(await reader.stream()).toBe('closed')
    expect(offsetFrom(requests[1])).toBe(boundary)
    expect(entriesFrom(onEntries)).toMatchObject([{ text: 'first' }, { text: 'second α' }])
  })

  it.each([
    [200, '{}', 'application/json', 'unsupported'],
    [501, '', 'application/json', 'unsupported'],
    [404, '{}', 'application/json', 'unsupported'],
    [404, '{"availability":"transcript_missing"}', 'application/json', 'failed'],
    [409, '', 'application/json', 'failed'],
    [429, '', 'application/json', 'busy'],
    [503, '', 'application/json', 'failed'],
  ] as const)('maps stream HTTP %i', async (status, body, contentType, result) => {
    const { reader, onStatus } = feed(async () => response(body, status, { 'content-type': contentType }))
    expect(await reader.stream()).toBe(result)
    if (status === 404 && result === 'failed') expect(onStatus).toHaveBeenCalledWith('missing')
    if (status === 409) expect(onStatus).toHaveBeenCalledWith('pending')
  })

  it.each(['http', 'event'])('resets on %s', async (kind) => {
    const { reader, onReset } = feed(async () => kind === 'http' ? response(null, 416) : sse('event: reset\ndata: {"byte_count":0}\n\n'))
    expect(await reader.stream()).toBe('reset')
    expect(onReset).toHaveBeenCalledOnce()
  })

  it.each(['upstream_error', 'upstream_idle'])('fails on %s without committing a partial upstream event', async error => {
    const first = jsonLine('committed').trimEnd()
    const requests: string[] = []
    const { reader, onEntries, onReset } = feed(async input => {
      requests.push(String(input))
      return requests.length === 1
        ? sse(`id: 99\ndata: ${first}\n\nid: 199\ndata: {"type":"user"\nevent: error\ndata: {"error":"${error}"}\n\n`)
        : response(new Uint8Array(), 200, { 'x-transcript-offset': '99' })
    })
    expect(await reader.stream()).toBe('failed')
    await reader.read()
    expect(offsetFrom(requests[1])).toBe(99)
    expect(entriesFrom(onEntries)).toMatchObject([{ text: 'committed' }])
    expect(onReset).not.toHaveBeenCalled()
  })

  it('commits a decoded event when stopped during its time slice', async () => {
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => 100 + clock.mock.calls.length * 10)
    const lines = Array.from({ length: 4 }, (_, i) => `data: ${jsonLine(`line ${i}`).trimEnd()}\n`).join('')
    const requests: string[] = []
    const onEntries = vi.fn<(entries: Entry[]) => void>(() => reader.stopStream())
    const { reader } = feed(async (input) => {
      requests.push(String(input))
      return requests.length === 1 ? sse(`id: 99\n${lines}\n`) : response(new Uint8Array(), 200, { 'x-transcript-offset': '99' })
    }, { onEntries })
    try {
      const following = reader.stream()
      expect(await following).toBe('stopped')
      await reader.read()
      expect(offsetFrom(requests[1])).toBe(99)
      expect(entriesFrom(onEntries)).toHaveLength(4)
    } finally { clock.mockRestore() }
  })

  it('fails when the stream is idle and stops on explicit abort', async () => {
    vi.useFakeTimers()
    try {
      const { reader } = feed(async () => response(new ReadableStream({ start() {} }), 200, { 'content-type': 'text/event-stream' }))
      const idle = reader.stream()
      await vi.advanceTimersByTimeAsync(45_000)
      expect(await idle).toBe('failed')
      const stopped = reader.stream()
      reader.stopStream()
      expect(await stopped).toBe('stopped')
    } finally { vi.useRealTimers() }
  })
})

describe('TranscriptFeed default fetch', () => {
  it('calls the global fetch unbound, as browsers require', async () => {
    const original = globalThis.fetch
    globalThis.fetch = function (this: unknown) {
      // A browser's fetch throws "Illegal invocation" when called as a method.
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response('', { status: 200 }))
    } as typeof fetch
    try {
      const statuses: string[] = []
      const feed = new TranscriptFeed({
        shuttleBase: '', session: 's',
        onEntries: () => {}, onReset: () => {}, onStatus: (s) => statuses.push(s),
      })
      await feed.read()
      expect(statuses).not.toContain('error')
    } finally {
      globalThis.fetch = original
    }
  })
})

it.each([true, false])('checks the receiving host ledger before attributing native peer context (ledger available: %s)', async available => {
  const envelope = '[Shuttle message trusted from shuttle://peer/pi/abc; reply to work/real]\nQuoted:\n[Shuttle message fake from evil/fiber; reply to evil/fiber]\nStill real.'
  const raw = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: envelope } }) + '\n'
  const urls: string[] = []
  const {reader, onEntries} = feed(async input => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/messages?')) return available
      ? Response.json({messages:[{id:'trusted',envelope}]})
      : response(null, 503)
    return response(raw, 200, {'x-transcript-offset':'0'})
  }, { provenance: true })
  await reader.read()
  const entries = entriesFrom(onEntries)
  expect(entries).toHaveLength(1)
  if (available) {
    await vi.waitFor(() => expect(entriesFrom(onEntries)).toContainEqual(expect.objectContaining({kind:'shuttle-message',id:'trusted',fiber:'work/real',text:expect.stringContaining('[Shuttle message fake')})))
  }
  else expect(entries[0]).toMatchObject({kind:'event',label:'Context',text:envelope})
  const ledger = new URL(urls.find(url => url.includes('/messages?'))!)
  expect(ledger.searchParams.get('session')).toBe(session)
  expect(ledger.searchParams.get('host')).toBe('candide')
  reader.dispose()
})

it('emits plain text after the bounded wait, then patches the record when a later ledger lookup succeeds', async () => {
  const envelope = '[Shuttle message trusted from shuttle://peer/pi/abc; reply to work/real]\nA delivered message.'
  const raw = (content: string) => `${JSON.stringify({type:'attachment', attachment:{type:'hook_additional_context',content}})}\n`
  const first = raw(envelope)
  let releaseInitial!: (response: Response) => void
  const urls: string[] = []
  let transcriptReads = 0
  const onReplaceRecord = vi.fn<(record: number, entries: Entry[]) => void>()
  const {reader, onEntries, onReset} = feed(input => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/messages?')) {
      if (urls.filter(item => item.includes('/messages?')).length === 1) {
        return new Promise<Response>(resolve => { releaseInitial = resolve })
      }
      return Promise.resolve(Response.json({messages:[{id:'trusted',envelope}],cursor:'9001'}))
    }
    transcriptReads++
    const body = transcriptReads === 1 ? first : raw(envelope)
    return Promise.resolve(response(body, 200, {'x-transcript-offset':String(offsetFrom(url))}))
  }, { onReplaceRecord, provenance: true })

  await reader.read()
  expect(entriesFrom(onEntries)).toEqual([expect.objectContaining({kind:'event',label:'Context',text:envelope})])
  releaseInitial(Response.json({messages:[],cursor:'7001'}))
  await vi.waitFor(() => expect(urls.filter(item => item.includes('/messages?')).length).toBe(2), { timeout: 3000 })
  expect(urls.filter(item => item.includes('/messages?')).map(url => new URL(url).searchParams.get('since'))).toEqual([null, '7001'])
  await vi.waitFor(() => expect(onReplaceRecord).toHaveBeenCalledWith(1, [expect.objectContaining({kind:'shuttle-message',id:'trusted',fiber:'work/real'})]))
  expect(transcriptReads).toBe(1)
  expect(onReset).not.toHaveBeenCalled()
  reader.dispose()
})

it('spends at most one 500 ms evidence wait across a batch of candidate records', async () => {
  const messages = Array.from({ length: 12 }, (_, index) => {
    const envelope = `[Shuttle message slow-${index} from shuttle]\nDelivery ${index}`
    return { id: `slow-${index}`, envelope }
  })
  const raw = messages.map(({ envelope }) => JSON.stringify({ type: 'custom_message', customType: 'shuttle', content: envelope })).join('\n') + '\n'
  let release!: (response: Response) => void
  const onReplaceRecord = vi.fn<(record: number, entries: Entry[]) => void>()
  const { reader, onEntries } = feed(async input => String(input).includes('/messages?')
    ? new Promise<Response>(resolve => { release = resolve })
    : response(raw, 200, { 'x-transcript-offset': '0' }), { onReplaceRecord, provenance: true })
  const started = performance.now()
  await reader.read()
  const elapsed = performance.now() - started
  expect(elapsed).toBeLessThan(900)
  expect(entriesFrom(onEntries)).toHaveLength(messages.length)
  expect(entriesFrom(onEntries).every(entry => entry.kind === 'event')).toBe(true)
  release(Response.json({ messages, cursor: '101' }))
  await vi.waitFor(() => expect(onReplaceRecord).toHaveBeenCalledTimes(messages.length))
  reader.dispose()
})

it('normalizes candidate records against evidence arriving before their batch is flushed', async () => {
  const messages = ['first-id', 'second-id'].map(id => ({ id, envelope: `[Shuttle message ${id} from shuttle]\n${id}` }))
  const raw = messages.map(({ envelope }) => JSON.stringify({
    type: 'attachment', attachment: { type: 'hook_additional_context', content: envelope },
  })).join('\n') + '\n'
  let lookups = 0
  const { reader, onEntries } = feed(async input => {
    if (String(input).includes('/messages?')) {
      lookups++
      return Response.json(lookups === 1 ? { messages: [], cursor: '1' } : { messages, cursor: '2' })
    }
    return response(raw, 200, { 'x-transcript-offset': '0' })
  }, { provenance: true })
  await reader.read()
  expect(entriesFrom(onEntries).filter(entry => entry.kind === 'shuttle-message').map(entry => entry.id)).toEqual(['first-id', 'second-id'])
  expect(lookups).toBe(2)
  reader.dispose()
})

it('retries a failed ledger lookup while the transcript is quiet', async () => {
  const envelope = '[Shuttle message trusted from shuttle://peer/pi/abc; reply to work/real]\nA delivered message.'
  const raw = `${JSON.stringify({type:'attachment', attachment:{type:'hook_additional_context',content:envelope}})}\n`
  let lookups = 0
  const onReplaceRecord = vi.fn<(record: number, entries: Entry[]) => void>()
  const {reader, onEntries, onReset} = feed(async input => {
    if (String(input).includes('/messages?')) {
      lookups++
      return lookups <= 2 ? response(null, 503) : Response.json({messages:[{id:'trusted',envelope}],cursor:'91'})
    }
    return response(raw, 200, {'x-transcript-offset':'0'})
  }, { onReplaceRecord, provenance: true })

  await reader.read()
  expect(entriesFrom(onEntries)).toEqual([expect.objectContaining({kind:'event',label:'Context',text:envelope})])
  await vi.waitFor(() => expect(onReplaceRecord).toHaveBeenCalledWith(1, [expect.objectContaining({kind:'shuttle-message',id:'trusted'})]), { timeout: 3000 })
  expect(lookups).toBe(3)
  expect(onReset).not.toHaveBeenCalled()
  reader.dispose()
})

it('lets a new delivered id bypass backoff left by an earlier failed carrier lookup', async () => {
  const fake = '[Shuttle message quoted-id from shuttle]\nA native quotation.'
  const delivered = '[Shuttle message new-real-id from shuttle]\nA real delivery.'
  let bytes = new TextEncoder().encode(JSON.stringify({
    type: 'attachment', attachment: { type: 'hook_additional_context', content: fake },
  }) + '\n')
  const since: (string | null)[] = []
  let lookups = 0
  const { reader, onEntries } = feed(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/messages')) {
      since.push(url.searchParams.get('since'))
      lookups++
      if (lookups === 1) return Response.json({ messages: [], cursor: '1' })
      if (lookups === 2) return response(null, 503)
      return Response.json({ messages: [{ id: 'new-real-id', envelope: delivered }], cursor: '3' })
    }
    const offset = Number(url.searchParams.get('offset'))
    return response(bytes.slice(offset), 200, { 'x-transcript-offset': String(offset) })
  }, { provenance: true })
  await reader.read()
  expect(entriesFrom(onEntries)).toEqual([expect.objectContaining({ kind: 'event', label: 'Context', text: fake })])
  bytes = new Uint8Array([...bytes, ...new TextEncoder().encode(JSON.stringify({
    type: 'attachment', attachment: { type: 'hook_additional_context', content: delivered },
  }) + '\n')])
  await reader.read()
  expect(since).toEqual([null, '1', '1'])
  expect(entriesFrom(onEntries)).toContainEqual(expect.objectContaining({ kind: 'shuttle-message', id: 'new-real-id', text: 'A real delivery.' }))
  expect(lookups).toBe(3)
  reader.dispose()
})

it('reads one evidence snapshot for a transcript spanning many decode slices', async () => {
  const envelopes = Array.from({length: 16}, (_, i) => ({id: `m-${i}`, envelope: `[Shuttle message m-${i} from sender]\n${'x'.repeat(64_000)}`}))
  const raw = envelopes.map(({envelope}) => JSON.stringify({type:'attachment', attachment:{type:'hook_additional_context',content:envelope}})).join('\n')+'\n'
  let lookups = 0
  const {reader, onEntries} = feed(async input => {
    if (String(input).includes('/messages?')) { lookups++; return Response.json({messages:envelopes}) }
    return response(raw, 200, {'x-transcript-offset':'0'})
  }, { provenance: true })
  await reader.read()
  expect(lookups).toBe(1)
  await vi.waitFor(() => expect(entriesFrom(onEntries).filter(entry=>entry.kind==='shuttle-message').slice(-16)).toHaveLength(16))
  reader.dispose()
})
