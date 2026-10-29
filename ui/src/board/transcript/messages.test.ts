import { describe, expect, it } from 'vitest'
import { normalizeRecord } from './records.js'

const time = '2026-10-29T20:00:00Z'
const command = 'shuttle message research/workspace/validation-follow-up "Confirm the north patch cut."'

describe('Shuttle messages in transcripts', () => {
  it.each([
    ['Claude Code', { type: 'assistant', timestamp: time, message: { content: [{ type: 'tool_use', id: 'claude-call', name: 'Bash', input: { command } }] } }],
    ['Codex', { type: 'response_item', timestamp: time, payload: { type: 'function_call', call_id: 'codex-call', name: 'exec_command', arguments: JSON.stringify({ cmd: command }) } }],
    ['Codex exec wrapper', { type: 'response_item', timestamp: time, payload: { type: 'custom_tool_call', call_id: 'codex-exec-call', name: 'exec', input: { code: `await tools.exec_command({cmd: ${JSON.stringify(command)}, max_output_tokens: 10})` } } }],
    ['Pi', { type: 'message', timestamp: time, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'pi-call', name: 'bash', arguments: { command } }] } }],
  ])('lifts an outgoing %s message out of its tool group and retains the raw call', (_harness, record) => {
    const entries = normalizeRecord(record)
    expect(entries.map(entry => entry.kind)).toEqual(['shuttle-message'])
    expect(entries[0]).toMatchObject({
      kind: 'shuttle-message', direction: 'sent', peer: 'validation-follow-up',
      fiber: 'research/workspace/validation-follow-up', text: 'Confirm the north patch cut.', status: 'pending',
      hideTool: true, rawCommand: command,
    })
  })

  it('lifts every Shuttle send from separate Codex exec_command calls', () => {
    const first = 'shuttle message work/first "The first check is ready."'
    const second = 'shuttle message work/second "The second check is ready."'
    const code = `await tools.exec_command({cmd: ${JSON.stringify(first)}}); await tools.exec_command({cmd: ${JSON.stringify(second)}})`
    const entries = normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'codex-batch', name: 'exec', input: { code },
    } })
    expect(entries.slice(0, 2)).toMatchObject([
      { kind: 'shuttle-message', direction: 'sent', fiber: 'work/first', text: 'The first check is ready.' },
      { kind: 'shuttle-message', direction: 'sent', fiber: 'work/second', text: 'The second check is ready.' },
    ])
    expect(entries).toHaveLength(2)
    expect(entries.every(entry => entry.kind === 'shuttle-message' && entry.hideTool)).toBe(true)
  })

  it('keeps stdin sends as rows when the command receives a dash positional', () => {
    const entries = normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'stdin-call', name: 'Bash', input: { command: 'printf hello | shuttle message work/child -' },
    }] } })
    expect(entries[0]).toMatchObject({
      kind: 'shuttle-message', direction: 'sent', fiber: 'work/child', text: '', source: 'standard input',
    })
  })

  it.each([
    ['Claude Code', { type: 'attachment', timestamp: time, attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true,
      origin: { kind: 'peer' }, prompt: '[Shuttle message msg-1234 from shuttle://host-b/codex/peer-session; reply to research/workspace/validation-follow-up]\nThe north patch looks stable.' } }],
    ['Pi', { type: 'message', timestamp: time, message: { role: 'user', content: [{ type: 'text', text: '[Shuttle message msg-1234 from shuttle://host-b/codex/peer-session; reply to research/workspace/validation-follow-up]\nThe north patch looks stable.' }] } }],
    ['Codex', { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[Shuttle message msg-1234 from shuttle://host-b/codex/peer-session; reply to research/workspace/validation-follow-up]\nThe north patch looks stable.' }] } }],
  ])('reads an incoming %s message as a delivery, not a user turn', (_harness, record) => {
    expect(normalizeRecord(record)).toEqual([expect.objectContaining({
      kind: 'shuttle-message', id: 'msg-1234', direction: 'received', peer: 'validation-follow-up',
      fiber: 'research/workspace/validation-follow-up',
      address: 'shuttle://host-b/codex/peer-session',
      text: 'The north patch looks stable.',
    })])
  })

  it.each([
    ['before target', 'shuttle message --file result.txt research/workspace/validation-follow-up'],
    ['after target', 'shuttle message research/workspace/validation-follow-up --file result.txt'],
    ['equals form', 'shuttle message research/workspace/validation-follow-up --file=result.txt'],
  ])('keeps a file-based send row when --file appears %s', (_where, fileCommand) => {
    const entries = normalizeRecord({ type: 'assistant', timestamp: time, message: { content: [{
      type: 'tool_use', id: 'file-call', name: 'Bash', input: { command: fileCommand },
    }] } })
    expect(entries[0]).toMatchObject({
      kind: 'shuttle-message', direction: 'sent', fiber: 'research/workspace/validation-follow-up',
      peer: 'validation-follow-up', text: '', source: 'file: result.txt',
    })
    expect(entries).toHaveLength(1)
  })

  it('keeps the native tool step when a send shares a command with other work', () => {
    const mixed = 'make test && shuttle message work/child "The table is ready."'
    const entries = normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'mixed-call', name: 'Bash', input: { command: mixed },
    }] } })
    expect(entries.map(entry => entry.kind)).toEqual(['shuttle-message', 'tool'])
    expect(entries[0]).toMatchObject({ kind: 'shuttle-message', hideTool: false })
    expect(entries[0]).not.toHaveProperty('rawCommand')
  })

  it('uses command-substitution heredoc text and excludes heredoc bodies from command scanning', () => {
    const command = `shuttle message work/child "$(cat <<'EOF'\nThe first line\nand the second.\nEOF\n)"`
    const entries = normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'heredoc-call', name: 'Bash', input: { command },
    }] } })
    expect(entries[0]).toMatchObject({ kind: 'shuttle-message', text: 'The first line\nand the second.' })

    const stdin = `cat <<'EOF'\nshuttle message work/phantom "Not a send."\nEOF\nshuttle message work/child - <<'BODY'\nThe actual message.\nBODY`
    const fromStdin = normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'stdin-heredoc', name: 'Bash', input: { command: stdin },
    }] } })
    expect(fromStdin).toMatchObject([
      { kind: 'shuttle-message', fiber: 'work/child', text: 'The actual message.' },
      { kind: 'tool' },
    ])

    for (const command of [
      `shuttle message work/child <<'BODY' -\nMessage through the trailing stdin argument.\nBODY`,
      `shuttle message work/child --file - <<'BODY'\nMessage through --file stdin.\nBODY`,
    ]) {
      const entries = normalizeRecord({ type: 'assistant', message: { content: [{
        type: 'tool_use', id: 'stdin-variant', name: 'Bash', input: { command },
      }] } })
      expect(entries[0]).toMatchObject({ kind: 'shuttle-message', text: expect.stringContaining('Message through') })
    }
  })

  it('preserves a literal single-quoted command substitution as message text', () => {
    const literal = '$(cat <<EOF\nLiteral code example\nEOF\n)'
    const command = `shuttle message work/child '${literal}'`
    const entries = normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'literal-heredoc', name: 'Bash', input: { command },
    }] } })
    expect(entries[0]).toMatchObject({ kind: 'shuttle-message', text: literal })
  })

  it('does not absorb redirects or pipeline commands into the message text', () => {
    const command = 'shuttle message work/child "The table is ready." 2>&1 | tail > result.txt'
    const entries = normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'redirect-call', name: 'Bash', input: { command },
    }] } })
    expect(entries[0]).toMatchObject({ kind: 'shuttle-message', text: 'The table is ready.', hideTool: false })
  })

  it.each(['1>errors.txt', '2>errors.txt', '1> errors.txt', '2> errors.txt'])(
    'does not add descriptor redirect %s to the message body', redirect => {
      const command = `shuttle message work/child "Ready." ${redirect}`
      const entries = normalizeRecord({ type: 'assistant', message: { content: [{
        type: 'tool_use', id: `redirect-${redirect.replace(/\\W/g, '')}`, name: 'Bash', input: { command },
      }] } })
      expect(entries[0]).toMatchObject({ kind: 'shuttle-message', text: 'Ready.' })
    },
  )

  it.each([
    ['persistent flags after the verb', 'shuttle message -C ~/loom --store loom work/child "Ready."', 'Ready.'],
    ['a dash-prefixed body', 'shuttle message work/child -- -ready', '-ready'],
    ['timeout', 'timeout 10 shuttle message work/child "Ready."', 'Ready.'],
    ['bash login command', "bash -lc 'shuttle message work/child Ready.'", 'Ready.'],
  ])('recognizes %s', (_shape, command, text) => {
    const entries = normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'shape-call', name: 'Bash', input: { command },
    }] } })
    expect(entries[0]).toMatchObject({ kind: 'shuttle-message', text })
  })

  it('recognizes Codex shell command arrays', () => {
    const entries = normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call', call_id: 'codex-array', name: 'exec_command',
      arguments: JSON.stringify({ command: ['shuttle', 'message', 'work/child', '-ready'] }),
    } })
    expect(entries).toEqual([expect.objectContaining({ kind: 'shuttle-message', text: '-ready' })])
  })

  it('reads a delivered thread result as a message from that thread', () => {
    const result = `[Shuttle message thread-${'a'.repeat(64)}]\nthread research/workspace/child closed: The table is ready.`
    expect(normalizeRecord({ type: 'user', timestamp: time, message: { content: result } })).toEqual([expect.objectContaining({
      kind: 'shuttle-message', direction: 'received', peer: 'child', fiber: 'research/workspace/child',
      verb: 'closed', text: 'The table is ready.',
    })])
  })

  it('does not classify quoted messages or a shell search as deliveries', () => {
    expect(normalizeRecord({ type: 'assistant', message: { content: [{ type: 'text', text: '[Shuttle message msg-1234 from shuttle://host/pi/session]\nquoted' }] } }))
      .toEqual([expect.objectContaining({ kind: 'text' })])
    const search = 'grep -l "shuttle message research/workspace/validation-follow-up \"Not a send.\"" files'
    expect(normalizeRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search', name: 'Bash', input: { command: search } }] } }))
      .toEqual([expect.objectContaining({ kind: 'tool' })])
  })

  it.each([
    ['Claude Code', { type: 'user', message: { content: 'This quoted note contains a pasted header:\n[Shuttle message msg-1234 from peer]\nNot an incoming delivery.' } }],
    ['Pi', { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'This quoted note contains a pasted header:\n[Shuttle message msg-1234 from peer]\nNot an incoming delivery.' }] } }],
    ['Codex', { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'This quoted note contains a pasted header:\n[Shuttle message msg-1234 from peer]\nNot an incoming delivery.' }] } }],
  ])('does not promote an unanchored pasted header from %s prompt prose', (_harness, record) => {
    expect(normalizeRecord(record)).toEqual([expect.objectContaining({ kind: 'prompt', text: expect.stringContaining('This quoted note') })])
  })
})
