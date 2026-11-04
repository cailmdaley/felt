export type ChangeRole = 'implementation' | 'test' | 'generated' | 'config' | 'docs'
export interface ChangeRange { file: string; from?: number; to?: number; side?: 'new' | 'old' }
export interface ChangeStop extends ChangeRange { note?: string; importance?: 'critical' | 'important' | 'supporting' | 'context' }
export interface ChangeChapter { id: string; title: string; narrative: string; why_here: string; stops: ChangeStop[] }
export interface ChangeBundle {
  version: 1
  title: string
  repo: { name: string; dir: string; forge_url: string | null }
  base: string; head: string; base_ref: string; head_ref: string
  commits: { sha: string; subject: string; author: string; time: string }[]
  patch: string
  files: { path: string; status: string; role: ChangeRole; additions: number; deletions: number }[]
  story: null | { overview: string; flags: (ChangeRange & { text: string })[]; chapters: ChangeChapter[]; roles?: Record<string, ChangeRole> }
}
export interface PatchRow { text: string; old: number; new: number }
export interface ChangeHunk { oldStart: number; oldCount: number; newStart: number; newCount: number; rows: PatchRow[] }
export interface ChangeFile { path: string; role: ChangeRole; status: string; additions: number; deletions: number; header: string; hunks: ChangeHunk[] }
export interface ChangeLanes { chapters: ChangeChapter[]; tests: ChangeFile[]; remaining: ChangeFile[] }

function unquote(path: string): string {
  if (!path.startsWith('"')) return path
  const escapes: Record<string, string> = { a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\u000b' }
  return path.slice(1, -1).replace(/(?:\\[0-7]{3})+|\\(.)/g, (match, char: string | undefined) => char === undefined
    ? new TextDecoder().decode(Uint8Array.from(match.match(/[0-7]{3}/g)!, octal => parseInt(octal, 8)))
    : escapes[char] ?? char)
}

/** Keep Git's file and hunk boundaries; cursors also anchor rows absent on the other side. */
export function changeFiles(bundle: ChangeBundle): ChangeFile[] {
  const patches = bundle.patch.split(/(?=^diff --git )/m).filter(Boolean).map(patch => {
    const lines = patch.replace(/\n$/, '').split('\n')
    const first = lines.findIndex(line => line.startsWith('@@ '))
    const header = lines.slice(0, first < 0 ? lines.length : first).join('\n')
    const destination = lines.find(line => line.startsWith('+++ '))?.slice(4)
    const source = lines.find(line => line.startsWith('--- '))?.slice(4)
    const path = destination && destination !== '/dev/null' ? unquote(destination).replace(/^b\//, '')
      : source ? unquote(source).replace(/^a\//, '') : undefined
    const hunks: ChangeHunk[] = []
    let hunk: ChangeHunk | undefined, old = 0, next = 0
    for (const line of lines.slice(first < 0 ? lines.length : first)) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (match) {
        old = +match[1]; next = +match[3]
        hunk = { oldStart: old, oldCount: +(match[2] ?? 1), newStart: next, newCount: +(match[4] ?? 1), rows: [] }
        hunks.push(hunk)
      } else if (hunk && /^[ +\\-]/.test(line)) {
        hunk.rows.push({ text: line, old, new: next })
        if (line[0] === ' ' || line[0] === '-') old++
        if (line[0] === ' ' || line[0] === '+') next++
      }
    }
    return { path, header, hunks }
  })
  return bundle.files.map((file, index) => {
    // Metadata-only changes have no ---/+++ header; Git and the inventory share their order.
    const patch = patches.find(p => p.path === file.path) ?? patches[index]
    return { ...file, role: bundle.story?.roles?.[file.path] ?? file.role, header: patch?.header ?? '', hunks: patch?.hunks ?? [] }
  })
}

export function overlaps(hunk: ChangeHunk, stop: ChangeRange): boolean {
  if (stop.from === undefined && stop.to === undefined) return true
  const start = stop.side === 'old' ? hunk.oldStart : hunk.newStart
  const count = stop.side === 'old' ? hunk.oldCount : hunk.newCount
  return count > 0 && start <= (stop.to ?? stop.from ?? Infinity) && start + count - 1 >= (stop.from ?? 1)
}

/** Tests stay together even when a chapter cites them; uncovered implementation cannot disappear. */
export function assignLanes(bundle: ChangeBundle, files = changeFiles(bundle)): ChangeLanes {
  const chapters = bundle.story?.chapters ?? []
  const stops = chapters.flatMap(chapter => chapter.stops)
  const order: ChangeRole[] = ['implementation', 'config', 'docs', 'generated', 'test']
  return {
    chapters,
    tests: files.filter(file => file.role === 'test'),
    remaining: files.filter(file => file.role !== 'test').flatMap(file => {
      const hunks = file.hunks.filter(hunk => !stops.some(stop => stop.file === file.path && overlaps(hunk, stop)))
      return hunks.length || !file.hunks.length ? [{ ...file, hunks }] : []
    }).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)),
  }
}

/** A stop contains only its requested line interval, preserving file line numbers on both sides. */
export function stopHunks(file: ChangeFile, stop: ChangeRange): ChangeHunk[] {
  return file.hunks.filter(hunk => overlaps(hunk, stop)).flatMap(hunk => {
    let selected = false
    const rows = hunk.rows.filter(row => {
      if (row.text.startsWith('\\')) return selected
      const line = stop.side === 'old' ? row.old : row.new
      selected = line >= (stop.from ?? 1) && line <= (stop.to ?? stop.from ?? Infinity)
      return selected
    })
    return rows.length ? [hunkFromRows(rows)] : []
  })
}
function hunkFromRows(rows: PatchRow[]): ChangeHunk {
  return { rows, oldStart: rows[0].old, newStart: rows[0].new,
    oldCount: rows.filter(row => /^[ -]/.test(row.text)).length,
    newCount: rows.filter(row => /^[ +]/.test(row.text)).length }
}

/** Small independently mounted windows keep long files out of the DOM without nested scrollers. */
export function diffWindows(file: ChangeFile, hunks = file.hunks, size = 120): { patch: string; rows: number; hunk: ChangeHunk }[] {
  return hunks.flatMap(hunk => {
    const windows: { patch: string; rows: number; hunk: ChangeHunk }[] = []
    for (let i = 0; i < hunk.rows.length;) {
      let end = Math.min(hunk.rows.length, i + size)
      if (hunk.rows[end]?.text.startsWith('\\')) end++
      const slice = hunkFromRows(hunk.rows.slice(i, end))
      i = end
      windows.push({ patch: `${file.header}\n@@ -${slice.oldStart},${slice.oldCount} +${slice.newStart},${slice.newCount} @@\n${slice.rows.map(row => row.text).join('\n')}\n`, rows: slice.rows.length, hunk: slice })
    }
    return windows
  })
}
export interface ChangeComment { file: string; line: number; side: 'new' | 'old'; text: string }
export interface ChangeDraft { note: string; comments: ChangeComment[] }
export function reviewMessage(bundle: ChangeBundle, draft: ChangeDraft): string {
  return [`Review of ${bundle.title}`, `Head: ${bundle.head}`, draft.note.trim(),
    ...draft.comments.filter(comment => comment.text.trim()).map(comment => `${comment.file}:${comment.line}${comment.side === 'old' ? ' (old)' : ''}\n${comment.text.trim()}`),
  ].filter(Boolean).join('\n\n')
}
