export type ChangeRole = 'implementation' | 'test' | 'generated' | 'config' | 'docs'
export interface ChangeRange { file: string; from?: number; to?: number; side?: 'new' | 'old' }
export interface ChangeLine { kind: 'addition' | 'deletion' | 'context' | 'note'; old: number; new: number; text: string }
export interface ChangeWindow { old_from: number; old_lines: number; new_from: number; new_lines: number; patch: string; rows: number; lines?: ChangeLine[] }
export interface ChangeHunk { file: string; old_from: number; old_lines: number; new_from: number; new_lines: number; patch: string; windows: ChangeWindow[] }
export interface ChangeStop extends ChangeRange { note: string; importance: 'critical' | 'important' | 'supporting' | 'context'; hunks: ChangeHunk[] }
export interface ChangeChapter { id: string; title: string; narrative: string; why_here: string; stops: ChangeStop[] }
export interface ChangeFile { path: string; old_path?: string; old_mode?: string; new_mode?: string; role: ChangeRole; status: string; additions: number; deletions: number; header: string; hunks: ChangeHunk[]; remaining: ChangeHunk[] }
export interface ChangeBundle {
  version: 1
  title: string
  repo: { name: string; dir: string; forge_url: string | null }
  base: string; head: string; base_ref: string; head_ref: string
  commits: { sha: string; subject: string; author: string; time: string }[]
  files: ChangeFile[]
  story: null | { title?: string; overview: string; flags: (ChangeRange & { text: string })[]; chapters: ChangeChapter[]; roles?: Record<string, ChangeRole> }
}
export interface ChangeLanes { chapters: ChangeChapter[]; tests: ChangeFile[]; remaining: ChangeFile[] }

/** Coverage and excerpts are resolved by shuttle change, alongside Git's file identities. */
export function assignLanes(bundle: ChangeBundle): ChangeLanes {
  const order: ChangeRole[] = ['implementation', 'config', 'docs', 'generated', 'test']
  return {
    chapters: bundle.story?.chapters ?? [],
    tests: bundle.files.filter(file => file.role === 'test'),
    remaining: bundle.files.filter(file => file.role !== 'test').flatMap(file => {
      const hunks = file.remaining
      return hunks.length || !file.hunks.length ? [{ ...file, hunks }] : []
    }).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)),
  }
}

/** A non-cryptographic fingerprint resets viewed state when the bundle changes. */
export function changeIdentity(source: string): string {
  let a = 2166136261, b = 0x9e3779b9
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i)
    a = Math.imul(a ^ char, 16777619); b = Math.imul(b ^ char, 2246822519)
  }
  return [a, b].map(hash => (hash >>> 0).toString(16).padStart(8, '0')).join('')
}

export interface ChangeComment { file: string; line: number; side: 'new' | 'old'; text: string; base?: string; head?: string }
export interface ChangeDraft { note: string; comments: ChangeComment[]; base?: string; head?: string }
function quoted(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
export function reviewMessage(bundle: ChangeBundle, draft: ChangeDraft): string {
  const anchor = (base = bundle.base, head = bundle.head): string => base === bundle.base && head === bundle.head ? '' : `Earlier snapshot\nBase: ${base}\nHead: ${head}\n`
  return [`Base: ${bundle.base}`, `Head: ${bundle.head}`, `Review of ${quoted(bundle.title)}`, draft.note.trim() ? `${anchor(draft.base, draft.head)}${draft.note.trim()}` : '',
    ...draft.comments.filter(comment => comment.text.trim()).map(comment => `${anchor(comment.base ?? draft.base, comment.head ?? draft.head)}${quoted(comment.file)}:${comment.line}${comment.side === 'old' ? ' (old)' : ''}\n${comment.text.trim()}`),
  ].filter(Boolean).join('\n\n')
}
