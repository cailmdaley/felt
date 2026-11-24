import '@ui-sdk/web/segmented-control'
import { dueCivilDay } from '../sdk/civilDay.js'
import { getDaemonJson, postDaemonJson } from '../board/daemonApi.js'
import type { KanbanCard, ShuttleKind } from '../board/KanbanTypes.js'
import { headerIcon } from '../board/workspace/headerIcon.js'
import { HostMoveControl, type RehomeResult } from '../board/workspace/HostMoveControl.js'
import { anchorSelect } from '../board/workspace/selectPicker.js'
import { SettingsMenu } from '../board/workspace/SettingsMenu.js'
import { agentGroups, type AgentEntry } from '../forms/agents.js'

interface AgentAxes {
  agent: string
  effort: string
  chrome: boolean
}

function ctlButton(label: string, cls: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `kbn-ctl-btn ${cls}`
  btn.textContent = label
  return btn
}

function ctlToggle(label: string, cls: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const el = document.createElement('label')
  el.className = `kbn-ctl-toggle ${cls}`
  const input = document.createElement('input')
  input.type = 'checkbox'
  const text = document.createElement('span')
  text.textContent = label
  el.append(input, text)
  return { label: el, input }
}

function segmented(
  name: string,
  options: ReadonlyArray<readonly [string, string]>,
  initial: string,
): HTMLElementTagNameMap['ui-segmented-control'] {
  const el = document.createElement('ui-segmented-control')
  el.className = 'kbn-ctl-segmented'
  el.setAttribute('default-value', initial)
  el.setAttribute('aria-label', name)
  for (const [value, label] of options) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'kbn-ctl-segment'
    btn.dataset.value = value
    btn.textContent = label
    const item = document.createElement('ui-segmented-control-item')
    item.setAttribute('value', value)
    item.setAttribute('as-child', '')
    item.append(btn)
    el.append(item)
  }
  return el
}

function field(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'kbn-ctl-field'
  const name = document.createElement('span')
  name.className = 'kbn-ctl-label'
  name.textContent = label
  const value = document.createElement('div')
  value.className = 'kbn-ctl-value'
  value.append(...controls)
  row.append(name, value)
  return row
}

function threadFacts(card: KanbanCard): { text: string; title: string } {
  const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const agent = card.workerAgent ?? card.shuttleAgent
  const role = card.shuttleRole && norm(card.shuttleRole) !== norm(card.name) ? card.shuttleRole : undefined
  const host = card.shuttleHost ?? card.originId
  const dir = card.shuttleProjectDir?.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
  const place = [host, dir].filter(Boolean).join(':')
  return {
    text: [agent, role, place].filter(Boolean).join(' · '),
    title: card.shuttleProjectDir ? [host, card.shuttleProjectDir].filter(Boolean).join(':') : '',
  }
}

/**
 * Lightweight settings popover for a constitution on `/thread`.
 * Lazily builds its controls and fetches `/api/v1/agents` only when the user
 * clicks the gear button, keeping idle thread pages free of extra DOM and I/O.
 */
export class ThreadSettings {
  readonly button = document.createElement('button')
  private readonly base: string
  private readonly host: HTMLElement
  private card: KanbanCard
  private lastFeedCard: KanbanCard
  private menu: SettingsMenu | null = null
  private drawer: HTMLElement | null = null
  private factsEl: HTMLElement | null = null
  private errorEl: HTMLElement | null = null
  private statusEl: HTMLElement | null = null
  private agentSelect: HTMLSelectElement | null = null
  private effortSelect: HTMLSelectElement | null = null
  private chromeToggle: HTMLInputElement | null = null
  private hostMove: HostMoveControl | null = null
  private readonly onMoved: ((result: RehomeResult) => void) | undefined
  private agentsState: 'idle' | 'loading' | 'loaded' = 'idle'
  private savesPending = 0
  private saveTail: Promise<void> = Promise.resolve()
  private statusTimer: number | undefined
  private disposed = false
  private readonly reseeders: Array<() => void> = []
  private readonly disposers: Array<() => void> = []

  constructor(base: string, host: HTMLElement, card: KanbanCard, opts?: { onMoved?: (result: RehomeResult) => void }) {
    this.base = base
    this.host = host
    this.card = card
    this.lastFeedCard = card
    this.onMoved = opts?.onMoved
    this.button.type = 'button'
    this.button.className = 'ws-header-icon ws-thread-settings'
    this.button.setAttribute('aria-label', 'Settings')
    this.button.title = 'Thread settings'
    this.button.setAttribute('aria-haspopup', 'dialog')
    this.button.setAttribute('aria-expanded', 'false')
    this.button.innerHTML = headerIcon('settings')
    this.button.addEventListener('click', () => this.toggle())
  }

  update(card: KanbanCard): void {
    if (card === this.lastFeedCard) return
    this.lastFeedCard = card
    this.card = card
    if (!this.drawer) return
    this.paintFacts()
    if (!this.savesPending && !this.drawer.contains(document.activeElement)) {
      for (const fn of this.reseeders) fn()
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.statusTimer)
    for (const fn of this.disposers) fn()
    this.disposers.length = 0
    this.menu?.dispose()
    this.menu = null
    this.drawer?.remove()
    this.drawer = null
  }

  /** Open the settings popover anchored at `anchor` (default: gear button) and pre-select `targetHost`. */
  openHostMove(targetHost: string, anchor: HTMLElement = this.button, container: HTMLElement = this.host): void {
    const drawer = this.ensureDrawer()
    this.paintFacts()
    if (!this.savesPending) {
      for (const fn of this.reseeders) fn()
    }
    ;(this.menu ??= new SettingsMenu()).show(drawer, anchor, container)
    void this.ensureAgents()
    void this.hostMove?.ensureLoaded()
    this.hostMove?.selectTarget(targetHost)
  }

  private toggle(): void {
    if (this.menu?.isOpen) {
      this.menu.close()
      return
    }
    const drawer = this.ensureDrawer()
    this.paintFacts()
    if (!this.savesPending) {
      for (const fn of this.reseeders) fn()
    }
    ;(this.menu ??= new SettingsMenu()).show(drawer, this.button, this.host)
    void this.ensureAgents()
    void this.hostMove?.ensureLoaded()
  }

  private ensureDrawer(): HTMLElement {
    if (this.drawer) return this.drawer

    const drawer = document.createElement('div')
    drawer.className = 'ws-band-drawer'

    const section = document.createElement('section')
    section.className = 'ws-band-section'
    section.setAttribute('aria-label', 'Settings')

    const fields = document.createElement('div')
    fields.className = 'kbn-ctl-fields'

    const errorEl = this.errorEl = document.createElement('div')
    errorEl.className = 'kbn-detail-error'
    errorEl.setAttribute('role', 'alert')
    errorEl.style.display = 'none'

    const statusEl = this.statusEl = document.createElement('span')
    statusEl.className = 'kbn-detail-save-status'
    statusEl.setAttribute('aria-live', 'polite')

    // ── Agent / Effort / Chrome ────────────────────────────────────────────
    const agentSelect = this.agentSelect = document.createElement('select')
    agentSelect.className = 'kbn-ctl-select kbn-ctl-agent-select'
    agentSelect.setAttribute('aria-label', 'Agent')
    agentSelect.append(new Option(this.card.shuttleAgent || '…', this.card.shuttleAgent ?? ''))

    const effortSelect = this.effortSelect = document.createElement('select')
    effortSelect.className = 'kbn-ctl-select kbn-ctl-effort-select'
    effortSelect.setAttribute('aria-label', 'Effort')
    if (this.card.shuttleEffort) effortSelect.append(new Option(this.card.shuttleEffort, this.card.shuttleEffort))
    this.disposers.push(anchorSelect(agentSelect), anchorSelect(effortSelect))

    const chrome = ctlToggle('Chrome', 'kbn-ctl-chrome')
    this.chromeToggle = chrome.input
    chrome.input.checked = this.card.shuttleChrome === true
    chrome.label.hidden = !chrome.input.checked

    fields.append(field('Agent', agentSelect, effortSelect, chrome.label))

    // ── Host (rehome) ──────────────────────────────────────────────────────
    const hostMove = this.hostMove = new HostMoveControl({
      base: this.base,
      card: () => this.card,
      withSaveStatus: write => this.withSaveStatus(write),
      onMoved: (result) => {
        this.card = {
          ...this.card,
          originId: result.host,
          shuttleHost: result.host,
          ...(result.projectDir ? { shuttleProjectDir: result.projectDir } : {}),
        }
        this.paintFacts()
        this.onMoved?.(result)
      },
      onWarning: (warning) => {
        if (this.errorEl) {
          this.errorEl.textContent = warning
          this.errorEl.style.display = ''
        }
      },
    })
    this.disposers.push(() => hostMove.dispose())
    this.reseeders.push(() => hostMove.reseed())
    fields.append(hostMove.row, hostMove.confirmRow)

    // ── Kind / Cron / TZ ───────────────────────────────────────────────────
    const baseline = {
      kind: (this.card.shuttleKind ?? 'oneshot') as ShuttleKind,
      schedule: this.card.shuttleSchedule ?? '',
      tz: this.card.shuttleTz ?? 'Europe/Paris',
    }
    const kind = segmented(
      'Kind',
      [['oneshot', 'One-shot'], ['standing', 'Standing']],
      baseline.kind,
    )

    const cronInput = document.createElement('input')
    cronInput.type = 'text'
    cronInput.className = 'kbn-ctl-input kbn-ctl-cron'
    cronInput.placeholder = '0 9 * * 1-5'
    cronInput.value = baseline.schedule
    cronInput.spellcheck = false
    cronInput.setAttribute('aria-label', 'Cron')

    const tzInput = document.createElement('input')
    tzInput.type = 'text'
    tzInput.className = 'kbn-ctl-input kbn-ctl-tz'
    tzInput.placeholder = 'Europe/Paris'
    tzInput.value = baseline.tz
    tzInput.spellcheck = false
    tzInput.setAttribute('aria-label', 'Timezone')

    const spoken = document.createElement('span')
    spoken.className = 'kbn-ctl-spoken'
    const paintSpoken = (): void => {
      spoken.textContent = cronInput.value.trim() === this.card.shuttleSchedule ? this.card.scheduleText ?? '' : ''
    }
    paintSpoken()
    cronInput.addEventListener('input', paintSpoken)

    const cronRow = field('Cron', cronInput, tzInput, spoken)
    cronRow.hidden = baseline.kind !== 'standing'

    // ── Due date ───────────────────────────────────────────────────────────
    let dueCurrent = dueCivilDay(this.card.due) ?? null
    let dueIntended = dueCurrent
    let dueRevision = 0
    const dueInput = document.createElement('input')
    dueInput.type = 'date'
    dueInput.className = 'kbn-ctl-input kbn-ctl-date'
    const dueLabel = this.card.isCycle ? 'Ends' : this.card.storedHorizon === 'stashed' ? 'Returns' : 'Due'
    dueInput.setAttribute('aria-label', this.card.isCycle ? 'Cycle end date' : dueLabel === 'Returns' ? 'Return date' : 'Due date')
    dueInput.value = dueCurrent ?? ''
    const dueClear = ctlButton('×', 'kbn-ctl-clear')
    dueClear.setAttribute('aria-label', 'Clear date')
    const paintDue = (): void => {
      dueClear.hidden = !dueInput.value
      dueInput.classList.toggle('kbn-ctl-empty', !dueInput.value)
    }
    paintDue()

    const commitDue = (next: string | null): void => {
      if ((next ?? '') === (dueIntended ?? '')) return
      dueIntended = next
      const request = ++dueRevision
      const card = this.card
      void this.withSaveStatus(() =>
        postDaemonJson(this.base, '/api/v1/felt-edit', {
          fiber_id: card.id,
          origin: card.originId,
          due: next,
        }),
      ).then((ok) => {
        if (ok) {
          dueCurrent = next
          this.card = { ...this.card, due: next ?? undefined }
          if (request === dueRevision) { dueInput.value = next ?? ''; paintDue() }
        } else if (request === dueRevision) {
          dueIntended = dueCurrent
          dueInput.value = dueCurrent ?? ''
          paintDue()
        }
      })
    }
    dueInput.addEventListener('change', () => commitDue(dueInput.value || null))
    dueClear.addEventListener('click', (e) => {
      e.stopPropagation()
      commitDue(null)
    })

    const dueRow = field(dueLabel, dueInput, dueClear)
    dueRow.hidden = baseline.kind === 'standing'

    fields.append(field('Kind', kind), cronRow, dueRow)

    this.reseeders.push(() => {
      baseline.kind = this.card.shuttleKind ?? 'oneshot'
      baseline.schedule = this.card.shuttleSchedule ?? ''
      baseline.tz = this.card.shuttleTz ?? 'Europe/Paris'
      kind.value = baseline.kind
      cronInput.value = baseline.schedule
      tzInput.value = baseline.tz
      cronRow.hidden = baseline.kind !== 'standing'
      dueRow.hidden = baseline.kind === 'standing'
      paintSpoken()

      dueCurrent = dueIntended = dueCivilDay(this.card.due) ?? null
      dueInput.value = dueCurrent ?? ''
      paintDue()
    })

    let kindRevision = 0
    let abandoningPromotion = false
    const commitKind = (value: ShuttleKind, revision: number): void => {
      if (value === baseline.kind && !this.savesPending) return
      if (value === 'standing') {
        errorEl.style.display = 'none'
        statusEl.textContent = '↵ to save'
        return
      }
      statusEl.textContent = ''
      const card = this.card
      void this.withSaveStatus(() =>
        postDaemonJson(this.base, '/api/v1/lifecycle', {
          action: 'reshape',
          origin: card.originId,
          fiber: card.id,
          kind: value,
        }),
      ).then((ok) => {
        if (ok) {
          baseline.kind = value
          this.card = { ...this.card, shuttleKind: value }
          dueRow.hidden = false
        } else if (revision === kindRevision) {
          kind.value = baseline.kind
          cronRow.hidden = baseline.kind !== 'standing'
          dueRow.hidden = baseline.kind === 'standing'
        }
      })
    }

    kind.addEventListener('valuechange', (event) => {
      const value = event.detail.value as ShuttleKind
      const revision = ++kindRevision
      cronRow.hidden = value !== 'standing'
      dueRow.hidden = value === 'standing'
      if (value === 'standing') {
        if (!cronInput.value.trim()) cronInput.value = '0 9 * * 1-5'
        if (!tzInput.value.trim()) tzInput.value = 'Europe/Paris'
        paintSpoken()
        cronInput.focus()
        cronInput.select()
      }
      commitKind(value, revision)
    })
    for (const btn of kind.querySelectorAll('button')) {
      btn.addEventListener('mousedown', () => {
        if (btn.dataset.value !== 'standing' && baseline.kind !== 'standing') abandoningPromotion = true
      })
      btn.addEventListener('click', () => { abandoningPromotion = false })
    }
    kind.addEventListener('keydown', (e) => {
      const arrow = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp'
      if (arrow && kind.value === 'standing' && baseline.kind !== 'standing') abandoningPromotion = true
    }, true)

    const commitSchedule = (): void => {
      if (abandoningPromotion) {
        abandoningPromotion = false
        statusEl.textContent = ''
        return
      }
      if (kind.value !== 'standing') return
      const schedule = cronInput.value.trim()
      const tz = tzInput.value.trim() || 'UTC'
      const promoting = baseline.kind !== 'standing'
      if (!promoting && schedule === baseline.schedule && tz === baseline.tz) return
      if (!schedule) {
        errorEl.textContent = 'A standing constitution needs a cron expression.'
        errorEl.style.display = ''
        return
      }
      const card = this.card
      void this.withSaveStatus(() =>
        postDaemonJson(this.base, '/api/v1/lifecycle', {
          action: 'reshape',
          origin: card.originId,
          fiber: card.id,
          kind: 'standing',
          schedule,
          tz,
        }),
      ).then((ok) => {
        if (!ok) return
        baseline.kind = 'standing'
        baseline.schedule = schedule
        baseline.tz = tz
        statusEl.textContent = ''
        this.card = { ...this.card, shuttleKind: 'standing', shuttleSchedule: schedule, shuttleTz: tz }
        dueRow.hidden = true
      })
    }
    for (const input of [cronInput, tzInput]) {
      input.addEventListener('blur', commitSchedule)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          input.blur()
        }
      })
    }

    const foot = document.createElement('div')
    foot.className = 'kbn-ctl-foot'
    foot.append(errorEl, statusEl)

    const factsEl = this.factsEl = document.createElement('p')
    factsEl.className = 'ws-header-facts'

    section.append(fields)
    drawer.append(section, foot, factsEl)
    this.drawer = drawer
    this.paintFacts()
    return drawer
  }

  private paintFacts(): void {
    if (!this.factsEl) return
    const facts = threadFacts(this.card)
    this.factsEl.textContent = facts.text
    this.factsEl.title = facts.title
    this.factsEl.hidden = !facts.text
  }

  private async ensureAgents(): Promise<void> {
    if (this.agentsState !== 'idle' || !this.agentSelect || !this.effortSelect || !this.chromeToggle) return
    this.agentsState = 'loading'
    const agentSelect = this.agentSelect
    const effortSelect = this.effortSelect
    const chromeToggle = this.chromeToggle
    const chromeChip = chromeToggle.parentElement

    const freeze = (why: string): void => {
      for (const el of [agentSelect, effortSelect, chromeToggle]) el.disabled = true
      effortSelect.hidden = effortSelect.options.length === 0
      agentSelect.title = why
      this.agentsState = 'idle'
    }

    let records: AgentEntry[]
    try {
      const agentsUrl = this.card.originId
        ? `${this.base}/api/v1/agents?origin=${encodeURIComponent(this.card.originId)}`
        : `${this.base}/api/v1/agents`
      const raw = await getDaemonJson<AgentEntry[]>(agentsUrl)
      records = Array.isArray(raw) ? raw : []
    } catch {
      if (!this.disposed) freeze('Agent registry unavailable')
      return
    }
    if (this.disposed) return

    const base = records.filter((a) => !a.alias_of)
    if (base.length === 0) {
      freeze('No agents in the registry')
      return
    }
    this.agentsState = 'loaded'
    agentSelect.disabled = false
    agentSelect.title = ''

    const current: AgentAxes = {
      agent: this.card.shuttleAgent ?? '',
      effort: this.card.shuttleEffort ?? '',
      chrome: this.card.shuttleChrome ?? false,
    }
    const defaultAgent = current.agent ? undefined : base.find((a) => a.default)?.id
    agentSelect.replaceChildren()
    for (const group of agentGroups(base)) {
      const optgroup = document.createElement('optgroup')
      optgroup.label = group.label
      for (const agent of group.agents) {
        const opt = new Option(agent.id, agent.id)
        if (agent.model) opt.title = agent.model
        if (agent.id === current.agent || (!current.agent && agent.id === defaultAgent)) opt.selected = true
        optgroup.append(opt)
      }
      agentSelect.append(optgroup)
    }
    if (current.agent && !base.some((a) => a.id === current.agent)) {
      agentSelect.prepend(new Option(`${current.agent} (custom)`, current.agent, true, true))
    }

    const recordFor = (id: string): AgentEntry | undefined => records.find((a) => a.id === id)
    const selectedAgent = (): string => agentSelect.value

    const syncDependents = (agentId: string, effort: string): void => {
      const rec = recordFor(agentId)
      const levels = rec?.effort_levels ?? []
      effortSelect.replaceChildren(...levels.map((lvl) => new Option(lvl, lvl)))
      effortSelect.disabled = levels.length === 0
      effortSelect.hidden = levels.length === 0
      effortSelect.value = levels.includes(effort)
        ? effort
        : rec?.default_effort && levels.includes(rec.default_effort)
          ? rec.default_effort
          : ''

      const chromeOk = rec?.chrome_capable ?? false
      chromeToggle.disabled = !chromeOk
      if (!chromeOk) chromeToggle.checked = false
      if (chromeChip) chromeChip.hidden = !chromeOk
    }

    syncDependents(selectedAgent() || current.agent, current.effort)
    chromeToggle.checked = current.chrome && !chromeToggle.disabled

    let landed: AgentAxes = {
      agent: selectedAgent(),
      effort: effortSelect.value,
      chrome: chromeToggle.checked,
    }
    let intended: AgentAxes = { ...landed }
    let revision = 0
    const axisRequests: Partial<Record<keyof AgentAxes, number>> = {}

    const paint = (axes: AgentAxes): AgentAxes => {
      if (axes.agent && ![...agentSelect.options].some((o) => o.value === axes.agent)) {
        agentSelect.prepend(new Option(`${axes.agent} (custom)`, axes.agent))
      }
      agentSelect.value = axes.agent || defaultAgent || ''
      syncDependents(selectedAgent(), axes.effort)
      chromeToggle.checked = axes.chrome && !chromeToggle.disabled
      return { agent: selectedAgent(), effort: effortSelect.value, chrome: chromeToggle.checked }
    }

    this.reseeders.push(() => {
      landed = paint({
        agent: this.card.shuttleAgent ?? '',
        effort: this.card.shuttleEffort ?? '',
        chrome: this.card.shuttleChrome ?? false,
      })
      intended = { ...landed }
    })

    const commit = (axis: keyof AgentAxes): void => {
      const axes: AgentAxes = { agent: selectedAgent(), effort: effortSelect.value, chrome: chromeToggle.checked }
      const patch: Partial<AgentAxes> = axis === 'agent'
        ? Object.fromEntries(Object.entries(axes).filter(([key, value]) => value !== intended[key as keyof AgentAxes]))
        : { [axis]: axes[axis] }
      if (!Object.keys(patch).length) return
      if ('agent' in patch && !patch.agent) return
      intended = axes
      const request = ++revision
      const keys = Object.keys(patch) as Array<keyof AgentAxes>
      for (const key of keys) axisRequests[key] = request
      const card = this.card
      void this.withSaveStatus(() =>
        postDaemonJson(this.base, '/api/v1/lifecycle', {
          action: 'set-agent',
          origin: card.originId,
          fiber: card.id,
          ...patch,
        }),
      ).then((ok) => {
        if (ok) {
          landed = { ...landed, ...patch }
          this.card = {
            ...this.card,
            ...('agent' in patch ? { shuttleAgent: patch.agent } : {}),
            ...('effort' in patch ? { shuttleEffort: patch.effort || undefined } : {}),
            ...('chrome' in patch ? { shuttleChrome: patch.chrome } : {}),
          }
          this.paintFacts()
        } else {
          for (const key of keys) if (axisRequests[key] === request) Object.assign(intended, { [key]: landed[key] })
          intended = paint(intended)
        }
      })
    }

    agentSelect.addEventListener('change', () => {
      syncDependents(selectedAgent(), '')
      chromeToggle.checked = chromeToggle.checked && !chromeToggle.disabled
      commit('agent')
    })
    effortSelect.addEventListener('change', () => commit('effort'))
    chromeToggle.addEventListener('change', () => commit('chrome'))
  }

  private withSaveStatus(write: () => Promise<void>): Promise<boolean> {
    const statusEl = this.statusEl
    const errorEl = this.errorEl
    this.savesPending++
    const result = this.saveTail.then(async () => {
      if (this.disposed || !statusEl || !errorEl) return false
      errorEl.style.display = 'none'
      statusEl.textContent = 'Saving…'
      statusEl.classList.remove('kbn-detail-save-status-saved')
      statusEl.classList.add('kbn-detail-save-status-saving')
      try {
        await write()
        if (this.disposed) return false
        statusEl.textContent = 'Saved'
        statusEl.classList.remove('kbn-detail-save-status-saving')
        statusEl.classList.add('kbn-detail-save-status-saved')
        clearTimeout(this.statusTimer)
        this.statusTimer = window.setTimeout(() => {
          if (statusEl.textContent === 'Saved') {
            statusEl.textContent = ''
            statusEl.classList.remove('kbn-detail-save-status-saved')
          }
        }, 1500)
        return true
      } catch (err: unknown) {
        if (this.disposed) return false
        const msg = (err as { message?: string })?.message ?? String(err)
        errorEl.textContent = msg
        errorEl.style.display = ''
        statusEl.textContent = ''
        statusEl.classList.remove('kbn-detail-save-status-saving')
        return false
      }
    }).finally(() => { this.savesPending-- })
    this.saveTail = result.then(() => {})
    return result
  }
}
