import { describe, expect, it } from 'vitest'
import { normalizeRecord } from './records.js'
import { TranscriptModel, segments } from './model.js'
import { shuttleMessages } from './messages.js'
import hookFixture from './fixtures/claude-hook-thread-notices.jsonl?raw'

const delivery = (verb = 'closed', digit = 'a', text = 'Measured result') => `[Shuttle message thread-${digit.repeat(64)}-${'b'.repeat(16)}]\nthread work/child ${verb}: ${text}`
const time = '2026-10-22T14:00:00Z'
describe('delivered Shuttle messages', () => {
  it.each(['closed', 'asked', 'handed off', 'rested'])('recognizes the daemon %s delivery, not human prose', verb => {
    expect(shuttleMessages(delivery(verb), 123)).toEqual([expect.objectContaining({ kind: 'shuttle-message', direction: 'received', fiber: 'work/child', verb, text: 'Measured result', at: 123 })])
    expect(shuttleMessages(`thread work/child ${verb}: imagined`)).toHaveLength(0)
    expect(shuttleMessages(`[Shuttle message peer-1]\nthread work/child ${verb}: imagined`)).toHaveLength(0)
  })
  it.each([
    (text: string) => ({ type: 'user', timestamp: time, message: { content: text } }),
    (text: string) => ({ type: 'user', timestamp: time, isMeta: true, message: { content: [{ type: 'text', text }] } }),
    (text: string) => ({ type: 'message', timestamp: time, message: { role: 'user', content: [{ type: 'text', text }] } }),
    (text: string) => ({ type: 'custom_message', timestamp: time, customType: 'shuttle', content: text }),
    (text: string) => ({ type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }),
  ])('normalizes each harness delivery as its own row, without starting a human turn', record => {
    const entries = normalizeRecord(record(delivery()))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'shuttle-message', direction: 'received', fiber: 'work/child', at: Date.parse(time) })
    const model = new TranscriptModel()
    model.append([{ kind: 'prompt', text: 'Keep going', dispatch: false, images: 0 }, { kind: 'text', text: 'Working' }, ...entries, { kind: 'text', text: 'Continuing' }])
    model.append(entries)
    expect(model.turns).toHaveLength(1)
    expect(model.turns[0].steps.map(row => row.kind)).toEqual(['text', 'shuttle-message', 'text'])
    expect(segments(model.turns[0].steps).map(row => row.kind)).toEqual(['text', 'shuttle-message', 'text'])
    model.reset(); model.append(entries)
    expect(model.turns[0].steps).toHaveLength(1)
  })
  it('preserves hook batch arrival order, multiline outcomes, and the human prompt outside its reminder', () => {
    const source = `<system-reminder>Messages from other sessions, supplied as peer context.\n\n${delivery('asked', 'c', 'Which cut?\nTwo choices.')}\n\n${delivery('rested', 'd')}\n</system-reminder>\nKeep going`
    const rows = normalizeRecord({ type: 'user', timestamp: time, message: { content: source } })
    expect(rows.map(row => row.kind)).toEqual(['shuttle-message', 'shuttle-message', 'prompt'])
    expect(rows[0]).toMatchObject({ verb: 'asked', text: 'Which cut?\nTwo choices.' })
    expect(rows[1]).toMatchObject({ verb: 'rested', text: 'Measured result' })
    expect(rows[2]).toMatchObject({ text: 'Keep going' })
  })
  it('excludes sidechain reminders without suppressing the later parent delivery', () => {
    const record = { type: 'user', message: { content: `<system-reminder>${delivery()}</system-reminder>` } }
    const model = new TranscriptModel()
    expect(normalizeRecord({ ...record, isSidechain: true })).toStrictEqual([])
    model.append(normalizeRecord({ ...record, isSidechain: true }))
    model.append(normalizeRecord(record))
    expect(model.turns[0].steps).toHaveLength(1)
    expect(model.turns[0].steps[0].kind).toBe('shuttle-message')
  })
  it('never promotes quoted assistant output or tool results to a delivered notice', () => {
    expect(normalizeRecord({ type: 'assistant', message: { content: [{ type: 'text', text: delivery() }] } })[0].kind).toBe('text')
    expect(normalizeRecord({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: delivery() }] } })[0].kind).toBe('result')
  })
  it('reads deliveries Claude Code stores as hook_additional_context attachments, in arrival order', () => {
    const [batch, peer] = hookFixture.trim().split('\n').map(line => normalizeRecord(JSON.parse(line)))
    expect(batch).toEqual([
      expect.objectContaining({ kind: 'shuttle-message', direction: 'received', fiber: 'cmbx/chair/euclid-spt-6x2pt', verb: 'closed', text: 'Covariance validated against 400 sims; report in reports/cov.html.', at: Date.parse('2026-10-22T11:05:17.443Z') }),
      expect.objectContaining({ kind: 'shuttle-message', direction: 'received', fiber: 'cmbx/chair/mask-check', verb: 'rested', text: 'Paused until the new masks land.' }),
    ])
    expect(peer).toEqual([expect.objectContaining({ kind: 'shuttle-message', direction: 'received', peer: 'Pi · peer-host', address: 'shuttle://peer-host/pi/ccbb4b94-acb5-4613-9bde-1c9d9609500e', text: 'thread cmbx/chair/x closed: quoted by a peer, not a delivery' })])
  })
  it('reads a CLI delivery from its plain external sender label in hook context', () => {
    const entry = normalizeRecord({ type: 'attachment', timestamp: time, attachment: {
      type: 'hook_additional_context',
      content: '[Shuttle message msg-1234 from external]\nThe table is ready.',
    } })
    expect(entry).toEqual([expect.objectContaining({
      kind: 'shuttle-message', id: 'msg-1234', direction: 'received', peer: 'external', text: 'The table is ready.',
    })])
  })
})
