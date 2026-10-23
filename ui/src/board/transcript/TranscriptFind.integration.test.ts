// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptBand } from './TranscriptBand.js'

const here = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
const elsewhere = 'b4edf873-cb1c-40ab-a891-f26f5333b321'

const stamp = (minute: number): string => new Date(Date.UTC(2026, 9, 20, 14, minute)).toISOString()
/** Thirty turns; the convention is discussed in the second, the twelfth and the last. */
const long = (): unknown[] => Array.from({ length: 30 }, (_, i) => {
  const word = i === 1 ? 'We settle the VMPZ convention here.' : i === 11 ? 'vmpz convention, again, with a caveat.' : i === 29 ? 'Last word on the vmpz convention.' : `Step ${i} of the work.`
  return [
    { type: 'user', timestamp: stamp(i * 2), message: { content: `Prompt ${i}` } },
    { type: 'assistant', timestamp: stamp(i * 2 + 1), message: { model: 'claude-opus', content: [{ type: 'text', text: word }] } },
  ]
}).flat()
const other = (): unknown[] => [
  { type: 'user', timestamp: stamp(0), message: { content: 'Unrelated opening.' } },
  { type: 'assistant', timestamp: stamp(1), message: { model: 'claude-opus', content: [{ type: 'text', text: 'Early: nothing of note.' }] } },
  { type: 'user', timestamp: stamp(40), message: { content: 'Now the vmpz conventions please.' } },
  { type: 'assistant', timestamp: stamp(41), message: { model: 'claude-opus', content: [{ type: 'text', text: 'The vmpz conventions are set out below.' }] } },
]

const encoded = (items: unknown[]): Uint8Array => new TextEncoder().encode(items.map((item) => JSON.stringify(item)).join('\n') + '\n')
const searchHit = {
  session: elsewhere, harness: 'claude', project: '/Users/x/dev/felt', path: '/Users/x/.claude/projects/p/b4ed.jsonl', line: 3,
  timestamp: stamp(41), role: 'assistant', score: 9.1, snippet: 'The «vmpz» «conventions» are set out', fibers: [{ id: 'ai/felt/vmpz', name: 'Fix the VMPZ convention' }],
}
const calls: string[] = []
const routed = (reply: () => Response = () => new Response(JSON.stringify({ query: 'vmpz convention', index: { sessions: 12, updated_at: stamp(30) }, hits: [searchHit], errors: [] }))): typeof fetch =>
  vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'http://localhost:4000')
    calls.push(url.pathname + url.search)
    if (url.pathname.endsWith('/transcripts/search')) return reply()
    const bytes = encoded(url.searchParams.get('session') === here ? long() : other())
    const offset = Number(url.searchParams.get('offset') ?? 0)
    return new Response(bytes.slice(offset), { status: 200, headers: { 'x-transcript-offset': String(offset), 'x-transcript-byte-count': String(bytes.byteLength) } })
  })

const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) }
let bands: TranscriptBand[] = []
const open = async (fetcher: typeof fetch): Promise<{ band: TranscriptBand; input: HTMLInputElement; count: HTMLElement }> => {
  const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fetcher, inline: true })
  bands.push(band)
  document.body.append(band.el)
  band.follow({ session: here, host: 'h', agent: 'claude-opus', live: false, at: Date.parse(stamp(0)) })
  await settle()
  return { band, input: band.el.querySelector<HTMLInputElement>('.ws-transcript-find-input')!, count: band.el.querySelector<HTMLElement>('.ws-transcript-find-count')! }
}
const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 160))
  await settle()
}
const press = (target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  for (const band of bands) band.dispose()
  bands = []
  calls.length = 0
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('finding words in the open transcript', () => {
  it('counts matches across turns that are not drawn yet, draws the one it stands on, and marks the words', async () => {
    const { band, input, count } = await open(routed())
    expect(band.el.querySelectorAll('.ws-transcript-turn')).toHaveLength(8)
    await type(input, 'VMPZ convention')
    expect(count.textContent).toMatch(/^\d of 3$/)
    expect(band.el.querySelectorAll('.ws-transcript-found')).toHaveLength(1)
    const marks = [...band.el.querySelectorAll('mark.ws-transcript-found-mark')].map((mark) => mark.textContent?.toLowerCase())
    expect(marks.length).toBeGreaterThanOrEqual(2)
    expect(new Set(marks)).toEqual(new Set(['vmpz', 'convention']))
  })

  it('steps forward and back around the matches, drawing earlier turns as needed', async () => {
    const { band, input, count } = await open(routed())
    await type(input, 'vmpz convention')
    const standing = (): string => (band.el.querySelector('.ws-transcript-found')?.textContent ?? '').replace(/^.*?(?=[A-Zv])/, '')
    const first = standing()
    const order = [first]
    for (let i = 0; i < 2; i++) { press(input, 'Enter'); order.push(standing()) }
    expect(new Set(order).size).toBe(3)
    expect(order.join('|')).toMatch(/settle the VMPZ convention/)
    expect(order.join('|')).toMatch(/again, with a caveat/)
    expect(order.join('|')).toMatch(/Last word/)
    expect(band.el.querySelectorAll('.ws-transcript-turn').length).toBeGreaterThan(8)
    press(input, 'Enter')
    expect(standing()).toBe(first)
    press(input, 'Enter', { shiftKey: true })
    expect(standing()).toBe(order[2])
    expect(count.textContent).toMatch(/^\d of 3$/)
  })

  it('reports no matches, and Escape clears the marks, the count and the field', async () => {
    const { band, input, count } = await open(routed())
    await type(input, 'vmpz')
    expect(band.el.querySelectorAll('mark.ws-transcript-found-mark').length).toBeGreaterThan(0)
    await type(input, 'zzzz')
    expect(count.textContent).toBe('no matches')
    expect(band.el.querySelector('mark.ws-transcript-found-mark')).toBeNull()
    await type(input, 'vmpz')
    const escape = press(input, 'Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(input.value).toBe('')
    expect(count.textContent).toBe('')
    expect(band.el.querySelector('mark.ws-transcript-found-mark')).toBeNull()
    expect(band.el.querySelector('.ws-transcript-found')).toBeNull()
  })

  it('takes Ctrl-F inside the transcript, and leaves it to the browser outside it', async () => {
    const { band, input } = await open(routed())
    const scroller = band.el.querySelector<HTMLElement>('.ws-transcript-scroll')!
    scroller.focus()
    expect(press(scroller, 'f', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input)
    input.blur()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(press(outside, 'f', { ctrlKey: true }).defaultPrevented).toBe(false)
  })
})

describe('searching every transcript', () => {
  const run = async (input: HTMLInputElement): Promise<void> => {
    await type(input, 'vmpz convention')
    press(input, 'Enter', { metaKey: true })
    await vi.waitFor(() => expect(document.querySelector('.ws-transcript-find-hit')).not.toBeNull())
  }

  it('lists hits with their snippet marks, harness, project, age and fibers, and asks the daemon once', async () => {
    const { band, input } = await open(routed())
    await run(input)
    const requests = calls.filter((call) => call.includes('/transcripts/search'))
    expect(requests).toHaveLength(1)
    expect(new URL(requests[0], 'http://x').searchParams.get('q')).toBe('vmpz convention')
    const row = band.el.querySelector<HTMLElement>('.ws-transcript-find-hit')!
    expect([...row.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['vmpz', 'conventions'])
    expect(row.querySelector('.ws-transcript-find-meta')?.textContent).toContain('claude · felt')
    expect(row.querySelector('a[data-fiber="ai/felt/vmpz"]')?.textContent).toBe('Fix the VMPZ convention')
    expect(band.el.querySelector('.ws-transcript-find-foot')?.textContent).toContain('12 sessions indexed')
  })

  it('opens the chosen hit\'s session in place and stands on the match nearest the hit', async () => {
    const { band, input, count } = await open(routed())
    await run(input)
    band.el.querySelector<HTMLElement>('.ws-transcript-find-hit')!.click()
    await vi.waitFor(() => expect(calls.some((call) => call.includes(`session=${elsewhere}`))).toBe(true))
    await vi.waitFor(() => expect(band.el.querySelector('.ws-transcript-found')).not.toBeNull())
    expect(band.el.querySelector('.ws-transcript-find-hit')).toBeNull()
    expect(input.value).toBe('vmpz conventions')
    expect(count.textContent).toBe('2 of 2')
    expect(band.el.querySelector('.ws-transcript-found')?.textContent).toContain('set out below')
  })

  it('says so when the daemon fails, rather than showing an empty list', async () => {
    const { band, input } = await open(routed(() => new Response(JSON.stringify({ error: 'shuttle transcript search exited 3', detail: 'index is corrupt' }), { status: 502 })))
    await type(input, 'vmpz')
    press(input, 'Enter', { ctrlKey: true })
    await vi.waitFor(() => expect(band.el.querySelector('.ws-transcript-find-note[data-problem]')).not.toBeNull())
    expect(band.el.querySelector('.ws-transcript-find-note')?.textContent).toContain('index is corrupt')
  })

  it('says so when nothing matches, and hides the list when the words change', async () => {
    const { band, input } = await open(routed(() => new Response(JSON.stringify({ query: 'q', hits: [], errors: [] }))))
    await type(input, 'vmpz')
    press(input, 'Enter', { metaKey: true })
    await vi.waitFor(() => expect(band.el.querySelector('.ws-transcript-find-note')?.textContent).toContain('Nothing in any transcript'))
    await type(input, 'vmpz co')
    expect(band.el.querySelector<HTMLElement>('.ws-transcript-find-results')!.hidden).toBe(true)
  })
})
