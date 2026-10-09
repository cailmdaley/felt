// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriptBand, type TranscriptTarget } from './TranscriptBand.js'

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

  it('opens the whole session in a dialog, with tools behind each run and safe prose', async () => {
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
    const dialog = band.el.querySelector<HTMLDialogElement>('.ws-transcript-dialog')!
    expect(dialog.open).toBe(false)
    band.el.querySelector<HTMLElement>('.ws-transcript-preview')!.click()
    await settle()
    expect(dialog.open).toBe(true)

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
    expect(tool.parentElement?.querySelector('.ws-transcript-tool-detail')).toBeNull()
    tool.click()
    const detail = tool.parentElement?.querySelector<HTMLElement>('.ws-transcript-tool-detail')!
    expect(detail.textContent).toContain('git log --oneline -5')
    expect(detail.querySelector('.ws-transcript-output')?.classList.contains('ws-transcript-error')).toBe(true)
    expect(detail.querySelector('.ws-transcript-output')?.textContent).toContain('response-bin-40')
    expect(detail.querySelector('.ws-transcript-output')?.textContent).not.toContain('response-bin-48')
    const showAll = detail.querySelector<HTMLButtonElement>('.ws-transcript-showall')!
    expect(showAll.textContent).toBe('Show all 48 lines')
    showAll.click()
    expect(detail.querySelector('.ws-transcript-output')?.textContent).toContain('response-bin-48')

    dialog.querySelector<HTMLButtonElement>('.ws-transcript-close')!.click()
    expect(dialog.open).toBe(false)
    expect(dialog.querySelector('.ws-transcript-turn')).toBeNull()
  })

  it('pages earlier turns inside the dialog, never in the page', async () => {
    const items = Array.from({ length: 20 }, (_, index) => records(`Prompt ${index}`, `Answer ${index}.`)).flat()
    const band = makeBand(fixtureFetch({ [latestId]: items }))
    band.follow(target(latestId))
    await settle()
    band.el.querySelector<HTMLButtonElement>('.ws-transcript-open-full')!.click()
    await settle()
    const dialog = band.el.querySelector<HTMLDialogElement>('.ws-transcript-dialog')!
    expect(dialog.querySelectorAll('.ws-transcript-turn')).toHaveLength(3)
    const earlier = dialog.querySelector<HTMLButtonElement>('.ws-transcript-earlier')!
    expect(earlier.textContent).toBe('▴ 12 earlier turns')
    earlier.click()
    expect(dialog.querySelectorAll('.ws-transcript-turn')).toHaveLength(15)
    expect(earlier.textContent).toBe('▴ 5 earlier turns')
    expect(band.el.querySelector('.ws-transcript-preview')?.textContent).toContain('Answer 19.')
    expect(band.el.querySelector('.ws-transcript-preview')?.textContent).not.toContain('Answer 18.')
  })

  it('marks a live worker at work after its last message, and Escape closes the dialog alone', async () => {
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
    const dialog = band.el.querySelector<HTMLDialogElement>('.ws-transcript-dialog')!
    expect(dialog.open).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(dialog.open).toBe(false)
    expect(outside).not.toHaveBeenCalled()
    window.removeEventListener('keydown', outside)
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
    expect(band.el.querySelector('.ws-transcript-label')?.textContent).toContain('Transcript ·')
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
