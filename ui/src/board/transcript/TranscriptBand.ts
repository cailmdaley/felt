import { renderMarkdown } from '../utils.js'
import { sessionWhen } from '../sessionHistory.js'
import { DATE_AND_TIME, formatInstant, formatSpanMinutes } from '../civilDay.js'
import { TranscriptModel, segments, type Step, type ToolStep, type Turn } from './model.js'
import { TranscriptFeed, type FeedStatus } from './feed.js'
import { toolLabel } from './tools.js'
import { promptParts, type Entry } from './records.js'
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

type Prompt = Extract<Entry, { kind: 'prompt' }>
type Text = Extract<Entry, { kind: 'text' }>
type Speaker = 'you' | 'dispatch' | 'agent'

interface StepRow {
  version: number
  node: HTMLLIElement
  mark?: HTMLElement
  detail?: HTMLElement
  detailKey?: string
}

/** One run of work between two agent messages, folded behind its summary. */
interface StepGroup {
  expanded: boolean
  count: number
  button: HTMLButtonElement
  list: HTMLOListElement | null
  more: HTMLButtonElement | null
}

interface Message {
  node: HTMLElement
  kicker: HTMLElement
  prose: HTMLElement
  images?: HTMLElement
  source?: string
  identity?: string
  unclamped: boolean
}

interface TurnView {
  index: number
  node: HTMLLIElement
  prompt?: Message
  texts: Map<number, Message>
  groups: Map<number, StepGroup>
  rows: Map<number, StepRow>
  expandedRows: Set<number>
}

const PAGE_SIZE = 150
const INITIAL_TURNS = 3
const EARLIER_TURNS = 12
const FOLD_KEY = 'shuttle.transcript.folded'
const LIVE_POLL_MS = 3000
const MAX_POLL_MS = 15000
/** Room left above the anchored message, so its kicker is not flush with the edge. */
const ANCHOR_MARGIN = 8
/** How close to the anchor a reader must stay to keep following new messages. */
const FOLLOW_SLACK = 24

function createButton(className: string, text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = text
  return button
}

function clock(ms: number): { text: string; title: string } {
  return {
    text: formatInstant(ms, { hour: '2-digit', minute: '2-digit', hour12: false }),
    title: formatInstant(ms, DATE_AND_TIME),
  }
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

function setKicker(kicker: HTMLElement, author: string, speaker: Speaker, time?: number): void {
  const name = document.createElement('span')
  name.className = `ws-transcript-author ws-transcript-author-${speaker}`
  name.textContent = author
  kicker.replaceChildren(name)
  if (time !== undefined) {
    const when = clock(time)
    const stamp = document.createElement('span')
    stamp.className = 'ws-transcript-clock'
    stamp.textContent = when.text
    stamp.title = when.title
    kicker.append(document.createTextNode(' · '), stamp)
  }
}

/** A speaker's message: a kicker naming who spoke and when, over the rendered words. */
function createMessage(speaker: Speaker, tag: 'div' | 'li' = 'div'): Message {
  const node = document.createElement(tag)
  node.className = `ws-transcript-msg ws-transcript-msg-${speaker === 'agent' ? 'agent' : 'you'}`
  const kicker = document.createElement('div')
  kicker.className = 'ws-transcript-kicker'
  const prose = document.createElement('div')
  prose.className = speaker === 'agent' ? 'ws-transcript-prose' : 'ws-transcript-prompt-text'
  node.append(kicker, prose)
  return { node, kicker, prose, unclamped: false }
}

function paintText(message: Message, author: string, entry: Text): void {
  const identity = `${author}|${entry.at ?? ''}`
  if (message.identity !== identity) {
    setKicker(message.kicker, author, 'agent', entry.at)
    message.identity = identity
  }
  if (message.source !== entry.text) {
    message.source = entry.text
    message.prose.innerHTML = renderMarkdown(entry.text, { untrusted: true })
  }
}

/** A prompt's words, with each pasted block set apart as a quoted paste. */
function promptHtml(source: string): string {
  return promptParts(source).map((part) => {
    const html = renderMarkdown(part.text, { untrusted: true })
    if (part.kind === 'text') return html
    const lines = part.text.split('\n').length
    return `<div class="ws-transcript-pasted"><div class="ws-transcript-pasted-label">pasted · ${lines} ${lines === 1 ? 'line' : 'lines'}</div>${html}</div>`
  }).join('')
}

/** A prompt clamps to a few lines until it is clicked open: a dispatch carries the whole constitution. */
function paintPrompt(message: Message, prompt: Prompt): void {
  const speaker: Speaker = prompt.dispatch ? 'dispatch' : 'you'
  const identity = `${speaker}|${prompt.at ?? ''}`
  if (message.identity !== identity) {
    setKicker(message.kicker, speaker, speaker, prompt.at)
    message.identity = identity
  }
  const text = message.prose
  if (message.source !== prompt.text) {
    message.source = prompt.text
    text.innerHTML = promptHtml(prompt.text)
  }
  if (!text.dataset.clampable) {
    text.dataset.clampable = '1'
    text.tabIndex = 0
    text.setAttribute('role', 'button')
    const unclamp = (event: Event): void => {
      if (!text.classList.contains('ws-transcript-overflowing')) return
      event.stopPropagation()
      message.unclamped = true
      text.classList.add('ws-transcript-unclamped')
      text.classList.remove('ws-transcript-overflowing')
      text.setAttribute('aria-expanded', 'true')
      text.removeAttribute('aria-label')
    }
    text.addEventListener('click', unclamp)
    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        unclamp(event)
      }
    })
  }
  text.classList.toggle('ws-transcript-prompt-dispatch', prompt.dispatch)
  text.classList.toggle('ws-transcript-unclamped', message.unclamped)
  text.setAttribute('aria-expanded', String(message.unclamped))
  if (!message.images) {
    message.images = document.createElement('span')
    message.images.className = 'ws-transcript-prompt-images'
    message.node.append(message.images)
  }
  message.images.textContent = Array.from({ length: prompt.images }, () => '[image]').join(' ')
  message.images.hidden = prompt.images === 0
}

function measureClamp(text: HTMLElement, unclamped: boolean): void {
  const overflow = !unclamped && text.scrollHeight > text.clientHeight
  text.classList.toggle('ws-transcript-overflowing', overflow)
  if (overflow) text.setAttribute('aria-label', 'Expand prompt')
  else text.removeAttribute('aria-label')
}

/**
 * Scroll so the newest message starts in view: its top when it is taller than
 * the window, otherwise as far down as the content goes. Returns the offset
 * it settled on, against which a reader's own scrolling is measured.
 */
function anchorLatest(scroller: HTMLElement): number {
  const messages = scroller.querySelectorAll<HTMLElement>('.ws-transcript-msg')
  const last = messages[messages.length - 1]
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const top = last
    ? scroller.scrollTop + last.getBoundingClientRect().top - scroller.getBoundingClientRect().top - ANCHOR_MARGIN
    : max
  const settled = Math.max(0, Math.min(top, max))
  scroller.scrollTop = settled
  return settled
}

/**
 * The Dock's reader for one worker's native session transcript.
 *
 * In the page it shows the last exchange as words only — the last prompt and
 * every agent message since — in a window a third of the viewport tall,
 * scrolled to the newest message. The whole session, with its tool calls,
 * thinking and events, opens as a pane over the constitution page's content:
 * not a modal, so the board, the sidebar and the constitution's other pages
 * stay in reach while it is open.
 */
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
  private readonly openButton: HTMLButtonElement
  private readonly latestButton: HTMLButtonElement
  private readonly note: HTMLParagraphElement
  private readonly body: HTMLElement
  private readonly preview: HTMLElement
  private readonly exchange: HTMLOListElement
  private readonly working: HTMLLIElement
  private readonly pane: HTMLElement
  private readonly paneReading: HTMLElement
  private readonly scroller: HTMLElement
  private readonly earlierButton: HTMLButtonElement
  private readonly list: HTMLOListElement
  private previewPrompt: Message | null = null
  private previewTexts = new Map<number, Message>()
  private previewTurn = -1
  private previewKey = ''
  private previewAnchor = 0
  private previewFollowing = true
  private fullAnchor = 0
  private fullFollowing = true
  private fullOpen = false
  private fullRendered = false
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
  private layoutFrame: number | null = null
  private pendingEntries: Entry[] = []
  private hasInitialRender = false
  private initialReadyPending = false
  private hasReadCurrent = false
  private visibleStart = -1
  private intersecting = true
  private disposed = false
  private readonly visibilityListener = (): void => this.visibilityChanged()
  private observer: IntersectionObserver | null = null
  private resizer: ResizeObserver | null = null
  private previewScroll = 0
  private fullScroll = 0

  constructor(opts: TranscriptBandOptions) {
    this.shuttleBase = opts.shuttleBase
    this.fetcher = opts.fetch
    this.folded = this.readFolded()
    this.el = document.createElement('section')
    this.el.className = 'ws-transcript'
    this.el.hidden = true
    this.el.addEventListener('click', (event) => event.stopPropagation())

    const headRow = document.createElement('div')
    headRow.className = 'ws-transcript-headrow'
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
    const chevron = document.createElement('span')
    chevron.className = 'ws-transcript-chevron'
    chevron.setAttribute('aria-hidden', 'true')
    chevron.textContent = '▾'
    this.head.append(this.label, this.reading, this.liveDot, this.liveLabel, chevron)
    this.openButton = createButton('ws-transcript-open-full', 'Full transcript')
    this.openButton.setAttribute('aria-expanded', 'false')
    headRow.append(this.head, this.openButton)

    this.latestButton = createButton('ws-transcript-latest', '← latest')
    this.latestButton.hidden = true
    this.note = document.createElement('p')
    this.note.className = 'ws-transcript-note'
    this.note.hidden = true

    this.body = document.createElement('div')
    this.body.className = 'ws-transcript-body'
    this.body.hidden = this.folded
    this.preview = document.createElement('div')
    this.preview.className = 'ws-transcript-preview'
    this.preview.title = 'Open the full transcript'
    this.preview.hidden = true
    this.exchange = document.createElement('ol')
    this.exchange.className = 'ws-transcript-exchange'
    this.working = document.createElement('li')
    this.working.className = 'ws-transcript-working'
    this.working.textContent = 'working'
    this.preview.append(this.exchange)
    this.body.append(this.preview)

    this.pane = document.createElement('section')
    this.pane.className = 'ws-transcript-pane'
    this.pane.setAttribute('aria-label', 'Transcript')
    this.pane.hidden = true
    const panelHead = document.createElement('header')
    panelHead.className = 'ws-transcript-panel-head'
    const title = document.createElement('span')
    title.className = 'kbn-ctl-label ws-transcript-label'
    title.textContent = 'Transcript'
    this.paneReading = document.createElement('span')
    this.paneReading.className = 'ws-transcript-reading'
    const close = createButton('ws-transcript-close', '×')
    close.setAttribute('aria-label', 'Close the transcript')
    panelHead.append(title, this.paneReading, close)
    this.scroller = document.createElement('div')
    this.scroller.className = 'ws-transcript-scroll'
    this.scroller.tabIndex = -1
    this.earlierButton = createButton('ws-transcript-earlier', '')
    this.earlierButton.hidden = true
    this.list = document.createElement('ol')
    this.list.className = 'ws-transcript-turns'
    this.scroller.append(this.earlierButton, this.list)
    this.pane.append(panelHead, this.scroller)

    this.el.append(headRow, this.latestButton, this.note, this.body)

    this.head.addEventListener('click', () => this.toggleFold())
    this.openButton.addEventListener('click', () => this.openFull())
    this.preview.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest('a')) return
      if (window.getSelection?.()?.toString()) return
      this.openFull()
    })
    this.preview.addEventListener('scroll', () => {
      if (!this.preview.clientHeight) return
      this.previewScroll = this.preview.scrollTop
      this.previewFollowing = this.preview.scrollTop >= this.previewAnchor - FOLLOW_SLACK
      this.preview.classList.toggle('ws-transcript-scrolled', this.preview.scrollTop > 0)
    }, { passive: true })
    this.scroller.addEventListener('scroll', () => {
      if (!this.scroller.clientHeight) return
      this.fullScroll = this.scroller.scrollTop
      this.fullFollowing = this.scroller.scrollTop >= this.fullAnchor - FOLLOW_SLACK
    }, { passive: true })
    close.addEventListener('click', () => this.closeFull())
    this.pane.addEventListener('click', (event) => event.stopPropagation())
    this.pane.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      this.closeFull()
    })
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
        } else if (!this.fullOpen) this.stopPollTimer()
      })
      this.observer.observe(this.el)
    }
    // When the window's box changes (a resize, unfolding), keep the reader
    // on the newest message, or where they were.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizer = new ResizeObserver(() => {
        if (this.disposed || !this.preview.clientHeight) return
        if (this.previewFollowing) this.scheduleLayout()
        else if (this.preview.scrollTop !== this.previewScroll) this.preview.scrollTop = this.previewScroll
      })
      this.resizer.observe(this.preview)
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
    this.closeFull()
    this.stopPollTimer()
    this.clearLoadingTimer()
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame)
    if (this.layoutFrame !== null) cancelAnimationFrame(this.layoutFrame)
    this.renderFrame = this.layoutFrame = null
    this.feed?.dispose()
    this.feed = null
    this.readingPromise = null
    this.cancelPendingRender()
    this.observer?.disconnect()
    this.observer = null
    this.resizer?.disconnect()
    this.resizer = null
    document.removeEventListener('visibilitychange', this.visibilityListener)
    this.pane.remove()
    this.el.replaceChildren()
  }

  private showTarget(target: TranscriptTarget | null): void {
    const previous = this.target
    if (!target) {
      this.closeFull()
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
      this.updateLiveMarks()
      if (becameParked) this.finishLiveSession()
      else if (!previous.live && target.live) {
        this.pollDelay = LIVE_POLL_MS
        this.readIfVisible()
      }
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
    if (!this.canReadNow()) this.stopPollTimer()
    else this.readIfVisible()
    if (!this.folded) this.scheduleLayout()
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
    const pieces: string[] = []
    const agent = this.agentName()
    if (target?.agent ?? stats.model) pieces.push(agent)
    if (when !== undefined) pieces.push(sessionWhen(when))
    if (stats.turns > 1) pieces.push(`${stats.turns} turns`)
    this.reading.textContent = pieces.slice(0, 2).join(' · ')
    this.paneReading.textContent = pieces.join(' · ')
    this.liveDot.hidden = !target?.live
    this.liveLabel.hidden = !target?.live
    this.latestButton.hidden = !(this.pinned && this.latest && target && !this.sameTarget(target, this.latest))
    this.el.hidden = !target && !this.pinned
  }

  private agentName(): string {
    return this.target?.agent ?? this.model.stats().model ?? 'worker'
  }

  private visibilityChanged(): void {
    if (document.visibilityState === 'visible') this.readIfVisible()
    else this.stopPollTimer()
  }

  private canReadNow(): boolean {
    return !this.disposed && !!this.target && document.visibilityState === 'visible'
      && (this.fullOpen || (!this.folded && this.intersecting))
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
      if (!this.hasInitialRender) {
        this.initialReadyPending = true
        this.renderInitialWhenDrained()
      }
      const empty = this.model.turns.length === 0
      this.setNote(empty && this.target?.live ? 'empty-live' : null)
      return
    }
    // A failed poll after a good read is transient: keep the words on screen
    // and let the next poll try again. Only a transcript never read says so.
    if ((status === 'error' || status === 'unreachable') && this.model.turns.length > 0) return
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
      if (!this.hasInitialRender) {
        this.renderInitialWhenDrained()
        return
      }
      const after = this.model.turns.length
      this.paintPreview()
      if (this.fullRendered) {
        if (before === 0 && after > 0) this.visibleStart = Math.max(0, after - INITIAL_TURNS)
        for (const index of changes.turns) {
          if (index >= this.visibleStart) this.renderTurn(index)
        }
        // The turn that was last loses its live marks once another follows it.
        if (after > before && before > 0) {
          const previous = this.views.get(before - 1)
          if (previous) this.updateTurnView(previous, this.model.turns[before - 1])
        }
        this.updateEarlierButton()
      }
      this.paintHead()
      this.scheduleLayout()
      this.setNote(null)
    })
  }

  private resetFeedView(): void {
    this.cancelPendingRender()
    this.model.reset()
    this.model.takeChanges()
    this.hasInitialRender = false
    this.hasReadCurrent = false
    this.clearView()
    this.paintHead()
    this.setNote(null)
  }

  private renderInitialWhenDrained(): void {
    if (!this.initialReadyPending || this.hasInitialRender || this.pendingEntries.length || this.renderFrame !== null) return
    this.initialReadyPending = false
    this.hasInitialRender = true
    this.previewFollowing = this.fullFollowing = true
    this.paintPreview()
    if (this.fullOpen) this.renderFull()
    this.paintHead()
    this.scheduleLayout()
    this.setNote(this.model.turns.length === 0 && this.target?.live ? 'empty-live' : null)
  }

  private cancelPendingRender(): void {
    this.pendingEntries = []
    this.initialReadyPending = false
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame)
    this.renderFrame = null
  }

  private clearView(): void {
    this.clearFull()
    this.exchange.replaceChildren()
    this.previewPrompt = null
    this.previewTexts.clear()
    this.previewTurn = -1
    this.previewKey = ''
    this.preview.hidden = true
    this.previewFollowing = true
  }

  private clearFull(): void {
    this.views.clear()
    this.list.replaceChildren()
    this.fullRendered = false
    this.visibleStart = -1
    this.fullFollowing = true
    this.earlierButton.hidden = true
    this.earlierButton.textContent = ''
  }

  // ── The exchange in the page ─────────────────────────────────────────

  /** Paint the last turn's prompt and every agent message since, words only. */
  private paintPreview(): void {
    const turns = this.model.turns
    const turn = turns[turns.length - 1]
    if (!turn) {
      this.exchange.replaceChildren()
      this.preview.hidden = true
      return
    }
    if (turn.index !== this.previewTurn) {
      this.previewTurn = turn.index
      this.previewPrompt = null
      this.previewTexts.clear()
      this.previewFollowing = true
    }
    const live = this.target?.live === true
    const last = turn.steps[turn.steps.length - 1]
    const working = live && (!last || last.kind !== 'text')
    const key = `${turn.index}:${turn.version}:${working}:${this.agentName()}`
    if (key === this.previewKey) return
    this.previewKey = key

    const nodes: HTMLElement[] = []
    if (turn.prompt) {
      this.previewPrompt ??= createMessage(turn.prompt.dispatch ? 'dispatch' : 'you', 'li')
      paintPrompt(this.previewPrompt, turn.prompt)
      nodes.push(this.previewPrompt.node)
    }
    const agent = this.agentName()
    turn.steps.forEach((step, index) => {
      if (step.kind !== 'text') return
      let message = this.previewTexts.get(index)
      if (!message) {
        message = createMessage('agent', 'li')
        this.previewTexts.set(index, message)
      }
      paintText(message, agent, step)
      nodes.push(message.node)
    })
    if (working) nodes.push(this.working)
    this.exchange.replaceChildren(...nodes)
    this.preview.hidden = nodes.length === 0
  }

  // ── The whole session, in a pane over the page ─────────────────────

  /**
   * The pane lies over the constitution page's content box, the frame its
   * prose scrolls inside, so the page's chrome, its tabs and the board stay
   * live around it. Outside a page it opens in place, under the band.
   */
  private openFull(): void {
    if (this.disposed || this.fullOpen || !this.target) return
    this.fullOpen = true
    const host = this.el.closest<HTMLElement>('.ws-content')
    this.pane.classList.toggle('ws-transcript-pane-inline', !host)
    ;(host ?? this.el).append(this.pane)
    this.pane.hidden = false
    this.openButton.setAttribute('aria-expanded', 'true')
    this.fullFollowing = true
    if (this.hasInitialRender) this.renderFull()
    this.scroller.focus({ preventScroll: true })
    this.scheduleLayout()
    this.readIfVisible()
  }

  /**
   * The band's element moved into a fresh page: moving resets scroll
   * positions, and the page's content box was rebuilt without the pane. Put
   * both back.
   */
  reseated(): void {
    if (this.disposed) return
    if (this.fullOpen) {
      const host = this.el.closest<HTMLElement>('.ws-content')
      if (host && this.pane.parentElement !== host) host.append(this.pane)
      if (!this.fullFollowing) this.scroller.scrollTop = this.fullScroll
    }
    if (!this.previewFollowing) this.preview.scrollTop = this.previewScroll
    this.scheduleLayout()
  }

  /** Close the full transcript; true when it was open, so Escape can peel it as a layer. */
  closeFull(): boolean {
    if (!this.fullOpen) return false
    this.fullOpen = false
    const hadFocus = this.pane.contains(document.activeElement)
    this.pane.hidden = true
    this.pane.remove()
    this.openButton.setAttribute('aria-expanded', 'false')
    this.clearFull()
    if (!this.canReadNow()) this.stopPollTimer()
    if (hadFocus && this.openButton.isConnected && !this.disposed) this.openButton.focus({ preventScroll: true })
    return true
  }

  private renderFull(): void {
    this.clearFull()
    this.fullRendered = true
    const turns = this.model.turns
    this.visibleStart = turns.length ? Math.max(0, turns.length - INITIAL_TURNS) : -1
    for (let index = Math.max(0, this.visibleStart); index < turns.length; index++) this.renderTurn(index)
    this.updateEarlierButton()
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
    return { index, node, texts: new Map(), groups: new Map(), rows: new Map(), expandedRows: new Set() }
  }

  private updateTurnView(view: TurnView, turn: Turn): void {
    const children: Node[] = []
    if (turn.prompt) {
      view.prompt ??= createMessage(turn.prompt.dispatch ? 'dispatch' : 'you')
      paintPrompt(view.prompt, turn.prompt)
      children.push(view.prompt.node)
    }
    const agent = this.agentName()
    const parts = segments(turn.steps)
    const isLastTurn = view.index === this.model.turns.length - 1
    parts.forEach((part, position) => {
      if (part.kind === 'text') {
        const step = turn.steps[part.index] as Text
        let message = view.texts.get(part.index)
        if (!message) {
          message = createMessage('agent')
          view.texts.set(part.index, message)
        }
        paintText(message, agent, step)
        children.push(message.node)
        return
      }
      const group = this.groupFor(view, part.start)
      const trailing = isLastTurn && position === parts.length - 1
      this.paintGroupSummary(group, turn, part.start, part.end, trailing)
      if (group.expanded) this.reconcileGroup(view, group, turn, part.start, part.end)
      children.push(group.button)
      if (group.expanded && group.list) children.push(group.list)
      if (group.expanded && group.more && !group.more.hidden) children.push(group.more)
    })
    view.node.replaceChildren(...children)
  }

  private groupFor(view: TurnView, start: number): StepGroup {
    let group = view.groups.get(start)
    if (group) return group
    const button = createButton('ws-transcript-steps', '')
    button.setAttribute('aria-expanded', 'false')
    const created: StepGroup = { expanded: false, count: PAGE_SIZE, button, list: null, more: null }
    button.addEventListener('click', () => {
      created.expanded = !created.expanded
      const turn = this.model.turns[view.index]
      if (turn) this.updateTurnView(view, turn)
    })
    view.groups.set(start, created)
    return created
  }

  private paintGroupSummary(group: StepGroup, turn: Turn, start: number, end: number, trailing: boolean): void {
    const steps = turn.steps.slice(start, end)
    const labels = new Map<string, number>()
    for (const step of steps) {
      if (step.kind !== 'tool') continue
      const name = toolLabel(step.name, step.input).name
      labels.set(name, (labels.get(name) ?? 0) + 1)
    }
    const first = steps.find((step) => step.at !== undefined)?.at ?? turn.startedAt
    const following = turn.steps[end]
    const last = following?.at ?? [...steps].reverse().find((step) => step.at !== undefined)?.at
    const minutes = first !== undefined && last !== undefined && last >= first ? Math.floor((last - first) / 60_000) : 0
    const pieces = [`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`]
    if (minutes > 0) pieces.push(formatSpanMinutes(minutes))
    pieces.push(...[...labels].map(([name, count]) => `${name} ${count}`))
    const lastTool = steps.filter((step): step is ToolStep => step.kind === 'tool').at(-1)
    const pending = trailing && this.target?.live === true && !!lastTool && !lastTool.result
    group.button.replaceChildren(document.createTextNode(`${group.expanded ? '▾' : '▸'} ${pieces.join(' · ')}`))
    if (pending) {
      const mark = document.createElement('span')
      mark.className = 'ws-transcript-pending'
      mark.setAttribute('aria-label', 'tool running')
      group.button.append(document.createTextNode(' '), mark)
    }
    group.button.setAttribute('aria-expanded', String(group.expanded))
  }

  private reconcileGroup(view: TurnView, group: StepGroup, turn: Turn, start: number, end: number): void {
    group.list ??= Object.assign(document.createElement('ol'), { className: 'ws-transcript-steplist' })
    if (!group.more) {
      group.more = createButton('ws-transcript-steps-more', '')
      group.more.addEventListener('click', () => {
        group.count += PAGE_SIZE
        const current = this.model.turns[view.index]
        if (current) this.updateTurnView(view, current)
      })
    }
    const available = turn.steps.slice(start, end)
    const shown = available.slice(0, group.count)
    // Opening a run opens what is in it: thinking reads as text, a tool shows
    // its input and output. Each row still folds on its own line.
    shown.forEach((_, relative) => { if (!view.rows.has(start + relative)) view.expandedRows.add(start + relative) })
    const wanted = shown.map((step, relative) => this.getStepRow(view, step, start + relative).node)
    const children = [...group.list.children]
    const prefix = children.length <= wanted.length && children.every((child, index) => child === wanted[index])
    if (prefix) {
      for (let i = children.length; i < wanted.length; i++) group.list.append(wanted[i])
    } else group.list.replaceChildren(...wanted)
    const remaining = Math.max(0, available.length - shown.length)
    group.more.hidden = remaining === 0
    group.more.textContent = `▾ ${remaining} more steps`
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
    if (step.kind !== 'event') return { version: 0, node }
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
    if (row.detail && !row.detail.hidden) {
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
    this.previewKey = ''
    this.paintPreview()
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
    const count = Math.min(EARLIER_TURNS, Math.max(0, this.visibleStart))
    this.earlierButton.hidden = count === 0
    this.earlierButton.textContent = `▴ ${count} earlier ${count === 1 ? 'turn' : 'turns'}`
  }

  /** Earlier turns load above the reader's place, which stays where it was. */
  private showEarlier(): void {
    if (this.visibleStart <= 0) return
    const anchor = this.list.firstElementChild as HTMLElement | null
    const before = anchor?.getBoundingClientRect().top
    const count = Math.min(EARLIER_TURNS, this.visibleStart)
    const start = this.visibleStart - count
    this.visibleStart = start
    for (let index = start; index < start + count; index++) this.renderTurn(index)
    this.updateEarlierButton()
    if (anchor && before !== undefined) {
      const delta = anchor.getBoundingClientRect().top - before
      if (delta) this.scroller.scrollTop += delta
    }
    this.fullFollowing = false
    this.scheduleLayout()
  }

  /** After a paint: measure prompt clamps, then keep each window on the newest message while its reader follows. */
  private scheduleLayout(): void {
    if (this.layoutFrame !== null) cancelAnimationFrame(this.layoutFrame)
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = null
      if (this.disposed) return
      if (this.previewPrompt) measureClamp(this.previewPrompt.prose, this.previewPrompt.unclamped)
      for (const view of this.views.values()) {
        if (view.prompt) measureClamp(view.prompt.prose, view.prompt.unclamped)
      }
      if (!this.preview.hidden && !this.body.hidden && this.previewFollowing && this.preview.clientHeight) {
        this.previewAnchor = this.previewScroll = anchorLatest(this.preview)
      }
      this.preview.classList.toggle('ws-transcript-scrolled', this.preview.scrollTop > 0)
      if (this.fullOpen && this.fullFollowing && this.scroller.clientHeight) this.fullAnchor = this.fullScroll = anchorLatest(this.scroller)
    })
  }
}
