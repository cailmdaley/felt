import type { InheritedProjectDir } from './KanbanTypes.js'

/**
 * The inline answer to a start refused for want of a project directory: the
 * owning host's reason, a directory field, and a button that retries the start
 * with what the field holds.
 *
 * The field is prefilled with the nearest ancestor's `shuttle.project_dir`
 * when the card has one, and says where it came from; nothing is sent until a
 * human presses Start, so no directory is ever chosen on their behalf. The
 * path is one on `host`, the machine that will validate it and run the worker.
 */
export interface ProjectDirPromptOptions {
  /** The refusal, as the board states it (`dispatchFailureMessage`). */
  reason: string
  /** The fiber's owning host, where the directory must exist. */
  host?: string
  suggestion?: InheritedProjectDir
  /** Retry the start in `projectDir` (trimmed, never blank). */
  onStart: (projectDir: string) => void
}

export function buildProjectDirPrompt(opts: ProjectDirPromptOptions): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'kbn-start-prompt'

  const reason = document.createElement('p')
  reason.className = 'kbn-start-prompt-reason'
  reason.textContent = opts.reason

  const label = document.createElement('label')
  label.className = 'kbn-start-prompt-label'
  label.textContent = opts.host ? `Project directory on ${opts.host}` : 'Project directory'

  const row = document.createElement('div')
  row.className = 'kbn-start-prompt-row'
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'kbn-ctl-input kbn-start-prompt-input'
  input.placeholder = '/path/to/checkout'
  input.spellcheck = false
  input.setAttribute('aria-label', label.textContent)
  input.value = opts.suggestion?.path ?? ''

  const start = document.createElement('button')
  start.type = 'button'
  start.className = 'kbn-ctl-btn kbn-ctl-send'
  start.textContent = 'Start here'

  const sync = (): void => {
    start.disabled = input.value.trim() === ''
  }
  const submit = (): void => {
    const dir = input.value.trim()
    if (!dir) return
    start.disabled = true
    opts.onStart(dir)
  }
  input.addEventListener('input', sync)
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault()
      submit()
    }
  })
  start.addEventListener('click', (e) => {
    e.stopPropagation()
    submit()
  })
  sync()

  row.append(input, start)
  wrap.append(reason, label, row)
  if (opts.suggestion) {
    const hint = document.createElement('p')
    hint.className = 'kbn-start-prompt-hint'
    hint.textContent = `Suggested from ${opts.suggestion.from}.`
    wrap.append(hint)
  }
  return wrap
}
