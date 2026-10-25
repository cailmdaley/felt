// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptBand } from './TranscriptBand.js'

const here = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
const elsewhere = 'b4edf873-cb1c-40ab-a891-f26f5333b321'
const stamp = (minute: number): string => new Date(Date.UTC(2026, 9, 20, 14, minute)).toISOString()
/** Thirty turns; the convention is discussed in the second, twelfth and last. */
const transcript = (): unknown[] => Array.from({ length: 30 }, (_, i) => [
  { type: 'user', timestamp: stamp(i * 2), message: { content: `Prompt ${i}` } },
  { type: 'assistant', timestamp: stamp(i * 2 + 1), message: { model: 'claude-opus', content: [{ type: 'text', text: [1, 11, 29].includes(i) ? `The vmpz conventions in turn ${i}.` : `Step ${i} of the work.` }] } },
]).flat()
const searchHit = {
  session: elsewhere, harness: 'claude', project: '/Users/x/dev/felt', path: '/Users/x/.claude/projects/p/b4ed.jsonl', line: 3,
  timestamp: stamp(3), role: 'assistant', score: 9.1, matches: 3, snippet: 'The «vmpz» «conventions» in turn 1', fibers: [{ id: 'ai/felt/vmpz', name: 'Fix the VMPZ convention' }],
}
const calls: string[] = []
const routed = (): typeof fetch => vi.fn<typeof fetch>(async input => {
  const url = new URL(String(input), 'http://localhost:4000')
  calls.push(url.pathname + url.search)
  const bytes = new TextEncoder().encode(transcript().map(item => JSON.stringify(item)).join('\n') + '\n')
  const offset = Number(url.searchParams.get('offset') ?? 0)
  return new Response(bytes.slice(offset), { status: 200, headers: { 'x-transcript-offset': String(offset), 'x-transcript-byte-count': String(bytes.byteLength) } })
})
const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => resolve(null))) }
let band: TranscriptBand
const open = async (): Promise<void> => {
  band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: routed(), inline: true })
  document.body.append(band.el)
  band.follow({ session: here, host: 'h', agent: 'claude-opus', live: false, at: Date.parse(stamp(0)) })
  await settle()
}
afterEach(() => { band?.dispose(); calls.length = 0; document.body.replaceChildren(); vi.restoreAllMocks() })

describe('hits opened by the board Find', () => {
  it.each([here, elsewhere])('draws an earlier hit in session %s, marking snippet terms nearest its timestamp', async session => {
    await open()
    expect(band.el.querySelectorAll('.ws-transcript-turn')).toHaveLength(8)
    band.openHit({ ...searchHit, session }, 'vmpz convention')
    await vi.waitFor(() => expect(band.el.querySelector('.ws-transcript-found')?.textContent).toContain('conventions in turn 1'))
    expect(calls.some(call => call.includes(`session=${session}`))).toBe(true)
    expect(band.el.querySelectorAll('.ws-transcript-turn').length).toBeGreaterThan(8)
    const marks = [...band.el.querySelectorAll('mark.ws-transcript-found-mark')].map(mark => mark.textContent)
    expect(new Set(marks)).toEqual(new Set(['vmpz', 'conventions']))
    expect(calls.filter(call => call.includes('/transcripts/search'))).toHaveLength(0)
  })

  it('draws no local Find controls and does not intercept Ctrl-F in the conversation', async () => {
    await open()
    expect(band.el.querySelector('input, .ws-transcript-find')).toBeNull()
    const scroller = band.el.querySelector<HTMLElement>('.ws-transcript-scroll')!
    scroller.focus()
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })
    scroller.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(scroller)
  })

  it('clears a board Find highlight with Escape without adding a search field', async () => {
    await open()
    band.openHit({ ...searchHit, session: here }, 'vmpz convention')
    expect(band.el.querySelector('.ws-transcript-found')).not.toBeNull()
    band.el.querySelector('.ws-transcript-scroll')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(band.el.querySelector('.ws-transcript-found, mark.ws-transcript-found-mark')).toBeNull()
  })
})
