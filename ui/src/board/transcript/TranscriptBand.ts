import { renderMarkdown } from '../utils.js'
import { sessionWhen } from '../sessionHistory.js'
import { formatSpanMinutes } from '../civilDay.js'
import { TranscriptModel, type Step, type ToolStep, type Turn } from './model.js'
import { TranscriptFeed, type FeedStatus } from './feed.js'
import { toolLabel } from './tools.js'
import type { Entry } from './records.js'
import './transcript.css'

export interface TranscriptTarget {
  session: string
  host?: string
  agent?: string
  live: boolean
  at?: number
}

export interface TranscriptBandOptions {
  shuttleBase: string
  fetch?: typeof fetch
}

interface StepRow {
  version: number
  node: HTMLLIElement
  mark?: HTMLElement
  detail?: HTMLElement
  detailKey?: string
}

interface StepListState {
  expanded: boolean
  count: number
  list: HTMLOListElement | null
  more: HTMLButtonElement | null
}

interface TurnView {
  index: number
  node: HTMLLIElement
  prompt?: HTMLElement
  promptText?: HTMLElement
  promptImages?: HTMLElement
  answer?: HTMLElement
  answerKicker?: HTMLElement
  answerProse?: HTMLElement
  answerMore?: HTMLButtonElement
  answerText?: string
  preButton: HTMLButtonElement | null
  trailingButton: HTMLButtonElement | null
  pre: StepListState
  trailing: StepListState
  rows: Map<number, StepRow>
  expandedRows: Set<number>
  promptUnclamped: boolean
  answerUnclamped: boolean
}

const PAGE_SIZE = 150
const FOLD_KEY = 'shuttle.transcript.folded'
const LIVE_POLL_MS = 3000
const MAX_POLL_MS = 15000

function createButton(className: string, text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = text
  return button
}

function clock(ms: number): { text: string; title: string } {
  const date = new Date(ms)
  return {
    text: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
    title: date.toLocaleString(),
  }
}

function entryTime(entry: Step): number | undefined {
  return entry.at
}

function outputWithImages(result: NonNullable<ToolStep['result']>): string {
  const images = Array.from({ length: result.images }, () => '[image]').join('\n')
  return [result.text, images].filter(Boolean).join('\n')
}

function shortenedOutput(text: string): { shown: string; truncated: boolean; lines: number } {
  const lines = text.split('\n')
  const byChars = text.length > 6000 ? text.slice(0, 6000) : text
  const byLines = byChars.split('\n').slice(0, 40).join('\n')
  return {
    shown: byLines,
    truncated: byLines.length < text.length,
    lines: lines.length,
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function inputObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function inputString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function shortPath(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
}

function buildToolInput(step: ToolStep): HTMLElement {
  const detail = document.createElement('div')
  detail.className = 'ws-transcript-tool-detail'
  const input = inputObject(step.input)
  const name = step.name
  const putPath = (path: string): void => {
    const label = document.createElement('div')
    label.className = 'ws-transcript-tool-path'
    label.textContent = shortPath(path)
    detail.append(label)
  }
  const pre = (text: string, className = ''): HTMLPreElement => {
    const element = document.createElement('pre')
    if (className) element.className = className
    element.textContent = text
    return element
  }

  if (['Bash', 'bash', 'exec_command', 'shell'].includes(name)) {
    const command = inputString(input?.command) ?? inputString(input?.cmd) ?? inputString(step.input)
    if (command) detail.append(pre(command))
  } else if (name === 'Edit' || name === 'edit') {
    const path = inputString(input?.file_path) ?? inputString(input?.path)
    if (path) putPath(path)
    const diff = document.createElement('pre')
    diff.className = 'ws-transcript-diff'
    const addLines = (value: unknown, sign: '−' | '+', kind: 'del' | 'ins'): void => {
      if (typeof value !== 'string') return
      const lines = value.split('\n')
      lines.forEach((line, index) => {
        if (index) diff.append(document.createTextNode('\n'))
        const span = document.createElement('span')
        span.className = kind
        span.textContent = `${sign} ${line}`
        diff.append(span)
      })
    }
    addLines(input?.old_string, '−', 'del')
    if (typeof input?.old_string === 'string' && typeof input?.new_string === 'string') diff.append(document.createTextNode('\n'))
    addLines(input?.new_string, '+', 'ins')
    if (diff.textContent) detail.append(diff)
  } else if (name === 'Write' || name === 'write') {
    const path = inputString(input?.file_path) ?? inputString(input?.path)
    if (path) putPath(path)
    const content = inputString(input?.content)
    if (content !== undefined) detail.append(pre(content))
  } else {
    const serialized = safeStringify(step.input)
    if (serialized) detail.append(pre(serialized))
  }
  return detail
}

function addKicker(parent: HTMLElement, author: string, kind: 'you' | 'dispatch' | 'agent', time?: number): HTMLElement {
  const kicker = document.createElement('div')
  kicker.className = 'ws-transcript-kicker'
  const name = document.createElement('span')
  name.className = `ws-transcript-author ws-transcript-author-${kind}`
  name.textContent = author
  kicker.append(name)
  if (time !== undefined) {
    const when = clock(time)
    const stamp = document.createElement('span')
    stamp.className = 'ws-transcript-clock'
    stamp.textContent = when.text
    stamp.title = when.title
    kicker.append(document.createTextNode(' · '), stamp)
  }
  parent.append(kicker)
  return kicker
}

/** The Dock's reader for one worker's native session transcript. */
export class TranscriptBand {
  readonly el: HTMLElement
  private readonly shuttleBase: string
  private readonly fetcher?: typeof fetch
  private readonly model = new TranscriptModel()
  private readonly views = new Map<number, TurnView>()
  private readonly head: HTMLButtonElement
  private readonly label: HTMLElement
  private readonly reading: HTMLElement
  private readonly liveDot: HTMLElement
  private readonly liveLabel: HTMLElement
  private readonly chevron: HTMLElement
  private readonly latestButton: HTMLButtonElement
  private readonly note: HTMLParagraphElement
  private readonly body: HTMLElement
  private readonly earlierButton: HTMLButtonElement
  private readonly list: HTMLOListElement
  private latest: TranscriptTarget | null = null
  private target: TranscriptTarget | null = null
  private pinned = false
  private folded: boolean
  private feed: TranscriptFeed | null = null
  private readingPromise: Promise<boolean> | null = null
  private pollTimer: number | null = null
  private pollDelay = LIVE_POLL_MS
  private loadingTimer: number | null = null
  private renderFrame: number | null = null
  private measureFrame: number | null = null
  private pendingEntries: Entry[] = []
  private hasInitialRender = false
  private hasReadCurrent = false
  private visibleStart = -1
  private intersecting = true
  private disposed = false
  private readonly visibilityListener = (): void => this.visibilityChanged()
  private observer: IntersectionObserver | null = null

  constructor(opts: TranscriptBandOptions) {
    this.shuttleBase = opts.shuttleBase
    this.fetcher = opts.fetch
    this.folded = this.readFolded()
    this.el = document.createElement('section')
    this.el.className = 'ws-transcript'
    this.el.hidden = true
    this.el.addEventListener('click', (event) => event.stopPropagation())

    this.head = createButton('ws-transcript-head', '')
    this.head.setAttribute('aria-expanded', String(!this.folded))
    this.label = document.createElement('span')
    this.label.className = 'kbn-ctl-label ws-transcript-label'
    this.label.textContent = 'Transcript'
    this.reading = document.createElement('span')
    this.reading.className = 'ws-transcript-reading'
    this.liveDot = document.createElement('span')
    this.liveDot.className = 'ws-transcript-live-dot'
    this.liveDot.setAttribute('aria-hidden', 'true')
    this.liveLabel = document.createElement('span')
    this.liveLabel.className = 'ws-transcript-live-label'
    this.liveLabel.textContent = 'live'
    this.chevron = document.createElement('span')
    this.chevron.className = 'ws-transcript-chevron'
    this.chevron.setAttribute('aria-hidden', 'true')
    this.chevron.textContent = '▾'
    this.head.append(this.label, this.reading, this.liveDot, this.liveLabel, this.chevron)

    this.latestButton = createButton('ws-transcript-latest', '← latest')
    this.latestButton.hidden = true
    this.note = document.createElement('p')
    this.note.className = 'ws-transcript-note'
    this.note.hidden = true
    this.body = document.createElement('div')
    this.body.className = 'ws-transcript-body'
    this.body.hidden = this.folded
    this.earlierButton = createButton('ws-transcript-earlier', '')
    this.earlierButton.hidden = true
    this.list = document.createElement('ol')
    this.list.className = 'ws-transcript-turns'
    this.body.append(this.earlierButton, this.list)
    this.el.append(this.head, this.latestButton, this.note, this.body)

    this.head.addEventListener('click', () => this.toggleFold())
    this.latestButton.addEventListener('click', () => {
      this.pinned = false
      this.showTarget(this.latest)
    })
    this.earlierButton.addEventListener('click', () => this.showEarlier())
    document.addEventListener('visibilitychange', this.visibilityListener)
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersecting = false
      this.observer = new IntersectionObserver((entries) => {
        const visible = entries.some((entry) => entry.isIntersecting)
        const becameVisible = visible && !this.intersecting
        this.intersecting = visible
        if (visible) {
          if (becameVisible) this.readIfVisible()
        } else this.stopPollTimer()
      })
      this.observer.observe(this.el)
    }
    this.paintFold()
  }

  /** Follow the card's latest runtime session, without disturbing a pinned read. */
  follow(target: TranscriptTarget | null): void {
    if (this.disposed) return
    this.latest = target ? { ...target } : null
    if (!this.pinned) this.showTarget(this.latest)
    else this.paintHead()
  }

  /** Pin this band to an earlier session from History. */
  read(target: TranscriptTarget): void {
    if (this.disposed) return
    this.pinned = true
    this.showTarget({ ...target })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopPollTimer()
    this.clearLoadingTimer()
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame)
    if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame)
    this.renderFrame = this.measureFrame = null
    this.feed?.dispose()
    this.feed = null
    this.readingPromise = null
    this.cancelPendingRender()
    this.observer?.disconnect()
    this.observer = null
    document.removeEventListener('visibilitychange', this.visibilityListener)
    this.el.replaceChildren()
  }

  private showTarget(target: TranscriptTarget | null): void {
    const previous = this.target
    if (!target) {
      this.target = null
      this.hasReadCurrent = false
      this.stopPollTimer()
      this.clearLoadingTimer()
      this.feed?.dispose()
      this.feed = null
      this.readingPromise = null
      this.cancelPendingRender()
      this.clearView()
      this.setNote(null)
      this.el.hidden = true
      this.paintHead()
      return
    }

    this.target = { ...target }
    this.el.hidden = false
    if (previous && this.sameTarget(previous, target)) {
      const becameParked = previous.live && !target.live
      this.paintHead()
      if (becameParked) this.finishLiveSession()
      else if (!previous.live && target.live) {
        this.pollDelay = LIVE_POLL_MS
        this.readIfVisible()
      } else this.updateLiveMarks()
      return
    }

    this.stopPollTimer()
    this.clearLoadingTimer()
    this.feed?.dispose()
    this.feed = null
    this.readingPromise = null
    this.cancelPendingRender()
    this.clearView()
    this.setNote(null)
    this.model.reset()
    this.model.takeChanges()
    this.hasInitialRender = false
    this.hasReadCurrent = false
    this.visibleStart = -1
    this.pollDelay = LIVE_POLL_MS
    this.feed = new TranscriptFeed({
      shuttleBase: this.shuttleBase,
      session: target.session,
      host: target.host,
      fetch: this.fetcher,
      onEntries: (entries) => this.acceptEntries(entries),
      onReset: () => this.resetFeedView(),
      onStatus: (status, detail) => this.statusChanged(status, detail),
    })
    this.paintHead()
    this.readIfVisible()
  }

  private sameTarget(a: TranscriptTarget, b: TranscriptTarget): boolean {
    return a.session === b.session && a.host === b.host
  }

  private readFolded(): boolean {
    try { return localStorage.getItem(FOLD_KEY) === '1' } catch { return false }
  }

  private writeFolded(): void {
    try {
      if (this.folded) localStorage.setItem(FOLD_KEY, '1')
      else localStorage.removeItem(FOLD_KEY)
    } catch { /* storage may be unavailable */ }
  }

  private toggleFold(): void {
    this.folded = !this.folded
    this.paintFold()
    this.writeFolded()
    if (this.folded) this.stopPollTimer()
    else this.readIfVisible()
  }

  private paintFold(): void {
    this.body.hidden = this.folded
    this.head.setAttribute('aria-expanded', String(!this.folded))
    this.el.classList.toggle('ws-transcript-open', !this.folded)
  }

  private paintHead(): void {
    const stats = this.model.stats()
    const target = this.target
    const when = stats.startedAt ?? target?.at
    this.label.textContent = `Transcript${this.pinned && target && when !== undefined ? ` · ${sessionWhen(when)}` : ''}`
    const agent = target?.agent ?? stats.model
    const pieces: string[] = []
    if (agent) pieces.push(agent)
    if (when !== undefined) pieces.push(sessionWhen(when))
    this.reading.textContent = pieces.join(' · ')
    this.liveDot.hidden = !target?.live
    this.liveLabel.hidden = !target?.live
    this.latestButton.hidden = !(this.pinned && this.latest && target && !this.sameTarget(target, this.latest))
    this.el.hidden = !target && !this.pinned
  }

  private visibilityChanged(): void {
    if (document.visibilityState === 'visible') this.readIfVisible()
    else this.stopPollTimer()
  }

  private canReadNow(): boolean {
    return !this.disposed && !!this.target && !this.folded && document.visibilityState === 'visible' && this.intersecting
  }

  private readIfVisible(): void {
    if (!this.canReadNow() || (!this.target?.live && this.hasReadCurrent)) return
    this.stopPollTimer()
    void this.readNow()
  }

  private readNow(): Promise<boolean> {
    if (!this.feed || this.disposed) return Promise.resolve(false)
    if (this.readingPromise) return this.readingPromise
    const feed = this.feed
    let shared!: Promise<boolean>
    shared = feed.read().then((arrived) => {
      if (this.readingPromise === shared) this.readingPromise = null
      if (this.feed === feed) this.hasReadCurrent = true
      if (this.feed === feed && this.canReadNow() && this.target?.live) {
        this.pollDelay = arrived ? LIVE_POLL_MS : Math.min(MAX_POLL_MS, this.pollDelay * 1.5)
        this.schedulePoll(this.pollDelay)
      }
      return arrived
    }, () => {
      if (this.readingPromise === shared) this.readingPromise = null
      if (this.feed === feed) this.hasReadCurrent = true
      if (this.feed === feed && this.canReadNow() && this.target?.live) {
        this.pollDelay = Math.min(MAX_POLL_MS, this.pollDelay * 1.5)
        this.schedulePoll(this.pollDelay)
      }
      return false
    })
    this.readingPromise = shared
    return shared
  }

  private schedulePoll(delay: number): void {
    this.stopPollTimer()
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null
      if (this.canReadNow() && this.target?.live) void this.readNow()
    }, delay)
  }

  private stopPollTimer(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private finishLiveSession(): void {
    this.stopPollTimer()
    if (!this.feed) return
    const current = this.readingPromise
    if (current) {
      void current.finally(() => {
        if (!this.disposed && this.feed && this.target && !this.target.live) void this.readNow()
      })
    } else void this.readNow()
  }

  private statusChanged(status: FeedStatus, detail?: string): void {
    if (this.disposed) return
    if (status === 'loading') {
      this.clearLoadingTimer()
      this.loadingTimer = window.setTimeout(() => {
        this.loadingTimer = null
        this.setNote('loading')
      }, 300)
      return
    }
    this.clearLoadingTimer()
    this.paintHead()
    if (status === 'ready') {
      if (!this.hasInitialRender) this.renderInitialTurns()
      const empty = this.model.turns.length === 0
      this.setNote(empty && this.target?.live ? 'empty-live' : null)
      return
    }
    this.setNote(status, detail)
  }

  private setNote(status: FeedStatus | 'empty-live' | null, detail?: string): void {
    if (!status) {
      this.note.hidden = true
      this.note.textContent = ''
      return
    }
    let text = ''
    if (status === 'loading') text = 'Reading the transcript…'
    else if (status === 'missing') text = `No transcript for this session${this.target?.host ? ` on ${this.target.host}` : ''}.`
    else if (status === 'pending') text = 'Waiting for the session to be recorded…'
    else if (status === 'unreachable') text = `${detail ?? this.target?.host ?? 'The host'} is unreachable.`
    else if (status === 'error') text = 'The transcript could not be read.'
    else if (status === 'empty-live') text = 'Nothing recorded yet.'
    this.note.textContent = text
    this.note.hidden = !text
  }

  private clearLoadingTimer(): void {
    if (this.loadingTimer !== null) window.clearTimeout(this.loadingTimer)
    this.loadingTimer = null
  }

  private acceptEntries(entries: Entry[]): void {
    if (this.disposed) return
    this.pendingEntries.push(...entries)
    if (this.renderFrame !== null) return
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null
      if (this.disposed || !this.pendingEntries.length) return
      const before = this.model.turns.length
      this.model.append(this.pendingEntries)
      this.pendingEntries = []
      const changes = this.model.takeChanges()
      if (changes.reset) this.clearView()
      if (!this.hasInitialRender) return
      const after = this.model.turns.length
      if (before === 0 && after > 0) this.visibleStart = after - 1
      for (const index of changes.turns) {
        if (index >= this.visibleStart) this.renderTurn(index)
      }
      if (after > before && before > 0) {
        const previous = this.views.get(before - 1)
        if (previous) this.updateTurnView(previous, this.model.turns[before - 1])
      }
      this.updateEarlierButton()
      this.paintHead()
      this.scheduleClampMeasure()
      this.setNote(null)
    })
  }

  private resetFeedView(): void {
    this.cancelPendingRender()
    this.model.reset()
    this.model.takeChanges()
    this.hasInitialRender = false
    this.hasReadCurrent = false
    this.visibleStart = -1
    this.clearView()
    this.paintHead()
    this.setNote(null)
  }

  private renderInitialTurns(): void {
    if (this.hasInitialRender) return
    this.hasInitialRender = true
    const turns = this.model.turns
    this.visibleStart = turns.length ? turns.length - 1 : -1
    this.list.replaceChildren()
    this.views.clear()
    if (turns.length) this.renderTurn(turns.length - 1)
    this.updateEarlierButton()
    this.paintHead()
    this.scheduleClampMeasure()
  }

  private cancelPendingRender(): void {
    this.pendingEntries = []
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame)
    this.renderFrame = null
  }

  private clearView(): void {
    this.views.clear()
    this.list.replaceChildren()
    this.earlierButton.hidden = true
    this.earlierButton.textContent = ''
  }

  private renderTurn(index: number): void {
    if (index < 0 || index >= this.model.turns.length || index < this.visibleStart) return
    const turn = this.model.turns[index]
    let view = this.views.get(index)
    if (!view) {
      view = this.createTurnView(index)
      this.views.set(index, view)
    }
    this.updateTurnView(view, turn)
    const next = [...this.list.children].find((node) => Number((node as HTMLElement).dataset.turn) > index)
    if (view.node.parentElement !== this.list || view.node.nextElementSibling !== next) {
      this.list.insertBefore(view.node, next ?? null)
    }
  }

  private createTurnView(index: number): TurnView {
    const node = document.createElement('li')
    node.className = 'ws-transcript-turn'
    node.dataset.turn = String(index)
    return {
      index,
      node,
      preButton: null,
      trailingButton: null,
      pre: { expanded: false, count: PAGE_SIZE, list: null, more: null },
      trailing: { expanded: false, count: PAGE_SIZE, list: null, more: null },
      rows: new Map(),
      expandedRows: new Set(),
      promptUnclamped: false,
      answerUnclamped: false,
    }
  }

  private updateTurnView(view: TurnView, turn: Turn): void {
    if (turn.prompt) this.updatePrompt(view, turn.prompt)
    const answerStep = turn.answer >= 0 ? turn.steps[turn.answer] : undefined
    if (answerStep?.kind === 'text') this.updateAnswer(view, answerStep, turn.answer, view.index === this.model.turns.length - 1)

    const beforeCount = turn.answer >= 0 ? turn.answer : 0
    const afterStart = turn.answer >= 0 ? turn.answer + 1 : 0
    const trailingCount = turn.steps.length - afterStart
    if (beforeCount > 0) this.ensureStepsButton(view)
    if (trailingCount > 0) this.ensureTrailingButton(view)
    if (view.pre.expanded && beforeCount > 0) this.reconcileStepList(view, turn, 'pre', beforeCount)
    if (view.trailing.expanded && trailingCount > 0) this.reconcileStepList(view, turn, 'trailing', trailingCount)

    const children: Node[] = []
    if (view.prompt) children.push(view.prompt)
    if (beforeCount > 0 && view.preButton) {
      children.push(view.preButton)
      if (view.pre.expanded && view.pre.list) children.push(view.pre.list)
      if (view.pre.expanded && view.pre.more) children.push(view.pre.more)
    }
    if (view.answer) children.push(view.answer)
    if (trailingCount > 0 && view.trailingButton) {
      children.push(view.trailingButton)
      if (view.trailing.expanded && view.trailing.list) children.push(view.trailing.list)
      if (view.trailing.expanded && view.trailing.more) children.push(view.trailing.more)
    }
    view.node.replaceChildren(...children)
    this.updateStepSummary(view, turn, beforeCount, trailingCount, afterStart)
  }

  private updatePrompt(view: TurnView, prompt: Extract<Entry, { kind: 'prompt' }>): void {
    if (!view.prompt) {
      view.prompt = document.createElement('div')
      view.prompt.className = 'ws-transcript-prompt'
      const text = document.createElement('div')
      text.className = 'ws-transcript-prompt-text'
      text.addEventListener('click', () => this.unclampPrompt(view))
      text.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          this.unclampPrompt(view)
        }
      })
      view.promptText = text
      const images = document.createElement('span')
      images.className = 'ws-transcript-prompt-images'
      view.promptImages = images
      view.prompt.append(text, images)
    }
    const text = view.promptText!
    if (text.dataset.source !== prompt.text) {
      text.dataset.source = prompt.text
      text.innerHTML = renderMarkdown(prompt.text, { untrusted: true })
    }
    text.classList.toggle('ws-transcript-prompt-dispatch', prompt.dispatch)
    text.classList.toggle('ws-transcript-unclamped', view.promptUnclamped)
    text.setAttribute('role', 'button')
    text.setAttribute('aria-expanded', String(view.promptUnclamped))
    text.tabIndex = 0
    const existing = view.prompt.querySelector('.ws-transcript-kicker')
    existing?.remove()
    addKicker(view.prompt, prompt.dispatch ? 'dispatch' : 'you', prompt.dispatch ? 'dispatch' : 'you', prompt.at)
    view.prompt.append(text, view.promptImages!)
    view.promptImages!.textContent = Array.from({ length: prompt.images }, () => '[image]').join(' ')
    view.promptImages!.hidden = prompt.images === 0
  }

  private updateAnswer(view: TurnView, entry: Extract<Entry, { kind: 'text' }>, index: number, isLast: boolean): void {
    if (!view.answer) {
      view.answer = document.createElement('div')
      view.answer.className = 'ws-transcript-answer'
      view.answerKicker = document.createElement('div')
      view.answerKicker.className = 'ws-transcript-kicker'
      view.answerProse = document.createElement('div')
      view.answerProse.className = 'ws-transcript-prose'
      view.answerMore = createButton('ws-transcript-more', 'Continue reading')
      view.answerMore.hidden = true
      view.answerMore.addEventListener('click', () => {
        view.answerUnclamped = true
        view.answerProse?.classList.add('ws-transcript-unclamped')
        view.answerProse?.classList.remove('ws-transcript-overflowing')
        view.answerMore!.hidden = true
      })
      view.answerProse.addEventListener('click', () => {
        if (view.answerProse?.classList.contains('ws-transcript-overflowing')) {
          view.answerUnclamped = true
          view.answerProse.classList.add('ws-transcript-unclamped')
          view.answerProse.classList.remove('ws-transcript-overflowing')
          view.answerMore!.hidden = true
        }
      })
      view.answer.append(view.answerKicker, view.answerProse, view.answerMore)
    }
    const agent = this.target?.agent ?? this.model.stats().model ?? 'worker'
    const stamp = entry.at === undefined ? '' : clock(entry.at).text
    const identity = `${agent}|${stamp}`
    if (view.answerKicker!.dataset.identity !== identity) {
      view.answerKicker!.replaceChildren()
      addKicker(view.answerKicker!, agent, 'agent', entry.at)
      view.answerKicker!.dataset.identity = identity
    }
    if (view.answerText !== entry.text || view.answer?.dataset.answerIndex !== String(index)) {
      view.answerText = entry.text
      view.answer.dataset.answerIndex = String(index)
      view.answerProse!.innerHTML = renderMarkdown(entry.text, { untrusted: true })
    }
    view.answer.classList.toggle('ws-transcript-answer-last', isLast)
    view.answerProse!.classList.toggle('ws-transcript-unclamped', view.answerUnclamped)
  }

  private ensureStepsButton(view: TurnView): HTMLButtonElement {
    if (!view.preButton) {
      view.preButton = createButton('ws-transcript-steps', '')
      view.preButton.setAttribute('aria-expanded', 'false')
      view.preButton.addEventListener('click', () => this.toggleSteps(view, 'pre'))
    }
    return view.preButton
  }

  private ensureTrailingButton(view: TurnView): HTMLButtonElement {
    if (!view.trailingButton) {
      view.trailingButton = createButton('ws-transcript-trailing', '')
      view.trailingButton.setAttribute('aria-expanded', 'false')
      view.trailingButton.addEventListener('click', () => this.toggleSteps(view, 'trailing'))
    }
    return view.trailingButton
  }

  private updateStepSummary(view: TurnView, turn: Turn, beforeCount: number, trailingCount: number, afterStart: number): void {
    if (beforeCount > 0 && view.preButton) {
      const steps = turn.steps.slice(0, beforeCount)
      const labels = new Map<string, number>()
      for (const step of steps) {
        if (step.kind !== 'tool') continue
        const name = toolLabel(step.name, step.input).name
        labels.set(name, (labels.get(name) ?? 0) + 1)
      }
      const start = turn.startedAt
      const end = turn.answer >= 0 ? entryTime(turn.steps[turn.answer]) : undefined
      const duration = start !== undefined && end !== undefined && end >= start
        ? ` · ${formatSpanMinutes(Math.floor((end - start) / 60_000))}`
        : ''
      const tools = [...labels].map(([name, count]) => `${name} ${count}`).join(' · ')
      view.preButton.textContent = `${view.pre.expanded ? '▾' : '▸'} ${beforeCount} steps${duration}${tools ? ` · ${tools}` : ''}`
      view.preButton.setAttribute('aria-expanded', String(view.pre.expanded))
    }

    if (trailingCount > 0 && view.trailingButton) {
      const trailing = turn.steps.slice(afterStart)
      const lines = trailing
        .filter((step): step is ToolStep => step.kind === 'tool')
        .slice(0, 2)
        .map((step) => {
          const label = toolLabel(step.name, step.input)
          return [label.name, label.summary].filter(Boolean).join(' ')
        })
      const lastTool = trailing.filter((step): step is ToolStep => step.kind === 'tool').at(-1)
      const pending = this.target?.live === true && !!lastTool && !lastTool.result
      view.trailingButton.replaceChildren(document.createTextNode(
        `then ${trailingCount} steps${lines.length ? ` · ${lines.join(' · ')}` : ''}`,
      ))
      const mark = document.createElement('span')
      mark.className = 'ws-transcript-pending'
      mark.hidden = !pending
      mark.setAttribute('aria-label', pending ? 'tool running' : '')
      view.trailingButton.append(document.createTextNode(' '), mark)
      view.trailingButton.setAttribute('aria-expanded', String(view.trailing.expanded))
    }
  }

  private toggleSteps(view: TurnView, which: 'pre' | 'trailing'): void {
    const state = view[which]
    state.expanded = !state.expanded
    const turn = this.model.turns[view.index]
    const count = which === 'pre'
      ? (turn.answer >= 0 ? turn.answer : 0)
      : turn.steps.length - (turn.answer >= 0 ? turn.answer + 1 : 0)
    if (state.expanded && count > 0) this.reconcileStepList(view, turn, which, count)
    this.updateTurnView(view, turn)
  }

  private reconcileStepList(view: TurnView, turn: Turn, which: 'pre' | 'trailing', count: number): void {
    const state = view[which]
    if (!state.expanded) return
    if (!state.list) {
      state.list = document.createElement('ol')
      state.list.className = 'ws-transcript-steplist'
    }
    if (!state.more) {
      state.more = createButton('ws-transcript-steps-more', '')
      state.more.hidden = true
      state.more.addEventListener('click', () => {
        state.count += PAGE_SIZE
        this.reconcileStepList(view, this.model.turns[view.index], which, which === 'pre'
          ? (this.model.turns[view.index].answer >= 0 ? this.model.turns[view.index].answer : 0)
          : this.model.turns[view.index].steps.length - (this.model.turns[view.index].answer >= 0 ? this.model.turns[view.index].answer + 1 : 0))
        this.updateTurnView(view, this.model.turns[view.index])
      })
    }
    const start = which === 'pre' ? 0 : (turn.answer >= 0 ? turn.answer + 1 : 0)
    const available = turn.steps.slice(start, start + count)
    const shown = available.slice(0, state.count)
    const wanted = shown.map((step, relative) => this.getStepRow(view, step, start + relative).node)
    const children = [...state.list.children]
    const prefix = children.length <= wanted.length && children.every((child, index) => child === wanted[index])
    if (prefix) {
      for (let i = children.length; i < wanted.length; i++) state.list.append(wanted[i])
    } else state.list.replaceChildren(...wanted)

    const remaining = Math.max(0, available.length - shown.length)
    state.more.hidden = remaining === 0
    state.more.textContent = `▾ ${remaining} more steps`
  }

  private getStepRow(view: TurnView, step: Step, index: number): StepRow {
    const version = step.kind === 'tool' ? step.version : 0
    const cached = view.rows.get(index)
    if (cached?.version === version) return cached
    const row = this.createStepRow(view, step, index)
    row.version = version
    view.rows.set(index, row)
    return row
  }

  private createStepRow(view: TurnView, step: Step, index: number): StepRow {
    const node = document.createElement('li')
    if (step.kind === 'text') {
      node.className = 'ws-transcript-say'
      node.innerHTML = renderMarkdown(step.text, { untrusted: true })
      return { version: 0, node }
    }
    if (step.kind === 'tool') return this.createToolRow(view, node, step, index)
    if (step.kind === 'thinking') {
      node.className = 'ws-transcript-think'
      const button = createButton('ws-transcript-expand', 'Thinking')
      const text = document.createElement('div')
      text.className = 'ws-transcript-thinking-text'
      text.textContent = step.text
      text.hidden = !view.expandedRows.has(index)
      button.setAttribute('aria-expanded', String(!text.hidden))
      button.addEventListener('click', () => {
        const expanded = view.expandedRows.has(index)
        if (expanded) view.expandedRows.delete(index)
        else view.expandedRows.add(index)
        text.hidden = expanded
        button.setAttribute('aria-expanded', String(!expanded))
      })
      node.append(button, text)
      return { version: 0, node }
    }
    node.className = 'ws-transcript-event'
    const text = step.text
    const label = [step.label, step.detail].filter(Boolean).join(' · ')
    const button = createButton('ws-transcript-expand', label)
    button.setAttribute('aria-expanded', String(view.expandedRows.has(index)))
    const content = document.createElement('div')
    content.className = 'ws-transcript-event-text'
    content.textContent = text ?? ''
    content.hidden = !view.expandedRows.has(index) || !text
    button.addEventListener('click', () => {
      if (!text) return
      const expanded = view.expandedRows.has(index)
      if (expanded) view.expandedRows.delete(index)
      else view.expandedRows.add(index)
      content.hidden = expanded
      button.setAttribute('aria-expanded', String(!expanded))
    })
    node.append(button, content)
    return { version: 0, node }
  }

  private createToolRow(view: TurnView, node: HTMLLIElement, step: ToolStep, index: number): StepRow {
    node.className = 'ws-transcript-tool'
    const line = createButton('ws-transcript-tool-line', '')
    line.setAttribute('aria-expanded', String(view.expandedRows.has(index)))
    const name = document.createElement('span')
    name.className = 'ws-transcript-tool-name'
    const summary = document.createElement('span')
    summary.className = 'ws-transcript-tool-summary'
    const mark = document.createElement('span')
    mark.className = 'ws-transcript-tool-mark'
    const label = toolLabel(step.name, step.input)
    name.textContent = label.name
    summary.textContent = label.summary
    line.append(name, summary, mark)
    node.append(line)
    const row: StepRow = { version: step.version, node, mark }
    line.addEventListener('click', () => {
      const expanded = view.expandedRows.has(index)
      if (expanded) view.expandedRows.delete(index)
      else view.expandedRows.add(index)
      line.setAttribute('aria-expanded', String(!expanded))
      if (!row.detail && !expanded) {
        row.detail = buildToolInput(step)
        node.append(row.detail)
      }
      if (row.detail) row.detail.hidden = expanded
      if (!expanded) this.buildToolResult(row, step)
      this.refreshToolRow(row, step)
    })
    if (view.expandedRows.has(index)) {
      row.detail = buildToolInput(step)
      node.append(row.detail)
      this.buildToolResult(row, step)
    }
    this.refreshToolRow(row, step)
    return row
  }

  private refreshToolRow(row: StepRow, step: ToolStep): void {
    if (!row.mark) return
    if (step.result?.isError) {
      row.mark.textContent = '✕'
      row.mark.className = 'ws-transcript-tool-mark ws-transcript-tool-error'
      row.mark.hidden = false
    } else if (!step.result && this.target?.live) {
      row.mark.textContent = ''
      row.mark.className = 'ws-transcript-tool-mark ws-transcript-tool-pending'
      row.mark.hidden = false
    } else {
      row.mark.textContent = ''
      row.mark.className = 'ws-transcript-tool-mark'
      row.mark.hidden = true
    }
    if (row.detail && viewExpanded(row)) {
      const detailKey = `${step.version}:${this.target?.live ? 'live' : 'parked'}`
      if (row.detailKey !== detailKey) this.buildToolResult(row, step)
    }
  }

  private buildToolResult(row: StepRow, step: ToolStep): void {
    row.detail?.querySelector('.ws-transcript-output-wrap, .ws-transcript-no-result')?.remove()
    row.detailKey = `${step.version}:${this.target?.live ? 'live' : 'parked'}`
    if (!step.result) {
      if (this.target?.live) return
      const noResult = document.createElement('div')
      noResult.className = 'ws-transcript-no-result'
      noResult.textContent = 'no result'
      row.detail?.append(noResult)
      return
    }
    const full = outputWithImages(step.result)
    const truncated = shortenedOutput(full)
    const wrap = document.createElement('div')
    wrap.className = 'ws-transcript-output-wrap'
    const output = document.createElement('pre')
    output.className = `ws-transcript-output${step.result.isError ? ' ws-transcript-error' : ''}`
    output.textContent = truncated.shown
    wrap.append(output)
    if (truncated.truncated) {
      const showAll = createButton('ws-transcript-showall', `Show all ${truncated.lines} lines`)
      showAll.addEventListener('click', () => {
        output.textContent = full
        showAll.remove()
      })
      wrap.append(showAll)
    }
    row.detail?.append(wrap)
  }

  private updateLiveMarks(): void {
    for (const view of this.views.values()) {
      for (const [index, row] of view.rows) {
        const step = this.model.turns[view.index]?.steps[index]
        if (step?.kind === 'tool') this.refreshToolRow(row, step)
      }
      const turn = this.model.turns[view.index]
      if (turn) this.updateTurnView(view, turn)
    }
  }

  private updateEarlierButton(): void {
    const count = Math.min(12, Math.max(0, this.visibleStart))
    this.earlierButton.hidden = count === 0
    this.earlierButton.textContent = `▴ ${count} earlier turns`
  }

  private showEarlier(): void {
    if (this.visibleStart <= 0) return
    const anchor = this.list.firstElementChild as HTMLElement | null
    const before = anchor?.getBoundingClientRect().top
    const count = Math.min(12, this.visibleStart)
    const start = this.visibleStart - count
    this.visibleStart = start
    for (let index = start; index < start + count; index++) this.renderTurn(index)
    this.updateEarlierButton()
    if (anchor && before !== undefined) {
      const after = anchor.getBoundingClientRect().top
      const delta = after - before
      if (delta) this.adjustScroll(delta, anchor)
    }
    this.scheduleClampMeasure()
  }

  private adjustScroll(delta: number, from: HTMLElement): void {
    let parent = from.parentElement
    while (parent) {
      const style = getComputedStyle(parent)
      if (/^(auto|scroll)$/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
        parent.scrollTop += delta
        return
      }
      parent = parent.parentElement
    }
    try { window.scrollBy(0, delta) } catch { /* the page may not expose a window scroller */ }
  }

  private unclampPrompt(view: TurnView): void {
    if (!view.promptText || !view.promptText.classList.contains('ws-transcript-overflowing')) return
    view.promptUnclamped = true
    view.promptText.setAttribute('aria-expanded', 'true')
    view.promptText.classList.add('ws-transcript-unclamped')
    view.promptText.classList.remove('ws-transcript-overflowing')
  }

  private scheduleClampMeasure(): void {
    if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame)
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = null
      if (this.disposed) return
      for (const view of this.views.values()) {
        const prompt = view.promptText
        if (prompt) {
          const overflow = !view.promptUnclamped && prompt.scrollHeight > prompt.clientHeight
          prompt.classList.toggle('ws-transcript-overflowing', overflow)
          prompt.setAttribute('aria-expanded', String(view.promptUnclamped))
          if (overflow) prompt.setAttribute('aria-label', 'Expand prompt')
          else prompt.removeAttribute('aria-label')
        }
        const prose = view.answerProse
        if (prose) {
          const overflow = !view.answerUnclamped && prose.scrollHeight > prose.clientHeight
          prose.classList.toggle('ws-transcript-overflowing', overflow)
          if (view.answerMore) view.answerMore.hidden = !overflow
        }
      }
    })
  }
}

function viewExpanded(row: StepRow): boolean {
  return Boolean(row.detail && !row.detail.hidden)
}
