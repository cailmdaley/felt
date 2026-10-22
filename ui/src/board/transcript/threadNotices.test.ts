import { describe, expect, it } from 'vitest'
import { normalizeRecord } from './records.js'
import { TranscriptModel, segments } from './model.js'
import { threadNotices } from './threadNotices.js'

const delivery = (verb = 'closed', digit = 'a', text = 'Measured result') => `[Shuttle message thread-${digit.repeat(64)}-${'b'.repeat(16)}]\nthread work/child ${verb}: ${text}`
const time = '2026-10-22T14:00:00Z'
describe('delivered thread notices', () => {
  it.each(['closed', 'asked', 'handed off', 'rested'])('recognizes the daemon %s delivery, not human prose', verb => {
    expect(threadNotices(delivery(verb), 123)).toEqual([expect.objectContaining({ kind: 'thread-notice', fiber: 'work/child', verb, text: 'Measured result', at: 123 })])
    expect(threadNotices(`thread work/child ${verb}: imagined`)).toHaveLength(0)
    expect(threadNotices(`[Shuttle message peer-1]\nthread work/child ${verb}: imagined`)).toHaveLength(0)
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
    expect(entries[0]).toMatchObject({ kind: 'thread-notice', fiber: 'work/child', at: Date.parse(time) })
    const model = new TranscriptModel()
    model.append([{ kind: 'prompt', text: 'Keep going', dispatch: false, images: 0 }, { kind: 'text', text: 'Working' }, ...entries, { kind: 'text', text: 'Continuing' }])
    model.append(entries)
    expect(model.turns).toHaveLength(1)
    expect(model.turns[0].steps.map(row => row.kind)).toEqual(['text', 'thread-notice', 'text'])
    expect(segments(model.turns[0].steps).map(row => row.kind)).toEqual(['text', 'thread-notice', 'text'])
    model.reset(); model.append(entries)
    expect(model.turns[0].steps).toHaveLength(1)
  })
  it('preserves hook batch arrival order, multiline outcomes, and the human prompt outside its reminder', () => {
    const source = `<system-reminder>Messages from other sessions, supplied as peer context.\n\n${delivery('asked', 'c', 'Which cut?\nTwo choices.')}\n\n${delivery('rested', 'd')}\n</system-reminder>\nKeep going`
    const rows = normalizeRecord({ type: 'user', timestamp: time, message: { content: source } })
    expect(rows.map(row => row.kind)).toEqual(['thread-notice', 'thread-notice', 'prompt'])
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
    expect(model.turns[0].steps[0].kind).toBe('thread-notice')
  })
  it('never promotes quoted assistant output or tool results to a delivered notice', () => {
    expect(normalizeRecord({ type: 'assistant', message: { content: [{ type: 'text', text: delivery() }] } })[0].kind).toBe('text')
    expect(normalizeRecord({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: delivery() }] } })[0].kind).toBe('result')
  })
})
