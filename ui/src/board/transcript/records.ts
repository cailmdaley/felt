import { threadNotices, type ThreadNotice } from './threadNotices.js'

export type UsageEntry = {
  kind: 'usage'
  at?: number
  model?: string
  context?: number
  window?: number
  /** The context tokens this turn read from the prompt cache, where the harness records it. */
  cached?: number
  /** Only Claude's native usage records establish a cache TTL. */
  cache?: { read: number; write: number; hourWrite: number }
}

/**
 * An image a tool returned, kept as the record's own text: a base64 payload
 * with its media type, or a URL. Nothing is decoded until it is drawn.
 */
export type ResultImage = { mediaType: string; data: string } | { url: string }

export type Entry =
  | ThreadNotice
  | UsageEntry
  | { kind: 'prompt'; text: string; images: number; dispatch: boolean; at?: number }
  | { kind: 'text'; text: string; at?: number; model?: string }
  | { kind: 'thinking'; text: string; at?: number }
  | { kind: 'tool'; id: string; name: string; input: unknown; at?: number }
  | { kind: 'result'; id: string; text: string; isError: boolean; images: number; pictures?: ResultImage[]; at?: number }
  | { kind: 'event'; label: string; detail?: string; text?: string; at?: number; contextReset?: boolean; context?: number }

type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue
    : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function sumCounts(...values: unknown[]): number | undefined {
  const counts = values.map(count)
  return counts.every((n) => n !== undefined) ? counts.reduce<number>((total, n) => total + n!, 0) : undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function at<T extends object>(entry: T, time: number | undefined): T | (T & { at: number }) {
  return time === undefined ? entry : { ...entry, at: time }
}

function blocks(value: unknown): ObjectValue[] {
  return Array.isArray(value) ? value.map(object).filter((item): item is ObjectValue => item !== null) : []
}

function contentText(value: unknown, acceptedTypes: readonly string[] = ['text']): string {
  if (typeof value === 'string') return value
  return blocks(value)
    .filter((block) => typeof block.type !== 'string' || acceptedTypes.includes(block.type))
    .map((block) => string(block.text) ?? '')
    .filter(Boolean)
    .join('\n')
}

/** Claude's `{source: {type: 'base64', media_type, data}}`, Pi's `{data, mimeType}`, Codex's `{type: 'input_image', image_url}`. */
function resultImage(block: ObjectValue): ResultImage | null {
  const source = object(block.source)
  const data = string(source?.data) ?? string(block.data)
  const mediaType = string(source?.media_type) ?? string(block.mimeType) ?? string(block.media_type)
  if (data && mediaType?.startsWith('image/')) return { mediaType, data }
  const url = string(block.image_url) ?? string(source?.url)
  return url && /^(data:image\/|https?:)/.test(url) ? { url } : null
}

function resultContent(value: unknown): { text: string; images: number; pictures?: ResultImage[] } {
  if (typeof value === 'string') return { text: value, images: 0 }
  let images = 0
  const text: string[] = []
  const pictures: ResultImage[] = []
  for (const block of blocks(value)) {
    if (block.type === 'image' || block.type === 'input_image') {
      images++
      const picture = resultImage(block)
      if (picture) pictures.push(picture)
    }
    else if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') {
      const value = string(block.text)
      if (value) text.push(value)
    }
  }
  return { text: text.join('\n'), images, ...(pictures.length ? { pictures } : {}) }
}

function firstLine(text: string, limit = 80): string {
  const line = text.split(/\r?\n/, 1)[0].trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

function event(label: string, fields: { detail?: string; text?: string } = {}, time?: number): Extract<Entry, { kind: 'event' }> {
  return at({ kind: 'event' as const, label, ...fields }, time)
}

// Claude Code's own caveat after a peer message, in its known phrasings.
const PEER_CAVEAT = /\n\s*(?:This came from another Claude session|That "other Claude session" is)[^\n]*(?:permission laundering|teammate)[\s\S]*$/

function classifiedClaudeText(raw: string, isMeta: boolean, time?: number): Entry | null {
  const text = raw
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/gi, '')
    // Claude Code heads a relayed session message with a line of its own and
    // closes it with a paragraph of advice to the model; neither is the message.
    .replace(/^\s*Another Claude session sent a message:\s*/, '')
    .replace(PEER_CAVEAT, '')
    .trim()
  if (!text) return null

  if (isMeta && text.startsWith('Base directory for this skill:')) {
    const dir = /^Base directory for this skill:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/[\\/]+$/, '')
    const detail = dir?.split(/[\\/]/).filter(Boolean).pop()
    return event('Skill', { detail, text }, time)
  }
  if (isMeta) return event('Context', { detail: firstLine(text), text }, time)
  if (text.startsWith('<task-notification')) {
    const detail = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(text)?.[1]?.trim()
    return event('Task', { detail, text }, time)
  }
  if (text.startsWith('<teammate-message')) {
    const detail = /\bteammate_id\s*=\s*(["'])(.*?)\1/i.exec(text)?.[2]
    return event('Teammate', { detail, text: innerText(text) }, time)
  }
  if (text.startsWith('<cross-session-message') || text.startsWith('<agent-message')) {
    const detail = /\bfrom\s*=\s*(["'])(.*?)\1/i.exec(text)?.[2]
    return event('Message', { detail, text: innerText(text) }, time)
  }
  if (text.startsWith('<command-name>')) {
    const detail = /<command-name>([\s\S]*?)<\/command-name\s*>/i.exec(text)?.[1]?.trim()
    return event('Command', { detail }, time)
  }
  if (text.startsWith('<local-command-stdout>')) {
    return event('Command output', { text: innerText(text) }, time)
  }
  if (text.startsWith('<local-command-stderr>')) {
    return event('Command output', { text: innerText(text) }, time)
  }
  if (text.startsWith('<local-command-caveat>')) return null
  if (text.startsWith('<bash-input>')) {
    return event('Shell', { detail: firstLine(innerText(text)), text: innerText(text) }, time)
  }
  if (/^<bash-(stdout|stderr)>/.test(text)) {
    return event('Shell output', { text: text.replace(/<\/?bash-(stdout|stderr)>/g, '').trim() || undefined }, time)
  }

  return at({ kind: 'prompt' as const, text, images: 0, dispatch: /^You are a Shuttle (?:[\w-]+ )?worker\b/.test(text) }, time)
}

function innerText(text: string): string {
  return text.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>\s*$/, '').trim()
}

function claudeUser(record: ObjectValue, message: ObjectValue, time?: number): Entry[] {
  const content = message.content
  if (record.isCompactSummary === true) {
    const summary = contentText(content)
    return [event('Compacted', { text: summary || undefined }, time)]
  }
  if (typeof content === 'string') {
    const classified = classifiedClaudeText(content, record.isMeta === true, time)
    return classified ? [classified] : []
  }

  const text: string[] = []
  const results: Entry[] = []
  let images = 0
  for (const block of blocks(content)) {
    if (block.type === 'text') {
      const value = string(block.text)
      if (value) text.push(value)
    } else if (block.type === 'image') {
      images++
    } else if (block.type === 'tool_result') {
      const result = resultContent(block.content)
      const id = string(block.tool_use_id)
      if (id) results.push(at({
        kind: 'result' as const,
        id,
        text: result.text,
        isError: block.is_error === true,
        images: result.images,
        ...(result.pictures ? { pictures: result.pictures } : {}),
      }, time))
    }
  }

  const joined = text.join('\n')
  const classified = joined ? classifiedClaudeText(joined, record.isMeta === true, time) : null
  if (classified?.kind === 'prompt' && images > 0) classified.images = images
  const prompt = !classified && images > 0
    ? at({ kind: 'prompt' as const, text: '', images, dispatch: false }, time)
    : null
  return [...(classified ? [classified] : prompt ? [prompt] : []), ...results]
}

/**
 * Claude Code's attachment records. A message typed while the agent worked
 * arrives as a queued command absorbed into the running turn. Context a hook
 * supplied (`shuttle hook`'s mailbox, which carries thread closes, asks,
 * handoffs and rests) arrives as `hook_additional_context`, never as a
 * system-reminder in a user record; only its thread deliveries are drawn.
 */
function claudeAttachment(record: ObjectValue): Entry[] {
  const attachment = object(record.attachment)
  if (attachment?.type === 'hook_additional_context') {
    const content = attachment.content
    const text = Array.isArray(content) ? content.filter((part): part is string => typeof part === 'string').join('\n') : string(content) ?? ''
    return threadNotices(text, timestamp(record.timestamp))
  }
  if (attachment?.type !== 'queued_command' || (attachment.commandMode ?? 'prompt') !== 'prompt') return []
  const time = timestamp(record.timestamp)
  // The prompt is a string, or blocks when the message carried images.
  const prompt = attachment.prompt
  const text = typeof prompt === 'string' ? prompt : contentText(prompt)
  const images = blocks(prompt).filter(block => block.type === 'image').length
  // Another session's message, injected as the queue's meta turn, is a delivery, never the human's.
  if (attachment.isMeta === true || object(attachment.origin)?.kind === 'peer') {
    const detail = /^\[Shuttle message \S+ from ([^;\]]+)/.exec(text)?.[1]
    return text ? [event('Message', { detail, text: text.replace(/^\[Shuttle message [^\]]*\]\n?/, '') }, time)] : []
  }
  const classified = text ? classifiedClaudeText(text, false, time) : null
  if (classified?.kind === 'prompt') return [{ ...classified, images }]
  if (classified) return [classified]
  return images ? [at({ kind: 'prompt' as const, text: '', images, dispatch: false }, time)] : []
}

function claudeRecord(record: ObjectValue): Entry[] {
  if (record.isSidechain === true) return []
  if (record.type === 'attachment') return claudeAttachment(record)
  if (!['user', 'assistant', 'system'].includes(String(record.type))) return []
  const message = object(record.message)
  const time = timestamp(record.timestamp)
  if (record.type === 'system') {
    return record.subtype === 'compact_boundary'
      ? [{ ...event('Compacted', {}, time), contextReset: true, context: count(object(record.compactMetadata)?.postTokens) }]
      : []
  }
  if (!message) return []
  if (record.type === 'user') return claudeUser(record, message, time)

  const model = string(message.model)
  const content = message.content
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : blocks(content)
  const usage = object(message.usage)
  const out: Entry[] = usage ? [at({
    kind: 'usage' as const, model,
    context: sumCounts(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens),
    cached: count(usage.cache_read_input_tokens),
    cache: {
      read: count(usage.cache_read_input_tokens) ?? 0,
      write: count(usage.cache_creation_input_tokens) ?? 0,
      hourWrite: count(object(usage.cache_creation)?.ephemeral_1h_input_tokens) ?? 0,
    },
  }, time)] : []
  for (const block of items) {
    const value = string(block.text)
    if (block.type === 'text' && value && value !== '(no content)') {
      out.push(at({ kind: 'text' as const, text: value, ...(model ? { model } : {}) }, time))
    } else if (block.type === 'thinking') {
      const thinking = string(block.thinking) ?? value
      if (thinking?.trim()) out.push(at({ kind: 'thinking' as const, text: thinking }, time))
    } else if (block.type === 'tool_use') {
      const id = string(block.id)
      const name = string(block.name)
      if (id && name) out.push(at({ kind: 'tool' as const, id, name, input: block.input }, time))
    }
  }
  return out
}

function piUserContent(value: unknown, time?: number): Entry[] {
  if (typeof value === 'string') return [{ kind: 'prompt', text: value, images: 0, dispatch: false, ...(time === undefined ? {} : { at: time }) }]
  let images = 0
  const text: string[] = []
  for (const block of blocks(value)) {
    if (block.type === 'image') images++
    else if (block.type === 'text') {
      const value = string(block.text)
      if (value) text.push(value)
    }
  }
  if (!text.length && images === 0) return []
  return [{ kind: 'prompt', text: text.join('\n'), images, dispatch: false, ...(time === undefined ? {} : { at: time }) }]
}

function piRecord(record: ObjectValue): Entry[] {
  if (record.type === 'compaction' || record.type === 'context_edit') {
    return [{ ...event('Compacted', {}, timestamp(record.timestamp)), contextReset: true }]
  }
  if (record.type === 'custom_message') {
    const content = string(record.content)
    return [event('Context', { detail: string(record.customType), text: content }, timestamp(record.timestamp))]
  }
  if (record.type !== 'message') return []
  const message = object(record.message)
  const role = message && string(message.role)
  if (!message || !role || role === 'system') return []
  const time = timestamp(record.timestamp)
  const content = message.content
  if (role === 'user') return piUserContent(content, time)
  if (role === 'toolResult') {
    const result = resultContent(content)
    const id = string(message.toolCallId)
    return id ? [at({ kind: 'result' as const, id, ...result, isError: message.isError === true }, time)] : []
  }
  if (role !== 'assistant') return []

  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : blocks(content)
  const usage = object(message.usage)
  const model = string(message.model)
  const out: Entry[] = usage && !['error', 'aborted'].includes(String(message.stopReason)) ? [at({
    kind: 'usage' as const, model,
    context: sumCounts(usage.input, usage.cacheRead, usage.cacheWrite),
    cached: count(usage.cacheRead),
  }, time)] : []
  for (const block of items) {
    const text = string(block.text)
    if (block.type === 'text' && text?.trim()) out.push(at({ kind: 'text' as const, text }, time))
    else if (block.type === 'thinking') {
      const thinking = string(block.thinking) ?? text
      if (thinking?.trim()) out.push(at({ kind: 'thinking' as const, text: thinking }, time))
    }
    else if (block.type === 'toolCall') {
      const id = string(block.id)
      const name = string(block.name)
      if (id && name) out.push(at({ kind: 'tool' as const, id, name, input: block.arguments ?? {} }, time))
    }
  }
  return out
}

function codexText(value: unknown, types = ['output_text', 'input_text', 'text']): string {
  if (typeof value === 'string') return value
  return blocks(value)
    .filter((block) => typeof block.type === 'string' && types.includes(block.type))
    .map((block) => string(block.text) ?? '')
    .filter(Boolean)
    .join('\n')
}

function codexInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value
  } catch {
    return value
  }
}

function codexRecord(record: ObjectValue): Entry[] {
  const payload = object(record.payload)
  const time = timestamp(record.timestamp)
  if (record.type === 'compacted' || (record.type === 'event_msg' && payload?.type === 'context_compacted')) {
    return [{ ...event('Compacted', {}, time), contextReset: true }]
  }
  if (record.type === 'event_msg' && payload?.type === 'token_count') {
    const info = object(payload.info)
    const usage = object(info?.last_token_usage)
    // Compaction resets can report a retained total with no measured input/output.
    const resetOnly = usage?.input_tokens === 0 && usage.output_tokens === 0
      && (count(usage.total_tokens) ?? 0) > 0
    return usage ? [at({ kind: 'usage' as const,
      // Codex's cached input is a subset, not another part of the prompt.
      context: resetOnly ? undefined : count(usage.input_tokens), window: count(info?.model_context_window),
      cached: resetOnly ? undefined : count(usage.cached_input_tokens),
    }, time)] : []
  }
  if (record.type !== 'response_item' || !payload) return []
  switch (payload.type) {
    case 'message': {
      const role = string(payload.role)
      const text = codexText(payload.content)
      if (role === 'assistant') return text.trim() ? [at({ kind: 'text' as const, text }, time)] : []
      if (role === 'developer') return text.trim() ? [event('Context', { detail: firstLine(text), text }, time)] : []
      if (role !== 'user' || !text.trim()) return []
      if (/^(# AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>|<user_instructions>)/.test(text)) {
        return [event('Context', { detail: firstLine(text), text }, time)]
      }
      return [at({ kind: 'prompt' as const, text, images: 0, dispatch: false }, time)]
    }
    case 'function_call':
    case 'custom_tool_call': {
      const id = string(payload.call_id)
      const name = string(payload.name)
      return id && name
        ? [at({ kind: 'tool' as const, id, name, input: codexInput(payload.arguments ?? payload.input) }, time)]
        : []
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const id = string(payload.call_id)
      if (!id) return []
      const result = resultContent(payload.output)
      return [at({ kind: 'result' as const, id, ...result, isError: payload.is_error === true }, time)]
    }
    case 'reasoning': {
      const summary = blocks(payload.summary).map((part) => string(part.text) ?? '').filter(Boolean).join('\n')
      return summary.trim() ? [at({ kind: 'thinking' as const, text: summary }, time)] : []
    }
    default:
      return []
  }
}

/** Normalize one native JSONL record by its record shape. Unknown and malformed records are ignored. */
export function normalizeRecord(raw: unknown): Entry[] {
  try {
    const record = object(raw)
    if (!record || record.isSidechain === true) return []
    const native = ['response_item', 'event_msg', 'compacted'].includes(String(record.type)) ? codexRecord(record)
      : ['message', 'custom_message', 'compaction', 'context_edit'].includes(String(record.type)) ? piRecord(record)
      : claudeRecord(record)
    const seen = new Set<string>()
    const entries = native.flatMap<Entry>(entry => {
      if (entry.kind !== 'prompt' && entry.kind !== 'event') return [entry]
      const notices = threadNotices(entry.text ?? '', entry.at)
      if (!notices.length) return [entry]
      for (const notice of notices) seen.add(notice.id)
      return notices
    })
    // Hook-supplied context is inside system-reminder blocks, which ordinary
    // Claude prompt normalization omits. Read deliveries before losing them.
    if (record.type === 'user') {
      const message = object(record.message)
      const source = contentText(message?.content)
      const reminders = [...source.matchAll(/<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder\s*>/gi)]
      const notices = reminders.flatMap(match => threadNotices(match[1], timestamp(record.timestamp))).filter(notice => !seen.has(notice.id))
      return [...notices, ...entries]
    }
    return entries
  } catch {
    return []
  }
}

export type PromptPart = { kind: 'text' | 'pasted'; text: string }

/**
 * Split a prompt around the `<pasted_content>` blocks Claude Code wraps
 * pasted text in, so the reader shows the paste as a quoted block rather
 * than as markup. An unclosed block runs to the end of the prompt.
 */
export function promptParts(text: string): PromptPart[] {
  const parts: PromptPart[] = []
  const open = /<pasted_content\b[^>]*>/gi
  let rest = 0
  let match: RegExpExecArray | null
  while ((match = open.exec(text))) {
    const before = text.slice(rest, match.index).trim()
    if (before) parts.push({ kind: 'text', text: before })
    const start = match.index + match[0].length
    const close = /<\/pasted_content\s*>/i.exec(text.slice(start))
    const end = close ? start + close.index : text.length
    const pasted = text.slice(start, end).replace(/^\n+|\s+$/g, '')
    if (pasted) parts.push({ kind: 'pasted', text: pasted })
    rest = close ? end + close[0].length : text.length
    open.lastIndex = rest
  }
  const after = text.slice(rest).trim()
  if (after) parts.push({ kind: 'text', text: after })
  return parts
}
