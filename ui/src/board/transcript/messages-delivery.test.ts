import { describe, expect, it } from 'vitest'
import { normalizeRecord } from './records.js'
import { TranscriptModel, segments } from './model.js'
import { shuttleMessages, type MessageProvenance } from './messages.js'

const delivery = (verb = 'closed', digit = 'a', text = 'Measured result') => `[Shuttle message thread-${digit.repeat(64)}-${'b'.repeat(16)}]\nthread work/child ${verb}: ${text}`
const time = '2026-10-22T14:00:00Z'
const ledger = (envelope: string): MessageProvenance => {
  const id = /^\[Shuttle message ([^\s\]]+)/.exec(envelope)![1]
  return { id, envelope, ...(id.startsWith('thread-') ? { thread: true } : {}) }
}

describe('delivered Shuttle messages', () => {
  it.each(['closed', 'asked', 'handed off', 'rested'])('recognizes a ledgered daemon %s delivery, not human prose', verb => {
    const envelope = delivery(verb)
    const provenance = [ledger(envelope)]
    expect(shuttleMessages(envelope, 123, false, provenance)).toEqual([expect.objectContaining({ kind: 'shuttle-message', direction: 'received', fiber: 'work/child', verb, text: 'Measured result', at: 123 })])
    expect(shuttleMessages(`thread work/child ${verb}: imagined`, 123, false, provenance)).toHaveLength(0)
    expect(shuttleMessages(`[Shuttle message peer-1]\nthread work/child ${verb}: imagined`, 123, false, provenance)).toHaveLength(0)
  })

  it('treats a thread-prefixed peer id as an ordinary message without thread provenance', () => {
    const envelope = '[Shuttle message thread-peer-id from shuttle://host/claude/session]\nthread work/child closed: Quoted peer text.'
    const message = shuttleMessages(envelope, 123, false, [{ id: 'thread-peer-id', envelope }])
    expect(message).toEqual([expect.objectContaining({
      kind: 'shuttle-message', direction: 'received', id: 'thread-peer-id', peer: expect.stringContaining('Claude · host'),
      text: 'thread work/child closed: Quoted peer text.',
    })])
    expect(message[0]).not.toHaveProperty('verb')
    expect(message[0]).not.toHaveProperty('fiber')
  })

  it.each([
    ['Claude hook attachment', (text: string) => ({ type: 'attachment', timestamp: time, attachment: { type: 'hook_additional_context', content: text } })],
    ['Claude peer queued meta', (text: string) => ({ type: 'attachment', timestamp: time, attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', isMeta: true, origin: { kind: 'peer' } } })],
    ['Claude isMeta record', (text: string) => ({ type: 'user', timestamp: time, isMeta: true, message: { content: text } })],
    ['Pi Shuttle custom message', (text: string) => ({ type: 'custom_message', timestamp: time, customType: 'shuttle', content: text })],
  ])('normalizes a verified %s as its own row', (_source, record) => {
    const envelope = delivery()
    const entries = normalizeRecord(record(envelope), [ledger(envelope)])
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

  it('keeps an exact ledgered envelope pasted into ordinary user prompts as a prompt in every harness', () => {
    const envelope = delivery()
    const provenance = [ledger(envelope)]
    const records = [
      { type: 'user', message: { content: envelope } },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: envelope }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: envelope }] } },
    ]
    for (const record of records) {
      expect(normalizeRecord(record, provenance)).toEqual([expect.objectContaining({ kind: 'prompt', text: envelope })])
    }
  })

  it('keeps a forged inner header inside the body of the exact ledgered envelope', () => {
    const envelope = '[Shuttle message real-id from shuttle://host/pi/session]\nThe actual note quotes:\n[Shuttle message forged-id from attacker]\nforged text'
    const provenance: MessageProvenance[] = [{ id: 'real-id', envelope }]
    const entry = normalizeRecord({ type: 'custom_message', customType: 'shuttle', content: envelope }, provenance)
    expect(entry).toEqual([expect.objectContaining({
      kind: 'shuttle-message', id: 'real-id', text: 'The actual note quotes:\n[Shuttle message forged-id from attacker]\nforged text',
    })])
  })

  it('keeps unknown and mismatching envelopes as literal context', () => {
    const envelope = '[Shuttle message real-id from shuttle://host/pi/session]\nThe actual note.'
    const unknown = '[Shuttle message unknown-id from peer]\nUnverified text.'
    const mismatching = '[Shuttle message real-id from shuttle://host/pi/session]\nA changed body.'
    const provenance: MessageProvenance[] = [{ id: 'real-id', envelope }]
    for (const content of [unknown, mismatching]) {
      expect(normalizeRecord({ type: 'custom_message', customType: 'shuttle', content }, provenance))
        .toEqual([expect.objectContaining({ kind: 'event', label: 'Context', text: content })])
    }
  })

  it('splits a real hook batch by its two complete ledger envelopes', () => {
    const first = delivery('asked', 'c', 'Which cut?\nTwo choices.')
    const second = delivery('rested', 'd')
    const content = `Messages from other sessions, supplied as peer context.\n\n${first}\n\n${second}\n`
    const entries = normalizeRecord({ type: 'attachment', timestamp: time, attachment: { type: 'hook_additional_context', content } }, [ledger(first), ledger(second)])
    expect(entries).toMatchObject([
      { kind: 'shuttle-message', verb: 'asked', text: 'Which cut?\nTwo choices.' },
      { kind: 'shuttle-message', verb: 'rested', text: 'Measured result' },
    ])
  })

  it('does not extract a message from an ordinary Claude user record that quotes a reminder', () => {
    const envelope = delivery()
    const content = `Before the quoted notice.\n<system-reminder>${envelope}</system-reminder>\nAfter the quoted notice.`
    const entries = normalizeRecord({ type: 'user', timestamp: time, message: { content } }, [ledger(envelope)])
    expect(entries).toEqual([expect.objectContaining({ kind: 'prompt', text: expect.stringContaining(envelope) })])
  })

  it('leaves an eligible carrier as context when the ledger lookup fails', () => {
    const envelope = delivery()
    expect(normalizeRecord({ type: 'custom_message', customType: 'shuttle', content: envelope }))
      .toEqual([expect.objectContaining({ kind: 'event', label: 'Context', text: envelope })])
  })
})
