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

const entriesFrom = (onEntries: EntriesMock): Entry[] => onEntries.mock.calls.flatMap(([entries]) => entries)

function feed(fetcher: typeof fetch, extra: { onEntries?: EntriesMock; onReset?: ResetMock; onStatus?: StatusMock } = {}) {
  const onEntries = extra.onEntries ?? vi.fn<(entries: Entry[]) => void>()
  const onReset = extra.onReset ?? vi.fn<() => void>()
  const onStatus = extra.onStatus ?? vi.fn<(status: FeedStatus, detail?: string) => void>()
  const reader = new TranscriptFeed({
    shuttleBase: 'http://localhost:4000/',
    session,
    host: 'candide',
    fetch: fetcher,
    onEntries,
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
    expect(parse).toHaveBeenCalledTimes(1)
    for (let tick = 0; tick < 239; tick++) expect(await reader.read()).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(240)
    expect(parse).toHaveBeenCalledTimes(1)
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
