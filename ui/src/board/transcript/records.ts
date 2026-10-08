export type Entry =
  | { kind: 'prompt'; text: string; images: number; dispatch: boolean; at?: number }
  | { kind: 'text'; text: string; at?: number; model?: string }
  | { kind: 'thinking'; text: string; at?: number }
  | { kind: 'tool'; id: string; name: string; input: unknown; at?: number }
  | { kind: 'result'; id: string; text: string; isError: boolean; images: number; at?: number }
  | { kind: 'event'; label: string; detail?: string; text?: string; at?: number }

type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ObjectValue
    : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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

function resultContent(value: unknown): { text: string; images: number } {
  if (typeof value === 'string') return { text: value, images: 0 }
  let images = 0
  const text: string[] = []
  for (const block of blocks(value)) {
    if (block.type === 'image') images++
    else if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') {
      const value = string(block.text)
      if (value) text.push(value)
    }
  }
  return { text: text.join('\n'), images }
}

function firstLine(text: string, limit = 80): string {
  const line = text.split(/\r?\n/, 1)[0].trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

function event(label: string, fields: { detail?: string; text?: string } = {}, time?: number): Entry {
  return at({ kind: 'event' as const, label, ...fields }, time)
}

function classifiedClaudeText(raw: string, isMeta: boolean, time?: number): Entry | null {
  const text = raw.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\s*>/gi, '').trim()
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
  if (text.startsWith('<local-command-caveat>')) return null

  return at({ kind: 'prompt' as const, text, images: 0, dispatch: /^You are a Shuttle worker\b/.test(text) }, time)
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

function claudeRecord(record: ObjectValue): Entry[] {
  if (!['user', 'assistant', 'system'].includes(String(record.type)) || record.isSidechain === true) return []
  const message = object(record.message)
  const time = timestamp(record.timestamp)
  if (record.type === 'system') {
    return record.subtype === 'compact_boundary' ? [event('Compacted', {}, time)] : []
  }
  if (!message) return []
  if (record.type === 'user') return claudeUser(record, message, time)

  const model = string(message.model)
  const content = message.content
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : blocks(content)
  const out: Entry[] = []
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
  const out: Entry[] = []
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
  if (record.type !== 'response_item' || !payload) return []
  const time = timestamp(record.timestamp)
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
    if (!record) return []
    if (record.type === 'response_item') return codexRecord(record)
    if (record.type === 'message' || record.type === 'custom_message') return piRecord(record)
    return claudeRecord(record)
  } catch {
    return []
  }
}
