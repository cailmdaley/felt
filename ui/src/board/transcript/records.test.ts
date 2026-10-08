import { describe, expect, it } from 'vitest'
import { normalizeRecord } from './records.js'

describe('normalizeRecord', () => {
  it('reads Claude assistant blocks in order and skips empty thinking and sidechains', () => {
    const entries = normalizeRecord({
      type: 'assistant',
      timestamp: '2026-09-26T14:02:03.000Z',
      message: {
        model: 'claude-opus',
        content: [
          { type: 'thinking', thinking: '', signature: 'opaque' },
          { type: 'text', text: 'The null-test vector is stable.' },
          { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'git log -5' } },
          { type: 'thinking', thinking: 'Check the mask split.' },
          { type: 'text', text: '(no content)' },
        ],
      },
    })

    expect(entries).toEqual([
      { kind: 'text', text: 'The null-test vector is stable.', model: 'claude-opus', at: Date.parse('2026-09-26T14:02:03.000Z') },
      { kind: 'tool', id: 'call-1', name: 'Bash', input: { command: 'git log -5' }, at: Date.parse('2026-09-26T14:02:03.000Z') },
      { kind: 'thinking', text: 'Check the mask split.', at: Date.parse('2026-09-26T14:02:03.000Z') },
    ])
    expect(normalizeRecord({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'hidden' }] } })).toEqual([])
    expect(normalizeRecord({ type: 'attachment', message: { content: 'ignored' } })).toEqual([])
  })

  it('classifies Claude prompts, injected context, and notifications', () => {
    expect(normalizeRecord({
      type: 'user', message: { content: '  <system-reminder>do not show</system-reminder> Measure the shear response.' },
    })).toEqual([{ kind: 'prompt', text: 'Measure the shear response.', images: 0, dispatch: false }])
    expect(normalizeRecord({
      type: 'user', isMeta: true,
      message: { content: 'Base directory for this skill: /opt/loom/skills/shear-check\nUse the null test.' },
    })).toEqual([{ kind: 'event', label: 'Skill', detail: 'shear-check', text: 'Base directory for this skill: /opt/loom/skills/shear-check\nUse the null test.' }])
    expect(normalizeRecord({
      type: 'user', message: { content: '<task-notification><summary>Mask split completed</summary><task-id>7</task-id></task-notification>' },
    })).toEqual([{ kind: 'event', label: 'Task', detail: 'Mask split completed', text: '<task-notification><summary>Mask split completed</summary><task-id>7</task-id></task-notification>' }])
    expect(normalizeRecord({ type: 'user', message: { content: '<local-command-caveat>not a prompt</local-command-caveat>' } })).toEqual([])
    expect(normalizeRecord({ type: 'user', message: { content: 'You are a Shuttle worker for shear calibration.' } })[0]).toMatchObject({ kind: 'prompt', dispatch: true })
    expect(normalizeRecord({ type: 'system', subtype: 'compact_boundary' })).toEqual([{ kind: 'event', label: 'Compacted' }])
  })

  it('counts Claude prompt and tool-result images without emitting their payloads', () => {
    expect(normalizeRecord({
      type: 'user',
      message: { content: [
        { type: 'text', text: 'Compare these response bins.' },
        { type: 'image', source: { data: 'private-payload' } },
        { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: [
          { type: 'text', text: 'file not found' },
          { type: 'image', source: { data: 'private-payload' } },
        ] },
      ] },
    })).toEqual([
      { kind: 'prompt', text: 'Compare these response bins.', images: 1, dispatch: false },
      { kind: 'result', id: 'call-1', text: 'file not found', isError: true, images: 1 },
    ])
  })

  it('normalizes pi messages and custom context by their envelope', () => {
    expect(normalizeRecord({ type: 'message', timestamp: '2026-09-26T14:00:00Z', message: { role: 'user', content: [
      { type: 'text', text: 'Inspect the response bins.' }, { type: 'image' },
    ] } })).toEqual([{ kind: 'prompt', text: 'Inspect the response bins.', images: 1, dispatch: false, at: Date.parse('2026-09-26T14:00:00Z') }])
    expect(normalizeRecord({ type: 'message', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'Check the null test.' },
      { type: 'toolCall', id: 'pi-1', name: 'bash', arguments: { command: 'npm test' } },
      { type: 'text', text: 'The calibration is consistent.' },
    ] } })).toEqual([
      { kind: 'thinking', text: 'Check the null test.' },
      { kind: 'tool', id: 'pi-1', name: 'bash', input: { command: 'npm test' } },
      { kind: 'text', text: 'The calibration is consistent.' },
    ])
    expect(normalizeRecord({ type: 'message', message: { role: 'toolResult', toolCallId: 'pi-1', isError: false, content: [{ type: 'text', text: 'tests passed' }] } })).toEqual([
      { kind: 'result', id: 'pi-1', text: 'tests passed', images: 0, isError: false },
    ])
    expect(normalizeRecord({ type: 'custom_message', customType: 'skill', content: 'Skill instructions loaded.' })).toEqual([
      { kind: 'event', label: 'Context', detail: 'skill', text: 'Skill instructions loaded.' },
    ])
    expect(normalizeRecord({ type: 'message', message: { role: 'system', content: 'hidden' } })).toEqual([])
  })

  it('normalizes Codex responses, tools, results, reasoning, and context', () => {
    expect(normalizeRecord({ type: 'response_item', timestamp: '2026-09-26T14:05:00Z', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The mask split is clean.' }],
    } })).toEqual([{ kind: 'text', text: 'The mask split is clean.', at: Date.parse('2026-09-26T14:05:00Z') }])
    expect(normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call', call_id: 'codex-1', name: 'read_file', arguments: '{"path":"src/response.py"}',
    } })).toEqual([{ kind: 'tool', id: 'codex-1', name: 'read_file', input: { path: 'src/response.py' } }])
    expect(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'codex-1', output: [{ type: 'output_text', text: 'response bins loaded' }],
    } })).toEqual([{ kind: 'result', id: 'codex-1', text: 'response bins loaded', images: 0, isError: false }])
    expect(normalizeRecord({ type: 'response_item', payload: {
      type: 'reasoning', summary: [{ text: 'Check weights.' }, { text: 'Then compare null tests.' }],
    } })).toEqual([{ kind: 'thinking', text: 'Check weights.\nThen compare null tests.' }])
    expect(normalizeRecord({ type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }],
    } })).toEqual([{ kind: 'event', label: 'Context', detail: '<environment_context>cwd</environment_context>', text: '<environment_context>cwd</environment_context>' }])
    expect(normalizeRecord({ type: 'response_item', payload: { type: 'event_msg' } })).toEqual([])
  })

  it('ignores malformed and unrecognized input without throwing', () => {
    expect(normalizeRecord(null)).toEqual([])
    expect(normalizeRecord('not a record')).toEqual([])
    expect(normalizeRecord({ type: 'message', message: null })).toEqual([])
    expect(normalizeRecord({ type: 'response_item', payload: [] })).toEqual([])
    expect(normalizeRecord({ type: 'system', subtype: 'warning', message: { content: 'ignored' } })).toEqual([])
  })
})
