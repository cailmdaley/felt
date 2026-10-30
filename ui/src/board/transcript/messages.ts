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
  /** The session-id suffix remains visible when a long host label is clipped. */
  peerSuffix?: string
  target?: string
  /** A caller-supplied receipt id that identifies this delivery. */
  messageId?: string
  text: string
  source?: string
  verb?: 'closed' | 'asked' | 'handed off' | 'rested'
  toolId?: string
  status?: 'pending' | 'sent' | 'failed' | 'uncertain'
  commandIndex?: number
  commandCount?: number
  commandSegmentCount?: number
  /** The shell command containing this send has no runtime receipt-producing substitutions. */
  receiptSafe?: boolean
  /** Hide a tool call that contains only sends; its source is shown in the expanded row. */
  hideTool?: boolean
  /** The Codex wrapper can report an error from a non-shell operation. */
  resultMayBeUnattributed?: boolean
  rawCommand?: string
  /** The result output attached to a failed or unclear pure send. */
  outcomeText?: string
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

function sessionLabel(address: string): Pick<ShuttleMessage, 'peer' | 'peerSuffix'> {
  const match = /^shuttle:\/\/([^/]+)\/([^/]+)(?:\/([^/?#]+))?/.exec(address)
  if (!match) return { peer: 'session' }
  const host = match[1]
  const harness = match[2]
  const session = match[3]
  const shortSession = session ? ` · ${session.slice(-6)}` : ''
  return {
    peer: `${harness.charAt(0).toUpperCase()}${harness.slice(1)} · ${host}${shortSession}`,
    ...(shortSession ? { peerSuffix: shortSession } : {}),
  }
}

function senderLabel(sender: string): string {
  const label = sender.trim().replace(/\s+/g, ' ')
  return label.length <= 48 ? label : `${label.slice(0, 47)}…`
}

function peerFor(target: string): Pick<ShuttleMessage, 'peer' | 'peerSuffix' | 'fiber' | 'address' | 'target'> {
  const fiber = fiberCandidate(target)
  if (fiber) return { peer: leaf(fiber), fiber, target }
  if (target.startsWith('shuttle://')) return { ...sessionLabel(target), target, address: target }
  return { peer: `Session · ${target.slice(-8)}`, target }
}

/** A host-owned record of the complete envelope offered to this receiving session. */
export interface MessageProvenance { id: string; envelope: string; thread?: boolean }

/** Match whole ledgered deliveries, so a quoted header cannot introduce a boundary. */
export function shuttleMessageParts(source: string, provenance: readonly MessageProvenance[]): Array<string | MessageProvenance> {
  const parts: Array<string | MessageProvenance> = []
  const trusted = [...provenance].filter(item => item.envelope.startsWith(`[Shuttle message ${item.id}`))
    .sort((a, b) => b.envelope.length - a.envelope.length)
  const header = /(?:^|\n)\[Shuttle message /g
  let consumed = 0
  for (const match of source.matchAll(header)) {
    const start = match.index! + (match[0].startsWith('\n') ? 1 : 0)
    if (start < consumed) continue
    const delivery = trusted.find(item => source.startsWith(item.envelope, start)
      && /^(?:\s|<\/system-reminder\s*>|$)/.test(source.slice(start + item.envelope.length)))
    if (!delivery) continue
    if (start > consumed) parts.push(source.slice(consumed, start))
    parts.push(delivery)
    consumed = start + delivery.envelope.length
  }
  if (consumed < source.length) parts.push(source.slice(consumed))
  return parts
}

/** Only a complete envelope recorded by the receiving host can name a sender. */
export function shuttleMessages(source: string, at?: number, anchored = false, provenance: readonly MessageProvenance[] = []): ShuttleMessage[] {
  if (anchored && !/^\s*\[Shuttle message /.test(source)) return []
  const messages: ShuttleMessage[] = []
  for (const part of shuttleMessageParts(source, provenance)) {
    if (typeof part === 'string') continue
    const match = /^\[Shuttle message ([^\s\]\r\n]+)([^\]\r\n]*)\]\r?\n([\s\S]*)$/.exec(part.envelope)
    if (!match || match[1] !== part.id) continue
    const id = match[1]
    const metadata = match[2]
    const body = match[3].trim()
    const result = /^thread ([^\s<>]+) (closed|asked|handed off|rested):[ \t]*([\s\S]*)$/.exec(body)
    if (part.thread === true && id.startsWith('thread-') && result && THREAD_VERB.has(result[2])) {
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
    if (!sender) continue
    const address = sender.startsWith('shuttle://') ? sender : undefined
    const session = address ? sessionLabel(address) : undefined
    const replyTo = /;\s*reply to\s+([^\]\r\n]+)/.exec(metadata)?.[1]?.trim()
    const fiber = replyTo ? fiberCandidate(replyTo) : undefined
    messages.push(withTime({
      kind: 'shuttle-message' as const,
      id,
      direction: 'received' as const,
      peer: fiber ? leaf(fiber) : session?.peer ?? senderLabel(sender),
      ...(fiber ? { fiber } : {}),
      ...(address ? { address } : {}),
      ...(session?.peerSuffix ? { peerSuffix: session.peerSuffix } : {}),
      ...(replyTo ? { target: replyTo } : {}),
      text: body,
    }, at))
  }
  return messages
}

type ToolCall = { id: string; name: string; input: unknown; at?: number }
type ShellCommand = { words: string[]; chain: number; impure: boolean }
type ShellParse = { commands: ShellCommand[]; substitutions: Map<string, string>; heredocs: Map<string, string> }
type ParsedSend = { target: string; text: string; source?: string; messageId?: string }
type CommandCollection = { sends: ParsedSend[]; chains: Map<string, boolean>; segmentCount: number }

const GLOBAL_VALUE_FLAGS = new Set(['-C', '--store'])
const MESSAGE_VALUE_FLAGS = new Set(['--file', '--message-id', '--from', '--attach'])
const MESSAGE_FLAGS = new Set(['--context-only', '--notify-wake', '--notify-when-idle', '--wake', '--json', '-j'])
const CAT_HEREDOC = /^\$\(\s*cat\s+<<-?\s*(['"]?)([\w.-]+)\1[\t ]*\r?\n([\s\S]*?)\r?\n\2[\t ]*\r?\n?[\t ]*\)/

function optionValue(words: string[], index: number, flags: Set<string>): { flag: string; value?: string; next: number } | undefined {
  const word = words[index]
  for (const flag of flags) {
    if (word === flag) return { flag, value: words[index + 1], next: index + 2 }
    if (word.startsWith(`${flag}=`)) return { flag, value: word.slice(flag.length + 1), next: index + 1 }
  }
  return undefined
}

function expandCatHereDocs(source: string): { source: string; substitutions: Map<string, string> } {
  const substitutions = new Map<string, string>()
  let next = 0
  let output = ''
  let quote = ''
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = []
  let index = 0
  while (index < source.length) {
    if (pending.length && (index === 0 || source[index - 1] === '\n')) {
      const newline = source.indexOf('\n', index)
      const end = newline < 0 ? source.length : newline
      const line = source.slice(index, end).replace(/\r$/, '')
      const current = pending[0]
      const comparable = current.stripTabs ? line.replace(/^\t+/, '') : line
      output += source.slice(index, newline < 0 ? source.length : newline + 1)
      if (comparable === current.delimiter) pending.shift()
      index = newline < 0 ? source.length : newline + 1
      continue
    }

    const char = source[index]
    if (quote === "'") {
      output += char
      if (char === "'") quote = ''
      index++
      continue
    }
    if (char === '\\') {
      output += char
      if (index + 1 < source.length) output += source[++index]
      index++
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ''
    } else if (char === "'" || char === '"') {
      quote = char
    }
    if (char === '$') {
      const match = CAT_HEREDOC.exec(source.slice(index))
      if (match) {
        const marker = `__FELT_HEREDOC_${next++}__`
        substitutions.set(marker, match[3])
        output += marker
        index += match[0].length
        continue
      }
    }
    if (!quote && char === '<' && source[index + 1] === '<' && source[index + 2] !== '<') {
      const lineStart = source.lastIndexOf('\n', index - 1) + 1
      const lineEnd = source.indexOf('\n', index)
      const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd)
      const heredoc = readHereDocDelimiter(line, index - lineStart)
      if (heredoc) pending.push({ delimiter: heredoc.delimiter, stripTabs: heredoc.stripTabs })
    }
    output += char
    index++
  }
  return { source: output, substitutions }
}

function readHereDocDelimiter(line: string, start: number): { delimiter: string; stripTabs: boolean; expand: boolean; end: number } | undefined {
  let index = start + 2
  let stripTabs = false
  if (line[index] === '-') { stripTabs = true; index++ }
  while (line[index] === ' ' || line[index] === '\t') index++
  const quote = line[index] === "'" || line[index] === '"' ? line[index++] : ''
  const startWord = index
  while (index < line.length && (quote ? line[index] !== quote : !/[\s;|&<>]/.test(line[index]))) index++
  const delimiter = line.slice(startWord, index)
  if (!delimiter) return undefined
  if (quote && line[index] === quote) index++
  return { delimiter, stripTabs, expand: quote === '', end: index }
}

/** Replace here-document bodies with tokens before tokenizing; bodies are input, never commands. */
function stripHereDocBodies(source: string): { source: string; bodies: Map<string, string>; impure: Set<string> } {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const output: string[] = []
  const bodies = new Map<string, string>()
  const impure = new Set<string>()
  const pending: Array<{ delimiter: string; stripTabs: boolean; expand: boolean; marker: string; lines: string[] }> = []
  let next = 0
  let quote = ''
  let escaped = false

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (pending.length) {
      const current = pending[0]
      const bodyLine = line.replace(/\r?\n$/, '')
      const comparable = current.stripTabs ? bodyLine.replace(/^\t+/, '') : bodyLine
      if (comparable === current.delimiter) {
        const body = current.lines.join('\n')
        bodies.set(current.marker, body)
        if (current.expand && hasHereDocCommandSubstitution(body)) impure.add(current.marker)
        pending.shift()
      } else current.lines.push(comparable)
      if (/\r?\n$/.test(line) && pending.length === 0) output.push('\n')
      continue
    }

    let cleaned = ''
    for (let index = 0; index < line.length; index++) {
      const char = line[index]
      if (escaped) { cleaned += char; escaped = false; continue }
      if (quote === "'") { cleaned += char; if (char === "'") quote = ''; continue }
      if (quote === '"') {
        cleaned += char
        if (char === '"') quote = ''
        else if (char === '\\') escaped = true
        continue
      }
      if (char === '\\') { cleaned += char; escaped = true; continue }
      if (char === "'" || char === '"') { quote = char; cleaned += char; continue }
      if (char === '<' && line[index + 1] === '<' && line[index + 2] !== '<') {
        const heredoc = readHereDocDelimiter(line, index)
        if (heredoc) {
          const marker = `__FELT_INPUT_HEREDOC_${next++}__`
          pending.push({ delimiter: heredoc.delimiter, stripTabs: heredoc.stripTabs, expand: heredoc.expand, marker, lines: [] })
          cleaned += ` ${marker} `
          index = heredoc.end - 1
          continue
        }
      }
      cleaned += char
    }
    output.push(cleaned)
  }
  return { source: output.join(''), bodies, impure }
}

function hasHereDocCommandSubstitution(source: string): boolean {
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue }
    if (source[index] === '`' || source[index] === '$' && source[index + 1] === '(') return true
  }
  return false
}

function hasRuntimeSubstitution(source: string): boolean {
  let quote = ''
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (escaped) { escaped = false; continue }
    if (quote === "'") { if (char === "'") quote = ''; continue }
    if (quote === '"') {
      if (char === '"') quote = ''
      else if (char === '\\') escaped = true
      else if (char === '`' || char === '$' && source[index + 1] === '(') return true
      continue
    }
    if (char === '\\') { escaped = true; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '`' || char === '$' && source[index + 1] === '('
      || (char === '<' || char === '>') && source[index + 1] === '(') return true
  }
  return false
}

function redirectionEnd(source: string, start: number): number {
  let index = start
  if (source[index] === '&' && source[index + 1] === '>') index += 2
  else {
    const operator = source[index]
    index++
    while (source[index] === operator) index++
    if ((source[index] === '&' || source[index] === '|') && operator !== source[index]) index++
  }
  while (source[index] === ' ' || source[index] === '\t') index++
  if (index >= source.length || /[\r\n;|&]/.test(source[index])) return index
  let quote = ''
  let escaped = false
  for (; index < source.length; index++) {
    const char = source[index]
    if (escaped) { escaped = false; continue }
    if (quote === "'") { if (char === "'") quote = ''; continue }
    if (quote === '"') { if (char === '"') quote = ''; else if (char === '\\') escaped = true; continue }
    if (char === '\\') { escaped = true; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (/\s/.test(char) || /[;|&<>]/.test(char)) break
  }
  return index
}

function parenthesizedEnd(source: string, open: number): number {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (escaped) { escaped = false; continue }
    if (quote === "'") { if (char === "'") quote = ''; continue }
    if (quote === '"') {
      if (char === '"') quote = ''
      else if (char === '\\') escaped = true
      continue
    }
    if (char === '\\') { escaped = true; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '(') depth++
    else if (char === ')' && --depth === 0) return index + 1
  }
  return source.length
}

function backtickEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue }
    if (source[index] === '`') return index + 1
  }
  return source.length
}

function shellSegments(source: string): ShellParse {
  const expanded = expandCatHereDocs(source)
  const heredocs = stripHereDocBodies(expanded.source)
  const clean = heredocs.source
  const commands: ShellCommand[] = []
  let words: string[] = []
  let word = ''
  let active = false
  let quote = ''
  let escaped = false
  let chain = 0
  let commandImpure = false

  const pushWord = () => {
    if (active) {
      let value = word
      for (const [marker, body] of expanded.substitutions) {
        if (value.includes(marker)) commandImpure = true
        value = value.split(marker).join(body)
      }
      for (const marker of heredocs.impure) {
        if (value.includes(marker)) commandImpure = true
      }
      words.push(value)
    }
    word = ''
    active = false
  }
  const pushPipelineCommand = () => {
    pushWord()
    if (words.length) commands.push({ words, chain, impure: commandImpure })
    words = []
    commandImpure = false
  }
  const pushSequence = () => {
    const hadCommand = words.length > 0 || active
    pushPipelineCommand()
    if (hadCommand) chain++
  }

  for (let index = 0; index < clean.length; index++) {
    const char = clean[index]
    if (escaped) {
      if (char !== '\n') word += char
      active = true
      escaped = false
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = ''
      else word += char
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ''
      else if ((char === '$' && clean[index + 1] === '(') || char === '`') {
        const end = char === '`' ? backtickEnd(clean, index) : parenthesizedEnd(clean, index + 1)
        commandImpure = true
        word += clean.slice(index, end)
        active = true
        index = end - 1
      } else if (char === '\\' && index + 1 < clean.length) {
        const next = clean[index + 1]
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') escaped = true
        else word += char
      } else word += char
      continue
    }
    if ((char === '<' || char === '>') && clean[index + 1] === '(') {
      const end = parenthesizedEnd(clean, index + 1)
      commandImpure = true
      word += clean.slice(index, end)
      active = true
      index = end - 1
      continue
    }
    if ((char === '<' || char === '>') || char === '&' && clean[index + 1] === '>') {
      if (/^\d+$/.test(word)) { word = ''; active = false }
      else pushWord()
      const end = redirectionEnd(clean, index)
      if (hasRuntimeSubstitution(clean.slice(index, end))) commandImpure = true
      index = end - 1
      continue
    }
    if (char === '\\') { escaped = true; active = true; continue }
    if (char === "'" || char === '"') { quote = char; active = true; continue }
    if (char === '`') {
      const end = backtickEnd(clean, index)
      commandImpure = true
      word += clean.slice(index, end)
      active = true
      index = end - 1
      continue
    }
    if (char === '$' && clean[index + 1] === '(') {
      // Keep command substitutions intact so their arguments cannot become shell separators.
      let depth = 1, end = index + 2, nestedQuote = ''
      for (; end < clean.length && depth > 0; end++) {
        const nestedChar = clean[end]
        if (nestedQuote === "'") { if (nestedChar === "'") nestedQuote = ''; continue }
        if (nestedQuote === '"') { if (nestedChar === '"') nestedQuote = ''; else if (nestedChar === '\\') end++; continue }
        if (nestedChar === "'" || nestedChar === '"') nestedQuote = nestedChar
        else if (nestedChar === '(') depth++
        else if (nestedChar === ')') depth--
      }
      word += clean.slice(index, end)
      active = true
      commandImpure = true
      index = end - 1
      continue
    }
    if (char === '|' && clean[index + 1] !== '|') {
      pushPipelineCommand()
      continue
    }
    if (char === '&' && clean[index + 1] === '&') {
      pushSequence()
      index++
      continue
    }
    if (char === '|' && clean[index + 1] === '|') {
      pushSequence()
      index++
      continue
    }
    if (char === ';' || char === '\n' || char === '&') {
      pushSequence()
      if (char === '&') while (clean[index + 1] === '&') index++
      continue
    }
    if (/\s/.test(char)) { pushWord(); continue }
    word += char
    active = true
  }
  pushPipelineCommand()
  return { commands, substitutions: expanded.substitutions, heredocs: heredocs.bodies }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function messageCommand(words: string[], heredocs: Map<string, string>): { target: string; text: string; source?: string; messageId?: string } | null {
  let index = 0
  while (words[index] === 'env') index++
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index++
  if (words[index] === 'command') index++
  if (words[index] === 'timeout') {
    index++
    while (words[index]?.startsWith('-')) {
      const option = words[index]
      if (['-k', '--kill-after', '-s', '--signal'].includes(option)) index += 2
      else index++
    }
    if (words[index] && /^\d/.test(words[index])) index++
  }
  if (words[index]?.split('/').at(-1) !== 'shuttle') return null
  index++
  while (index < words.length) {
    const option = optionValue(words, index, GLOBAL_VALUE_FLAGS)
    if (option) { index = option.next; continue }
    if (words[index] === '--json' || words[index] === '-j') { index++; continue }
    break
  }
  if (words[index++] !== 'message') return null
  let target: string | undefined
  const text: string[] = []
  let source: string | undefined
  let messageId: string | undefined
  let heredocText: string | undefined
  const heredocMarkers: string[] = []
  let stdin = false
  let attachments = false
  let options = true
  const noteValueFlag = (flag: string, value?: string): void => {
    if (flag === '--file') {
      if (value === '-') { source = 'standard input'; stdin = true }
      else source = value ? `file: ${value}` : 'file'
    }
    if (flag === '--attach') {
      attachments = true
      source = source ?? (value ? `attachment: ${value}` : 'attachment')
    }
    if (flag === '--message-id' && value) messageId = value
  }
  for (; index < words.length; index++) {
    const word = words[index]
    if (heredocs.has(word)) {
      heredocMarkers.push(word)
      continue
    }
    if (options && word === '--') { options = false; continue }
    if (options) {
      const global = optionValue(words, index, GLOBAL_VALUE_FLAGS)
      const option = optionValue(words, index, MESSAGE_VALUE_FLAGS)
      if (global) { index = global.next - 1; continue }
      if (option) { noteValueFlag(option.flag, option.value); index = option.next - 1; continue }
      if (MESSAGE_FLAGS.has(word) || /^--wake=/.test(word)) {
        if (word === '--notify-when-idle') source = source ?? 'idle notification'
        continue
      }
      if (!target && word.startsWith('-')) continue
    }
    if (!target) target = word
    else if (word === '-' && text.length === 0) { source = source ?? 'standard input'; stdin = true }
    else text.push(word)
  }
  if (!target) return null
  if (stdin && heredocMarkers.length) heredocText = heredocs.get(heredocMarkers.at(-1)!)
  const body = heredocText ?? text.join(' ')
  const bodySource = heredocText === undefined ? source : undefined
  if (!body && !bodySource && !attachments) return null
  return {
    target,
    text: body,
    ...(bodySource ? { source: bodySource } : {}),
    ...(attachments && !body ? { source: bodySource ?? 'attachment' } : {}),
    ...(messageId ? { messageId } : {}),
  }
}

function shellWrapper(words: string[]): string | undefined {
  let index = 0
  while (words[index] === 'env') index++
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index++
  if (words[index] === 'timeout') {
    index++
    while (words[index]?.startsWith('-')) {
      if (['-k', '--kill-after', '-s', '--signal'].includes(words[index])) index += 2
      else index++
    }
    if (words[index] && /^\d/.test(words[index])) index++
  }
  const program = words[index]?.split('/').at(-1)
  if (!['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(program ?? '')) return undefined
  for (let flag = index + 1; flag < words.length; flag++) {
    if (words[flag] === '-c' || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[flag])) return words[flag + 1]
  }
  return undefined
}

function collectShell(source: string, namespace: string, depth = 0): CommandCollection {
  if (depth > 4) return { sends: [], chains: new Map(), segmentCount: 0 }
  const parsed = shellSegments(source)
  const sends: ParsedSend[] = []
  const chains = new Map<string, boolean>()
  let segmentCount = 0
  for (const command of parsed.commands) {
    const key = `${namespace}.${command.chain}`
    const wrapped = shellWrapper(command.words)
    if (wrapped !== undefined) {
      const nested = collectShell(wrapped, key, depth + 1)
      segmentCount += nested.segmentCount
      for (const [nestedKey, hasSend] of nested.chains) chains.set(nestedKey, hasSend && !command.impure)
      sends.push(...nested.sends)
      if (!nested.chains.size) chains.set(key, false)
      continue
    }
    segmentCount++
    const send = messageCommand(command.words, parsed.heredocs)
    chains.set(key, (chains.get(key) ?? true) && !!send && !command.impure)
    if (send) sends.push(send)
  }
  return { sends, chains, segmentCount }
}

function toolCommands(tool: ToolCall): string[] {
  const input = object(tool.input)
  if (tool.name === 'exec') return codexCommands(tool.input)
  const command = input?.command
  if (Array.isArray(command) && command.every((part): part is string => typeof part === 'string')) {
    return [command.map(shellQuote).join(' ')]
  }
  return [string(command) ?? string(input?.cmd) ?? string(tool.input)].filter((value): value is string => Boolean(value))
}

function codexWrapperIsShellOnly(input: unknown, parsedCommands: number): boolean {
  const code = typeof input === 'string' ? input : object(input)?.code
  if (typeof code !== 'string') return false

  let index = 0
  let calls = 0
  let commands = 0
  const skipSpace = (): void => {
    while (/\s/.test(code[index] ?? '')) index++
  }
  const consume = (token: string): boolean => {
    skipSpace()
    if (!code.startsWith(token, index)) return false
    index += token.length
    return true
  }
  const consumeWord = (word: string): boolean => {
    skipSpace()
    if (!code.startsWith(word, index) || /[\w$]/.test(code[index + word.length] ?? '')) return false
    index += word.length
    return true
  }
  const readString = (): boolean => {
    skipSpace()
    const quote = code[index]
    if (quote !== '"' && quote !== "'" && quote !== '`') return false
    index++
    while (index < code.length) {
      const char = code[index++]
      if (char === '\\') { index++; continue }
      if (char === quote) return true
      if (quote !== '`' && (char === '\n' || char === '\r')) return false
      if (quote === '`' && char === '$' && code[index] === '{') return false
    }
    return false
  }
  const readKey = (): string | undefined => {
    skipSpace()
    if (code[index] === '"' || code[index] === "'") {
      const start = index
      if (!readString()) return undefined
      const raw = code.slice(start + 1, index - 1)
      return raw.includes('\\') ? undefined : raw
    }
    const match = /^[A-Za-z_$][\w$]*/.exec(code.slice(index))
    if (!match) return undefined
    index += match[0].length
    return match[0]
  }
  const readStaticValue = (depth = 0): boolean => {
    if (depth > 8) return false
    skipSpace()
    if (code[index] === '"' || code[index] === "'" || code[index] === '`') return readString()
    if (code[index] === '[' || code[index] === '{') {
      const close = code[index] === '[' ? ']' : '}'
      index++
      skipSpace()
      if (consume(close)) return true
      while (index < code.length) {
        if (close === '}') {
          const key = readKey()
          if (key === undefined || !consume(':') || !readStaticValue(depth + 1)) return false
        } else if (!readStaticValue(depth + 1)) return false
        skipSpace()
        if (consume(close)) return true
        if (!consume(',')) return false
        skipSpace()
        if (consume(close)) return true
      }
      return false
    }
    const literal = /^(?:true|false|null)(?![\w$])/.exec(code.slice(index))
    if (literal) { index += literal[0].length; return true }
    const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(code.slice(index))
    if (number) { index += number[0].length; return true }
    return false
  }
  const readCommandCall = (): boolean => {
    skipSpace()
    let wrapped = false
    if (code.startsWith('text', index) && !/[\w$]/.test(code[index + 4] ?? '')) {
      index += 4
      if (!consume('(')) return false
      wrapped = true
    }
    if (!consumeWord('await') || !consumeWord('tools') || !consume('.') || !consumeWord('exec_command') || !consume('(') || !consume('{')) return false
    let commandProperties = 0
    while (index < code.length) {
      skipSpace()
      if (consume('}')) break
      const key = readKey()
      if (key === undefined || !consume(':')) return false
      if (key === 'cmd') {
        if (!readString()) return false
        commandProperties++
      } else if (!readStaticValue()) return false
      skipSpace()
      if (consume('}')) break
      if (!consume(',')) return false
    }
    if (commandProperties !== 1 || !consume(')') || (wrapped && !consume(')'))) return false
    return true
  }

  while (index < code.length) {
    skipSpace()
    while (consume(';')) skipSpace()
    if (index >= code.length) break
    if (!readCommandCall()) return false
    calls++
    commands++
    skipSpace()
    if (index < code.length && !consume(';')) return false
  }
  return calls > 0 && calls === parsedCommands && commands === parsedCommands
}

/** Outgoing shell calls become a separate row; pure-send tool calls fold into that row's detail. */
export function sentShuttleMessages(tool: ToolCall): ShuttleMessage[] {
  if (!/^(bash|shell|exec|exec_command|terminal|command|run_terminal_cmd)$/i.test(tool.name)) return []
  const commands = toolCommands(tool)
  if (!commands.length) return []
  const collected = commands.map((command, index) => collectShell(command, `cmd${index}`))
  const parsedSends = collected.flatMap(result => result.sends)
  if (!parsedSends.length) return []
  const allChains = new Map(collected.flatMap(result => [...result.chains]))
  const shellOnlyWrapper = tool.name !== 'exec' || codexWrapperIsShellOnly(tool.input, commands.length)
  const pureSend = allChains.size > 0 && [...allChains.values()].every(Boolean) && shellOnlyWrapper
  return parsedSends.map((parsed, index) => {
    const peer = peerFor(parsed.target)
    const commandIndex = collected.findIndex(result => result.sends.includes(parsed))
    const commandChains = [...(collected[commandIndex]?.chains.values() ?? [])]
    const receiptSafe = shellOnlyWrapper && commandChains.length > 0 && commandChains.every(Boolean)
    return withTime({
      kind: 'shuttle-message' as const,
      id: `sent:${tool.id}:${index}`,
      direction: 'sent' as const,
      ...peer,
      ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
      text: parsed.text,
      ...(parsed.source ? { source: parsed.source } : {}),
      toolId: tool.id,
      commandIndex,
      commandCount: commands.length,
      commandSegmentCount: collected[commandIndex]?.segmentCount ?? 1,
      ...(receiptSafe ? { receiptSafe: true } : {}),
      hideTool: pureSend,
      ...(tool.name === 'exec' && !shellOnlyWrapper ? { resultMayBeUnattributed: true } : {}),
      ...(pureSend ? { rawCommand: commands[commandIndex] } : {}),
      status: 'pending' as const,
    }, tool.at)
  })
}
