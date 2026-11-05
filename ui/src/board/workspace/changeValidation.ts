import type { ChangeBundle } from './changeModel.js'

const roles = ['implementation', 'test', 'generated', 'config', 'docs']
const sha = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i
function require(condition: unknown, at: string): asserts condition {
  if (!condition) throw new Error(`Invalid change bundle: ${at}`)
}
function object(value: unknown, at: string): Record<string, unknown> {
  require(value !== null && typeof value === 'object' && !Array.isArray(value), `${at} must be an object`)
  return value as Record<string, unknown>
}
function strings(value: Record<string, unknown>, keys: string[], at: string): void {
  for (const key of keys) require(typeof value[key] === 'string', `${at}.${key} must be text`)
}
function integer(value: unknown, at: string): void {
  require(Number.isSafeInteger(value) && (value as number) >= 0, `${at} must be a nonnegative integer`)
}
function array(value: unknown, at: string, check: (value: unknown, at: string) => void): void {
  require(Array.isArray(value), `${at} must be an array`)
  value.forEach((item, i) => check(item, `${at}[${i}]`))
}
function coordinates(value: Record<string, unknown>, at: string): void {
  for (const key of ['old_from', 'old_lines', 'new_from', 'new_lines']) integer(value[key], `${at}.${key}`)
  strings(value, ['patch'], at)
}
function hunk(value: unknown, at: string, file: string): void {
  const h = object(value, at)
  require(h.file === file, `${at}.file must match its file`)
  coordinates(h, at)
  array(h.windows, `${at}.windows`, (value, at) => {
    const window = object(value, at); coordinates(window, at); integer(window.rows, `${at}.rows`)
    require((window.rows as number) > 0, `${at}.rows must be positive`)
    if (window.lines !== undefined) {
      array(window.lines, `${at}.lines`, (value, at) => {
        const line = object(value, at)
        require(['addition', 'deletion', 'context', 'note'].includes(line.kind as string), `${at}.kind is unknown`)
        strings(line, ['text'], at); integer(line.old, `${at}.old`); integer(line.new, `${at}.new`)
        require(line.kind === 'addition' ? line.old === 0 && (line.new as number) > 0 : line.kind === 'deletion' ? line.new === 0 && (line.old as number) > 0 : line.kind === 'context' ? (line.old as number) > 0 && (line.new as number) > 0 : line.old === 0 && line.new === 0, `${at} must use its own side’s coordinates`)
      })
      require((window.lines as unknown[]).length === window.rows, `${at}.lines must match rows`)
      require((window.lines as { kind: string }[]).some(line => line.kind !== 'note'), `${at} must contain source rows`)
    }
  })
}

/** Validate worker-authored bytes before any reader, storage or review operation. */
export function validateChangeBundle(value: unknown): ChangeBundle {
  const b = object(value, 'bundle')
  require(b.version === 1, 'unsupported version')
  strings(b, ['title', 'base_ref', 'head_ref'], 'bundle')
  for (const key of ['base', 'head']) require(typeof b[key] === 'string' && sha.test(b[key]), `${key} must be a full hex SHA`)
  const repo = object(b.repo, 'repo'); strings(repo, ['name', 'dir'], 'repo')
  require(repo.forge_url === null || typeof repo.forge_url === 'string', 'repo.forge_url must be text or null')
  array(b.commits, 'commits', (value, at) => {
    const commit = object(value, at); strings(commit, ['sha', 'subject', 'author', 'time'], at)
    require(sha.test(commit.sha as string), `${at}.sha must be a full hex SHA`)
  })
  const paths = new Set<string>()
  array(b.files, 'files', (value, at) => {
    const file = object(value, at); strings(file, ['path', 'status', 'header'], at)
    const path = file.path as string
    require(path.length && !paths.has(path), `${at}.path must be nonempty and unique`); paths.add(path)
    require(roles.includes(file.role as string), `${at}.role is unknown`)
    require(['added', 'deleted', 'modified', 'renamed'].includes(file.status as string), `${at}.status is unknown`)
    integer(file.additions, `${at}.additions`); integer(file.deletions, `${at}.deletions`)
    if (file.old_path !== undefined) strings(file, ['old_path'], at)
    for (const mode of ['old_mode', 'new_mode']) if (file[mode] !== undefined) require(typeof file[mode] === 'string' && /^[0-7]{6}$/.test(file[mode]), `${at}.${mode} must be an octal mode`)
    array(file.hunks, `${at}.hunks`, (value, at) => hunk(value, at, path))
    array(file.remaining, `${at}.remaining`, (value, at) => hunk(value, at, path))
  })
  const range = (value: unknown, at: string): Record<string, unknown> => {
    const r = object(value, at)
    require(typeof r.file === 'string' && paths.has(r.file), `${at}.file is unknown`)
    for (const key of ['from', 'to']) if (r[key] !== undefined) { integer(r[key], `${at}.${key}`); require((r[key] as number) > 0, `${at}.${key} must be positive`) }
    require(r.side === undefined || r.side === 'old' || r.side === 'new', `${at}.side is unknown`)
    require(r.to === undefined || (typeof r.from === 'number' && (r.to as number) >= r.from), `${at}.to must follow from`)
    return r
  }
  if (b.story !== null) {
    const story = object(b.story, 'story'); strings(story, ['overview'], 'story')
    if (story.title !== undefined) strings(story, ['title'], 'story')
    if (story.roles !== undefined) {
      for (const [path, role] of Object.entries(object(story.roles, 'story.roles'))) require(paths.has(path) && roles.includes(role as string), 'story.roles must name known files and roles')
    }
    array(story.flags, 'story.flags', (value, at) => strings(range(value, at), ['text'], at))
    const ids = new Set<string>()
    array(story.chapters, 'story.chapters', (value, at) => {
      const chapter = object(value, at); strings(chapter, ['id', 'title', 'narrative', 'why_here'], at)
      require(typeof chapter.id === 'string' && chapter.id.length && !ids.has(chapter.id), `${at}.id must be nonempty and unique`); ids.add(chapter.id)
      array(chapter.stops, `${at}.stops`, (value, at) => {
        const stop = range(value, at); strings(stop, ['note'], at)
        require(['critical', 'important', 'supporting', 'context'].includes(stop.importance as string), `${at}.importance is unknown`)
        array(stop.hunks, `${at}.hunks`, (value, at) => hunk(value, at, stop.file as string))
      })
    })
  }
  return b as unknown as ChangeBundle
}

export function parseChangeBundle(source: string): ChangeBundle {
  return validateChangeBundle(JSON.parse(source))
}
