// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptBand, type TranscriptTarget } from './TranscriptBand.js'
import claudeUsage from './fixtures/claude-usage.jsonl?raw'
import codexUsage from './fixtures/codex-usage.jsonl?raw'
import piUsage from './fixtures/pi-usage.jsonl?raw'
import codexResetUsage from './fixtures/codex-compaction-reset.jsonl?raw'

const captured = (source: string): unknown[] => source.trim().split('\n').map((line) => JSON.parse(line))

const latestId = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
const earlierId = 'b4edf873-cb1c-40ab-a891-f26f5333b321'
const records = (prompt: string, answer: string, withTool = false): unknown[] => [
  { type: 'user', timestamp: '2026-09-26T14:02:00.000Z', message: { content: prompt } },
  ...(withTool ? [
    { type: 'assistant', timestamp: '2026-09-26T14:03:00.000Z', message: { model: 'claude-opus', content: [
      { type: 'thinking', thinking: '', signature: 'opaque' },
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'git log --oneline -5' } },
    ] } },
    { type: 'user', timestamp: '2026-09-26T14:04:00.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: answer },
    ] } },
  ] : []),
  { type: 'assistant', timestamp: '2026-09-26T14:14:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: answer }] } },
]

const encoded = (items: unknown[]): Uint8Array => new TextEncoder().encode(items.map((item) => JSON.stringify(item)).join('\n') + '\n')
const tick = async (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); await tick() }
const microtasks = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
let bands: TranscriptBand[] = []
const makeBand = (fetcher: typeof fetch): TranscriptBand => {
  const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fetcher })
  bands.push(band)
  document.body.append(band.el)
  return band
}
const target = (session: string, patch: Partial<TranscriptTarget> = {}): TranscriptTarget => ({
  session, host: 'candide', agent: 'claude-opus', live: false, at: Date.parse('2026-09-26T14:02:00Z'), ...patch,
})
const fixtureFetch = (itemsBySession: Record<string, unknown[]>, requests: string[] = []): typeof fetch =>
  vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    requests.push(url)
    const parsed = new URL(url)
    const bytes = encoded(itemsBySession[parsed.searchParams.get('session') ?? ''] ?? [])
    const offset = Number(parsed.searchParams.get('offset') ?? 0)
    return new Response(bytes.slice(offset), {
      status: 200,
      headers: { 'x-transcript-offset': String(offset), 'x-transcript-byte-count': String(bytes.byteLength) },
    })
  })

const sessionAndFilesFetch = (
  itemsBySession: Record<string, unknown[]>,
  files: () => unknown[],
  requests: string[] = [],
): typeof fetch => vi.fn<typeof fetch>(async (input) => {
  const url = new URL(String(input))
  requests.push(url.toString())
  if (url.pathname.endsWith('/sent-files/session')) {
    return new Response(JSON.stringify({ files: files() }), { headers: { ETag: `"files-${files().length}"` } })
  }
  const bytes = encoded(itemsBySession[url.searchParams.get('session') ?? ''] ?? [])
  const offset = Number(url.searchParams.get('offset') ?? 0)
  return new Response(bytes.slice(offset), {
    status: 200,
    headers: { 'x-transcript-offset': String(offset), 'x-transcript-byte-count': String(bytes.byteLength) },
  })
})

/** Controlled HTTP bodies exercise the real feed, including abort and byte offsets. */
const streamFixture = () => {
  let bytes = encoded(records('Initial prompt', 'Initial answer'))
  const requests: string[] = []
  const streams: { controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }[] = []
  let streamStatus = 200
  let files: unknown[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    requests.push(url.toString())
    if (url.pathname.endsWith('/sent-files/session')) return new Response(JSON.stringify({ files }))
    if (url.pathname.endsWith('/transcript/stream')) {
      if (streamStatus !== 200) return new Response('', { status: streamStatus })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { streams.push({ controller, signal: init!.signal! }) },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const offset = Number(url.searchParams.get('offset'))
    return new Response(bytes.slice(offset), { headers: { 'x-transcript-offset': String(offset) } })
  })
  return {
    fetcher, requests, streams,
    raw: () => requests.filter(url => url.includes('/transcript/raw')),
    sent: () => requests.filter(url => url.includes('/sent-files/session')),
    status: (status: number) => { streamStatus = status },
    files: (next: unknown[]) => { files = next },
    append(items: unknown[]) {
      const extra = encoded(items)
      bytes = new Uint8Array([...bytes, ...extra])
      streams.at(-1)!.controller.enqueue(new TextEncoder().encode(
        `id: ${bytes.length}\n${items.map(item => `data: ${JSON.stringify(item)}\n`).join('')}\n`,
      ))
    },
    reset() {
      bytes = encoded(records('Replacement prompt', 'Replacement answer'))
      streams.at(-1)!.controller.enqueue(new TextEncoder().encode('event: reset\ndata: {"byte_count":0}\n\n'))
    },
  }
}

const send = (fullPath: string, timestamp: number, sessionId = latestId): Record<string, unknown> => ({
  fullPath,
  basename: fullPath.split('/').pop(),
  timestamp,
  sessionId,
})

const groupedTranscript = (): unknown[] => [
  { type: 'user', timestamp: '2026-09-26T14:02:00.000Z', message: { content: 'Check the fixture.' } },
  { type: 'assistant', timestamp: '2026-09-26T14:03:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'Before the receipt.' }] } },
  { type: 'assistant', timestamp: '2026-09-26T14:04:00.000Z', message: { model: 'claude-opus', content: [
    { type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'python validate.py --batch 1' } },
    { type: 'tool_use', id: 'call-b', name: 'Bash', input: { command: 'python validate.py --batch 2' } },
  ] } },
  { type: 'assistant', timestamp: '2026-09-26T14:05:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'After the receipt.' }] } },
]

afterEach(() => {
  for (const band of bands) band.dispose()
  bands = []
  document.body.replaceChildren()
  try { localStorage.removeItem('shuttle.transcript.folded') } catch { /* unavailable */ }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TranscriptBand', () => {
  it('pins live tasks above both readers and updates without a transcript fetch or human turn', async () => {
    const fetcher = fixtureFetch({ [latestId]: records('Fixture', 'Answer'), [earlierId]: records('Old', 'Earlier') })
    const band = makeBand(fetcher)
    const tasks = [{ id: '1', subject: 'Verify', status: 'in_progress' as const, activeForm: 'Verifying' }]
    band.follow(target(latestId, { live: true, tasks }))
    await settle()
    const checklist = band.el.querySelector('.ws-transcript-checklist')!
    expect(checklist.textContent).toContain('Verifying')
    expect(band.el.querySelector('.ws-transcript-body')!.firstElementChild).toBe(checklist)
    const reads = vi.mocked(fetcher).mock.calls.length
    band.follow(target(latestId, { live: true, tasks: [{ ...tasks[0], status: 'completed' }] }))
    expect(checklist.textContent).toContain('✓Verify')
    expect(vi.mocked(fetcher).mock.calls).toHaveLength(reads)
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    expect(band.el.querySelector('.ws-transcript-scroll')!.firstElementChild?.className).toBe('ws-transcript-checklist')
    band.read(target(earlierId))
    expect(band.el.querySelector('.ws-transcript-checklist')).toBeNull()
    band.follow(target(latestId, { live: true, tasks }))
    expect(band.el.querySelector('.ws-transcript-checklist')).toBeNull()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-latest')!.click()
    expect(band.el.querySelector('.ws-transcript-checklist')?.textContent).toContain('Verifying')
    band.follow(target(latestId, { live: true, tasks: [] }))
    expect(band.el.querySelector('.ws-transcript-checklist')).toBeNull()
    band.follow(target(latestId, { live: false, tasks }))
    expect(band.el.querySelector('.ws-transcript-checklist')).toBeNull()
  })
  it('keeps thread deliveries visible between messages in preview and full transcript, outside folded tools', async () => {
    const delivered = `[Shuttle message thread-${'a'.repeat(64)}]\nthread work/child closed: A measured result`
    const items = [
      ...records('Keep going', 'I am coordinating.'),
      { type: 'user', message: { content: delivered } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I will integrate it.' }] } },
    ]
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await settle()
    const preview = band.el.querySelector('.ws-transcript-exchange')!
    expect([...preview.children].map(row => row.textContent)).toEqual([
      expect.stringContaining('Keep going'), expect.stringContaining('I am coordinating.'),
      expect.stringContaining('← Fromchild· closedA measured result'), expect.stringContaining('I will integrate it.'),
    ])
    expect(preview.querySelectorAll('.ws-transcript-thread-notice')).toHaveLength(1)
    const notice = preview.querySelector<HTMLElement>('.ws-transcript-thread-notice')!
    expect(notice.querySelector('.ws-transcript-message-toggle')?.textContent).toContain('· closed')
    expect(notice.querySelector('.ws-transcript-message-toggle')?.getAttribute('aria-label')).toContain('· closed')
    expect(notice.querySelector('.ws-transcript-message-detail .ws-transcript-message-thread-state')).toBeNull()
    notice.querySelector<HTMLElement>('.ws-transcript-message-toggle')!.click()
    await settle()
    expect(notice.querySelector<HTMLElement>('.ws-transcript-message-preview')?.hidden).toBe(true)
    expect(notice.querySelector('.ws-transcript-message-detail')?.textContent).toContain('A measured result')
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    expect(band.el.querySelectorAll('.ws-transcript-turn')).toHaveLength(1)
    expect(band.el.querySelector('.ws-transcript-pane .ws-transcript-thread-notice a')?.getAttribute('data-fiber')).toBe('work/child')
    expect(band.el.querySelector('.ws-transcript-steps')).toBeNull()
  })
  it('keeps an expanded sent-message row when its tool result arrives', async () => {
    const session = latestId
    const items: unknown[] = [
      { type: 'user', timestamp: '2026-09-26T14:02:00.000Z', message: { content: 'Send the result.' } },
      { type: 'assistant', timestamp: '2026-09-26T14:03:00.000Z', message: { content: [{
        type: 'tool_use', id: 'send-call', name: 'Bash', input: { command: 'shuttle message work/child "The table is ready."' },
      }] } },
    ]
    const fetcher = fixtureFetch({ [session]: items })
    const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fetcher, inline: true })
    bands.push(band)
    document.body.append(band.el)
    band.follow(target(session))
    await settle()
    const row = band.el.querySelector<HTMLElement>('.ws-transcript-shuttle-message')!
    row.querySelector<HTMLElement>('.ws-transcript-message-toggle')!.click()
    expect(row.querySelector<HTMLElement>('.ws-transcript-message-detail')!.hidden).toBe(false)

    items.push({ type: 'user', timestamp: '2026-09-26T14:04:00.000Z', message: { content: [{
      type: 'tool_result', tool_use_id: 'send-call', content: 'accepted (msg-42)',
    }] } })
    await (band as unknown as { readNow(): Promise<boolean> }).readNow()
    await settle()

    expect(band.el.querySelector('.ws-transcript-shuttle-message')).toBe(row)
    expect(row.dataset.status).toBe('sent')
    expect(row.querySelector('.ws-transcript-message-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector<HTMLElement>('.ws-transcript-message-detail')!.hidden).toBe(false)
  })
  it('shows one sent image in the preview and full transcript, and opens it on its owner', async () => {
    const uid = '01KTESTFIBER000000000000001'
    const sentAt = Date.parse('2026-09-26T14:08:00Z')
    const requests: string[] = []
    const onFile = vi.fn()
    const band = new TranscriptBand({
      shuttleBase: 'http://localhost:4000',
      fetch: sessionAndFilesFetch({ [latestId]: records('Open the plots.', 'The fit is stable.') }, () => [send('/tmp/plot.png', sentAt)], requests),
      onFile,
    })
    bands.push(band)
    document.body.append(band.el)
    band.follow(target(latestId, { uid }))
    await settle()

    const preview = band.el.querySelector('.ws-transcript-exchange')!
    const row = preview.querySelector<HTMLElement>('.ws-transcript-sent-file')!
    expect(preview.querySelectorAll('.ws-transcript-sent-file')).toHaveLength(1)
    expect(row.querySelector<HTMLImageElement>('.ws-transcript-sent-inline img')?.loading).toBe('lazy')
    expect(row.querySelector('img')?.getAttribute('src')).toContain('/api/v1/file?path=%2Ftmp%2Fplot.png&origin=candide')
    expect(row.textContent).toContain('plot.png')
    expect(new URL(requests.find((url) => url.includes('/sent-files/session?'))!).searchParams.get('uid')).toBe(uid)
    expect(new URL(requests.find((url) => url.includes('/sent-files/session?'))!).searchParams.get('session')).toBe(latestId)
    expect(new URL(requests.find((url) => url.includes('/sent-files/session?'))!).searchParams.get('origin')).toBe('candide')

    row.querySelector<HTMLButtonElement>('.ws-transcript-sent-file-item')!.click()
    expect(onFile).toHaveBeenCalledExactlyOnceWith('/tmp/plot.png', 'plot.png', 'candide')
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    expect(band.el.querySelectorAll('.ws-transcript-pane .ws-transcript-sent-file')).toHaveLength(1)
  })

  it('keeps several files from one send in one row and names non-image kinds', async () => {
    const sentAt = Date.parse('2026-09-26T14:08:00Z')
    const files = [send('/tmp/fit.pdf', sentAt), send('/tmp/parameters.json', sentAt)]
    const band = makeBand(sessionAndFilesFetch({ [latestId]: records('Read the fit.', 'It converged.') }, () => files))
    band.follow(target(latestId, { uid: '01KTESTFIBER000000000000002' }))
    await settle()

    const rows = band.el.querySelectorAll('.ws-transcript-exchange .ws-transcript-sent-file')
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelectorAll('.ws-transcript-sent-file-item')).toHaveLength(2)
    expect(rows[0].querySelector('.ws-transcript-sent-inline')).toBeNull()
    expect([...rows[0].querySelectorAll('.ws-transcript-sent-kind')].map((node) => node.textContent)).toEqual(['PDF', 'text'])
    expect(rows[0].querySelector('img')).toBeNull()
  })

  it('shows each predecessor session’s receipts only in that session', async () => {
    const uid = '01KTESTFIBER000000000000003'
    const files = [
      send('/tmp/current.pdf', Date.parse('2026-09-26T14:08:00Z'), latestId),
      send('/tmp/earlier.pdf', Date.parse('2026-09-25T14:08:00Z'), earlierId),
    ]
    const band = makeBand(sessionAndFilesFetch({
      [latestId]: records('Current prompt', 'Current answer.'),
      [earlierId]: records('Earlier prompt', 'Earlier answer.'),
    }, () => files))
    band.follow(target(latestId, { uid }))
    await settle()
    expect(band.el.querySelector('.ws-transcript-exchange .ws-transcript-sent-file')?.textContent).toContain('current.pdf')

    band.read(target(earlierId, { uid }))
    await settle()
    expect(band.el.querySelector('.ws-transcript-exchange .ws-transcript-sent-file')?.textContent).toContain('earlier.pdf')
    expect(band.el.querySelector('.ws-transcript-exchange .ws-transcript-sent-file')?.textContent).not.toContain('current.pdf')
  })

  it('orders a send between the transcript steps around its timestamp', async () => {
    const uid = '01KTESTFIBER000000000000004'
    const time = (minute: number): string => `2026-09-26T14:${String(minute).padStart(2, '0')}:00.000Z`
    const transcript = [
      { type: 'user', timestamp: time(2), message: { content: 'Compare the bands.' } },
      { type: 'assistant', timestamp: time(4), message: { model: 'claude-opus', content: [{ type: 'text', text: 'Before the figure.' }] } },
      { type: 'assistant', timestamp: time(12), message: { model: 'claude-opus', content: [{ type: 'text', text: 'After the figure.' }] } },
    ]
    const band = makeBand(sessionAndFilesFetch({ [latestId]: transcript }, () => [send('/tmp/response.png', Date.parse(time(8)))]))
    band.follow(target(latestId, { uid }))
    await settle()

    const preview = band.el.querySelector('.ws-transcript-exchange')!
    const children = [...preview.children]
    const before = children.findIndex((node) => node.textContent?.includes('Before the figure.'))
    const file = children.findIndex((node) => node.classList.contains('ws-transcript-sent-file'))
    const after = children.findIndex((node) => node.textContent?.includes('After the figure.'))
    expect(before).toBeGreaterThanOrEqual(0)
    expect(before).toBeLessThan(file)
    expect(file).toBeLessThan(after)

    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    const full = band.el.querySelector('.ws-transcript-pane [data-turn="0"]')!
    const fullChildren = [...full.children]
    expect(fullChildren.findIndex((node) => node.textContent?.includes('Before the figure.')))
      .toBeLessThan(fullChildren.findIndex((node) => node.classList.contains('ws-transcript-sent-file')))
    expect(fullChildren.findIndex((node) => node.classList.contains('ws-transcript-sent-file')))
      .toBeLessThan(fullChildren.findIndex((node) => node.textContent?.includes('After the figure.')))
  })

  it('keeps text and an expanded group intact when a receipt is spliced before them', async () => {
    const band = makeBand(fixtureFetch({ [latestId]: groupedTranscript() }))
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()

    const pane = band.el.querySelector<HTMLElement>('.ws-transcript-pane')!
    const before = [...pane.querySelectorAll<HTMLElement>('.ws-transcript-msg-agent')].find(node => node.textContent?.includes('Before the receipt.'))!
    const after = [...pane.querySelectorAll<HTMLElement>('.ws-transcript-msg-agent')].find(node => node.textContent?.includes('After the receipt.'))!
    const group = pane.querySelector<HTMLButtonElement>('.ws-transcript-steps')!
    group.click()
    const tools = [...pane.querySelectorAll<HTMLElement>('.ws-transcript-tool')]
    expect(tools).toHaveLength(2)
    group.focus()
    expect(document.activeElement).toBe(group)

    const internal = band as unknown as { acceptSentFiles: (session: string, files: unknown[]) => void }
    internal.acceptSentFiles(latestId, [send('/tmp/mid-turn.pdf', Date.parse('2026-09-26T14:03:30Z'))])
    expect(document.activeElement).toBe(group)
    await settle()

    expect(pane.querySelector('.ws-transcript-sent-file')?.textContent).toContain('mid-turn.pdf')
    expect(pane.querySelector('.ws-transcript-steps')).toBe(group)
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(group)
    expect([...pane.querySelectorAll('.ws-transcript-tool')]).toEqual(tools)
    expect([...pane.querySelectorAll('.ws-transcript-msg-agent')].find(node => node.textContent?.includes('Before the receipt.'))).toBe(before)
    expect([...pane.querySelectorAll('.ws-transcript-msg-agent')].find(node => node.textContent?.includes('After the receipt.'))).toBe(after)
  })

  it('keeps both halves of an expanded group open when a receipt lands inside its run', async () => {
    const split = groupedTranscript()
    split.splice(2, 1,
      { type: 'assistant', timestamp: '2026-09-26T14:04:00.000Z', message: { model: 'claude-opus', content: [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: { command: 'python validate.py --batch 1' } }] } },
      { type: 'assistant', timestamp: '2026-09-26T14:04:30.000Z', message: { model: 'claude-opus', content: [{ type: 'tool_use', id: 'call-b', name: 'Bash', input: { command: 'python validate.py --batch 2' } }] } },
    )
    const band = makeBand(fixtureFetch({ [latestId]: split }))
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()
    const pane = band.el.querySelector<HTMLElement>('.ws-transcript-pane')!
    pane.querySelector<HTMLButtonElement>('.ws-transcript-steps')!.click()
    const tools = [...pane.querySelectorAll<HTMLElement>('.ws-transcript-tool')]
    expect(tools).toHaveLength(2)

    const internal = band as unknown as { acceptSentFiles: (session: string, files: unknown[]) => void }
    internal.acceptSentFiles(latestId, [send('/tmp/mid-run.pdf', Date.parse('2026-09-26T14:04:10Z'))])
    await settle()

    const groups = [...pane.querySelectorAll<HTMLButtonElement>('.ws-transcript-steps')]
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
    expect([...pane.querySelectorAll('.ws-transcript-tool')]).toEqual(tools)
  })

  it('repaints a changed send with the same id and prunes it when that step disappears', async () => {
    const band = makeBand(fixtureFetch({ [latestId]: groupedTranscript() }))
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()

    const internal = band as unknown as {
      acceptSentFiles: (session: string, files: unknown[]) => void
      views: Map<number, { kept: Map<string, unknown> }>
    }
    const timestamp = Date.parse('2026-09-26T14:03:30Z')
    internal.acceptSentFiles(latestId, [send('/tmp/original.pdf', timestamp)])
    await settle()
    const first = band.el.querySelector<HTMLElement>('.ws-transcript-sent-file')!
    const id = first.dataset.send!
    expect(first.textContent).toContain('original.pdf')

    internal.acceptSentFiles(latestId, [send('/tmp/revised.pdf', timestamp)])
    await settle()
    const revised = band.el.querySelector<HTMLElement>('.ws-transcript-sent-file')!
    expect(revised).not.toBe(first)
    expect(revised.dataset.send).toBe(id)
    expect(revised.textContent).toContain('revised.pdf')
    expect(first.isConnected).toBe(false)

    internal.acceptSentFiles(latestId, [])
    await settle()
    expect(band.el.querySelector('.ws-transcript-sent-file')).toBeNull()
    expect(internal.views.get(0)?.kept.has(`sent:${id}`)).toBe(false)
  })

  it('prunes text, group, and expanded-row caches when their steps disappear', async () => {
    const band = makeBand(fixtureFetch({ [latestId]: groupedTranscript() }))
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-steps')!.click()

    const internal = band as unknown as {
      model: { turns: Array<{ steps: unknown[] }> }
      views: Map<number, { texts: Map<string, unknown>; groups: Map<string, unknown>; rows: Map<string, unknown>; expandedRows: Set<string> }>
      renderTurn: (index: number) => void
    }
    const view = internal.views.get(0)!
    expect(view.texts.size).toBe(2)
    expect(view.groups.size).toBe(1)
    expect(view.rows.size).toBe(2)
    expect(view.expandedRows.size).toBe(2)

    internal.model.turns[0].steps.splice(1)
    internal.renderTurn(0)

    expect(view.texts.size).toBe(1)
    expect(view.groups.size).toBe(0)
    expect(view.rows.size).toBe(0)
    expect(view.expandedRows.size).toBe(0)
  })

  it('adds a send from the live feed without reloading the conversation', async () => {
    vi.useFakeTimers()
    const uid = '01KTESTFIBER000000000000005'
    let files: unknown[] = []
    const fetcher = sessionAndFilesFetch({ [latestId]: records('Watch the run.', 'Still working.') }, () => files)
    const band = makeBand(fetcher)
    band.follow(target(latestId, { uid, live: true }))
    await microtasks()
    expect(band.el.querySelector('.ws-transcript-sent-file')).toBeNull()
    files = [send('/tmp/live.png', Date.now())]

    await vi.advanceTimersByTimeAsync(4000)
    expect(band.el.querySelector('.ws-transcript-exchange .ws-transcript-sent-file')?.textContent).toContain('live.png')
  })
  it('keeps a visible message fixed across a send refresh, and follows the bottom when pinned', async () => {
    const items = [
      ...records('First', 'First answer'),
      ...records('Second', 'Second answer').map(item => ({ ...item as object, timestamp: '2026-09-26T15:00:00Z' })),
      ...records('Third', 'Third answer').map(item => ({ ...item as object, timestamp: '2026-09-26T16:00:00Z' })),
    ]
    const band = makeBand(sessionAndFilesFetch({ [latestId]: items }, () => []))
    band.follow(target(latestId, { uid: '01KTESTFIBER000000000000001' }))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    const scroller = band.el.querySelector<HTMLElement>('.ws-transcript-scroll')!
    Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { get: () => scroller.querySelectorAll('.ws-transcript-msg').length * 100 } })
    const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: () => ({}) })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('ws-transcript-msg')) return rect(0)
      const parent = this.closest<HTMLElement>('.ws-transcript-scroll, .ws-transcript-preview')
      const index = parent ? [...parent.querySelectorAll('.ws-transcript-msg')].indexOf(this) : 0
      return rect(index * 100 - (parent?.scrollTop ?? 0))
    })
    scroller.scrollTop = 250
    scroller.dispatchEvent(new Event('scroll'))
    const anchor = [...scroller.querySelectorAll<HTMLElement>('.ws-transcript-msg')].find(node => node.getBoundingClientRect().bottom > 0)!
    const before = anchor.getBoundingClientRect().top
    const refresh = band as unknown as { acceptSentFiles: (session: string, files: unknown[]) => void }
    refresh.acceptSentFiles(latestId, [send('/tmp/above.pdf', Date.parse('2026-09-26T14:10:00Z')), send('/tmp/below.pdf', Date.parse('2026-09-26T16:10:00Z'))])
    expect(anchor.getBoundingClientRect().top).toBe(before)
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
    scroller.dispatchEvent(new Event('scroll'))
    refresh.acceptSentFiles(latestId, [send('/tmp/above.pdf', Date.parse('2026-09-26T14:10:00Z')), send('/tmp/below.pdf', Date.parse('2026-09-26T16:10:00Z')), send('/tmp/new.pdf', Date.parse('2026-09-26T16:20:00Z'))])
    await tick()
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(scroller.scrollHeight - scroller.clientHeight)
  })

  it('opens the full pane at the same message when the preview is scrolled', async () => {
    const items: unknown[] = [
      { type: 'user', timestamp: '2026-09-26T14:02:00.000Z', message: { content: 'Check the fixture.' } },
      ...Array.from({ length: 6 }, (_, index) => ({
        type: 'assistant', timestamp: new Date(Date.parse('2026-09-26T14:03:00Z') + index * 60_000).toISOString(),
        message: { model: 'claude-opus', content: [{ type: 'text', text: `Answer ${index + 1}.` }] },
      })),
    ]
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await settle()

    const preview = band.el.querySelector<HTMLElement>('.ws-transcript-preview')!
    const previewMessages = [...preview.querySelectorAll<HTMLElement>('.ws-transcript-msg')]
    Object.defineProperties(preview, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 700 },
    })
    const scroller = (band as unknown as { scroller: HTMLElement }).scroller
    Object.defineProperties(scroller, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 900 },
    })
    const rect = (top: number) => ({ top, bottom: top + 80, left: 0, right: 100, width: 100, height: 80, x: 0, y: top, toJSON: () => ({}) })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === preview || this === scroller) return rect(100)
      if (!this.classList.contains('ws-transcript-msg')) return rect(0)
      const parent = this.closest<HTMLElement>('.ws-transcript-scroll, .ws-transcript-preview')
      const messages = parent ? [...parent.querySelectorAll<HTMLElement>('.ws-transcript-msg')] : []
      return rect(100 + messages.indexOf(this) * 100 - (parent?.scrollTop ?? 0))
    })
    preview.scrollTop = 200
    preview.dispatchEvent(new Event('scroll'))
    const anchor = previewMessages.find(node => node.getBoundingClientRect().bottom > preview.getBoundingClientRect().top)!
    const readingKey = anchor.dataset.readingKey!
    const top = anchor.getBoundingClientRect().top

    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()

    const fullAnchor = scroller.querySelector<HTMLElement>(`[data-reading-key="${readingKey}"]`)
    expect(fullAnchor?.textContent).toBe(anchor.textContent)
    expect(fullAnchor?.getBoundingClientRect().top).toBe(top)
    expect(scroller.scrollTop).toBeGreaterThan(0)
  })

  it('opens an outcome at its message outside the initial turn window, before the feed loads', async () => {
    const items = Array.from({ length: 6 }, (_, index) => records(`Prompt ${index}`, `Answer ${index}`)).flat()
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    const host = document.createElement('div')
    host.className = 'ws-content'
    document.body.append(host)
    host.append(band.el)
    const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100, x: 0, y: top, toJSON: () => ({}) })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.classList.contains('ws-transcript-msg') ? (this.textContent?.includes('Answer 1') ? 240 : 1000) : 0
      return rect(this.classList.contains('ws-transcript-msg') ? top - (this.closest('.ws-transcript-scroll')?.scrollTop ?? 0) : 0)
    })
    band.follow(target(latestId))
    band.openAtMessage('Answer 1')
    const scroller = host.querySelector<HTMLElement>('.ws-transcript-scroll')!
    Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 2000 } })
    await settle()
    await tick()
    const pane = host.querySelector<HTMLElement>('.ws-transcript-pane')!
    expect(pane.hidden).toBe(false)
    expect(pane.querySelector('[data-turn="1"]')?.textContent).toContain('Answer 1')
    expect(scroller.scrollTop).toBeGreaterThan(200)
    const position = scroller.scrollTop
    scroller.dispatchEvent(new Event('scroll'))
    band.reseated()
    await tick()
    expect(scroller.scrollTop).toBe(position)
    expect(band.el.querySelector('.ws-transcript-pane')).toBeNull()
  })

  it('waits for initial decoding to finish before consuming a partially decoded native match', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 10)
    const yields: Array<() => void> = []
    const timeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === 0) { yields.push(callback); return 0 }
      return timeout(callback, delay)
    }) as typeof setTimeout)
    const items = [
      ...records('First prompt', 'Early outcome'),
      ...Array.from({ length: 6 }, (_, index) => records(`Later prompt ${index}`, `Later answer ${index}`)).flat(),
    ]
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await microtasks()
    yields.shift()!()
    await microtasks()
    await tick()
    // The first two records have reached the model; later records are held at a decoder yield.
    band.openAtMessage('Early outcome')
    await tick()
    expect(band.el.querySelector('.ws-transcript-outcome')?.textContent).toContain('Early outcome')
    for (let index = 0; index < items.length; index++) {
      yields.shift()?.()
      await microtasks()
    }
    await settle()
    await tick()
    expect(band.el.querySelector('.ws-transcript-outcome')).toBeNull()
    expect(band.el.querySelector('.ws-transcript-pane [data-turn="0"]')?.textContent).toContain('Early outcome')
  })

  it.each([404, 202, 503])('reads the full outcome even when the initial transcript response is %s', async (status) => {
    const band = makeBand(vi.fn<typeof fetch>(async () => new Response('', { status })))
    band.follow(target(latestId))
    band.openAtMessage('Independently authored **outcome**.')
    await settle()
    await tick()
    expect(band.el.querySelector('.ws-transcript-outcome')?.textContent).toContain('Independently authored outcome.')
    expect(band.el.querySelector('.ws-transcript-outcome strong')?.textContent).toBe('outcome')
  })

  it('retains a requested outcome until an in-flight read delivers its message', async () => {
    let deliver!: (response: Response) => void
    const bytes = encoded(records('Initial prompt', 'Initial answer'))
    const more = encoded(records('Next prompt', 'Delayed outcome'))
    let reads = 0
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (++reads === 1) return new Response(new TextDecoder().decode(bytes), { headers: { 'x-transcript-offset': '0', 'x-transcript-byte-count': String(bytes.length) } })
      return new Promise<Response>(resolve => { deliver = resolve })
    })
    const band = makeBand(fetcher)
    band.follow(target(latestId))
    await settle()
    band.follow(target(latestId, { live: true }))
    await microtasks()
    band.openAtMessage('Delayed outcome')
    await tick()
    expect(band.el.querySelector('.ws-transcript-outcome')?.textContent).toContain('Delayed outcome')
    const scroller = band.el.querySelector<HTMLElement>('.ws-transcript-scroll')!
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: this.classList.contains('ws-transcript-msg-agent') && this.textContent?.includes('Delayed outcome') ? 300 : 0 } as DOMRect
    })
    deliver(new Response(new TextDecoder().decode(more), { headers: { 'x-transcript-offset': String(bytes.length), 'x-transcript-byte-count': String(bytes.length + more.length) } }))
    await settle()
    await tick()
    expect(scroller.scrollTop).toBeGreaterThan(250)
    expect(band.el.querySelector('.ws-transcript-pane')?.textContent).toContain('Delayed outcome')
    expect(band.el.querySelector('.ws-transcript-outcome')).toBeNull()
  })

  it('shows stopped-session warmth and context, and expires while folded without polling', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-09T13:52:00Z'))
    const fetcher = fixtureFetch({ [latestId]: [captured(claudeUsage)[0]] })
    const band = makeBand(fetcher)
    band.follow(target(latestId))
    await settle()
    const cache = band.el.querySelector<HTMLElement>('.ws-transcript-cache')!
    expect(cache.hidden).toBe(false)
    expect(cache.title).toMatch(/^Cache warm until \d\d:\d\d/)
    expect(cache.dataset.cache).toBe('warm')
    const left = Number(cache.style.getPropertyValue('--ws-cache-left'))
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThanOrEqual(1)
    // Claude records no window: its context is read against a million tokens.
    const context = band.el.querySelector<HTMLElement>('.ws-transcript-context')!
    expect(context.textContent).toBe('53.3k')
    expect(context.title).toContain('1,000,000-token window')
    expect(context.style.color).toContain('5%')
    // Each figure says what it is: the window's share and the session's cache share.
    const share = band.el.querySelector<HTMLElement>('.ws-transcript-share')!
    expect([share.hidden, share.textContent]).toEqual([false, '5% ctx'])
    const hit = band.el.querySelector<HTMLElement>('.ws-transcript-hit')!
    expect([hit.hidden, hit.textContent]).toEqual([false, '49% cached'])
    expect(hit.title).toBe('This session read 49% of its context tokens from the prompt cache (26,331 of 53,327)')
    vi.advanceTimersByTime(60_000)
    expect(Number(cache.style.getPropertyValue('--ws-cache-left'))).toBeLessThan(left)
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-head')!.click()
    vi.advanceTimersByTime(3_600_000)
    expect(cache.title).toMatch(/^Cache cold since \d\d:\d\d/)
    expect(cache.dataset.cache).toBe('cold')
    expect(cache.style.getPropertyValue('--ws-cache-left')).toBe('0')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('tells its owner when the facts change and says how long the shown session\'s cache stays warm', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-09T13:52:00Z'))
    const onFacts = vi.fn()
    const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fixtureFetch({ [latestId]: [captured(claudeUsage)[0]] }), onFacts })
    bands.push(band); document.body.append(band.el)
    expect(band.cacheWarm(latestId)).toBeUndefined()
    band.follow(target(latestId))
    await settle()
    expect(onFacts).toHaveBeenCalled()
    const until = band.cacheWarm(latestId)!
    expect(until).toBeGreaterThan(Date.now())
    // Another session's warmth is not this one's.
    expect(band.cacheWarm(earlierId)).toBeUndefined()
    onFacts.mockClear()
    vi.advanceTimersByTime(until - Date.now() + 1)
    expect(onFacts).toHaveBeenCalled()
    expect(band.cacheWarm(latestId)).toBeUndefined()
  })

  it('shows already cold cache, resets facts on target change and clears expiry on dispose', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-09T16:00:00Z'))
    const band = makeBand(fixtureFetch({ [latestId]: [captured(claudeUsage)[0]], [earlierId]: records('Hello', 'Hi') }))
    band.follow(target(latestId))
    await settle()
    expect(band.el.querySelector('.ws-transcript-cache')?.getAttribute('aria-label')).toMatch(/^Cache cold since /)
    band.read(target(earlierId))
    await settle()
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-cache')!.hidden).toBe(true)
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-context')!.hidden).toBe(true)
    vi.setSystemTime(new Date('2026-10-09T13:52:00Z'))
    band.read(target(latestId))
    await settle()
    expect(vi.getTimerCount()).toBe(1)
    band.follow(null)
    // A pinned read survives follow(null); disposal still owns its expiry timer.
    band.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows Codex recorded context/window and Pi context without cache or an invented window', async () => {
    const band = makeBand(fixtureFetch({ [latestId]: [captured(codexUsage)[0]], [earlierId]: [captured(piUsage)[0]] }))
    band.follow(target(latestId))
    await settle()
    const context = band.el.querySelector<HTMLElement>('.ws-transcript-context')!
    expect(context.textContent).toBe('20.9k')
    expect(context.style.color).toContain('8%')
    expect(context.title).toContain('258,400-token window')
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-cache')!.hidden).toBe(true)
    band.read(target(earlierId))
    await settle()
    // Pi records no window and is no Claude model: the count stands untinted.
    expect(context.textContent).toBe('16.8k')
    expect(context.style.color).toBe('')
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-cache')!.hidden).toBe(true)
  })

  it('keeps Context hidden through a streamed Codex reset placeholder until genuine usage arrives', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const [compacted, placeholder, genuine] = captured(codexResetUsage)
    const items = [captured(codexUsage)[0], compacted]
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId, { live: true }))
    await settle()
    const context = band.el.querySelector<HTMLElement>('.ws-transcript-context')!
    expect(context.hidden).toBe(true)
    items.push(placeholder)
    vi.advanceTimersByTime(3000)
    await settle()
    expect(context.hidden).toBe(true)
    expect(context.textContent).toBe('')
    items.push(genuine)
    vi.advanceTimersByTime(3000)
    await settle()
    expect(context.hidden).toBe(false)
    expect(context.textContent).toBe('43k')
  })

  it('omits stale context after compaction without post usage and omits both facts without usage', async () => {
    const band = makeBand(fixtureFetch({ [latestId]: captured(piUsage), [earlierId]: records('Hello', 'Hi') }))
    band.follow(target(latestId))
    await settle()
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-context')!.hidden).toBe(true)
    band.read(target(earlierId))
    await settle()
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-context')!.hidden).toBe(true)
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-cache')!.hidden).toBe(true)
  })

  it('shows the last exchange as words only: the prompt and every agent message since, no tools or thinking', async () => {
    const items = [
      ...records('Inspect the first mask split.', 'Earlier report.'),
      { type: 'user', timestamp: '2026-09-26T14:20:00.000Z', message: { content: 'Check the response again.' } },
      { type: 'assistant', timestamp: '2026-09-26T14:21:00.000Z', message: { model: 'claude-opus', content: [
        { type: 'text', text: 'Starting with the bins.' },
        { type: 'thinking', thinking: 'Private reasoning.' },
        { type: 'tool_use', id: 'call-2', name: 'Bash', input: { command: 'pytest -q' } },
      ] } },
      { type: 'user', timestamp: '2026-09-26T14:22:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'ok' }] } },
      { type: 'assistant', timestamp: '2026-09-26T14:23:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'All **bins** pass.' }] } },
    ]
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await settle()

    const preview = band.el.querySelector<HTMLElement>('.ws-transcript-preview')!
    expect(preview.hidden).toBe(false)
    const messages = [...preview.querySelectorAll<HTMLElement>('.ws-transcript-msg')]
    expect(messages.map((node) => node.classList.contains('ws-transcript-msg-agent') ? 'agent' : 'you')).toEqual(['you', 'agent', 'agent'])
    expect(messages[0].textContent).toContain('Check the response again.')
    expect(messages[1].textContent).toContain('Starting with the bins.')
    expect(messages[2].querySelector('strong')?.textContent).toBe('bins')
    expect(preview.textContent).not.toContain('Earlier report.')
    expect(preview.textContent).not.toContain('pytest')
    expect(preview.textContent).not.toContain('Private reasoning')
    expect(preview.querySelector('.ws-transcript-steps, .ws-transcript-tool')).toBeNull()
    expect(band.el.querySelector('.ws-transcript-turn')).toBeNull()
  })

  it('opens the whole session in a pane over the page content, with each run opening onto its tools and thinking', async () => {
    const output = Array.from({ length: 48 }, (_, index) => `response-bin-${index + 1}`).join('\n')
    const answer = `# Calibration\n\nThe null test is consistent with $\\chi^2$.\n\n[unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>\n\n${output}`
    const items = [
      ...records('Inspect the first mask split.', 'Earlier report.'),
      ...records('You are a Shuttle worker for shear calibration.', answer, true),
    ]
    ;((items[4] as { message: { content: Array<{ content: string }> } }).message.content[0]).content = output
    const requests: string[] = []
    const band = makeBand(fixtureFetch({ [latestId]: items }, requests))
    band.follow(target(latestId))
    await settle()

    expect(requests[0]).toContain(`/api/v1/transcript/raw?session=${latestId}&offset=0&host=candide`)
    expect(band.el.hidden).toBe(false)
    const content = document.createElement('div')
    content.className = 'ws-content'
    document.body.append(content)
    content.append(band.el)
    expect(document.querySelector('.ws-transcript-pane')).toBeNull()
    band.el.querySelector<HTMLElement>('.ws-transcript-preview')!.click()
    await settle()
    const dialog = document.querySelector<HTMLElement>('.ws-transcript-pane')!
    expect(dialog.parentElement).toBe(content)
    expect(dialog.hidden).toBe(false)
    expect(band.el.querySelector('.ws-transcript-open-full')?.getAttribute('aria-expanded')).toBe('true')

    expect(dialog.querySelectorAll('.ws-transcript-turn')).toHaveLength(2)
    const last = dialog.querySelectorAll<HTMLElement>('.ws-transcript-turn')[1]
    expect(last.querySelector('.ws-transcript-prompt-text')?.textContent).toContain('You are a Shuttle worker')
    // The dispatch folds behind one line that opens and closes it.
    const brief = last.querySelector<HTMLElement>('.ws-transcript-msg-brief')!
    const kicker = brief.querySelector<HTMLElement>('.ws-transcript-kicker')!
    expect(kicker.textContent).toContain('Session brief')
    expect(kicker.getAttribute('role')).toBe('button')
    expect(kicker.getAttribute('aria-expanded')).toBe('false')
    expect(brief.classList.contains('ws-transcript-brief-open')).toBe(false)
    kicker.click()
    expect(kicker.getAttribute('aria-expanded')).toBe('true')
    expect(brief.classList.contains('ws-transcript-brief-open')).toBe(true)
    kicker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(brief.classList.contains('ws-transcript-brief-open')).toBe(false)
    const prose = last.querySelector('.ws-transcript-msg-agent')!
    expect(prose.textContent).toContain('Calibration')
    expect(prose.innerHTML).not.toContain('<img')
    expect(prose.innerHTML).not.toContain('javascript:')
    expect(dialog.querySelector('.ws-transcript-steplist')).toBeNull()

    const steps = last.querySelector<HTMLButtonElement>('.ws-transcript-steps')!
    expect(steps.textContent).toBe('▸ 1 step · 11m · Bash 1')
    steps.click()
    expect(dialog.querySelectorAll('.ws-transcript-steplist')).toHaveLength(1)
    const tool = dialog.querySelector<HTMLButtonElement>('.ws-transcript-tool-line')!
    expect(tool.textContent).toContain('Bash')
    expect(tool.getAttribute('aria-expanded')).toBe('true')
    const detail = tool.parentElement?.querySelector<HTMLElement>('.ws-transcript-tool-detail')!
    expect(detail.textContent).toContain('git log --oneline -5')
    expect(detail.querySelector('.ws-transcript-output')?.classList.contains('ws-transcript-error')).toBe(true)
    expect(detail.querySelector('.ws-transcript-output')?.textContent).toContain('response-bin-40')
    expect(detail.querySelector('.ws-transcript-output')?.textContent).not.toContain('response-bin-48')
    const showAll = detail.querySelector<HTMLButtonElement>('.ws-transcript-showall')!
    expect(showAll.textContent).toBe('Show all 48 lines')
    showAll.click()
    expect(detail.querySelector('.ws-transcript-output')?.textContent).toContain('response-bin-48')

    tool.click()
    expect(detail.hidden).toBe(true)

    dialog.querySelector<HTMLButtonElement>('.ws-transcript-close')!.click()
    expect(dialog.isConnected).toBe(false)
    expect(dialog.querySelector('.ws-transcript-turn')).toBeNull()
  })

  it('pages earlier turns inside the pane, never in the page', async () => {
    const items = Array.from({ length: 20 }, (_, index) => records(`Prompt ${index}`, `Answer ${index}.`)).flat()
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()
    const dialog = band.el.querySelector<HTMLElement>('.ws-transcript-pane')!
    expect(dialog.querySelectorAll('.ws-transcript-turn')).toHaveLength(3)
    const earlier = dialog.querySelector<HTMLButtonElement>('.ws-transcript-earlier')!
    expect(earlier.textContent).toBe('▴ 12 earlier turns')
    earlier.click()
    expect(dialog.querySelectorAll('.ws-transcript-turn')).toHaveLength(15)
    expect(earlier.textContent).toBe('▴ 5 earlier turns')
    expect(band.el.querySelector('.ws-transcript-preview')?.textContent).toContain('Answer 19.')
    expect(band.el.querySelector('.ws-transcript-preview')?.textContent).not.toContain('Answer 18.')
  })

  it('marks a live worker at work after its last message, and Escape in the pane closes it alone', async () => {
    const items = records('Run the suite.', 'unused', true).slice(0, 3)
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId, { live: true }))
    await settle()
    const preview = band.el.querySelector<HTMLElement>('.ws-transcript-preview')!
    expect(preview.querySelector('.ws-transcript-working')).not.toBeNull()
    expect(preview.textContent).not.toContain('git log')
    band.follow(target(latestId, { live: false }))
    await settle()
    expect(preview.querySelector('.ws-transcript-working')).toBeNull()

    const outside = vi.fn()
    window.addEventListener('keydown', outside)
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    const pane = band.el.querySelector<HTMLElement>('.ws-transcript-pane')!
    expect(document.activeElement).toBe(pane.querySelector('.ws-transcript-scroll'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }))
    expect(outside).toHaveBeenCalledTimes(1)
    pane.querySelector('.ws-transcript-scroll')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(pane.isConnected).toBe(false)
    expect(outside).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', outside)
  })

  it('sets a paste apart as a quoted block, with no wrapper markup', async () => {
    const items = [
      { type: 'user', timestamp: '2026-09-26T14:02:00.000Z', message: { content: 'Read this note.\n\n<pasted_content id="6629">\nThe mask split is fine.\nKeep the bins.\n</pasted_content>\n\nThen decide.' } },
      { type: 'assistant', timestamp: '2026-09-26T14:03:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'Decided.' }] } },
    ]
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await settle()
    const prompt = band.el.querySelector<HTMLElement>('.ws-transcript-preview .ws-transcript-prompt-text')!
    expect(prompt.textContent).not.toContain('pasted_content')
    expect(prompt.querySelector('.ws-transcript-pasted')?.textContent).toContain('The mask split is fine.')
    expect(prompt.querySelector('.ws-transcript-pasted-label')?.textContent).toBe('pasted · 2 lines')
    expect(prompt.textContent).toContain('Read this note.')
    expect(prompt.textContent).toContain('Then decide.')
  })

  it('keeps the last good words through a failed poll, and says so only for a transcript never read', async () => {
    vi.useFakeTimers()
    const bytes = encoded(records('Run it.', 'First result.'))
    let fail = false
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (fail) return new Response('boom', { status: 500 })
      const offset = Number(new URL(String(input)).searchParams.get('offset'))
      return new Response(bytes.slice(offset), { headers: { 'x-transcript-offset': String(offset) } })
    })
    const band = makeBand(fetcher)
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    expect(band.el.textContent).toContain('First result.')
    fail = true
    await vi.advanceTimersByTimeAsync(4000)
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-note')?.hidden).toBe(true)
    expect(band.el.textContent).toContain('First result.')

    const fresh = makeBand(vi.fn<typeof fetch>(async () => new Response('boom', { status: 500 })))
    fresh.follow(target(earlierId))
    await vi.advanceTimersByTimeAsync(50)
    expect(fresh.el.querySelector('.ws-transcript-note')?.textContent).toBe('The transcript could not be read.')
  })

  it('opens a run onto its thinking text', async () => {
    const items = [
      { type: 'user', timestamp: '2026-09-26T14:02:00.000Z', message: { content: 'Think first.' } },
      { type: 'assistant', timestamp: '2026-09-26T14:03:00.000Z', message: { model: 'claude-opus', content: [
        { type: 'thinking', thinking: 'The bins at high ell carry the signal.' },
        { type: 'text', text: 'Done thinking.' },
      ] } },
    ]
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()
    const pane = band.el.querySelector<HTMLElement>('.ws-transcript-pane')!
    pane.querySelector<HTMLButtonElement>('.ws-transcript-steps')!.click()
    const thinking = pane.querySelector<HTMLElement>('.ws-transcript-thinking-text')!
    expect(thinking.hidden).toBe(false)
    expect(thinking.textContent).toBe('The bins at high ell carry the signal.')
  })

  it('puts the open pane back when the page re-seats the band in a fresh prose page', async () => {
    const band = makeBand(fixtureFetch({ [latestId]: records('Prompt', 'Answer.') }))
    const content = document.createElement('div')
    content.className = 'ws-content'
    document.body.append(content)
    content.append(band.el)
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    const pane = content.querySelector<HTMLElement>('.ws-transcript-pane')!
    const fresh = document.createElement('div')
    fresh.append(band.el)
    content.replaceChildren(fresh)
    expect(pane.isConnected).toBe(false)
    band.reseated()
    expect(pane.parentElement).toBe(content)
    expect(pane.querySelector('.ws-transcript-turn')).not.toBeNull()
  })

  it('pins a History session and returns to the latest runtime session', async () => {
    const requests: string[] = []
    const fetcher = fixtureFetch({
      [latestId]: records('Latest prompt', 'Latest word.'),
      [earlierId]: records('Earlier prompt', 'Earlier word.'),
    }, requests)
    const band = makeBand(fetcher)
    band.follow(target(latestId))
    await settle()
    band.read(target(earlierId, { agent: 'pi' }))
    await settle()

    expect(band.el.querySelector<HTMLButtonElement>('.ws-transcript-latest')?.hidden).toBe(false)
    expect(band.el.querySelector('.ws-transcript-reading')?.textContent).toMatch(/^pi · /)
    expect(band.el.textContent).toContain('Earlier word.')
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-latest')!.click()
    await settle()
    expect(band.el.querySelector<HTMLButtonElement>('.ws-transcript-latest')?.hidden).toBe(true)
    expect(band.el.textContent).toContain('Latest word.')
    expect(requests.map((url) => new URL(url).searchParams.get('session'))).toEqual([latestId, earlierId, latestId])
  })

  it('streams visible live entries without raw polls, including when the full pane opens', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.raw()).toHaveLength(1)
    expect(fixture.streams).toHaveLength(1)
    const stream = fixture.streams[0]
    expect(new URL(fixture.requests.find(url => url.includes('/stream'))!).searchParams.get('offset'))
      .toBe(String(encoded(records('Initial prompt', 'Initial answer')).length))
    fixture.append(records('Streamed prompt', 'Streamed answer'))
    await vi.advanceTimersByTimeAsync(50)
    expect(band.el.textContent).toContain('Streamed answer')
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    for (let i = 0; i < 4; i++) {
      stream.controller.enqueue(new TextEncoder().encode(': keepalive\n\n'))
      await vi.advanceTimersByTimeAsync(15_000)
    }
    expect(fixture.raw()).toHaveLength(1)
    expect(fixture.streams).toHaveLength(1)
    expect(stream.signal.aborted).toBe(false)
  })

  it.each(['fold', 'hidden', 'offscreen', 'dispose'] as const)('aborts following on %s and resumes with catch-up when visible', async (reason) => {
    vi.useFakeTimers()
    let intersect!: (entries: { isIntersecting: boolean }[]) => void
    if (reason === 'offscreen') {
      vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: typeof intersect) { intersect = callback }
        observe() {} disconnect() {}
      })
    }
    try {
      const fixture = streamFixture()
      const band = makeBand(fixture.fetcher)
      band.follow(target(latestId, { live: true }))
      if (reason === 'offscreen') intersect([{ isIntersecting: true }])
      await vi.advanceTimersByTimeAsync(50)
      const stream = fixture.streams[0]
      const head = band.el.querySelector<HTMLButtonElement>('.ws-transcript-head')!
      const visibility = vi.spyOn(document, 'visibilityState', 'get')
      if (reason === 'fold') head.click()
      else if (reason === 'hidden') {
        visibility.mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      } else if (reason === 'offscreen') intersect([{ isIntersecting: false }])
      else band.dispose()
      expect(stream.signal.aborted).toBe(true)
      // Resume before the aborted stream's promise has settled.
      if (reason === 'fold') head.click()
      else if (reason === 'hidden') {
        visibility.mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
      } else if (reason === 'offscreen') intersect([{ isIntersecting: true }])
      await vi.advanceTimersByTimeAsync(50)
      expect(fixture.raw()).toHaveLength(reason === 'dispose' ? 1 : 2)
      expect(fixture.streams).toHaveLength(reason === 'dispose' ? 1 : 2)
    } finally { vi.unstubAllGlobals() }
  })

  it('aborts a parked worker stream and makes exactly one final raw read', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    fixture.append(records('Last prompt', 'Last answer'))
    await microtasks()
    band.follow(target(latestId))
    expect(fixture.streams[0].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fixture.raw()).toHaveLength(2)
    expect(fixture.streams).toHaveLength(1)
    expect(band.el.textContent).toContain('Last answer')
    expect(new URL(fixture.raw()[1]).searchParams.get('offset')).not.toBe('0')
  })

  it('waits for a time-sliced stream event to commit before the parked final read', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => clock.mock.calls.length * 10)
    const extra = records('Final prompt', 'Final answer')
    fixture.append(extra)
    await microtasks() // The first decoded record yields to a timer; the event is not committed yet.
    band.follow(target(latestId))
    expect(fixture.raw()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.raw()).toHaveLength(2)
    const expectedOffset = encoded(records('Initial prompt', 'Initial answer')).length + encoded(extra).length
    expect(new URL(fixture.raw()[1]).searchParams.get('offset')).toBe(String(expectedOffset))
    expect(band.el.textContent).toContain('Final answer')
  })

  it('ignores an old stream ending after switching targets', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    band.follow(target(earlierId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.streams[0].signal.aborted).toBe(true)
    expect(fixture.streams[1].signal.aborted).toBe(false)
    expect(fixture.raw()).toHaveLength(2)
    expect(fixture.streams).toHaveLength(2)
    fixture.append(records('New session prompt', 'New session answer'))
    await vi.advanceTimersByTimeAsync(50)
    expect(band.el.textContent).toContain('New session answer')
  })

  it('polls an unsupported target without retrying its stream, and tries a new target', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    fixture.status(501)
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.raw()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fixture.requests.filter(url => url.includes('/transcript/stream'))).toHaveLength(1)
    fixture.status(200)
    band.follow(target(earlierId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.streams).toHaveLength(1)
  })

  it.each([429, 503])('polls after HTTP %i and retries streams with exponential backoff', async status => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    fixture.status(status)
    const band = makeBand(fixture.fetcher)
    const attempts = () => fixture.requests.filter(url => url.includes('/transcript/stream')).length
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    expect(attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.raw()).toHaveLength(2)
    expect(attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.raw()).toHaveLength(3)
    expect(attempts()).toBe(2) // The second failure waits four seconds before another attempt.
    fixture.status(200)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.streams).toHaveLength(1)
  })

  it.each(['upstream_error', 'upstream_idle'])('backs off repeated %s events instead of reconnecting immediately', async error => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    const fail = (): void => {
      const stream = fixture.streams.at(-1)!
      stream.controller.enqueue(new TextEncoder().encode(`\nevent: error\ndata: {"error":"${error}"}\n\n`))
      stream.controller.close()
    }
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    fail()
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.raw()).toHaveLength(2)
    expect(fixture.streams).toHaveLength(2)
    fail()
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(fixture.raw()).toHaveLength(3)
    expect(fixture.streams).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.streams).toHaveLength(3)
  })

  it('reconnects a closed stream from its offset and catches up from zero after reset', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true }))
    await vi.advanceTimersByTimeAsync(50)
    fixture.append(records('Appended', 'Appended answer'))
    await vi.advanceTimersByTimeAsync(50)
    fixture.streams[0].controller.close()
    await microtasks()
    expect(fixture.streams).toHaveLength(2)
    expect(fixture.raw()).toHaveLength(1)
    fixture.reset()
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.raw()).toHaveLength(2)
    expect(new URL(fixture.raw()[1]).searchParams.get('offset')).toBe('0')
    expect(fixture.streams).toHaveLength(3)
    expect(band.el.textContent).toContain('Replacement answer')
    expect(band.el.textContent).not.toContain('Appended answer')
  })

  it('refreshes sent files 1.5 seconds after connecting or receiving streamed entries', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true, uid: 'task-uid' }))
    await vi.advanceTimersByTimeAsync(50)
    expect(fixture.sent()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1450)
    expect(fixture.sent()).toHaveLength(2)
    fixture.files([send('/tmp/stream-result.html', Date.parse('2026-09-26T14:15:00Z'))])
    fixture.append(records('Send the file', 'Here is the result'))
    await microtasks()
    await vi.advanceTimersByTimeAsync(1499)
    expect(fixture.sent()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(51)
    expect(fixture.sent()).toHaveLength(3)
    expect(band.el.textContent).toContain('stream-result.html')
    expect(fixture.raw()).toHaveLength(1)
  })

  it('debounces sent-file refreshes after the last streamed append so its projection can settle', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true, uid: 'task-uid' }))
    await vi.advanceTimersByTimeAsync(1400)
    fixture.append(records('Sending a report', 'Report sent'))
    await microtasks()
    await vi.advanceTimersByTimeAsync(100)
    expect(fixture.sent()).toHaveLength(1) // The connect-time refresh must move behind the append.
    await vi.advanceTimersByTimeAsync(500)
    fixture.files([send('/tmp/debounced-report.html', Date.parse('2026-09-26T14:15:00Z'))])
    await vi.advanceTimersByTimeAsync(899)
    expect(fixture.sent()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(51)
    expect(fixture.sent()).toHaveLength(2)
    expect(band.el.textContent).toContain('debounced-report.html')
  })

  it('preserves the delayed sent-file refresh when parking precedes receipt projection', async () => {
    vi.useFakeTimers()
    const fixture = streamFixture()
    const band = makeBand(fixture.fetcher)
    band.follow(target(latestId, { live: true, uid: 'task-uid' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fixture.sent()).toHaveLength(2)
    fixture.append(records('Sending the final report', 'Final report sent'))
    await microtasks()
    await vi.advanceTimersByTimeAsync(200)
    band.follow(target(latestId, { uid: 'task-uid' }))
    await microtasks()
    expect(fixture.sent()).toHaveLength(3) // The immediate final read predates the receipt projection.
    await vi.advanceTimersByTimeAsync(400)
    fixture.files([send('/tmp/parked-report.html', Date.parse('2026-09-26T14:15:00Z'))])
    await vi.advanceTimersByTimeAsync(950)
    expect(fixture.sent()).toHaveLength(4)
    expect(band.el.textContent).toContain('parked-report.html')
    expect(fixture.raw()).toHaveLength(2)
  })

  it('reads immediately when unfolded, polls only while live, and stops polling when folded', async () => {
    vi.useFakeTimers()
    const requests: string[] = []
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      requests.push(String(input))
      const offset = Number(new URL(String(input)).searchParams.get('offset'))
      return new Response(new Uint8Array(), { headers: { 'x-transcript-offset': String(offset) } })
    })
    const band = makeBand(fetcher)
    band.follow(target(latestId, { live: true }))
    await microtasks()
    const rawReads = () => requests.filter(url => url.includes('/transcript/raw')).length
    expect(rawReads()).toBe(1)

    await vi.advanceTimersByTimeAsync(4500)
    expect(rawReads()).toBe(2)
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-head')!.click()
    expect(band.el.querySelector('.ws-transcript-head')?.getAttribute('aria-expanded')).toBe('false')
    const stoppedAt = rawReads()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(rawReads()).toBe(stoppedAt)

    band.el.querySelector<HTMLButtonElement>('.ws-transcript-head')!.click()
    await microtasks()
    expect(rawReads()).toBe(stoppedAt + 1)
  })
})
