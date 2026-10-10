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

afterEach(() => {
  for (const band of bands) band.dispose()
  bands = []
  document.body.replaceChildren()
  try { localStorage.removeItem('shuttle.transcript.folded') } catch { /* unavailable */ }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TranscriptBand', () => {
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
    vi.advanceTimersByTime(60_000)
    expect(Number(cache.style.getPropertyValue('--ws-cache-left'))).toBeLessThan(left)
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-head')!.click()
    vi.advanceTimersByTime(3_600_000)
    expect(cache.title).toMatch(/^Cache cold since \d\d:\d\d/)
    expect(cache.dataset.cache).toBe('cold')
    expect(cache.style.getPropertyValue('--ws-cache-left')).toBe('0')
    expect(fetcher).toHaveBeenCalledTimes(1)
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
    expect(last.querySelector('.ws-transcript-kicker')?.textContent).toContain('dispatch')
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
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4500)
    expect(fetcher).toHaveBeenCalledTimes(2)
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-head')!.click()
    expect(band.el.querySelector('.ws-transcript-head')?.getAttribute('aria-expanded')).toBe('false')
    const stoppedAt = fetcher.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetcher).toHaveBeenCalledTimes(stoppedAt)

    band.el.querySelector<HTMLButtonElement>('.ws-transcript-head')!.click()
    await microtasks()
    expect(fetcher).toHaveBeenCalledTimes(stoppedAt + 1)
  })
})
