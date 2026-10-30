// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { TranscriptBand } from './TranscriptBand.js'
import { mentionRuntime, type ConstitutionMention } from '../workspace/bodyLinks.js'
import source from './fixtures/claude-shuttle-thread-command.jsonl?raw'

const session = 'a3edf873-cb1c-40ab-a891-f26f5333b320'
let bands: TranscriptBand[] = []
let runtimes: ReturnType<typeof mentionRuntime>[] = []
let observers: MutationObserver[] = []

afterEach(() => {
  for (const observer of observers) observer.disconnect()
  observers = []
  vi.restoreAllMocks()
  for (const runtime of runtimes) runtime.dispose()
  for (const band of bands) band.dispose()
  runtimes = []; bands = []
  document.body.replaceChildren()
})

function makeBand(items: unknown[], inline = true): TranscriptBand {
  const bytes = new TextEncoder().encode(items.map(item => JSON.stringify(item)).join('\n') + '\n')
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, { status: 200, headers: { 'x-transcript-offset': '0', 'x-transcript-byte-count': String(bytes.byteLength) } }))
  const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fetcher, inline })
  bands.push(band); document.body.append(band.el)
  band.follow({ session, host: 'host-b', agent: 'claude-opus', live: false, at: Date.parse('2026-10-22T22:40:00Z') })
  return band
}

async function settle(band: TranscriptBand): Promise<void> {
  // Initial step groups paint after the feed is ready and queued entries drain.
  // Decoding may yield to a timer between records, before the next frame.
  await new Promise<void>(resolve => {
    const ready = (): boolean => !!band.el.querySelector('.ws-transcript-steps, [data-spawn-preview]')
    if (ready()) { resolve(); return }
    const observer = new MutationObserver(() => {
      if (ready()) { observer.disconnect(); resolve() }
    })
    observers.push(observer)
    observer.observe(band.el, { childList: true, subtree: true })
  })
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
  // Progress records exercise decoding across multiple frames even on a fast host.
  let clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock += 10)
  const records = source.trim().split('\n').map(line => JSON.parse(line) as unknown)
  const items = [
    ...Array.from({ length: 32 }, () => ({ type: 'progress' })),
    { type: 'user', timestamp: '2026-10-22T22:40:00.000Z', message: { content: 'Open the two threads.' } },
    ...records,
    { type: 'assistant', timestamp: '2026-10-22T22:59:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'Opened project-x/cloe-backends under the chair.' }] } },
  ]
  const band = makeBand(items)
  await settle(band)
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
  await settle(band)
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
  await settle(missing)
  const missingMentions = mentionRuntime(missing.el, vi.fn())
  runtimes.push(missingMentions)
  missingMentions.update([row('project-x/new-child', 'Waiting', 'idle')])
  expect(missing.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
  expect(missing.el.querySelector('.ws-transcript-steps')?.textContent).toContain('1 step')
  expect(missing.el.textContent).not.toContain('shuttle thread')

  const failed = makeBand(spawnRecords('project-x/new-child', true))
  await settle(failed)
  const failedMentions = mentionRuntime(failed.el, vi.fn())
  runtimes.push(failedMentions)
  failedMentions.update([row('project-x/new-child', 'Waiting', 'idle')])
  expect(failed.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
  expect(failed.el.querySelector('.ws-transcript-steps')?.textContent).toContain('1 step')
  expect(failed.el.textContent).not.toContain('project-x/new-child')
  expect(failed.el.textContent).not.toContain('shuttle thread')
})

it.each([
  'Wall time: 1.2 seconds\nOutput:\n{\n  "id": "project-x/json-child",\n  "uid": "01ABCDEFGHJKMNPQRSTVWXYZ12"\n}',
  'warning: remote unavailable\n{\n  "id": "project-x/json-child",\n  "uid": "01ABCDEFGHJKMNPQRSTVWXYZ12"\n}',
])('reads indented JSON after a tool header or warning', async output => {
  const items = spawnRecords(output)
  const tool = items[1] as { message: { content: Array<{ input: { command: string } }> } }
  tool.message.content[0].input.command += ' --json'
  const band = makeBand(items); await settle(band)
  const mentions = mentionRuntime(band.el, vi.fn()); runtimes.push(mentions)
  mentions.update([{ ...row('project-x/moved/json-child', 'Working', 'working'), uid: '01ABCDEFGHJKMNPQRSTVWXYZ12' }])
  expect(band.el.querySelector<HTMLAnchorElement>('.ws-transcript-spawn-chip:not([hidden])')?.dataset.constitution).toBe('project-x/moved/json-child')
})

it('resolves an older plain spawn after nesting only when its leaf is unique', async () => {
  const band = makeBand(spawnRecords('project-x/new-child')); await settle(band)
  const mentions = mentionRuntime(band.el, vi.fn()); runtimes.push(mentions)
  mentions.update([row('project-x/nested/new-child', 'Working', 'working')])
  const chip = band.el.querySelector<HTMLAnchorElement>('.ws-transcript-spawn-chip')!
  expect(chip.dataset.constitution).toBe('project-x/nested/new-child')
  // A fresh unresolved chip must not guess between duplicate leaves.
  const other = makeBand(spawnRecords('project-x/new-child')); await settle(other)
  const otherMentions = mentionRuntime(other.el, vi.fn()); runtimes.push(otherMentions)
  otherMentions.update([row('a/new-child', 'Working', 'working'), row('b/new-child', 'Working', 'working')])
  expect(other.el.querySelector('.ws-transcript-spawn-chip:not([hidden])')).toBeNull()
})

it('does not treat a search for shuttle thread as a spawn', async () => {
  const items = spawnRecords('project-x/new-child')
  const tool = items[1] as { message: { content: Array<{ input: { command: string } }> } }
  tool.message.content[0].input.command = "grep -l 'shuttle thread' files"
  const band = makeBand(items); await settle(band)
  expect(band.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
})

it('does not attribute another command’s IDs to a spawn', async () => {
  const items = spawnRecords('project-x/other\nproject-x/new-child')
  const tool = items[1] as { message: { content: Array<{ input: { command: string } }> } }
  tool.message.content[0].input.command = 'felt ls --ids && shuttle thread project-x "New child"'
  const band = makeBand(items); await settle(band)
  expect(band.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
})


it('rejects JSON from mixed commands and ambiguous output', async () => {
  for (const [command, output] of [
    ['shuttle thread project-x "New child" --json && felt ls --json', '{"id":"project-x/other"}'],
    ['shuttle thread project-x "New child" --json', '{"id":"project-x/other"}\n{"id":"project-x/new-child"}'],
  ]) {
    const items = spawnRecords(output)
    const tool = items[1] as { message: { content: Array<{ input: { command: string } }> } }
    tool.message.content[0].input.command = command
    const band = makeBand(items); await settle(band)
    expect(band.el.querySelector('.ws-transcript-spawn-chip')).toBeNull()
  }
})

it('uses the plain output UID across a move even when the leaf is ambiguous', async () => {
  const band = makeBand(spawnRecords('Thread UID: project-x/new-child 01ABCDEFGHJKMNPQRSTVWXYZ12\nproject-x/new-child'))
  await settle(band)
  const mentions = mentionRuntime(band.el, vi.fn()); runtimes.push(mentions)
  mentions.update([{ ...row('project-x/moved/new-child', 'Working', 'working'), uid: '01ABCDEFGHJKMNPQRSTVWXYZ12' }, row('other/new-child', 'Working', 'working')])
  expect(band.el.querySelector<HTMLAnchorElement>('.ws-transcript-spawn-chip:not([hidden])')?.dataset.constitution).toBe('project-x/moved/new-child')
})

it('shows the preview spawn row, a list item kept in place, only while its spawn resolves', async () => {
  const band = makeBand(spawnRecords('project-x/new-child'), false); await settle(band)
  const mentions = mentionRuntime(band.el, vi.fn()); runtimes.push(mentions)
  const group = band.el.querySelector<HTMLElement>('[data-spawn-preview]')!
  expect(group.tagName).toBe('LI')
  mentions.update([])
  expect(group.hidden).toBe(true)
  mentions.update([row('project-x/new-child', 'Working', 'working')])
  expect(group.hidden).toBe(false)
  mentions.update([])
  expect(group.hidden).toBe(true)
  expect(band.el.querySelector('[data-spawn-preview]')).toBe(group)
})

it('keeps a resolved spawn chip in place when a receipt lands earlier in its turn', async () => {
  const band = makeBand(spawnRecords('project-x/new-child')); await settle(band)
  const mentions = mentionRuntime(band.el, vi.fn()); runtimes.push(mentions)
  mentions.update([row('project-x/new-child', 'Working', 'working')])
  const chip = band.el.querySelector<HTMLAnchorElement>('.ws-transcript-spawn-chip:not([hidden])')!
  expect(chip).not.toBeNull()
  // A receipt timed before the spawn splices in ahead of it, shifting the spawn's step index.
  const accept = (band as unknown as { acceptSentFiles(session: string, files: unknown[]): void }).acceptSentFiles.bind(band)
  accept(session, [{ fullPath: '/tmp/early.png', basename: 'early.png', timestamp: Date.parse('2026-10-22T22:40:30Z'), sessionId: session }])
  await settle(band)
  expect(band.el.querySelector('.ws-transcript-sent-file')).not.toBeNull()
  expect(chip.isConnected).toBe(true)
  expect(chip.hidden).toBe(false)
})

it('reuses a resolved spawn chip when its group expands and folds again', async () => {
  const band = makeBand(spawnRecords('project-x/new-child\nThread UID: project-x/new-child 01KTESTFIBER000000000000001'))
  await settle(band)
  const pane = band.el.querySelector<HTMLElement>('.ws-transcript-pane')!
  const mentions = mentionRuntime(pane, vi.fn()); runtimes.push(mentions)
  mentions.update([row('project-x/new-child', 'Working', 'working')])
  const chip = pane.querySelector<HTMLAnchorElement>('.ws-transcript-spawn-chip:not([hidden])')!
  const group = pane.querySelector<HTMLButtonElement>('.ws-transcript-steps')!
  expect(chip).not.toBeNull()

  group.click()
  expect(chip.isConnected).toBe(false)
  group.click()

  expect(pane.querySelector('.ws-transcript-spawn-chip')).toBe(chip)
  expect(chip.hidden).toBe(false)
})

it('keeps a bottom-following transcript at the bottom when a spawn chip resolves', async () => {
  const band = makeBand(spawnRecords('project-x/new-child\nThread UID: project-x/new-child 01KTESTFIBER000000000000001'))
  await settle(band)
  const scroller = band.el.querySelector<HTMLElement>('.ws-transcript-scroll')!
  const chip = band.el.querySelector<HTMLElement>('.ws-transcript-spawn-chip')!
  Object.defineProperties(scroller, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => chip.hidden ? 1000 : 1050 },
  })
  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
  scroller.dispatchEvent(new Event('scroll'))
  const mentions = mentionRuntime(band.el, vi.fn()); runtimes.push(mentions)

  mentions.update([row('project-x/new-child', 'Working', 'working')])
  await settle(band)

  expect(chip.hidden).toBe(false)
  expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight)
})
