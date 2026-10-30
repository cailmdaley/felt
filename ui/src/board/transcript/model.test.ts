import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { TranscriptModel, segments, type Step, type Turn } from './model.js'
import { normalizeRecord, type Entry } from './records.js'

const entry: fc.Arbitrary<Entry> = fc.oneof(
  fc.record({ text: fc.string(), images: fc.nat(3), dispatch: fc.boolean(), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'prompt', ...value } as Entry)),
  fc.record({ text: fc.string(), model: fc.option(fc.constantFrom('opus', 'sonnet'), { nil: undefined }), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'text', ...value } as Entry)),
  fc.record({ text: fc.string(), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'thinking', ...value } as Entry)),
  fc.record({ id: fc.constantFrom('call-a', 'call-b'), name: fc.constantFrom('Bash', 'Read'), input: fc.anything(), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'tool', ...value } as Entry)),
  fc.record({ id: fc.constantFrom('call-a', 'call-b'), text: fc.string(), isError: fc.boolean(), images: fc.nat(2), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'result', ...value } as Entry)),
  fc.record({ label: fc.constantFrom('Skill', 'Context'), detail: fc.option(fc.string(), { nil: undefined }), text: fc.option(fc.string(), { nil: undefined }), at: fc.option(fc.nat(20_000), { nil: undefined }) })
    .map((value) => ({ kind: 'event', ...value } as Entry)),
)

const snapshot = (turns: readonly Turn[]): Turn[] => JSON.parse(JSON.stringify(turns)) as Turn[]

function modelAfterCodexExec(commands: string[], output: string): TranscriptModel {
  const model = new TranscriptModel()
  const code = commands.map(command => `text(await tools.exec_command({cmd: ${JSON.stringify(command)}}))`).join('; ')
  model.append(normalizeRecord({ type: 'response_item', payload: {
    type: 'custom_tool_call', call_id: 'exec-send', name: 'exec', input: { code },
  } }))
  const result = normalizeRecord({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'exec-send', output,
  } })
  model.append(result)
  return model
}

function modelAfterBash(command: string, output: string, isError = false): TranscriptModel {
  const model = new TranscriptModel()
  model.append(normalizeRecord({ type: 'assistant', message: { content: [{
    type: 'tool_use', id: 'bash-send', name: 'Bash', input: { command },
  }] } }))
  model.append(normalizeRecord({ type: 'user', message: { content: [{
    type: 'tool_result', tool_use_id: 'bash-send', content: output, is_error: isError,
  }] } }))
  return model
}

describe('TranscriptModel', () => {
  it('does not treat prose about a process exit as structured exit status', () => {
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call', call_id: 'send-call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'shuttle message work/child "The table is ready."' }),
    } }))
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'send-call', output: 'Process exited with code 1',
    } }))
    const steps = model.turns.flatMap(turn => turn.steps)
    expect(steps.find(step => step.kind === 'shuttle-message')).toMatchObject({ status: 'uncertain' })
    expect(steps.find(step => step.kind === 'tool')).toBeUndefined()
  })

  it('uses the structured Codex process status to mark a failed send', () => {
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call', call_id: 'send-call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'shuttle message work/child "The table is ready."' }),
    } }))
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'send-call', exit_code: 1, output: 'receiver unavailable',
    } }))
    const steps = model.turns.flatMap(turn => turn.steps)
    expect(steps.find(step => step.kind === 'shuttle-message')).toMatchObject({
      status: 'failed', outcomeText: 'receiver unavailable',
    })
    expect(steps.find(step => step.kind === 'tool')).toBeUndefined()
  })

  it('marks a Codex exec-wrapper message failed when its nested shell output is JSON', () => {
    const command = 'shuttle message work/child "The table is ready."'
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'exec-send', name: 'exec',
      input: { code: `text(await tools.exec_command({cmd: ${JSON.stringify(command)}}))` },
    } }))
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'exec-send',
      output: 'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":1,"output":"Error: receiver unavailable"}',
    } }))
    const steps = model.turns.flatMap(turn => turn.steps)
    expect(steps.find(step => step.kind === 'shuttle-message')).toMatchObject({
      status: 'failed', outcomeText: 'Error: receiver unavailable',
    })
    expect(steps.find(step => step.kind === 'tool')).toBeUndefined()
  })

  it('reads raw-string Codex exec input and matches its caller-supplied receipt id', () => {
    const command = 'shuttle message --message-id follow-up work/child "Ready."'
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'exec-string-send', name: 'exec',
      input: `text(await tools.exec_command({cmd: ${JSON.stringify(command)}}))`,
    } }))
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'exec-string-send',
      output: 'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":"accepted shuttle://host/codex/session (follow-up)"}',
    } }))
    const steps = model.turns.flatMap(turn => turn.steps)
    expect(steps.find(step => step.kind === 'shuttle-message')).toMatchObject({ status: 'sent', messageId: 'follow-up' })
    expect(steps.find(step => step.kind === 'tool')).toBeUndefined()
  })

  it.each([
    ['accepted', 'accepted shuttle://host/codex/session (follow-up(2))'],
    ['queued', "queued for work/child's next worker (follow-up(2))"],
  ])('matches a %s receipt with parentheses in its message id', (_status, receipt) => {
    const command = `shuttle message --message-id 'follow-up(2)' work/child "Ready."`
    const messages = modelAfterCodexExec(
      [command],
      `Script completed\nWall time 0.1s\nOutput:\n${JSON.stringify({ exit_code: 0, output: receipt })}`,
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ messageId: 'follow-up(2)', status: 'sent' }])
  })

  it('keeps delivery unclear when a mixed Codex wrapper fails outside its shell call', () => {
    const command = 'shuttle message work/child "Ready."'
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'exec-send', name: 'exec',
      input: { code: `const result = await tools.exec_command({cmd: ${JSON.stringify(command)}}); await tools.apply_patch(badPatch)` },
    } }))
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'exec-send', is_error: true, output: 'patch rejected',
    } }))
    const steps = model.turns.flatMap(turn => turn.steps)
    expect(steps.find(step => step.kind === 'shuttle-message')).toMatchObject({
      status: 'uncertain', resultMayBeUnattributed: true,
    })
    expect(steps.find(step => step.kind === 'tool')?.kind).toBe('tool')
  })

  it('does not attribute an indexed shell failure to a later send after an unparsed call', () => {
    const command = 'shuttle message work/child "Ready."'
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'exec-indexed-send', name: 'exec',
      input: { code: `text({i:0,result:await tools.exec_command({cmd: buildCommand})}); await tools.exec_command({cmd: ${JSON.stringify(command)}})` },
    } }))
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'exec-indexed-send', is_error: true,
      output: 'Script completed\nWall time 0.1s\nOutput:\n{"i":0,"result":{"exit_code":1,"output":"unrelated failure"}}',
    } }))
    const steps = model.turns.flatMap(turn => turn.steps)
    expect(steps.find(step => step.kind === 'shuttle-message')).toMatchObject({
      status: 'uncertain', resultMayBeUnattributed: true,
    })
    expect(steps.find(step => step.kind === 'tool')?.kind).toBe('tool')
  })

  it('keeps an explicit unknown Shuttle receipt unclear despite its nonzero exit status', () => {
    const messages = modelAfterCodexExec(
      ['shuttle message --message-id msg-abc work/child "The table is ready."'],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":1,"output":"unknown shuttle://host/codex/session (msg-abc)"}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain' }])
  })

  it.each([
    ['accepted', 0, 'sent'],
    ['unknown', 1, 'uncertain'],
  ] as const)('matches a custom message ID in an explicit %s receipt', (status, exitCode, expected) => {
    const command = 'shuttle message --message-id follow-up work/child "Ready."'
    const receipt = `${status} shuttle://host/codex/session (follow-up)`
    const output = `Script completed\nWall time 0.1s\nOutput:\n${JSON.stringify({ exit_code: exitCode, output: receipt })}`
    const messages = modelAfterCodexExec([command], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: expected }])
  })

  it.each([
    ['accepted', 0, 'sent'],
    ['unknown', 1, 'uncertain'],
  ] as const)('matches a custom message ID in a pretty-printed JSON %s receipt', (status, exitCode, expected) => {
    const command = 'shuttle message --message-id follow-up work/child "Ready."'
    const receipt = JSON.stringify({
      message_id: 'follow-up',
      address: 'shuttle://host/codex/session',
      status,
      transport: 'codex',
    }, null, 2)
    const output = `Script completed\nWall time 0.1s\nOutput:\n${JSON.stringify({
      exit_code: exitCode,
      output: `sending follow-up to shuttle://host/codex/session\n${receipt}`,
    })}`
    const messages = modelAfterCodexExec([command], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: expected }])
  })

  it('does not let an unrelated accepted receipt override an unknown custom message id', () => {
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'send-call', name: 'Bash',
      input: { command: 'shuttle message --message-id intended work/child "Ready." && cat old-receipt.txt' },
    }] } }))
    model.append(normalizeRecord({ type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'send-call', is_error: true,
      content: 'unknown shuttle://host/codex/session (intended)\naccepted shuttle://host/codex/session (unrelated)',
    }] } }))
    const message = model.turns.flatMap(turn => turn.steps).find(step => step.kind === 'shuttle-message')
    expect(message).toMatchObject({ status: 'uncertain', messageId: 'intended' })
  })

  it('uses explicit indices when concurrent nested commands finish out of order', () => {
    const first = 'shuttle message work/first "First result."'
    const second = 'shuttle message work/second "Second result."'
    const output = 'Script completed\nWall time 0.1s\nOutput:\n{"i":1,"result":{"exit_code":1,"output":"receiver unavailable"}}\n{"i":0,"result":{"exit_code":0,"output":"accepted work/first (msg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)"}}'
    const messages = modelAfterCodexExec([first, second], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/first', status: 'sent' },
      { fiber: 'work/second', status: 'failed' },
    ])
  })

  it('keeps a send successful when another nested shell command fails', () => {
    const send = 'shuttle message work/child "The table is ready."'
    const output = 'Script completed\nWall time 0.1s\nOutput:\n{"i":0,"result":{"exit_code":0,"output":"accepted work/child (msg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)"}}\n{"i":1,"result":{"exit_code":1,"output":"unrelated command failed"}}'
    const messages = modelAfterCodexExec([send, 'printf unrelated'], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ fiber: 'work/child', status: 'sent' }])
  })

  it('leaves batched sends unclear when an aggregate failure cannot be assigned', () => {
    const first = 'shuttle message work/first "First result."'
    const second = 'shuttle message work/second "Second result."'
    const output = 'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":1,"output":"receiver unavailable"}'
    const messages = modelAfterCodexExec([first, second], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/first', status: 'uncertain' },
      { fiber: 'work/second', status: 'uncertain' },
    ])
  })

  it('does not infer command identity from the count of unindexed concurrent results', () => {
    const first = 'shuttle message work/first "First result."'
    const second = 'shuttle message work/second "Second result."'
    const output = 'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":"accepted"}\n{"exit_code":1,"output":"receiver unavailable"}'
    const messages = modelAfterCodexExec([first, second], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/first', status: 'uncertain' },
      { fiber: 'work/second', status: 'uncertain' },
    ])
  })

  it('uses a matching Shuttle receipt when another result field has an unrelated exit code', () => {
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call', call_id: 'send-call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'shuttle message work/child "The table is ready."' }),
    } }))
    model.append(normalizeRecord({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'send-call', exit_code: 1, output: 'accepted work/child (msg-cccccccccccccccccccccccccccccccc)\n{"exit_code":1}',
    } }))
    const steps = model.turns.flatMap(turn => turn.steps)
    expect(steps.find(step => step.kind === 'shuttle-message')).toMatchObject({ status: 'sent' })
    expect(steps.find(step => step.kind === 'tool')).toBeUndefined()
  })

  it('assigns a target-matched receipt only to its send in a shared shell call', () => {
    const first = 'shuttle message work/first "First result."'
    const second = 'shuttle message work/second "Second result."'
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'shared-send', name: 'Bash', input: { command: `${first}; ${second}` },
    }] } }))
    model.append(normalizeRecord({ type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'shared-send', content: `accepted work/first (msg-dddddddddddddddddddddddddddddddd)`,
    }] } }))
    const messages = model.turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/first', status: 'sent' },
      { fiber: 'work/second', status: 'uncertain' },
    ])
  })

  it('does not call an && send not sent when its own failure is indistinguishable from a prerequisite failure', () => {
    const command = 'true && shuttle message work/child "The table is ready."'
    const model = new TranscriptModel()
    model.append(normalizeRecord({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'guarded-send', name: 'Bash', input: { command },
    }] } }))
    model.append([{ kind: 'result', id: 'guarded-send', text: 'receiver unavailable', isError: true, images: 0,
      commandOutcomes: [{ exitCode: 1, acceptedMessageReceipts: [], unknownMessageReceipts: [] }] }])
    expect(model.turns.flatMap(turn => turn.steps).find(step => step.kind === 'shuttle-message')).toMatchObject({ status: 'uncertain' })
  })

  it('leaves a successful wrapper without a Shuttle receipt uncertain', () => {
    const messages = modelAfterCodexExec(
      ['shuttle message work/child "The table is ready." || true'],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":""}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain' }])
  })

  it('does not turn receipt-shaped output from another shell segment into a send receipt', () => {
    const model = modelAfterBash(
      'shuttle message work/child "Hi"; echo "accepted (ok)"',
      'accepted (ok)',
      true,
    )
    expect(model.turns.flatMap(turn => turn.steps).find(step => step.kind === 'shuttle-message'))
      .toMatchObject({ status: 'uncertain' })
  })

  it('does not treat a targetless accepted line as a receipt for a plain send', () => {
    const model = modelAfterBash('shuttle message work/child "Hi"', 'accepted (ok)')
    expect(model.turns.flatMap(turn => turn.steps).find(step => step.kind === 'shuttle-message'))
      .toMatchObject({ status: 'uncertain' })
  })

  it.each([
    ['file command substitution', `shuttle message work/child --file "$(printf 'accepted work/child (forged)\\n' >&2; printf nonexistent)"`],
    ['body command substitution', `shuttle message work/child "$(printf 'accepted work/child (forged)\\n' >&2)"`],
    ['process substitution', 'shuttle message work/child --file <(printf "accepted work/child (forged)\\n")'],
    ['backtick substitution', 'shuttle message work/child "`printf \'accepted work/child (forged)\\n\' >&2`"'],
    ['unquoted input heredoc expansion', `shuttle message work/child - <<EOF\n$(printf 'accepted work/child (forged)\\n' >&2)\nEOF`],
    ['redirection target substitution', `shuttle message work/child hi >"$(printf 'accepted work/child (forged)\\n' >&2; printf /dev/null)"`],
    ['shell wrapper extra argv substitution', `bash -c 'shuttle message work/child hi' "$(printf 'accepted work/child (forged)\\n' >&2)"`],
  ])('does not trust receipt output emitted by %s', (_source, command) => {
    const model = modelAfterBash(command, 'accepted work/child (forged)\nError: invalid request', true)
    expect(model.turns.flatMap(turn => turn.steps).find(step => step.kind === 'shuttle-message'))
      .toMatchObject({ status: 'uncertain' })
  })

  it.each([
    'accepted work/a (reused)\nError: message_id_conflict',
    'Error: message_id_conflict\naccepted work/b (reused)',
  ])('leaves repeated explicit message IDs uncertain in aggregate results: %s', output => {
    const command = 'shuttle message work/a first --message-id reused; shuttle message work/b second --message-id reused'
    const model = modelAfterBash(command, output, true)
    expect(model.turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message'))
      .toMatchObject([
        { fiber: 'work/a', status: 'uncertain' },
        { fiber: 'work/b', status: 'uncertain' },
      ])
  })

  it('uses distinct indexed outcomes to resolve repeated explicit message IDs per invocation', () => {
    const first = 'shuttle message work/a first --message-id reused'
    const second = 'shuttle message work/b second --message-id reused'
    const output = 'Script completed\nWall time 0.1s\nOutput:\n{"i":0,"result":{"exit_code":0,"output":"accepted work/a (reused)"}}\n{"i":1,"result":{"exit_code":1,"output":"Error: message_id_conflict"}}'
    const messages = modelAfterCodexExec([first, second], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/a', status: 'sent' },
      { fiber: 'work/b', status: 'failed' },
    ])
  })

  it('keeps repeated IDs uncertain when an indexed result omits one invocation', () => {
    const first = 'shuttle message work/a first --message-id reused'
    const second = 'shuttle message work/b second --message-id reused'
    const output = 'Script completed\nWall time 0.1s\nOutput:\n{"i":0,"result":{"exit_code":0,"output":"accepted work/a (reused)"}}'
    const messages = modelAfterCodexExec([first, second], output).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/a', status: 'uncertain' },
      { fiber: 'work/b', status: 'uncertain' },
    ])
  })

  it('does not trust an indexed receipt when its corresponding shell command has non-send segments', () => {
    const message = 'shuttle message --message-id wanted work/child "Hi" && echo done'
    const result = 'Script completed\nWall time 0.1s\nOutput:\n{"i":0,"result":{"exit_code":0,"output":"accepted work/child (wanted)"}}'
    const messages = modelAfterCodexExec([message], result).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain', messageId: 'wanted' }])
  })

  it('does not trust a JSON receipt from a recovery command in a compound shell segment', () => {
    const receipt = JSON.stringify({ status: 'accepted', fiber: 'work/child', message_id: 'msg-1234567890abcdef' })
    const model = modelAfterCodexExec(
      ['shuttle message work/child "Hi" || cat notes.txt'],
      `Script completed\nWall time 0.1s\nOutput:\n${JSON.stringify({ exit_code: 0, output: receipt })}`,
    )
    expect(model.turns.flatMap(turn => turn.steps).find(step => step.kind === 'shuttle-message'))
      .toMatchObject({ status: 'uncertain' })
  })

  it.each(['|| true', '; true', '| tail'])('does not trust a resolved message receipt through `%s`', (suffix) => {
    const messages = modelAfterCodexExec(
      [`shuttle message work/child "The table is ready." ${suffix}`],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":"accepted shuttle://host/claude/123e4567-e89b-12d3-a456-426614174000 (msg-1234567890abcdef)"}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ fiber: 'work/child', status: 'uncertain' }])
  })

  it('does not treat an accepted lifecycle receipt as a message receipt', () => {
    const messages = modelAfterCodexExec(
      ['shuttle message work/child "The table is ready."'],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":"accepted run for work/child (re-armed; message queued)"}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain' }])
  })

  it('matches the queued next-worker receipt to its fiber target', () => {
    const messages = modelAfterCodexExec(
      ['shuttle message work/child "The table is ready."'],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":"queued for work/child\'s next worker (msg-1234567890abcdef)"}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ fiber: 'work/child', status: 'sent' }])
  })

  it('matches a partial queued receipt to the send with its exact fiber target', () => {
    const messages = modelAfterBash([
      'shuttle message work/first "First result."',
      'shuttle message work/second "Second result."',
    ].join('; '), 'queued for work/second\'s next worker (msg-second)')
      .turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/first', status: 'uncertain' },
      { fiber: 'work/second', status: 'sent' },
    ])
  })

  it('does not guess which duplicate-target send a partial receipt belongs to', () => {
    const messages = modelAfterBash([
      'shuttle message work/child "First result."',
      'shuttle message work/child "Second result."',
    ].join('; '), 'queued for work/child\'s next worker (msg-one)')
      .turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/child', status: 'uncertain' },
      { fiber: 'work/child', status: 'uncertain' },
    ])
  })

  it('does not trust a JSON queued receipt through a shell wrapper', () => {
    const receipt = JSON.stringify({
      status: 'queued_for_next_worker',
      fiber: 'work/child',
      message_id: 'msg-1234567890abcdef',
    })
    const messages = modelAfterCodexExec(
      ['shuttle message work/child "The table is ready." || true'],
      `Script completed\nWall time 0.1s\nOutput:\n${JSON.stringify({ exit_code: 0, output: receipt })}`,
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ fiber: 'work/child', status: 'uncertain' }])
  })

  it('does not resolve session-address receipts to fiber-target sends', () => {
    const model = modelAfterBash([
      'shuttle message work/first "First result."',
      'shuttle message work/second "Second result."',
    ].join('; '), [
      'accepted shuttle://host/claude/123e4567-e89b-12d3-a456-426614174000 (msg-first)',
      'accepted shuttle://host/claude/123e4567-e89b-12d3-a456-426614174001 (msg-second)',
    ].join('\n'))
    const messages = model.turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([
      { fiber: 'work/first', status: 'uncertain' },
      { fiber: 'work/second', status: 'uncertain' },
    ])
  })

  it('requires a direct session receipt to match its requested address', () => {
    const target = 'shuttle://host/claude/123e4567-e89b-12d3-a456-426614174000'
    const messages = modelAfterCodexExec(
      [`shuttle message ${target} "The table is ready." || true`],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":"accepted shuttle://host/claude/123e4567-e89b-12d3-a456-426614174999 (msg-1234567890abcdef)"}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain' }])
  })

  it('does not resolve a native session ID through a receipt address', () => {
    const target = '123e4567-e89b-12d3-a456-426614174000'
    const messages = modelAfterCodexExec(
      [`shuttle message ${target} "The table is ready." || true`],
      `Script completed\nWall time 0.1s\nOutput:\n${JSON.stringify({
        exit_code: 0,
        output: `accepted shuttle://host/claude/${target} (msg-1234567890abcdef)`,
      })}`,
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain' }])
  })

  it('does not match a native session ID to a different session receipt', () => {
    const target = '123e4567-e89b-12d3-a456-426614174000'
    const messages = modelAfterCodexExec(
      [`shuttle message ${target} "The table is ready." || true`],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":0,"output":"accepted shuttle://host/claude/123e4567-e89b-12d3-a456-426614174001 (msg-1234567890abcdef)"}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain' }])
  })

  it('ignores JSON output that lacks the structured process-result shape', () => {
    const messages = modelAfterCodexExec(
      ['shuttle message work/child "The table is ready."'],
      'Script completed\nWall time 0.1s\nOutput:\n{"exit_code":1}',
    ).turns.flatMap(turn => turn.steps).filter(step => step.kind === 'shuttle-message')
    expect(messages).toMatchObject([{ status: 'uncertain' }])
  })

  it('folds entries before the first prompt into a null-prompt turn and attaches results by id', () => {
    const model = new TranscriptModel()
    model.append([
      { kind: 'text', text: 'preface', model: 'opus', at: 1 },
      { kind: 'tool', id: 'a', name: 'Bash', input: { command: 'pytest' }, at: 2 },
      { kind: 'result', id: 'a', text: 'ok', isError: false, images: 0, at: 3 },
      { kind: 'result', id: 'unknown', text: 'dropped', isError: false, images: 0 },
      { kind: 'prompt', text: 'Inspect the mask split.', images: 0, dispatch: false, at: 4 },
      { kind: 'text', text: 'First answer.', at: 5 },
      { kind: 'text', text: 'Last answer.', model: 'sonnet', at: 6 },
      { kind: 'tool', id: 'b', name: 'Read', input: { path: 'response.py' }, at: 7 },
      { kind: 'result', id: 'b', text: 'not found', isError: true, images: 0, at: 8 },
      { kind: 'prompt', text: 'Second prompt.', images: 1, dispatch: true, at: 9 },
    ])

    expect(model.turns).toHaveLength(3)
    expect(model.turns[0]).toMatchObject({ prompt: null, answer: 0, steps: [
      { kind: 'text', text: 'preface' },
      { kind: 'tool', id: 'a', result: { text: 'ok', isError: false, images: 0 }, version: 1 },
    ] })
    expect(model.turns[1]).toMatchObject({ prompt: { text: 'Inspect the mask split.' }, answer: 1, steps: [
      { kind: 'text', text: 'First answer.' }, { kind: 'text', text: 'Last answer.' },
      { kind: 'tool', id: 'b', result: { text: 'not found', isError: true }, version: 1 },
    ] })
    expect(model.turns[2]).toMatchObject({ prompt: { text: 'Second prompt.' }, steps: [], answer: -1 })
    expect(model.toolCounts(model.turns[1])).toEqual({ Read: 1 })
    expect(model.stats()).toEqual({ turns: 3, tools: 2, startedAt: 1, endedAt: 9, model: 'opus' })
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0, 1, 2] })
    expect(model.takeChanges()).toEqual({ reset: false, turns: [] })
  })

  it('marks a prior turn dirty when a late tool result arrives and resets cleanly', () => {
    const model = new TranscriptModel()
    model.append([
      { kind: 'prompt', text: 'Run the null test.', images: 0, dispatch: false },
      { kind: 'tool', id: 'call', name: 'Bash', input: 'pytest' },
      { kind: 'prompt', text: 'Now inspect the split.', images: 0, dispatch: false },
    ])
    model.takeChanges()
    model.append([{ kind: 'result', id: 'call', text: 'passed', isError: false, images: 0 }])
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0] })
    expect(model.turns[0].version).toBe(3)

    model.reset()
    expect(model.turns).toEqual([])
    expect(model.takeChanges()).toEqual({ reset: true, turns: [] })
    model.append([{ kind: 'prompt', text: 'Fresh session', images: 0, dispatch: false }])
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0] })
  })

  it('places current send rows at their timestamps and moves them when transcript turns arrive', () => {
    const model = new TranscriptModel()
    const send = (id: string, at: number) => ({
      kind: 'sent-file' as const,
      id,
      sessionId: 'session',
      at,
      timestamp: at,
      files: [{ fullPath: `/tmp/${id}.png`, basename: `${id}.png`, timestamp: at, sessionId: 'session' }],
    })

    model.setSentFiles([send('send-3', 3)])
    expect(model.turns).toHaveLength(0)
    model.append([
      { kind: 'prompt', text: 'First prompt', images: 0, dispatch: false, at: 1 },
      { kind: 'text', text: 'Before send', at: 2 },
      { kind: 'text', text: 'After send', at: 4 },
      { kind: 'prompt', text: 'Second prompt', images: 0, dispatch: false, at: 8 },
      { kind: 'text', text: 'Second answer', at: 9 },
    ])
    model.placeSentFiles()

    expect(model.turns.map((turn) => turn.steps.map((step) => step.kind))).toEqual([
      ['text', 'sent-file', 'text'],
      ['text'],
    ])
    expect(segments(model.turns[0].steps).map((part) => part.kind)).toEqual(['text', 'sent-file', 'text'])
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0, 1] })

    model.setSentFiles([send('send-6', 6)])
    expect(model.turns[0].steps.map((step) => step.kind)).toEqual(['text', 'text', 'sent-file'])
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0] })
    model.placeSentFiles()
    expect(model.takeChanges()).toEqual({ reset: false, turns: [] })
    model.setSentFiles([])
    expect(model.turns.flatMap(turn => turn.steps).some(step => step.kind === 'sent-file')).toBe(false)
    expect(model.takeChanges()).toEqual({ reset: false, turns: [0] })
  })

  it('is invariant to splitting a record sequence across append calls', () => {
    fc.assert(fc.property(
      fc.array(entry, { maxLength: 40 }),
      fc.array(fc.boolean(), { maxLength: 40 }),
      (entries, cuts) => {
        const whole = new TranscriptModel()
        whole.append(entries)

        const chunked = new TranscriptModel()
        let start = 0
        for (let i = 0; i < entries.length; i++) {
          if (i === entries.length - 1 || cuts[i]) {
            chunked.append(entries.slice(start, i + 1))
            start = i + 1
          }
        }
        expect(snapshot(chunked.turns)).toEqual(snapshot(whole.turns))
      },
    ))
  })
})

describe('segments', () => {
  it('sets each agent message apart and folds the work between messages into runs', () => {
    const step = (kind: 'text' | 'thinking'): Step => ({ kind, text: kind })
    const tool: Step = { kind: 'tool', id: 'a', name: 'Bash', input: {}, version: 0 }
    expect(segments([])).toEqual([])
    expect(segments([step('thinking'), tool, step('text'), step('text'), tool])).toEqual([
      { kind: 'steps', start: 0, end: 2 },
      { kind: 'text', index: 2 },
      { kind: 'text', index: 3 },
      { kind: 'steps', start: 4, end: 5 },
    ])
  })

  it('covers every step exactly once, in order', () => {
    const steps = fc.array(fc.constantFrom<Step>(
      { kind: 'text', text: 't' }, { kind: 'thinking', text: 'th' }, { kind: 'tool', id: 'x', name: 'Read', input: {}, version: 0 },
      { kind: 'shuttle-message', id: 'n', direction: 'received', peer: 'child', fiber: 'work/child', target: 'work/child', verb: 'asked', text: 'Which?' },
    ))
    fc.assert(fc.property(steps, (list) => {
      const covered: number[] = []
      for (const part of segments(list)) {
        if (part.kind !== 'steps') {
          expect(list[part.index].kind).toBe(part.kind)
          covered.push(part.index)
        } else {
          for (let i = part.start; i < part.end; i++) {
            expect(list[i].kind).not.toBe('text')
            covered.push(i)
          }
        }
      }
      expect(covered).toEqual(list.map((_, index) => index))
    }))
  })
})
