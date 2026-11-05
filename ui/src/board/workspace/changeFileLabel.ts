import type { ChangeFile } from './changeModel.js'

export function changeFileLabel(file: ChangeFile): string {
  const status = file.status === 'renamed' ? `renamed from ${file.old_path ?? '(source path unavailable)'}` : file.status
  const { old_mode: old, new_mode: next } = file
  const mode = old && next && old !== '000000' && next !== '000000' && old !== next
    ? `${old.slice(0, 3) !== next.slice(0, 3) ? 'type change' : 'mode change'} ${old} → ${next}` : ''
  const count = file.additions + file.deletions
  return [status, mode, `${count} changed ${count === 1 ? 'line' : 'lines'} in file`].filter(Boolean).join(' · ')
}
