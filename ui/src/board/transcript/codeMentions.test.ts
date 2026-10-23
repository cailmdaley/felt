// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { TranscriptBand } from './TranscriptBand.js'
import { mentionRuntime, type ConstitutionMention } from '../workspace/bodyLinks.js'
import source from './fixtures/claude-shuttle-thread-command.jsonl?raw'

afterEach(() => document.body.replaceChildren())

it('leaves fiber ids in a tool\'s command and result as code, and chips them in the worker\'s prose', async () => {
  const records = source.trim().split('\n').map(line => JSON.parse(line) as unknown)
  const items = [
    { type: 'user', timestamp: '2026-10-22T22:40:00.000Z', message: { content: 'Open the two threads.' } },
    ...records,
    { type: 'assistant', timestamp: '2026-10-22T22:59:00.000Z', message: { model: 'claude-opus', content: [{ type: 'text', text: 'Opened project-x/cloe-backends under the chair.' }] } },
  ]
  const bytes = new TextEncoder().encode(items.map(item => JSON.stringify(item)).join('\n') + '\n')
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, { status: 200, headers: { 'x-transcript-offset': '0', 'x-transcript-byte-count': String(bytes.byteLength) } }))
  const band = new TranscriptBand({ shuttleBase: 'http://localhost:4000', fetch: fetcher, inline: true })
  document.body.append(band.el)
  band.follow({ session: 'a3edf873-cb1c-40ab-a891-f26f5333b320', host: 'host-b', agent: 'claude-opus', live: false, at: Date.parse('2026-10-22T22:40:00Z') })
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
  const rows: ConstitutionMention[] = ['project-x/cloe-backends', 'project-x/foreground-mitigation', 'project-x'].map(id => ({ id, name: id.split('/').pop()!, state: 'Waiting', outcome: '', origin: 'host-b' }))
  const mentions = mentionRuntime(band.el, vi.fn())
  mentions.update(rows)

  const command = band.el.querySelector('.ws-transcript-spawn')!
  expect(command.tagName).toBe('PRE')
  expect(command.textContent).toContain('shuttle thread project-x "CLOE implementations')
  expect(command.querySelector('.ws-constitution-chip')).toBeNull()
  band.el.querySelector<HTMLButtonElement>('.ws-transcript-steps')!.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  const detail = band.el.querySelector('.ws-transcript-tool-detail')!
  expect(detail.textContent).toContain('Nested project-x/cloe-backends under project-x/code')
  expect(detail.querySelector('.ws-constitution-chip')).toBeNull()
  expect(band.el.querySelector('.ws-transcript-msg-agent .ws-constitution-chip')?.textContent).toBe('cloe-backends · Waiting')
  mentions.dispose(); band.dispose()
})
