// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeRecord } from './records.js'
import { TranscriptBand } from './TranscriptBand.js'
import source from './fixtures/claude-queued-messages.jsonl?raw'

const lines = source.trim().split('\n').map(line => JSON.parse(line) as unknown)

describe('messages queued while the worker worked', () => {
  it('reads a human message as the human\'s prompt, with its images, and another session\'s as a delivery', () => {
    const peerEnvelope = '[Shuttle message msg-1165a5c8e1effd4bbedccc80502ef237 from shuttle://host-b/claude/chair-session; reply to project-x]\nThe chair\'s tree is clean.'
    const [plain, pictured, peer, task] = lines.map((record, index) => normalizeRecord(record, index === 2
      ? [{ id: 'msg-1165a5c8e1effd4bbedccc80502ef237', envelope: peerEnvelope }]
      : []))
    expect(plain).toMatchObject([{ kind: 'prompt', text: 'remind me about blocked on?', images: 0, dispatch: false }])
    expect(pictured).toMatchObject([{ kind: 'prompt', text: '[Image #11] this is ugly', images: 1 }])
    expect(peer).toMatchObject([{ kind: 'shuttle-message', direction: 'received', peer: 'project-x', senderIsFiber: true, fiber: 'project-x', address: 'shuttle://host-b/claude/chair-session', target: 'project-x', text: 'The chair\'s tree is clean.' }])
    expect(task).toEqual([])
  })
})

describe('a message sent from the composer', () => {
  afterEach(() => document.body.replaceChildren())
  it('shows at once, marked sent, and gives way to the recorded prompt', async () => {
    const session = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
    let items: unknown[] = [{ type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: 'Start.' } }]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset') ?? 0)
      const bytes = new TextEncoder().encode(items.map(item => JSON.stringify(item)).join('\n') + '\n')
      return new Response(bytes.slice(offset), { status: 200, headers: { 'x-transcript-offset': String(offset), 'x-transcript-byte-count': String(bytes.byteLength) } })
    })
    const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fetcher, inline: true })
    document.body.append(band.el)
    const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => resolve(null))) }
    band.follow({ session, host: 'host-a', agent: 'claude-opus', live: false, at: Date.now() })
    await settle()

    band.pend('merge and rerun is priority,\nthen the worktrees')
    const sending = band.el.querySelector<HTMLElement>('.ws-transcript-msg-sending')!
    expect(sending.textContent).toContain('merge and rerun is priority')
    expect(sending.querySelector('.ws-transcript-sending')?.textContent).toBe('sent · not yet read')

    items = [...items, { type: 'user', timestamp: new Date().toISOString(), message: { content: 'merge and rerun is priority, then the worktrees' } }]
    const read = (): Promise<boolean> => (band as unknown as { readNow(): Promise<boolean> }).readNow()
    await vi.waitFor(async () => { await read(); await settle(); expect(band.el.querySelector('.ws-transcript-msg-sending')).toBeNull() }, { timeout: 3000 })
    expect([...band.el.querySelectorAll('.ws-transcript-msg-you')].at(-1)?.textContent).toContain('then the worktrees')
    band.dispose()
  })
})
