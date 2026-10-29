import { codexCommands } from './tools.js'

export interface ShuttleMessage {
  kind: 'shuttle-message'
  /** The native message id or the transcript-local id of the sending tool call. */
  id: string
  direction: 'sent' | 'received'
  /** A short visible label; addresses and ids stay out of the collapsed row. */
  peer: string
  /** A fiber candidate, resolved into the board's existing constitution chip when available. */
  fiber?: string
  /** The original address or target, retained for future detail views. */
  address?: string
  target?: string
  text: string
  source?: string
  verb?: 'closed' | 'asked' | 'handed off' | 'rested'
  toolId?: string
  status?: 'pending' | 'sent' | 'failed' | 'uncertain'
  commandIndex?: number
  commandCount?: number
  commandSegmentCount?: number
  at?: number
}

const THREAD_VERBS = ['closed', 'asked', 'handed off', 'rested'] as const
const THREAD_VERB = new Set<string>(THREAD_VERBS)

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function withTime<T extends object>(value: T, at?: number): T | (T & { at: number }) {
  return at === undefined ? value : { ...value, at }
}

function leaf(value: string): string {
  return value.split('/').filter(Boolean).at(-1) ?? value
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value) || /^[0-9a-f]{24,}$/i.test(value)
}

function fiberCandidate(value: string): string | undefined {
  if (value.startsWith('shuttle://') || isSessionId(value)) return undefined
  return value
}

function sessionLabel(address: string): string {
  const match = /^shuttle:\/\/([^/]+)\/([^/]+)\//.exec(address)
  if (!match) return 'session'
  const harness = match[2]
  return `${harness.charAt(0).toUpperCase()}${harness.slice(1)} · ${match[1]}`
}

function senderLabel(sender: string): string {
  const label = sender.trim().replace(/\s+/g, ' ')
  return label.length <= 48 ? label : `${label.slice(0, 47)}…`
}

function peerFor(target: string): Pick<ShuttleMessage, 'peer' | 'fiber' | 'address' | 'target'> {
  const fiber = fiberCandidate(target)
  if (fiber) return { peer: leaf(fiber), fiber, target }
  return {
    peer: target.startsWith('shuttle://') ? sessionLabel(target) : `Session · ${target.slice(-8)}`,
    target,
    ...(target.startsWith('shuttle://') ? { address: target } : {}),
  }
}

const DELIVERY = /\[Shuttle message ([^\s\]\r\n]+)([^\]\r\n]*)\]\r?\n([\s\S]*?)(?=\r?\n\[Shuttle message |\s*<\/system-reminder\s*>|$)/g

/** Peer mailboxes and daemon thread results are explicit user-context envelopes. */
export function shuttleMessages(source: string, at?: number): ShuttleMessage[] {
  const messages: ShuttleMessage[] = []
  for (const match of source.matchAll(DELIVERY)) {
    const id = match[1]
    const metadata = match[2]
    const body = match[3].trim()
    const result = /^thread ([^\s<>]+) (closed|asked|handed off|rested):[ \t]*([\s\S]*)$/.exec(body)
    if (id.startsWith('thread-') && result && THREAD_VERB.has(result[2])) {
      const fiber = result[1]
      messages.push(withTime({
        kind: 'shuttle-message' as const,
        id,
        direction: 'received' as const,
        peer: leaf(fiber),
        fiber,
        target: fiber,
        text: result[3].trim(),
        verb: result[2] as ShuttleMessage['verb'],
      }, at))
      continue
    }

    const sender = /(?:^|\s)from\s+([^;\]\r\n]+)/.exec(metadata)?.[1]?.trim()
    if (!sender || id.startsWith('thread-')) continue
    const address = sender.startsWith('shuttle://') ? sender : undefined
    const replyTo = /;\s*reply to\s+([^\]\r\n]+)/.exec(metadata)?.[1]?.trim()
    const fiber = replyTo ? fiberCandidate(replyTo) : undefined
    messages.push(withTime({
      kind: 'shuttle-message' as const,
      id,
      direction: 'received' as const,
      peer: fiber ? leaf(fiber) : address ? sessionLabel(address) : senderLabel(sender),
      ...(fiber ? { fiber } : {}),
      ...(address ? { address } : {}),
      ...(replyTo ? { target: replyTo } : {}),
      text: body,
    }, at))
  }
  return messages
}

type ToolCall = { id: string; name: string; input: unknown; at?: number }

function shellSegments(source: string): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let active = false
  let quote = ''
  let escaped = false
  const pushWord = () => {
    if (active) words.push(word)
    word = ''
    active = false
  }
  const pushSegment = () => {
    pushWord()
    if (words.length) segments.push(words)
    words = []
  }

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (escaped) {
      if (char !== '\n') word += char
      active = true
      escaped = false
    } else if (quote === "'") {
      if (char === "'") quote = ''
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = ''
      else if (char === '\\' && index + 1 < source.length) escaped = true
      else word += char
    } else if (char === '\\') {
      escaped = true
      active = true
    } else if (char === "'" || char === '"') {
      quote = char
      active = true
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      pushSegment()
      while (index + 1 < source.length && (source[index + 1] === char || char === '&' && source[index + 1] === '|')) index++
    } else if (/\s/.test(char)) pushWord()
    else {
      word += char
      active = true
    }
  }
  pushSegment()
  return segments
}

const GLOBAL_VALUE_FLAGS = new Set(['-C', '--store'])
const MESSAGE_VALUE_FLAGS = new Set(['--file', '--message-id', '--from', '--attach'])
const MESSAGE_FLAGS = new Set(['--context-only', '--notify-wake', '--notify-when-idle', '--wake', '--json', '-j'])

function skipValueFlag(words: string[], index: number, flags: Set<string>): number | undefined {
  const word = words[index]
  if (flags.has(word)) return index + 2
  for (const flag of flags) if (word.startsWith(`${flag}=`)) return index + 1
  return undefined
}

function optionValue(words: string[], index: number, flags: Set<string>): { flag: string; value?: string; next: number } | undefined {
  const word = words[index]
  for (const flag of flags) {
    if (word === flag) return { flag, value: words[index + 1], next: index + 2 }
    if (word.startsWith(`${flag}=`)) return { flag, value: word.slice(flag.length + 1), next: index + 1 }
  }
  return undefined
}

function messageCommand(words: string[]): { target: string; text: string; source?: string } | null {
  let executable = 0
  if (words[executable] === 'env') executable++
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executable] ?? '')) executable++
  const program = words[executable]?.split('/').at(-1)
  if (program !== 'shuttle') return null
  let index = executable + 1
  while (index < words.length) {
    const skipped = skipValueFlag(words, index, GLOBAL_VALUE_FLAGS)
    if (skipped !== undefined) { index = skipped; continue }
    if (words[index] === '--json' || words[index] === '-j') { index++; continue }
    break
  }
  if (words[index++] !== 'message') return null
  let target: string | undefined
  const text: string[] = []
  let source: string | undefined
  let attachments = false
  const noteValueFlag = (flag: string, value?: string): void => {
    if (flag === '--file') source = value ? `file: ${value}` : 'file'
    if (flag === '--attach') {
      attachments = true
      source = source ?? (value ? `attachment: ${value}` : 'attachment')
    }
  }
  for (; index < words.length; index++) {
    const word = words[index]
    const option = optionValue(words, index, MESSAGE_VALUE_FLAGS)
    if (option) {
      noteValueFlag(option.flag, option.value)
      index = option.next - 1
    } else if (MESSAGE_FLAGS.has(word) || /^--(?:wake|store)=/.test(word)) {
      if (word === '--notify-when-idle') source = source ?? 'idle notification'
    } else if (!target && word.startsWith('-')) continue
    else if (!target) target = word
    else if (word === '-' && text.length === 0) source = source ?? 'standard input'
    else if (word.startsWith('-')) continue
    else text.push(word)
  }
  if (!target) return null
  const body = text.join(' ')
  if (!body && !source && !attachments) return null
  return { target, text: body, ...(source ? { source } : {}), ...(attachments && !body ? { source: source ?? 'attachment' } : {}) }
}

/** Outgoing shell calls become a separate row; their native tool record remains alongside them. */
export function sentShuttleMessages(tool: ToolCall): ShuttleMessage[] {
  if (!/^(bash|shell|exec|exec_command|terminal|command|run_terminal_cmd)$/i.test(tool.name)) return []
  const input = object(tool.input)
  const commands = tool.name === 'exec'
    ? codexCommands(tool.input)
    : [string(input?.command) ?? string(input?.cmd) ?? string(tool.input)].filter((command): command is string => Boolean(command))
  if (!commands.length) return []
  const messages: ShuttleMessage[] = []
  for (const [commandIndex, command] of commands.entries()) {
    const segments = shellSegments(command)
    for (const words of segments) {
      const parsed = messageCommand(words)
      if (!parsed) continue
      const peer = peerFor(parsed.target)
      messages.push(withTime({
        kind: 'shuttle-message' as const,
        id: `sent:${tool.id}:${messages.length}`,
        direction: 'sent' as const,
        ...peer,
        text: parsed.text,
        ...(parsed.source ? { source: parsed.source } : {}),
        toolId: tool.id,
        commandIndex,
        commandCount: commands.length,
        commandSegmentCount: segments.length,
        status: 'pending' as const,
      }, tool.at))
    }
  }
  return messages
}
