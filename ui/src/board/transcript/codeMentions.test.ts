// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { TranscriptBand } from './TranscriptBand.js'
import { mentionRuntime, type ConstitutionMention } from '../workspace/bodyLinks.js'
import source from './fixtures/claude-shuttle-thread-command.jsonl?raw'

const session = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
let bands: TranscriptBand[] = []
let runtimes: ReturnType<typeof mentionRuntime>[] = []

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose()
  for (const band of bands) band.dispose()
  runtimes = []; bands = []
  document.body.replaceChildren()
})

function makeBand(items: unknown[]): TranscriptBand {
  const bytes = new TextEncoder().encode(items.map(item => JSON.stringify(item)).join('\n') + '\n')
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, { status: 200, headers: { 'x-transcript-offset': '0', 'x-transcript-byte-count': String(bytes.byteLength) } }))
  const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fetcher, inline: true })
  bands.push(band); document.body.append(band.el)
  band.follow({ session, host: 'host-b', agent: 'claude-opus', live: false, at: Date.parse('2026-10-22T22:40:00Z') })
  return band
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
}

const row = (id: string, state: string, turn: ConstitutionMention['turn']): ConstitutionMention => ({
  id, name: id.split('/').pop()!, state, turn, outcome: '', origin: 'host-b',
})

const spawnRecords = (output?: string, isError = false): unknown[] => [
  { type: 'user', timestamp: '2026-10-22T22:40:00.000Z', message: { content: 'Spawn a thread.' } },
  { type: 'assistant', timestamp: '2026-10-22T22:41:00.000Z', message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'tool_use', id: 'toolu_spawn', name: 'Bash', input: { command: 'shuttle thread project-x "New child"' } }] } },
  ...(output === undefined ? [] : [{ type: 'user', timestamp: '2026-10-22T22:42:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn', content: output, is_error: isError }] } }]),
]

it('shows a plain-output spawn as live thread chips, and leaves the folded command in the expanded detail', async () => {
  const records = source.trim().split('\n').map(line => JSON.parse(line) as unknown)
  const items = [
    { type: 'user', timestamp: '2026-10-22T22:40:00.000Z', message: { content: 'Open the two threads.' } },
    ...records,
    { type: 'assistant', timestamp: '2026-10-22T22:59:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'Opened project-x/cloe-backends under the chair.' }] } },
  ]
  const band = makeBand(items)
  await settle()
  const open = vi.fn()
  const mentions = mentionRuntime(band.el, open)
  runtimes.push(mentions)
  const rows = [
    row('project-x/cloe-backends', 'Waiting', 'idle'),
    row('project-x/foreground-mitigation', 'Working', 'working'),
    row('project-x', 'Waiting', 'question'),
  ]
  mentions.update(rows)

  const chips = [...band.el.querySelectorAll<HTMLAnchorElement>('.ws-transcript-spawn-chip')]
  expect(chips.map(chip => chip.textContent)).toEqual(['cloe-backends', 'foreground-mitigation'])
  expect(chips.map(chip => chip.dataset.turn)).toEqual(['idle', 'working'])
  expect(chips[1].getAttribute('aria-label')).toBe('Open foreground-mitigation — working')
  expect(band.el.querySelector('.ws-transcript-steps')?.textContent).toContain('1 step')
  expect(band.el.textContent).not.toContain('shuttle thread')
  expect(band.el.textContent).not.toContain('Nested project-x')
  expect(band.el.querySelector('.ws-transcript-msg-agent .ws-constitution-chip')?.textContent).toBe('cloe-backends · Waiting')

  chips[0].click()
  expect(open).toHaveBeenCalledWith('project-x/cloe-backends', 'host-b')
  mentions.update([{ ...rows[0], state: 'Waiting', turn: 'question' }, ...rows.slice(1)])
  expect(chips[0].dataset.turn).toBe('question')

  band.el.querySelector<HTMLButtonElement>('.ws-transcript-steps')!.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  const detail = band.el.querySelector('.ws-transcript-tool-detail')!
  expect(detail.textContent).toContain('shuttle thread project-x "CLOE implementations')
  expect(detail.textContent).toContain('Nested project-x/cloe-backends under project-x/code')
  expect(detail.querySelector('.ws-constitution-chip')).toBeNull()
  expect(band.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
})

it('reads the id from a --json spawn and draws it when the poll has its row', async () => {
  const items = spawnRecords('{"id":"project-x/json-child"}')
  const tool = items[1] as { message: { content: Array<{ input: { command: string } }> } }
  tool.message.content[0].input.command += ' --json'
  const band = makeBand(items)
  await settle()
  const mentions = mentionRuntime(band.el, vi.fn())
  runtimes.push(mentions)
  mentions.update([row('project-x/other-child', 'Working', 'working')])
  expect(band.el.querySelector('.ws-transcript-spawn-chip:not([hidden])')).toBeNull()
  expect(band.el.querySelector('.ws-transcript-steps')?.textContent).toContain('1 step')
  expect(band.el.textContent).not.toContain('project-x/json-child')

  mentions.update([row('project-x/json-child', 'Working', 'working')])
  const chip = band.el.querySelector<HTMLAnchorElement>('.ws-transcript-spawn-chip')!
  expect(chip.textContent).toBe('json-child')
  expect(chip.dataset.constitution).toBe('project-x/json-child')
  expect(chip.dataset.turn).toBe('working')
})

it('draws nothing when a spawn result is missing or failed', async () => {
  const missing = makeBand(spawnRecords())
  await settle()
  const missingMentions = mentionRuntime(missing.el, vi.fn())
  runtimes.push(missingMentions)
  missingMentions.update([row('project-x/new-child', 'Waiting', 'idle')])
  expect(missing.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
  expect(missing.el.querySelector('.ws-transcript-steps')?.textContent).toContain('1 step')
  expect(missing.el.textContent).not.toContain('shuttle thread')

  const failed = makeBand(spawnRecords('project-x/new-child', true))
  await settle()
  const failedMentions = mentionRuntime(failed.el, vi.fn())
  runtimes.push(failedMentions)
  failedMentions.update([row('project-x/new-child', 'Waiting', 'idle')])
  expect(failed.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
  expect(failed.el.querySelector('.ws-transcript-steps')?.textContent).toContain('1 step')
  expect(failed.el.textContent).not.toContain('project-x/new-child')
  expect(failed.el.textContent).not.toContain('shuttle thread')
})
