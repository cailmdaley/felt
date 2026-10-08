export interface ToolLabel {
  name: string
  summary: string
}

type InputObject = Record<string, unknown>

function object(input: unknown): InputObject | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as InputObject
    : null
}

function value(input: InputObject | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof input?.[key] === 'string' && input[key]) return input[key] as string
  }
  return undefined
}

function compact(text: string, limit = 160): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

function commandSummary(text: string): string {
  const lines = text.split(/\r?\n/)
  const first = lines[0].trim()
  return compact(lines.length > 1 ? `${first} …` : first)
}

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
}

function jsString(source: string): string {
  try {
    return JSON.parse(`"${source}"`) as string
  } catch {
    return source
      .replace(/\\([\\'"`])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
  }
}

function codexCommand(input: unknown): string {
  const sources: string[] = []
  const visit = (item: unknown): void => {
    if (typeof item === 'string') sources.push(item)
    else if (Array.isArray(item)) item.forEach(visit)
    else if (item !== null && typeof item === 'object') Object.values(item).forEach(visit)
  }
  visit(input)
  for (const source of sources) {
    const match = /\bcmd\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/s.exec(source)
    if (match) return jsString(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return ''
}

function genericSummary(input: unknown): string {
  if (typeof input === 'string') return input
  const values = object(input)
  if (!values) return ''
  return Object.values(values).find((item): item is string => typeof item === 'string') ?? ''
}

/** The quiet one-line label used for a tool call in a transcript. */
export function toolLabel(name: string, input: unknown): ToolLabel {
  const values = object(input)
  let label = name
  const mcp = /^mcp__.+__(.+)$/.exec(name)
  if (mcp) label = mcp[1]
  else if (/^[a-z][a-z0-9_]*$/.test(name)) label = `${name[0].toUpperCase()}${name.slice(1)}`

  let summary = ''
  if (['Bash', 'bash', 'exec_command', 'shell'].includes(name)) {
    summary = commandSummary(value(values, 'command', 'cmd') ?? (typeof input === 'string' ? input : ''))
  } else if (name === 'exec') {
    summary = commandSummary(codexCommand(input))
  } else if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'read', 'edit', 'write'].includes(name)) {
    const path = value(values, 'file_path', 'path', 'notebook_path')
    summary = path ? shortPath(path) : ''
  } else if (name === 'Grep' || name === 'grep') {
    const pattern = value(values, 'pattern') ?? ''
    const path = value(values, 'path')
    summary = path ? `${pattern} in ${shortPath(path)}` : pattern
  } else if (name === 'Glob' || name === 'find') {
    summary = value(values, 'pattern') ?? ''
  } else if (name === 'Agent' || name === 'Task') {
    summary = value(values, 'description', 'subagent_type') ?? ''
  } else if (name === 'WebFetch') {
    summary = value(values, 'url') ?? ''
  } else if (name === 'WebSearch') {
    summary = value(values, 'query') ?? ''
  } else if (name === 'Skill') {
    summary = value(values, 'skill') ?? ''
  } else if (name === 'ToolSearch') {
    summary = value(values, 'query') ?? ''
  } else if (name === 'TodoWrite') {
    const items = values?.todos ?? values?.items
    summary = Array.isArray(items) ? `${items.length} items` : ''
  } else if (name === 'SendMessage') {
    const to = value(values, 'to')
    summary = to ? `to ${to}` : ''
  } else {
    summary = genericSummary(input)
  }
  return { name: label, summary: compact(summary) }
}
