import { getDaemonJson } from '../daemonApi.js'
import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { anchorSelect } from './selectPicker.js'

interface FeltStoresOrigin {
  stale?: boolean
  projects?: string[]
}

interface FeltStoresResponse {
  host?: string
  origins?: Record<string, FeltStoresOrigin>
}

export interface RehomeResult {
  host: string
  fromHost?: string
  projectDir?: string
  warning?: string
}

export interface HostMoveOptions {
  base: string
  card: () => KanbanCard
  withSaveStatus: (write: () => Promise<void>) => Promise<boolean>
  onMoved: (result: RehomeResult) => void
  onWarning?: (message: string) => void
  onError?: (message: string) => void
}

/** Suggest the best matching project directory on `targetHost` for `currentDir`. */
export function suggestProjectDir(currentDir: string | undefined, projects: readonly string[] | undefined): string {
  if (!projects?.length) return ''
  if (!currentDir) return ''
  const norm = (p: string): string => p.replace(/\/+$/, '')
  const cur = norm(currentDir)
  const exact = projects.find(p => norm(p) === cur)
  if (exact) return exact
  const base = cur.split('/').at(-1)?.toLowerCase()
  if (!base) return ''
  return projects.find(p => norm(p).split('/').at(-1)?.toLowerCase() === base) ?? ''
}

/**
 * Host selector + inline confirm row for moving a constitution to another host
 * via `POST /api/v1/rehome`. Lazily loads `/api/v1/felt-stores` when opened.
 */
export class HostMoveControl {
  readonly row = document.createElement('div')
  readonly confirmRow = document.createElement('div')
  private readonly hostSelect = document.createElement('select')
  private readonly dirInput = document.createElement('input')
  private readonly dirList = document.createElement('datalist')
  private readonly noteEl = document.createElement('p')
  private readonly moveBtn = document.createElement('button')
  private readonly cancelBtn = document.createElement('button')
  private readonly opts: HostMoveOptions
  private readonly disposeSelect: () => void
  private origins: Record<string, FeltStoresOrigin> = {}
  private state: 'idle' | 'loading' | 'loaded' = 'idle'
  private pendingTarget: string | null = null
  private moving = false
  private disposed = false

  constructor(opts: HostMoveOptions) {
    this.opts = opts
    const card = opts.card()
    const current = this.currentHost(card)

    this.row.className = 'kbn-ctl-field kbn-ctl-host-field'
    const label = document.createElement('span')
    label.className = 'kbn-ctl-label'
    label.textContent = 'Host'
    const value = document.createElement('div')
    value.className = 'kbn-ctl-value'

    this.hostSelect.className = 'kbn-ctl-select kbn-ctl-host-select'
    this.hostSelect.setAttribute('aria-label', 'Host')
    this.hostSelect.append(new Option(current || '…', current))
    this.disposeSelect = anchorSelect(this.hostSelect)
    value.append(this.hostSelect)
    this.row.append(label, value)

    this.confirmRow.className = 'kbn-ctl-host-move'
    this.confirmRow.hidden = true

    const listId = `host-move-dirs-${Math.random().toString(36).slice(2, 9)}`
    this.dirList.id = listId
    this.dirInput.type = 'text'
    this.dirInput.className = 'kbn-ctl-input kbn-ctl-host-dir'
    this.dirInput.setAttribute('list', listId)
    this.dirInput.setAttribute('aria-label', 'Destination project directory')
    this.dirInput.spellcheck = false

    this.noteEl.className = 'kbn-ctl-host-note'
    this.noteEl.hidden = true

    this.moveBtn.type = 'button'
    this.moveBtn.className = 'kbn-ctl-btn kbn-ctl-send'
    this.moveBtn.textContent = 'Move'

    this.cancelBtn.type = 'button'
    this.cancelBtn.className = 'kbn-ctl-btn'
    this.cancelBtn.textContent = 'Cancel'

    const actions = document.createElement('div')
    actions.className = 'kbn-ctl-host-actions'
    actions.append(this.moveBtn, this.cancelBtn)

    this.confirmRow.append(this.dirInput, this.dirList, this.noteEl, actions)

    this.hostSelect.addEventListener('change', () => {
      const target = this.hostSelect.value
      const cur = this.currentHost(this.opts.card())
      if (!target || target === cur) {
        this.hideConfirm()
      } else {
        this.showConfirm(target)
      }
    })
    this.cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.reset()
    })
    this.moveBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void this.commitMove()
    })
    this.dirInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void this.commitMove()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.reset()
      }
    })
  }

  /** Load the fleet's host list if not yet fetched. */
  async ensureLoaded(): Promise<void> {
    if (this.state !== 'idle') return
    this.state = 'loading'
    try {
      const res = await getDaemonJson<FeltStoresResponse>(`${this.opts.base}/api/v1/felt-stores`)
      if (this.disposed) return
      this.origins = res?.origins && typeof res.origins === 'object' ? res.origins : {}
      this.state = 'loaded'
      this.paintOptions()
      if (this.pendingTarget) {
        const wanted = this.pendingTarget
        this.pendingTarget = null
        this.selectTarget(wanted)
      }
    } catch {
      if (!this.disposed) this.state = 'idle'
    }
  }

  /** Programmatically pre-select a destination host (e.g. from a mismatch banner). */
  selectTarget(targetHost: string): void {
    const cur = this.currentHost(this.opts.card())
    if (!targetHost || targetHost === cur) {
      this.hideConfirm()
      return
    }
    if (this.state !== 'loaded') {
      this.pendingTarget = targetHost
      void this.ensureLoaded()
      return
    }
    if (![...this.hostSelect.options].some(o => o.value === targetHost)) {
      this.hostSelect.append(new Option(targetHost, targetHost))
    }
    const opt = [...this.hostSelect.options].find(o => o.value === targetHost)
    if (opt?.disabled) return
    this.hostSelect.value = targetHost
    this.showConfirm(targetHost)
  }

  /** Reseed the control from the latest card when not actively confirming a move. */
  reseed(): void {
    if (!this.confirmRow.hidden || this.moving) return
    this.paintOptions()
  }

  reset(): void {
    const cur = this.currentHost(this.opts.card())
    this.hostSelect.value = cur
    this.hideConfirm()
  }

  dispose(): void {
    this.disposed = true
    this.disposeSelect()
  }

  private currentHost(card: KanbanCard): string {
    return card.shuttleHost ?? card.originId ?? ''
  }

  private paintOptions(): void {
    const cur = this.currentHost(this.opts.card())
    const names = Object.keys(this.origins).sort((a, b) => a.localeCompare(b))
    if (cur && !names.includes(cur)) names.unshift(cur)
    const selected = !this.confirmRow.hidden ? this.hostSelect.value : cur
    this.hostSelect.replaceChildren()
    for (const name of names) {
      const info = this.origins[name]
      const offline = info?.stale === true && name !== cur
      const label = offline ? `${name} (offline)` : name
      const opt = new Option(label, name, false, name === selected)
      opt.disabled = offline
      this.hostSelect.append(opt)
    }
    if (selected) this.hostSelect.value = selected
  }

  private showConfirm(targetHost: string): void {
    const card = this.opts.card()
    const cur = this.currentHost(card)
    const projects = this.origins[targetHost]?.projects ?? []
    this.dirList.replaceChildren(...projects.map(p => {
      const opt = document.createElement('option')
      opt.value = p
      return opt
    }))
    this.dirInput.value = suggestProjectDir(card.shuttleProjectDir, projects)
    this.dirInput.placeholder = `Project dir on ${targetHost}`
    if (hasLiveWorker(card)) {
      this.noteEl.textContent = `Stops the running worker on ${cur} and moves this constitution to ${targetHost}.`
      this.noteEl.hidden = false
    } else {
      this.noteEl.textContent = ''
      this.noteEl.hidden = true
    }
    this.confirmRow.hidden = false
    this.dirInput.focus()
    this.dirInput.select()
  }

  private hideConfirm(): void {
    this.confirmRow.hidden = true
    this.noteEl.hidden = true
  }

  private async commitMove(): Promise<void> {
    if (this.moving) return
    const targetHost = this.hostSelect.value.trim()
    const card = this.opts.card()
    const cur = this.currentHost(card)
    if (!targetHost || targetHost === cur) {
      this.hideConfirm()
      return
    }
    const projectDir = this.dirInput.value.trim()
    this.moving = true
    this.moveBtn.disabled = true
    this.cancelBtn.disabled = true
    this.hostSelect.disabled = true
    this.dirInput.disabled = true
    this.moveBtn.textContent = 'Moving…'

    interface RehomeApiResponse {
      ok?: boolean
      host?: string
      from_host?: string
      project_dir?: string
      previous_host_warning?: string
      error?: string
      needs?: string
    }
    const responseBox: { body: RehomeApiResponse | null } = { body: null }

    try {
      const ok = await this.opts.withSaveStatus(async () => {
        const res = await fetch(`${this.opts.base}/api/v1/rehome`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fiber: card.uid ?? card.id,
            origin: card.originId,
            target_host: targetHost,
            fiber_path: card.id,
            ...(projectDir ? { project_dir: projectDir } : {}),
          }),
        })
        responseBox.body = (await res.json().catch(() => null)) as RehomeApiResponse | null
        if (!res.ok) {
          throw new Error(responseBox.body?.error || `Move failed (${res.status})`)
        }
      })
      if (this.disposed) return
      const body = responseBox.body
      if (ok) {
        this.hideConfirm()
        const result: RehomeResult = {
          host: body?.host || targetHost,
          fromHost: body?.from_host || cur,
          projectDir: body?.project_dir || projectDir || undefined,
          warning: body?.previous_host_warning,
        }
        if (result.warning) this.opts.onWarning?.(result.warning)
        this.opts.onMoved(result)
      } else if (body?.needs === 'project_dir') {
        this.dirInput.focus()
        this.dirInput.select()
      }
    } finally {
      if (!this.disposed) {
        this.moving = false
        this.moveBtn.disabled = false
        this.cancelBtn.disabled = false
        this.hostSelect.disabled = false
        this.dirInput.disabled = false
        this.moveBtn.textContent = 'Move'
      }
    }
  }
}
