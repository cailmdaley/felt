import { fileBytesUrl, renderMarkdown } from '../utils.js'
import { sessionWhen } from '../sessionHistory.js'
import { DATE_AND_TIME, formatInstant, formatSpanMinutes } from '../civilDay.js'
import { fileKind } from '../attachments.js'
import { sentFileSends, type SentFile } from '../sentFiles.js'
import { TranscriptModel, segments, type SentFileNotice, type Step, type ToolStep, type Turn } from './model.js'
import { TranscriptFeed, type FeedStatus, type StreamEnd } from './feed.js'
import { SentFilesFeed } from './sentFilesFeed.js'
import type { ShuttleMessage } from './messages.js'
import { toolLabel } from './tools.js'
import { promptParts, type Entry, type ResultImage } from './records.js'
import { tokenLabel } from './tokenLabel.js'
import { TaskChecklist, type WorkerTask } from './tasks.js'
import { findMatches, markTerms, nearestMatch, queryTerms, snippetTerms, termPattern, unmark, type Match, type TranscriptHit } from './find.js'
import { MENTION_LAYOUT_EVENT } from '../workspace/bodyLinks.js'
import './transcript.css'

export interface TranscriptTarget {
  session: string
  host?: string
  uid?: string
  agent?: string
  live: boolean
  tasks?: WorkerTask[]
  at?: number
}

export interface TranscriptBandOptions {
  shuttleBase: string
  fetch?: typeof fetch
  /**
   * The whole session as the page's own column: every turn in place, no
   * preview window, no head line and no pane to open. Its usage facts are
   * `meter`, for the caller to seat.
   */
  inline?: boolean
  /** Open a file the worker touched in the reader's file viewer. */
  onFile?: (path: string, title?: string, owner?: string) => void
  /** Called whenever the usage facts are repainted: new usage, another session, or the cache estimate running out. */
  onFacts?: () => void
}

type Prompt = Extract<Entry, { kind: 'prompt' }>
type Text = Extract<Entry, { kind: 'text' }>
type Speaker = 'you' | 'dispatch' | 'agent'

function messageRow(entry: ShuttleMessage, tag: 'div' | 'li' = 'div'): HTMLElement {
  const row = document.createElement(tag)
  row.className = `ws-transcript-msg ws-transcript-shuttle-message${entry.verb ? ' ws-transcript-thread-notice' : ''}`
  row.dataset.message = entry.id
  row.dataset.direction = entry.direction
  const expander = document.createElement('details')
  expander.className = 'ws-transcript-message-expander'
  const toggle = document.createElement('summary')
  toggle.className = 'ws-transcript-message-toggle'
  const direction = document.createElement('span')
  direction.className = 'ws-transcript-message-direction'
  const peer = document.createElement('span')
  peer.className = 'ws-transcript-message-peer'
  const preview = document.createElement('span')
  preview.className = 'ws-transcript-message-preview'
  const detail = document.createElement('div')
  detail.className = 'ws-transcript-message-detail'
  const threadState = document.createElement('span')
  threadState.className = 'ws-transcript-message-thread-state'
  const text = document.createElement('p')
  text.className = 'ws-transcript-message-text'
  const source = document.createElement('p')
  source.className = 'ws-transcript-message-text ws-transcript-message-source'
  const command = document.createElement('pre')
  command.className = 'ws-transcript-message-command'
  command.dataset.mentionIgnore = ''
  const outcome = document.createElement('pre')
  outcome.className = 'ws-transcript-message-outcome'
  outcome.dataset.mentionIgnore = ''
  detail.append(text, source, command, outcome)
  toggle.append(direction, peer, threadState, preview)
  expander.append(toggle, detail)
  row.append(expander)
  expander.addEventListener('toggle', () => {
    paintMessageRow(row, entry)
  })
  paintMessageRow(row, entry)
  return row
}

function firstMessageLine(text: string, limit = 100): string {
  const line = text.split(/\r?\n/, 1)[0].trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

function paintMessageRow(row: HTMLElement, entry: ShuttleMessage): void {
  const direction = row.querySelector<HTMLElement>('.ws-transcript-message-direction')!
  const expander = row.querySelector<HTMLDetailsElement>('.ws-transcript-message-expander')!
  let peer = row.querySelector<HTMLElement>('.ws-transcript-message-peer')!
  const toggle = row.querySelector<HTMLElement>('.ws-transcript-message-toggle')!
  const preview = row.querySelector<HTMLElement>('.ws-transcript-message-preview')!
  const threadState = row.querySelector<HTMLElement>('.ws-transcript-message-thread-state')!
  const expanded = expander.open
  const rowClass = `ws-transcript-msg ws-transcript-shuttle-message${entry.verb ? ' ws-transcript-thread-notice' : ''}`
  if (row.className !== rowClass) row.className = rowClass
  setAttr(row, 'data-message', entry.id)
  setAttr(row, 'data-direction', entry.direction)
  if (entry.fiber && peer.tagName !== 'A') {
    const link = document.createElement('a')
    link.className = 'ws-transcript-message-peer kbn-wikilink'
    link.dataset.transcriptMessagePeer = ''
    link.dataset.spawnChip = ''
    link.dataset.fiber = entry.fiber
    link.dataset.mentionSource = entry.peer
    const label = document.createElement('span')
    label.className = 'ws-transcript-message-peer-label'
    link.append(label)
    peer.replaceWith(link)
    peer = link
  } else if (!entry.fiber && peer.tagName === 'A') {
    const label = document.createElement('span')
    label.className = 'ws-transcript-message-peer ws-transcript-session-chip'
    peer.replaceWith(label)
    peer = label
  }
  peer.classList.toggle('kbn-wikilink', !!entry.fiber)
  peer.classList.toggle('ws-transcript-session-chip', !entry.fiber)
  if (entry.fiber) {
    setAttr(peer, 'data-spawn-chip', '')
    setAttr(peer, 'data-transcript-message-peer', '')
    setAttr(peer, 'data-fiber', entry.fiber)
    if (!peer.classList.contains('ws-constitution-chip')) {
      let label = peer.querySelector<HTMLElement>(':scope > .ws-transcript-message-peer-label')
      if (!label) {
        label = document.createElement('span')
        label.className = 'ws-transcript-message-peer-label'
        peer.replaceChildren(label)
      }
      if (label.textContent !== entry.peer) label.textContent = entry.peer
    }
  } else {
    let label = peer.querySelector<HTMLElement>(':scope > .ws-transcript-session-label')
    let suffix = peer.querySelector<HTMLElement>(':scope > .ws-transcript-session-id')
    if (!label) {
      label = document.createElement('span')
      label.className = 'ws-transcript-session-label'
    }
    if (entry.peerSuffix) {
      if (!suffix) {
        suffix = document.createElement('span')
        suffix.className = 'ws-transcript-session-id'
      }
      if (peer.firstElementChild !== label || peer.lastElementChild !== suffix) peer.replaceChildren(label, suffix)
      const prefix = entry.peer.slice(0, -entry.peerSuffix.length)
      if (label.textContent !== prefix) label.textContent = prefix
      if (suffix.textContent !== entry.peerSuffix) suffix.textContent = entry.peerSuffix
    } else {
      if (suffix) suffix.remove()
      if (peer.firstElementChild !== label || peer.childElementCount !== 1) peer.replaceChildren(label)
      if (label.textContent !== entry.peer) label.textContent = entry.peer
    }
  }
  if (entry.fiber) setAttr(peer, 'data-fiber', entry.fiber)
  else if (peer.hasAttribute('data-fiber')) peer.removeAttribute('data-fiber')
  const directionText = entry.direction === 'received'
    ? '← From'
    : entry.status === 'failed' ? '↯ Message failed' : entry.status === 'uncertain' ? '↯ Delivery unclear' : entry.status === 'pending' ? '→ Messaging' : '→ Messaged'
  if (direction.textContent !== directionText) direction.textContent = directionText
  const toggleText = entry.direction === 'received' && !expanded
    ? firstMessageLine(entry.text || (entry.source ? 'Shared an attachment' : 'Message received'))
    : ''
  if (preview.textContent !== toggleText) preview.textContent = toggleText
  setAttr(toggle, 'data-direction', entry.direction)
  const action = entry.direction === 'received' ? `Expand message from ${entry.peer}` : `Expand message to ${entry.peer}`
  setAttr(toggle, 'aria-label', entry.verb ? `${action} · ${entry.verb}` : action)
  setAttr(toggle, 'aria-expanded', String(expanded))
  setAttr(toggle, 'data-expanded', String(expanded))
  setHidden(preview, expanded || !toggleText)
  const text = row.querySelector<HTMLElement>('.ws-transcript-message-text:not(.ws-transcript-message-source)')!
  const source = row.querySelector<HTMLElement>('.ws-transcript-message-source')!
  const command = row.querySelector<HTMLElement>('.ws-transcript-message-command')!
  const outcome = row.querySelector<HTMLElement>('.ws-transcript-message-outcome')!
  const stateText = entry.verb ? `· ${entry.verb}` : ''
  if (threadState.textContent !== stateText) threadState.textContent = stateText
  setHidden(threadState, !entry.verb)
  if (text.textContent !== entry.text) text.textContent = entry.text
  setHidden(text, !entry.text)
  const sourceText = entry.source ? `Message text supplied by ${entry.source}` : ''
  if (source.textContent !== sourceText) source.textContent = sourceText
  setHidden(source, !entry.source || !!entry.text)
  if (command.textContent !== (entry.rawCommand ?? '')) command.textContent = entry.rawCommand ?? ''
  setHidden(command, !entry.rawCommand)
  const outcomeText = entry.status === 'failed' || entry.status === 'uncertain' ? entry.outcomeText ?? '' : ''
  if (outcome.textContent !== outcomeText) outcome.textContent = outcomeText
  setHidden(outcome, !outcomeText)
  let stamp = toggle.querySelector<HTMLTimeElement>('.ws-transcript-message-time')
  if (entry.at === undefined) stamp?.remove()
  else {
    if (!stamp) {
      stamp = document.createElement('time')
      stamp.className = 'ws-transcript-message-time'
      toggle.append(stamp)
    }
    const when = clock(entry.at)
    if (stamp.textContent !== ` · ${when.text}`) stamp.textContent = ` · ${when.text}`
    setAttr(stamp, 'title', when.title)
  }
  setAttr(row, 'data-status', entry.status ?? '')
}

/** Keep the row node under its transcript step identity while streamed tool status changes. */
function keepMessage(cache: Map<string, Kept>, used: Set<string>, identity: string, entry: ShuttleMessage, tag: 'div' | 'li'): HTMLElement {
  let key = identity
  for (let n = 1; used.has(key); n++) key = `${identity}#${n}`
  used.add(key)
  const previous = cache.get(key)
  const signature = JSON.stringify(entry)
  const node = previous?.node ?? messageRow(entry, tag)
  if (previous && previous.signature !== signature) paintMessageRow(node, entry)
  cache.set(key, { signature, node })
  return node
}

function sentFileRow(
  entry: SentFileNotice,
  owner: string | undefined,
  shuttleBase: string,
  onFile: TranscriptBandOptions['onFile'],
  tag: 'div' | 'li' = 'div',
): HTMLElement {
  const row = document.createElement(tag)
  row.className = 'ws-transcript-msg ws-transcript-sent-file'
  row.dataset.send = entry.id
  if (entry.at !== undefined) {
    const stamp = document.createElement('time')
    stamp.dateTime = new Date(entry.at).toISOString()
    const when = clock(entry.at)
    stamp.textContent = when.text
    stamp.title = when.title
    row.append(stamp)
  }

  const files = document.createElement('div')
  files.className = 'ws-transcript-sent-files'
  for (const file of entry.files) {
    const kind = fileKind(file.fullPath)
    const kindLabel = ({ image: 'image', audio: 'audio', video: 'video', html: 'HTML', markdown: 'Markdown', text: 'text', pdf: 'PDF', other: 'file' } as const)[kind]
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'ws-transcript-sent-file-item'
    item.dataset.path = file.fullPath
    item.setAttribute('aria-label', `Open ${file.basename} (${kindLabel})`)
    item.title = `${file.basename} · ${kindLabel}`
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      onFile?.(file.fullPath, file.basename, owner)
    })
    if (kind === 'image') {
      if (entry.files.length === 1) item.classList.add('ws-transcript-sent-inline')
      const thumbnail = document.createElement('img')
      thumbnail.className = 'ws-transcript-sent-thumb'
      thumbnail.alt = ''
      thumbnail.loading = 'lazy'
      thumbnail.src = fileBytesUrl(shuttleBase, file.fullPath, owner ?? 'local')
      item.append(thumbnail)
    } else {
      const badge = document.createElement('span')
      badge.className = 'ws-transcript-sent-kind'
      badge.textContent = kindLabel
      item.append(badge)
    }
    const name = document.createElement('span')
    name.className = 'ws-transcript-sent-name'
    name.textContent = file.basename
    item.append(name)
    files.append(item)
  }
  row.append(files)
  return row
}

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
  /** The find pattern whose marks the prose carries; unset when its words were just repainted. */
  marked?: string
}

interface TurnView {
  index: number
  node: HTMLLIElement
  /** Rows drawn from a step's data (notices, sent files, spawn chips), kept while that data holds. */
  kept: Map<string, Kept>
  prompt?: Message
  texts: Map<string, Message>
  groups: Map<string, StepGroup>
  rows: Map<string, StepRow>
  expandedRows: Set<string>
  /** The group each step was drawn in last paint, so a run split by a receipt keeps its open half open. */
  memberOf: Map<string, string>
}

const PAGE_SIZE = 150
const INITIAL_TURNS = 3
/** The inline column opens on more of the session than the pane does. */
const INLINE_TURNS = 8
const EARLIER_TURNS = 12
const FOLD_KEY = 'shuttle.transcript.folded'
const LIVE_POLL_MS = 3000
const MAX_POLL_MS = 15000
/** Room left above the anchored message, so its kicker is not flush with the edge. */
const ANCHOR_MARGIN = 8
/** How close to the anchor a reader must stay to keep following new messages. */
const FOLLOW_SLACK = 24

/** A warm cache dot drains on this cadence. */
const CACHE_REPAINT_MS = 15_000

/** The class of a find mark in a message's words. */
const FOUND_MARK = 'ws-transcript-found-mark'
/** The message the find is standing on. */
const FOUND_MESSAGE = 'ws-transcript-found'

/**
 * The window a session's context is read against. Claude transcripts record
 * none; Claude sessions run with a million-token window.
 */
export function contextWindow(recorded: number | undefined, model: string | undefined): number | undefined {
  if (recorded) return recorded
  return model?.startsWith('claude') ? 1_000_000 : undefined
}

/** Two corners pulled apart: the full transcript opens over the page. */
const EXPAND_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg>'

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
  // Images drawn beside the output need no placeholder.
  const images = Array.from({ length: result.images - (result.pictures?.length ?? 0) }, () => '[image]').join('\n')
  return [result.text, images].filter(Boolean).join('\n')
}

/** The file a tool step read or wrote, where its input names one. */
export function stepPath(step: Pick<ToolStep, 'input'>): string | undefined {
  const input = step.input !== null && typeof step.input === 'object' ? step.input as Record<string, unknown> : null
  const path = input && [input.file_path, input.path, input.filePath].find(value => typeof value === 'string' && value)
  return typeof path === 'string' ? path : undefined
}

function imageSource(picture: ResultImage): string {
  return 'url' in picture ? picture.url : `data:${picture.mediaType};base64,${picture.data}`
}

/** Full size in a tab of its own, decoded only now: a blob, since browsers refuse to navigate to data URLs. */
function openPicture(picture: ResultImage): void {
  if ('url' in picture && !picture.url.startsWith('data:')) { window.open(picture.url, '_blank', 'noopener'); return }
  const source = imageSource(picture)
  const comma = source.indexOf(',')
  const mediaType = source.slice(5, source.indexOf(';'))
  const bytes = Uint8Array.from(atob(source.slice(comma + 1)), c => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
  // A tool's arguments and results are code, never prose to link.
  detail.dataset.mentionIgnore = ''
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

/** The constitutions a `shuttle thread` step created, read from its command and output. */
function spawnIds(step: Step): { id: string; uid?: string }[] {
  if (step.kind !== 'tool' || !step.result || step.result.isError) return []
  const input = inputObject(step.input)
  const command = inputString(input?.command) ?? inputString(input?.cmd) ?? inputString(step.input) ?? ''
  // Match an executable command at a shell boundary, not a quoted search phrase.
  const invocations = [...command.matchAll(/(?:^|[;&|]\s*)(?:\S*\/)?shuttle\s+thread\b/g)]
  if (!invocations.length) return []
  const output = step.result.text
  const ids: { id: string; uid?: string }[] = []
  const segments = command.replace(/2>&1/g, '').split(/(?:&&|\|\||[;|])/).map(part => part.trim()).filter(Boolean)
  if (/\s--json(?:\s|$|[;&|])/.test(command)) {
    // Only a single thread and silent directory changes can attribute JSON to it.
    if (invocations.length !== 1 || segments.some(part => !/^(?:(?:\S*\/)?shuttle\s+thread\b|cd\s+)/.test(part))) return []
    const objects = [...output.matchAll(/\{[^{}]*"id"\s*:\s*"[^"\n]+"[^{}]*\}/g)]
    if (objects.length !== 1) return []
    for (const object of objects) {
      try {
        const parsed = inputObject(JSON.parse(object[0]))
        const id = inputString(parsed?.id), uid = inputString(parsed?.uid)
        if (id) ids.push({ id, uid })
      } catch { /* Ignore non-JSON output. */ }
    }
  } else {
    // Combined stdout cannot identify which command emitted a bare path.
    if (segments.some(part => !/^(?:(?:\S*\/)?shuttle\s+thread\b|cd\s+|felt\s+nest\b|tail\s+-\d+\b)/.test(part))) return []
    const lines = output.split(/\r?\n/).map(line => line.trim())
    for (const id of lines) {
      if (/^[\w.-]+(?:\/[\w.-]+)+$/.test(id)) {
        const uid = lines.map(line => line.match(/^Thread UID: (\S+) ([0-9A-HJKMNP-TV-Z]{26})$/)).find(match => match?.[1] === id)?.[2]
        ids.push({ id, uid })
      }
      if (ids.length === invocations.length) break
    }
  }
  return ids
}

/** One hidden chip per spawned constitution; the mention scan shows each once the read model knows it. */
function spawnChips(ids: { id: string; uid?: string }[], origin?: string): HTMLAnchorElement[] {
  return ids.map(({ id, uid }) => {
    const chip = document.createElement('a')
    chip.className = 'ws-constitution-chip ws-transcript-spawn-chip'
    chip.dataset.constitutionIdentity = uid ?? id
    chip.dataset.spawnId = id
    chip.dataset.spawnChip = ''
    if (origin) chip.dataset.origin = origin
    chip.hidden = true
    return chip
  })
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
    const separator = document.createElement('span')
    separator.className = 'ws-transcript-sep'
    separator.textContent = ' · '
    kicker.append(separator, stamp)
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
    message.marked = undefined
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

/** The word a dispatch's kicker shows: the machine-written brief, folded behind one line. */
export const SESSION_BRIEF = 'Session brief'

/**
 * A prompt clamps to a few lines until it is clicked open. A dispatch is the
 * machine-written brief that started the session: it folds whole behind one
 * quiet line, its kicker, which opens and closes it.
 */
function paintPrompt(message: Message, prompt: Prompt): void {
  const speaker: Speaker = prompt.dispatch ? 'dispatch' : 'you'
  const identity = `${speaker}|${prompt.at ?? ''}`
  if (message.identity !== identity) {
    setKicker(message.kicker, prompt.dispatch ? SESSION_BRIEF : speaker, speaker, prompt.at)
    message.identity = identity
  }
  const kicker = message.kicker
  message.node.classList.toggle('ws-transcript-msg-brief', prompt.dispatch)
  if (prompt.dispatch && !kicker.dataset.toggle) {
    kicker.dataset.toggle = '1'
    const toggle = (event: Event): void => {
      if (!message.node.classList.contains('ws-transcript-msg-brief')) return
      event.stopPropagation()
      message.unclamped = !message.unclamped
      paintBrief(message)
    }
    kicker.addEventListener('click', toggle)
    kicker.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && message.node.classList.contains('ws-transcript-msg-brief')) { event.preventDefault(); toggle(event) }
    })
  }
  if (prompt.dispatch) {
    setAttr(kicker, 'tabindex', '0')
    setAttr(kicker, 'role', 'button')
    paintBrief(message)
  } else if (kicker.dataset.toggle) {
    for (const name of ['aria-expanded', 'role', 'tabindex']) kicker.removeAttribute(name)
    message.node.classList.remove('ws-transcript-brief-open')
  }
  const text = message.prose
  if (message.source !== prompt.text) {
    message.source = prompt.text
    message.marked = undefined
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
  setAttr(text, 'aria-expanded', String(message.unclamped))
  if (!message.images) {
    message.images = document.createElement('span')
    message.images.className = 'ws-transcript-prompt-images'
    message.node.append(message.images)
  }
  message.images.textContent = Array.from({ length: prompt.images }, () => '[image]').join(' ')
  setHidden(message.images, prompt.images === 0)
}

function paintBrief(message: Message): void {
  message.node.classList.toggle('ws-transcript-brief-open', message.unclamped)
  message.prose.classList.toggle('ws-transcript-unclamped', message.unclamped)
  setAttr(message.kicker, 'aria-expanded', String(message.unclamped))
}

function measureClamp(text: HTMLElement, unclamped: boolean): void {
  const overflow = !unclamped && text.scrollHeight > text.clientHeight
  if (text.classList.contains('ws-transcript-overflowing') !== overflow) text.classList.toggle('ws-transcript-overflowing', overflow)
  if (overflow) setAttr(text, 'aria-label', 'Expand prompt')
  else if (text.hasAttribute('aria-label')) text.removeAttribute('aria-label')
}

/**
 * Put a scroller at `top` only when that moves it. Any write of the position,
 * even of the value it already holds, stops a smooth or momentum scroll in
 * flight, so a refresh that changed nothing must leave it untouched.
 */
function settleScroll(scroller: HTMLElement, top: number): number {
  if (Math.abs(top - scroller.scrollTop) >= 0.5) scroller.scrollTop = top
  return scroller.scrollTop
}

/** Put a scroller at its bottom, where a reader following new messages sits, only when that moves it. */
function settleScrollAtEnd(scroller: HTMLElement): number {
  return settleScroll(scroller, scroller.scrollHeight - scroller.clientHeight)
}

/** Set an attribute only when it changes, so a refresh that changed nothing writes nothing. */
function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden
}

/** A node drawn from data, and the data it was drawn from. */
interface Kept { signature: string; node: HTMLElement }

/**
 * The node for `key`, kept from the last paint while its signature holds.
 * A refresh that redraws an unchanged row would hand the reader a new node
 * whose decorations (constitution chips) resolve only after the reading
 * position was measured, so the view jumps by their height.
 */
function keep(cache: Map<string, Kept>, used: Set<string>, identity: string, signature: string, make: () => HTMLElement): HTMLElement {
  // Keyed by the step's own id, not its place: a receipt spliced in mid-turn must not rebuild what follows it.
  let key = identity
  for (let n = 1; used.has(key); n++) key = `${identity}#${n}`
  used.add(key)
  const kept = cache.get(key)
  if (kept?.signature === signature) return kept.node
  const node = make()
  cache.set(key, { signature, node })
  return node
}

function prune(cache: Map<string, Kept>, used: Set<string>): void {
  for (const key of cache.keys()) if (!used.has(key)) cache.delete(key)
}

/** The spawn chips of one folded step run, or null when it created no constitutions. */
function keepSpawns(cache: Map<string, Kept>, used: Set<string>, step: Step, origin: string | undefined, tag: 'span' | 'li'): HTMLElement | null {
  const ids = spawnIds(step)
  if (!ids.length || step.kind !== 'tool') return null
  return keep(cache, used, `spawns:${step.id}`, JSON.stringify([ids, origin]), () => {
    const group = document.createElement(tag)
    group.className = 'ws-transcript-spawns'
    if (tag === 'li') { group.dataset.spawnPreview = ''; group.hidden = true }
    group.append(...spawnChips(ids, origin))
    return group
  })
}

/**
 * Make `parent`'s children exactly `children`, moving only the nodes out of
 * place: a node that stays is never detached, so nothing the reader sees is
 * torn down and rebuilt by a refresh that changed nothing.
 */
export function placeChildren(parent: Element, children: readonly Node[]): void {
  const wanted = new Set(children)
  let cursor = parent.firstChild
  for (const child of children) {
    // A leaving node is removed where it stands, so the ones after it stay put.
    while (cursor && !wanted.has(cursor)) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next }
    if (child === cursor) { cursor = cursor.nextSibling; continue }
    parent.insertBefore(child, cursor)
  }
  while (cursor) {
    const next = cursor.nextSibling
    parent.removeChild(cursor)
    cursor = next
  }
}

/** Preserve a visible message through DOM reconciliation and height changes above it. */
function preserveReadingPosition(scroller: HTMLElement, render: () => void): void {
  const edge = scroller.getBoundingClientRect().top
  const anchor = [...scroller.querySelectorAll<HTMLElement>('.ws-transcript-msg')].find(node => node.getBoundingClientRect().bottom > edge)
  const top = anchor?.getBoundingClientRect().top
  const send = anchor?.dataset.send
  const key = anchor?.dataset.readingKey
  render()
  const restored = anchor?.isConnected && (!key || anchor.dataset.readingKey === key) ? anchor
    : [...scroller.querySelectorAll<HTMLElement>('.ws-transcript-msg')].find(node => key ? node.dataset.readingKey === key : send && node.dataset.send === send)
  if (restored && top !== undefined) settleScroll(scroller, scroller.scrollTop + restored.getBoundingClientRect().top - top)
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
  private readonly stepIdentities = new WeakMap<Step, string>()
  private nextStepIdentity = 0
  private readonly previewTasks = new TaskChecklist()
  private readonly fullTasks = new TaskChecklist()
  private readonly views = new Map<number, TurnView>()
  private readonly head: HTMLButtonElement
  private readonly label: HTMLElement
  private readonly reading: HTMLElement
  private readonly liveDot: HTMLElement
  private readonly liveLabel: HTMLElement
  private readonly headRow: HTMLElement
  private readonly cacheFact: HTMLElement
  private readonly contextFact: HTMLElement
  private readonly shareFact: HTMLElement
  private readonly hitFact: HTMLElement
  /** Context and cache warmth; standalone bands also carry window and cache-read shares. */
  readonly meter: HTMLElement
  /** Cache-read share, seated in settings for inline conversations. */
  get cacheShare(): HTMLElement { return this.hitFact }
  private readonly inline: boolean
  private readonly onFile?: (path: string, title?: string, owner?: string) => void
  private readonly onFacts?: () => void
  private readonly inlineWorking: HTMLElement
  /** Messages sent from the composer that the transcript has not yet recorded, drawn after the last turn. */
  private readonly sentList = document.createElement('div')
  private sent: { text: string; at: number; node: HTMLElement }[] = []
  private sessions: HTMLElement | null = null
  private cacheTimer: number | null = null
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
  private previewTexts = new Map<string, Message>()
  private previewKept = new Map<string, Kept>()
  private previewTurn = -1
  private previewKey = ''
  private previewFollowing = true
  private fullFollowing = true
  private messageToReveal: string | null = null
  private fullOpen = false
  private fullRendered = false
  private latest: TranscriptTarget | null = null
  private target: TranscriptTarget | null = null
  private pinned = false
  private folded: boolean
  private feed: TranscriptFeed | null = null
  private sentFilesFeed: SentFilesFeed | null = null
  private sentFileNotices: SentFileNotice[] = []
  private readingPromise: Promise<boolean> | null = null
  private pollTimer: number | null = null
  private pollDelay = LIVE_POLL_MS
  private following: Promise<void> | null = null
  private followingStopped = false
  private streamUnsupported = false
  private streamRetryAt = 0
  private streamRetryDelay = 2000
  private sentFilesTimer: number | null = null
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
  private findPattern: RegExp | null = null
  private findKey = ''
  private matches: Match[] = []
  private currentMatch = -1
  private pendingHit: { query: string; at?: number } | null = null
  private findFrame: number | null = null
  private readonly visibilityListener = (): void => this.visibilityChanged()
  private readonly mentionLayoutListener = (): void => this.scheduleLayout()
  private observer: IntersectionObserver | null = null
  private resizer: ResizeObserver | null = null
  private previewScroll = 0
  private fullScroll = 0

  constructor(opts: TranscriptBandOptions) {
    this.shuttleBase = opts.shuttleBase
    this.fetcher = opts.fetch
    this.inline = opts.inline ?? false
    this.onFile = opts.onFile
    this.onFacts = opts.onFacts
    this.folded = this.inline ? false : this.readFolded()
    this.el = document.createElement('section')
    this.el.className = this.inline ? 'ws-transcript ws-transcript-inline' : 'ws-transcript'
    this.el.hidden = true
    this.el.addEventListener('click', (event) => event.stopPropagation())
    this.el.addEventListener(MENTION_LAYOUT_EVENT, this.mentionLayoutListener)

    const headRow = document.createElement('div')
    headRow.className = 'ws-transcript-headrow'
    this.headRow = headRow
    this.head = createButton('ws-transcript-head', '')
    this.head.setAttribute('aria-expanded', String(!this.folded))
    const chevron = document.createElement('span')
    chevron.className = 'ws-transcript-chevron'
    chevron.setAttribute('aria-hidden', 'true')
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
    this.contextFact = document.createElement('span')
    this.contextFact.className = 'ws-transcript-fact ws-transcript-context'
    this.cacheFact = document.createElement('span')
    this.cacheFact.className = 'ws-transcript-fact ws-transcript-cache'
    this.shareFact = document.createElement('span')
    this.shareFact.className = 'ws-transcript-fact ws-transcript-share'
    this.hitFact = document.createElement('span')
    this.hitFact.className = 'ws-transcript-fact ws-transcript-hit'
    this.meter = document.createElement('span')
    this.meter.className = 'ws-transcript-meter'
    this.meter.dataset.part = 'context-meter'
    this.meter.append(this.contextFact, ...(this.inline ? [] : [this.shareFact]), this.cacheFact, ...(this.inline ? [] : [this.hitFact]))
    this.head.append(chevron, this.label, this.reading, this.liveDot, this.liveLabel, ...(this.inline ? [] : [this.meter]))
    this.latestButton = createButton('ws-transcript-latest', '← latest')
    this.latestButton.hidden = true
    this.openButton = createButton('ws-transcript-open-full', '')
    this.openButton.setAttribute('aria-expanded', 'false')
    this.openButton.setAttribute('aria-label', 'Full transcript')
    this.openButton.title = 'Open the full transcript'
    this.openButton.innerHTML = EXPAND_ICON
    headRow.append(this.head, this.latestButton, this.openButton)

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
    this.pane.addEventListener(MENTION_LAYOUT_EVENT, this.mentionLayoutListener)
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
    this.inlineWorking = document.createElement('p')
    this.inlineWorking.className = 'ws-transcript-working ws-transcript-working-inline'
    this.inlineWorking.textContent = 'working'
    this.inlineWorking.hidden = true
    this.sentList.className = 'ws-transcript-sent'
    if (this.inline) {
      this.scroller.append(this.sentList, this.inlineWorking)
      this.pane.append(this.scroller)
      this.pane.hidden = false
      this.fullOpen = true
      this.el.append(this.note, this.latestButton, this.pane)
    } else {
      this.pane.append(panelHead, this.scroller)
      this.el.append(headRow, this.note, this.body)
    }

    this.head.addEventListener('click', () => this.toggleFold())
    this.openButton.addEventListener('click', () => this.openFull())
    this.preview.addEventListener('click', (event) => {
      if ((event.target as Element | null)?.closest('a, .ws-transcript-sent-file-item')) return
      if (window.getSelection?.()?.toString()) return
      this.openFull()
    })
    this.preview.addEventListener('scroll', () => {
      if (!this.preview.clientHeight) return
      this.previewScroll = this.preview.scrollTop
      this.previewFollowing = this.preview.scrollTop >= this.preview.scrollHeight - this.preview.clientHeight - FOLLOW_SLACK
      this.preview.classList.toggle('ws-transcript-scrolled', this.preview.scrollTop > 0)
    }, { passive: true })
    this.scroller.addEventListener('scroll', () => {
      if (!this.scroller.clientHeight) return
      this.fullScroll = this.scroller.scrollTop
      this.fullFollowing = this.scroller.scrollTop >= this.scroller.scrollHeight - this.scroller.clientHeight - FOLLOW_SLACK
    }, { passive: true })
    close.addEventListener('click', () => this.closeFull())
    this.pane.addEventListener('click', (event) => event.stopPropagation())
    this.pane.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      // The first Escape clears a board Find highlight; the next peels the pane.
      if (this.findKey) this.clearQuery()
      else this.closeFull()
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
        } else if (!this.fullOpen || this.inline) this.stopFollowing()
      })
      this.observer.observe(this.el)
    }
    // When the window's box changes (a resize, unfolding), keep the reader
    // on the newest message, or where they were.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizer = new ResizeObserver(() => {
        if (this.disposed || !this.preview.clientHeight) return
        if (this.previewFollowing) this.scheduleLayout()
        else settleScroll(this.preview, this.previewScroll)
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
    this.clearCacheTimer()
    this.closeFull()
    this.stopFollowing()
    this.clearSentFilesTimer()
    this.clearLoadingTimer()
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame)
    if (this.layoutFrame !== null) cancelAnimationFrame(this.layoutFrame)
    this.renderFrame = this.layoutFrame = null
    this.feed?.dispose()
    this.feed = null
    this.sentFilesFeed?.dispose()
    this.sentFilesFeed = null
    this.readingPromise = null
    this.cancelPendingRender()
    this.observer?.disconnect()
    this.observer = null
    this.resizer?.disconnect()
    this.resizer = null
    document.removeEventListener('visibilitychange', this.visibilityListener)
    this.el.removeEventListener(MENTION_LAYOUT_EVENT, this.mentionLayoutListener)
    this.pane.removeEventListener(MENTION_LAYOUT_EVENT, this.mentionLayoutListener)
    if (this.findFrame !== null) cancelAnimationFrame(this.findFrame)
    this.findFrame = null
    this.pane.remove()
    this.el.replaceChildren()
  }

  private showTarget(target: TranscriptTarget | null): void {
    const previous = this.target
    if (!target) {
      this.closeFull()
      this.target = null
      this.paintTasks()
      this.hasReadCurrent = false
      this.stopFollowing()
      this.following = null
      this.clearSentFilesTimer()
      this.clearLoadingTimer()
      this.feed?.dispose()
      this.feed = null
      this.sentFilesFeed?.dispose()
      this.sentFilesFeed = null
      this.sentFileNotices = []
      this.readingPromise = null
      this.cancelPendingRender()
      this.clearView()
      this.model.reset()
      this.setNote(null)
      this.el.hidden = true
      this.paintHead()
      return
    }

    this.target = { ...target }
    this.paintTasks()
    this.el.hidden = false
    if (previous && this.sameTarget(previous, target)) {
      const becameParked = previous.live && !target.live
      this.paintHead()
      this.preservePositions(() => this.updateLiveMarks())
      this.scheduleLayout()
      if (becameParked) this.finishLiveSession()
      else if (!previous.live && target.live) {
        this.pollDelay = LIVE_POLL_MS
        this.readIfVisible()
      }
      return
    }

    this.stopFollowing()
    this.following = null
    this.clearSentFilesTimer()
    this.clearLoadingTimer()
    this.feed?.dispose()
    this.feed = null
    this.sentFilesFeed?.dispose()
    this.sentFilesFeed = null
    this.sentFileNotices = []
    this.readingPromise = null
    this.cancelPendingRender()
    this.clearView()
    this.setNote(null)
    this.model.reset()
    this.model.takeChanges()
    this.hasInitialRender = false
    this.hasReadCurrent = false
    this.pollDelay = LIVE_POLL_MS
    this.streamUnsupported = false
    this.streamRetryAt = 0
    this.streamRetryDelay = 2000
    this.feed = new TranscriptFeed({
      shuttleBase: this.shuttleBase,
      session: target.session,
      host: target.host,
      fetch: this.fetcher,
      onEntries: (entries) => this.acceptEntries(entries),
      onReset: () => this.resetFeedView(),
      onStatus: (status, detail) => this.statusChanged(status, detail),
    })
    if (target.uid) {
      this.sentFilesFeed = new SentFilesFeed({
        shuttleBase: this.shuttleBase,
        uid: target.uid,
        session: target.session,
        host: target.host,
        fetch: this.fetcher,
        onFiles: (files) => this.acceptSentFiles(target.session, files),
      })
    }
    this.paintHead()
    this.readIfVisible()
  }

  private paintTasks(): void {
    const tasks = this.target?.live ? this.target.tasks ?? [] : []
    if (this.previewTasks.paint(tasks)) this.body.prepend(this.previewTasks.el)
    else this.previewTasks.el.remove()
    if (this.fullTasks.paint(tasks)) this.scroller.prepend(this.fullTasks.el)
    else this.fullTasks.el.remove()
  }

  private sameTarget(a: TranscriptTarget, b: TranscriptTarget): boolean {
    return a.session === b.session && a.host === b.host && a.uid === b.uid
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
    if (!this.canReadNow()) this.stopFollowing()
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
    const pieces: string[] = []
    const agent = this.agentName()
    if (target?.agent ?? stats.model) pieces.push(agent)
    if (when !== undefined) pieces.push(sessionWhen(when))
    if (stats.turns > 1) pieces.push(`${stats.turns} turns`)
    this.reading.textContent = pieces.slice(0, 2).join(' · ')
    this.paneReading.textContent = pieces.join(' · ')
    this.liveDot.hidden = !target?.live
    this.liveLabel.hidden = !target?.live
    this.paintFacts()
    setHidden(this.latestButton, !(this.pinned && this.latest && target && !this.sameTarget(target, this.latest)))
    // With no session to read, the line keeps only the session list.
    this.head.hidden = this.openButton.hidden = !target
    this.el.hidden = this.inline ? !target : !target && !this.pinned && !this.sessions
    this.paintWorking()
  }

  /**
   * Show a message the moment the composer sends it. A busy worker records it
   * only when it takes the message in, so until a prompt with its words
   * appears the bubble stands after the last turn, marked as sent.
   */
  pend(text: string): void {
    const words = text.trim()
    if (!words || !this.inline) return
    const message = createMessage('you')
    message.node.classList.add('ws-transcript-msg-sending')
    message.prose.textContent = words
    const at = Date.now()
    setKicker(message.kicker, 'you', 'you', at)
    const state = document.createElement('span')
    state.className = 'ws-transcript-sending'
    state.textContent = 'sent · not yet read'
    message.kicker.prepend(state)
    this.sent.push({ text: words, at, node: message.node })
    this.sentList.append(message.node)
    this.scroller.scrollTop = this.scroller.scrollHeight
  }

  /** A sent message is confirmed by a recorded prompt holding its opening words, near or after its send. */
  private confirmSent(): void {
    if (!this.sent.length) return
    const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
    // Hosts' clocks differ, so a prompt up to two minutes before the send still counts.
    const prompts = this.model.turns.slice(-8).map(turn => turn.prompt).filter(prompt => prompt !== null)
    this.sent = this.sent.filter(sent => {
      const opening = flat(sent.text).slice(0, 60)
      const landed = prompts.some(prompt => (prompt.at ?? Infinity) >= sent.at - 120_000 && flat(prompt.text).includes(opening))
      if (landed) sent.node.remove()
      return !landed
    })
  }

  /** The inline column's last line while a live worker is mid-turn. */
  private paintWorking(): void {
    if (!this.inline) return
    const turn = this.model.turns.at(-1)
    const last = turn?.steps.at(-1)
    setHidden(this.inlineWorking, !(this.target?.live && this.hasInitialRender && (!last || last.kind !== 'text')))
  }

  /**
   * Seat the fiber's session list on the head line, beside the reader it
   * feeds: its toggle sits at the line's right end and its rows unfold
   * under the line. A later list replaces this one where it stands.
   */
  mountSessions(sessions: HTMLElement): void {
    if (this.disposed || this.inline) return
    sessions.classList.add('ws-transcript-sessions')
    if (this.sessions?.isConnected && this.sessions !== sessions) this.sessions.replaceWith(sessions)
    else if (!sessions.isConnected || sessions.parentElement !== this.headRow) this.headRow.insertBefore(sessions, this.openButton)
    this.sessions = sessions
    this.paintHead()
  }

  private clearCacheTimer(): void {
    if (this.cacheTimer !== null) window.clearTimeout(this.cacheTimer)
    this.cacheTimer = null
  }

  /**
   * The session's usage facts, as words in the head line, each saying what it
   * is. Context is its token count, tinted from verdigris toward red as it
   * fills the window. The cache is a verdigris dot draining as the entry ages,
   * an alarm-red ring once cold. Standalone bands also show the window share
   * and cache-read share; inline chats seat the latter in settings.
   */
  private paintFacts(): void {
    this.clearCacheTimer()
    const stats = this.model.stats()
    const until = stats.cacheUntil
    const now = Date.now()
    const warm = until !== undefined && until > now
    this.cacheFact.hidden = until === undefined
    this.cacheFact.dataset.cache = until === undefined ? '' : warm ? 'warm' : 'cold'
    const cacheSaid = until === undefined ? '' : warm ? `Cache warm until ${clock(until).text}` : `Cache cold since ${clock(until).text}`
    this.cacheFact.title = until === undefined ? '' : `${cacheSaid} (estimated from Claude cache usage)`
    this.cacheFact.setAttribute('aria-label', cacheSaid)
    const ttl = stats.cacheTtl ?? 300_000
    this.cacheFact.style.setProperty('--ws-cache-left', warm ? String(Math.min(1, (until! - now) / ttl)) : '0')
    if (warm) {
      this.cacheTimer = window.setTimeout(() => {
        this.cacheTimer = null
        if (!this.disposed) this.paintFacts()
      }, Math.min(until! - now, CACHE_REPAINT_MS))
    }
    const count = (n: number): string => new Intl.NumberFormat('en-US').format(n)
    const cache = stats.sessionCache
    const hit = cache ? Math.round(Math.min(1, cache.cached / cache.context) * 100) : undefined
    this.hitFact.hidden = hit === undefined
    this.hitFact.textContent = cache ? `${hit}% cached` : ''
    this.hitFact.title = cache ? `This session read ${hit}% of its context tokens from the prompt cache (${count(cache.cached)} of ${count(cache.context)})` : ''
    const context = stats.context
    this.contextFact.hidden = context === undefined
    this.shareFact.hidden = true
    this.meter.hidden = context === undefined && until === undefined && (this.inline || cache === undefined)
    const window_ = context === undefined ? undefined : contextWindow(stats.window, stats.model ?? this.target?.agent)
    this.contextFact.textContent = context === undefined ? '' : tokenLabel(context)
    this.contextFact.title = context === undefined ? '' : `Context: ${count(context)} tokens${window_ ? ` of a ${count(window_)}-token window` : ''}`
    if (context !== undefined && window_) {
      const share = Math.round(Math.min(1, context / window_) * 100)
      this.contextFact.title += ` (${share}% full)`
      this.contextFact.style.color = `color-mix(in oklch, var(--kbn-alarm) ${share}%, var(--kbn-tempered))`
      this.shareFact.hidden = false
      this.shareFact.textContent = `${share}% ctx`
      this.shareFact.title = this.contextFact.title
    } else {
      this.contextFact.style.removeProperty('color')
    }
    this.onFacts?.()
  }

  /** When the cache of `session` stays warm until, while it is the session shown and the estimate says it is still warm. */
  cacheWarm(session: string): number | undefined {
    if (this.target?.session !== session) return undefined
    const until = this.model.stats().cacheUntil
    return until !== undefined && until > Date.now() ? until : undefined
  }

  private agentName(): string {
    return this.target?.agent ?? this.model.stats().model ?? 'worker'
  }

  private visibilityChanged(): void {
    if (document.visibilityState === 'visible') this.readIfVisible()
    else this.stopFollowing()
  }

  private canReadNow(): boolean {
    return !this.disposed && !!this.target && document.visibilityState === 'visible'
      && (this.inline ? this.intersecting : this.fullOpen || (!this.folded && this.intersecting))
  }

  private readIfVisible(): void {
    if (!this.canReadNow() || (!this.target?.live && this.hasReadCurrent)) return
    if (this.following) {
      // A stopped stream must commit its last event before a catch-up read.
      if (this.followingStopped) {
        const feed = this.feed
        void this.following.then(() => { if (this.feed === feed) this.readIfVisible() })
      }
      return
    }
    this.stopPollTimer()
    void this.readNow()
  }

  private readNow(): Promise<boolean> {
    if (!this.feed || this.disposed) return Promise.resolve(false)
    if (this.readingPromise) return this.readingPromise
    const feed = this.feed
    let shared!: Promise<boolean>
    const sentFilesFeed = this.sentFilesFeed
    let sentFilesArrived = false
    void sentFilesFeed?.read().then(arrived => {
      sentFilesArrived = arrived
      if (arrived && this.feed === feed && this.canReadNow() && this.target?.live) {
        if (!this.following && !this.readingPromise) this.keepFollowing(true)
      }
    })
    shared = feed.read().then((transcriptArrived) => {
      const arrived = transcriptArrived || sentFilesArrived
      if (this.readingPromise === shared) this.readingPromise = null
      if (this.feed === feed) this.hasReadCurrent = true
      if (this.feed === feed && this.canReadNow() && this.target?.live) {
        this.keepFollowing(arrived)
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

  private keepFollowing(arrived: boolean): void {
    this.pollDelay = arrived ? LIVE_POLL_MS : Math.min(MAX_POLL_MS, this.pollDelay * 1.5)
    if (this.following) return
    if (this.streamUnsupported || Date.now() < this.streamRetryAt) {
      this.schedulePoll(this.pollDelay)
      return
    }
    this.startFollowing()
  }

  private startFollowing(): void {
    const feed = this.feed
    if (!feed || this.following || !this.target?.live || !this.canReadNow()) return
    this.stopPollTimer()
    this.followingStopped = false
    const following = feed.stream().then(end => {
      if (this.following !== following || this.feed !== feed) return
      this.following = null
      this.onStreamEnd(end)
    })
    this.following = following
    this.sentFilesSoon()
  }

  private onStreamEnd(end: StreamEnd): void {
    if (end === 'stopped' || !this.target?.live || !this.canReadNow()) return
    if (end === 'closed') {
      this.streamRetryDelay = 2000
      this.streamRetryAt = 0
      this.startFollowing()
    } else if (end === 'reset') {
      void this.readNow()
    } else if (end === 'unsupported') {
      this.streamUnsupported = true
      this.schedulePoll(LIVE_POLL_MS)
    } else {
      this.streamRetryAt = Date.now() + this.streamRetryDelay
      this.streamRetryDelay = Math.min(60_000, this.streamRetryDelay * 2)
      this.schedulePoll(LIVE_POLL_MS)
    }
  }

  private sentFilesSoon(): void {
    if (!this.sentFilesFeed) return
    this.clearSentFilesTimer()
    const feed = this.sentFilesFeed
    this.sentFilesTimer = window.setTimeout(() => {
      this.sentFilesTimer = null
      if (this.sentFilesFeed === feed && this.canReadNow()) void feed.read()
    }, 1500)
  }

  private stopFollowing(): void {
    this.stopPollTimer()
    this.followingStopped = true
    this.feed?.stopStream()
  }

  private clearSentFilesTimer(): void {
    if (this.sentFilesTimer !== null) window.clearTimeout(this.sentFilesTimer)
    this.sentFilesTimer = null
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
    this.stopFollowing()
    const feed = this.feed
    if (!feed) return
    void Promise.all([this.following, this.readingPromise]).then(() => {
      if (!this.disposed && this.feed === feed && this.target && !this.target.live) void this.readNow()
    })
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
    // A failure while following is transient: keep the words on screen
    // and retry. Only a transcript never read says so.
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
    if (this.following) this.sentFilesSoon()
    this.pendingEntries.push(...entries)
    if (this.renderFrame !== null) return
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null
      if (this.disposed || !this.pendingEntries.length) return
      const before = this.model.turns.length
      this.model.append(this.pendingEntries)
      this.model.placeSentFiles()
      this.pendingEntries = []
      const changes = this.model.takeChanges()
      this.confirmSent()
      if (changes.reset) this.clearView()
      if (!this.hasInitialRender) {
        this.renderInitialWhenDrained()
        return
      }
      const after = this.model.turns.length
      const render = () => {
        this.paintPreview()
        if (this.fullRendered) {
          if (before === 0 && after > 0) this.visibleStart = Math.max(0, after - (this.inline ? INLINE_TURNS : INITIAL_TURNS))
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
      }
      this.preservePositions(render)
      this.paintHead()
      this.scheduleLayout()
      this.setNote(null)
      if (this.findPattern) this.scheduleFindRefresh()
    })
  }

  private acceptSentFiles(session: string, files: SentFile[]): void {
    if (this.disposed || this.target?.session !== session) return
    const notices = sentFileSends(files, session).map((send): SentFileNotice => ({
      ...send,
      kind: 'sent-file',
      ...(send.timestamp === undefined ? {} : { at: send.timestamp }),
    }))
    this.sentFileNotices = notices
    this.model.setSentFiles(notices)
    const changes = this.model.takeChanges()
    if (!changes.turns.length) return
    if (!this.hasInitialRender) {
      this.initialReadyPending = true
      this.renderInitialWhenDrained()
      return
    }
    this.preservePositions(() => {
      this.paintPreview()
      if (this.fullRendered) {
        for (const index of changes.turns) this.renderTurn(index)
        this.updateEarlierButton()
      }
    })
    this.paintHead()
    this.scheduleLayout()
    this.setNote(null)
    if (this.findPattern) this.scheduleFindRefresh()
  }

  private preservePositions(render: () => void): void {
    const active = document.activeElement
    const focused = this.el.contains(active) || this.pane.contains(active) ? active as HTMLElement : null
    const full = () => this.fullRendered && !this.fullFollowing
      ? preserveReadingPosition(this.scroller, render) : render()
    if (!this.previewFollowing) preserveReadingPosition(this.preview, full)
    else full()
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
    if (!this.fullFollowing) this.fullScroll = this.scroller.scrollTop
    if (!this.previewFollowing) this.previewScroll = this.preview.scrollTop
  }

  private resetFeedView(): void {
    this.cancelPendingRender()
    this.model.reset()
    this.model.setSentFiles(this.sentFileNotices)
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
    this.settleFind()
    this.setNote(this.model.turns.length === 0 && this.target?.live ? 'empty-live' : null)
  }

  private cancelPendingRender(): void {
    this.pendingEntries = []
    this.initialReadyPending = false
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame)
    this.renderFrame = null
  }

  private clearView(): void {
    this.messageToReveal = null
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
    if (this.inline) return
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
      this.previewKept.clear()
    }
    const live = this.target?.live === true
    const last = [...turn.steps].reverse().find(step => step.kind !== 'sent-file')
    const working = live && (!last || last.kind !== 'text')
    const key = `${turn.index}:${turn.version}:${working}:${this.agentName()}`
    if (key === this.previewKey) return
    this.previewKey = key

    const nodes: HTMLElement[] = []
    if (turn.prompt) {
      this.previewPrompt ??= createMessage(turn.prompt.dispatch ? 'dispatch' : 'you', 'li')
      paintPrompt(this.previewPrompt, turn.prompt)
      setAttr(this.previewPrompt.node, 'data-reading-key', `${turn.index}:prompt`)
      nodes.push(this.previewPrompt.node)
    }
    const agent = this.agentName()
    const used = new Set<string>()
    const usedTexts = new Set<string>()
    turn.steps.forEach((step) => {
      if (step.kind === 'shuttle-message') {
        const identity = this.stepIdentity(step)
        const node = keepMessage(this.previewKept, used, `message:${identity}`, step, 'li')
        setAttr(node, 'data-reading-key', `${turn.index}:message:${identity}`)
        nodes.push(node)
        return
      }
      if (step.kind === 'sent-file') {
        const owner = this.target?.host
        nodes.push(keep(this.previewKept, used, `sent:${step.id}`, JSON.stringify([step, owner]), () => sentFileRow(step, owner, this.shuttleBase, this.onFile, 'li')))
        return
      }
      if (step.kind !== 'text') {
        const spawns = keepSpawns(this.previewKept, used, step, this.target?.host, 'li')
        if (spawns) nodes.push(spawns)
        return
      }
      const identity = this.stepIdentity(step)
      usedTexts.add(identity)
      let message = this.previewTexts.get(identity)
      if (!message) {
        message = createMessage('agent', 'li')
        this.previewTexts.set(identity, message)
      }
      paintText(message, agent, step)
      setAttr(message.node, 'data-reading-key', `${turn.index}:text:${identity}`)
      nodes.push(message.node)
    })
    if (working) nodes.push(this.working)
    for (const identity of this.previewTexts.keys()) if (!usedTexts.has(identity)) this.previewTexts.delete(identity)
    prune(this.previewKept, used)
    placeChildren(this.exchange, nodes)
    this.preview.hidden = nodes.length === 0
  }

  // ── The whole session, in a pane over the page ─────────────────────

  /**
   * The pane lies over the constitution page's content box, the frame its
   * prose scrolls inside, so the page's chrome, its tabs and the board stay
   * live around it. Outside a page it opens in place, under the band.
   */
  /** Read the outcome in its native session, keeping the page preview bounded. */
  openAtMessage(text: string): void {
    this.pinned = false
    this.showTarget(this.latest)
    this.messageToReveal = text.trim()
    this.openFull()
    this.scheduleLayout()
  }

  private openFull(): void {
    if (this.disposed || this.fullOpen || !this.target) return
    const edge = this.preview.getBoundingClientRect().top
    const visible = [...this.preview.querySelectorAll<HTMLElement>('.ws-transcript-msg')].find(node => node.getBoundingClientRect().bottom > edge)
    const key = visible?.dataset.readingKey
    const send = visible?.dataset.send
    const offset = visible ? visible.getBoundingClientRect().top - edge : 0
    const transfer = !this.previewFollowing && (key || send)
    this.fullOpen = true
    const host = this.el.closest<HTMLElement>('.ws-content')
    this.pane.classList.toggle('ws-transcript-pane-inline', !host)
    ;(host ?? this.el).append(this.pane)
    this.pane.hidden = false
    this.openButton.setAttribute('aria-expanded', 'true')
    this.fullFollowing = true
    if (this.hasInitialRender) this.renderFull()
    if (transfer) {
      const match = [...this.scroller.querySelectorAll<HTMLElement>('.ws-transcript-msg')].find(node => key ? node.dataset.readingKey === key : node.dataset.send === send)
      if (match) {
        this.scroller.scrollTop += match.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - offset
        this.fullScroll = this.scroller.scrollTop
        this.fullFollowing = false
      }
    }
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
    if (this.inline) {
      if (!this.fullFollowing) settleScroll(this.scroller, this.fullScroll)
    } else if (this.fullOpen) {
      const host = this.el.closest<HTMLElement>('.ws-content')
      if (host && this.pane.parentElement !== host) host.append(this.pane)
      if (!this.fullFollowing) settleScroll(this.scroller, this.fullScroll)
    }
    if (!this.previewFollowing) settleScroll(this.preview, this.previewScroll)
    this.scheduleLayout()
  }

  /** Close the full transcript; true when it was open, so Escape can peel it as a layer. */
  closeFull(): boolean {
    if (!this.fullOpen || this.inline) return false
    this.fullOpen = false
    this.messageToReveal = null
    const hadFocus = this.pane.contains(document.activeElement)
    this.pane.hidden = true
    this.pane.remove()
    this.openButton.setAttribute('aria-expanded', 'false')
    this.clearFull()
    if (!this.canReadNow()) this.stopFollowing()
    if (hadFocus && this.openButton.isConnected && !this.disposed) this.openButton.focus({ preventScroll: true })
    return true
  }

  private renderFull(): void {
    this.clearFull()
    this.fullRendered = true
    const turns = this.model.turns
    this.visibleStart = turns.length ? Math.max(0, turns.length - (this.inline ? INLINE_TURNS : INITIAL_TURNS)) : -1
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
    return { index, node, kept: new Map(), texts: new Map(), groups: new Map(), rows: new Map(), expandedRows: new Set(), memberOf: new Map() }
  }

  private updateTurnView(view: TurnView, turn: Turn): void {
    const focused = view.node.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    const children: Node[] = []
    if (turn.prompt) {
      view.prompt ??= createMessage(turn.prompt.dispatch ? 'dispatch' : 'you')
      paintPrompt(view.prompt, turn.prompt)
      setAttr(view.prompt.node, 'data-reading-key', `${turn.index}:prompt`)
      children.push(view.prompt.node)
    }
    const agent = this.agentName()
    const parts = segments(turn.steps)
    const isLastTurn = view.index === this.model.turns.length - 1
    const used = new Set<string>()
    const usedTexts = new Set<string>()
    const usedGroups = new Set<string>()
    const memberOf = new Map<string, string>()
    parts.forEach((part, position) => {
      if (part.kind === 'shuttle-message') {
        const message = turn.steps[part.index] as ShuttleMessage
        const identity = this.stepIdentity(message)
        const row = keepMessage(view.kept, used, `message:${identity}`, message, 'div')
        setAttr(row, 'data-reading-key', `${turn.index}:message:${identity}`)
        children.push(row)
        return
      }
      if (part.kind === 'sent-file') {
        const sent = turn.steps[part.index] as SentFileNotice
        const owner = this.target?.host
        children.push(keep(view.kept, used, `sent:${sent.id}`, JSON.stringify([sent, owner]), () => sentFileRow(sent, owner, this.shuttleBase, this.onFile)))
        return
      }
      if (part.kind === 'text') {
        const step = turn.steps[part.index] as Text
        const identity = this.stepIdentity(step)
        usedTexts.add(identity)
        let message = view.texts.get(identity)
        if (!message) {
          message = createMessage('agent')
          view.texts.set(identity, message)
        }
        paintText(message, agent, step)
        setAttr(message.node, 'data-reading-key', `${turn.index}:text:${identity}`)
        children.push(message.node)
        return
      }
      const identity = this.stepIdentity(turn.steps[part.start])
      usedGroups.add(identity)
      const split = !view.groups.has(identity) && view.groups.get(view.memberOf.get(identity) ?? '')
      const group = this.groupFor(view, identity)
      if (split) { group.expanded = split.expanded; group.count = split.count }
      for (let index = part.start; index < part.end; index++) memberOf.set(this.stepIdentity(turn.steps[index]), identity)
      const trailing = isLastTurn && position === parts.length - 1
      this.paintGroupSummary(group, turn, part.start, part.end, trailing)
      if (group.expanded) this.reconcileGroup(view, group, turn, part.start, part.end)
      children.push(group.button)
      // An open run shows its commands instead; its chips stay kept for when it folds again.
      for (let index = part.start; index < part.end; index++) {
        const spawns = keepSpawns(view.kept, used, turn.steps[index], this.target?.host, 'span')
        if (spawns && !group.expanded) children.push(spawns)
      }
      if (group.expanded && group.list) children.push(group.list)
      if (group.expanded && group.more && !group.more.hidden) children.push(group.more)
    })
    view.memberOf = memberOf
    for (const identity of view.texts.keys()) if (!usedTexts.has(identity)) view.texts.delete(identity)
    for (const identity of view.groups.keys()) if (!usedGroups.has(identity)) view.groups.delete(identity)
    const currentSteps = new Set(turn.steps.map(step => this.stepIdentity(step)))
    for (const identity of view.rows.keys()) if (!currentSteps.has(identity)) view.rows.delete(identity)
    for (const identity of view.expandedRows) if (!currentSteps.has(identity)) view.expandedRows.delete(identity)
    prune(view.kept, used)
    placeChildren(view.node, children)
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
    this.markView(view)
  }

  private stepIdentity(step: Step): string {
    // Receipt rows can splice before a step without changing the step itself.
    let identity = this.stepIdentities.get(step)
    if (!identity) {
      identity = `step:${++this.nextStepIdentity}`
      this.stepIdentities.set(step, identity)
    }
    return identity
  }

  private groupFor(view: TurnView, identity: string): StepGroup {
    let group = view.groups.get(identity)
    if (group) return group
    const button = createButton('ws-transcript-steps', '')
    button.setAttribute('aria-expanded', 'false')
    const created: StepGroup = { expanded: false, count: PAGE_SIZE, button, list: null, more: null }
    button.addEventListener('click', () => {
      created.expanded = !created.expanded
      const turn = this.model.turns[view.index]
      if (turn) this.updateTurnView(view, turn)
    })
    view.groups.set(identity, created)
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
    const label = `${group.expanded ? '▾' : '▸'} ${pieces.join(' · ')}`
    const painted = group.button.firstChild
    if (painted?.nodeType === Node.TEXT_NODE) { if (painted.nodeValue !== label) painted.nodeValue = label }
    else group.button.replaceChildren(document.createTextNode(label))
    const mark = group.button.querySelector('.ws-transcript-pending')
    if (pending && !mark) {
      const mark = document.createElement('span')
      mark.className = 'ws-transcript-pending'
      mark.setAttribute('aria-label', 'tool running')
      group.button.append(document.createTextNode(' '), mark)
    } else if (!pending && mark) {
      mark.previousSibling?.remove()
      mark.remove()
    }
    const expanded = String(group.expanded)
    if (group.button.getAttribute('aria-expanded') !== expanded) group.button.setAttribute('aria-expanded', expanded)
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
    shown.forEach(step => {
      const identity = this.stepIdentity(step)
      if (!view.rows.has(identity)) view.expandedRows.add(identity)
    })
    const wanted = shown.map(step => this.getStepRow(view, step).node)
    placeChildren(group.list, wanted)
    const remaining = Math.max(0, available.length - shown.length)
    group.more.hidden = remaining === 0
    group.more.textContent = `▾ ${remaining} more steps`
  }

  private getStepRow(view: TurnView, step: Step): StepRow {
    const identity = this.stepIdentity(step)
    const version = step.kind === 'tool' ? step.version : 0
    const cached = view.rows.get(identity)
    if (cached?.version === version) return cached
    const row = this.createStepRow(view, step, identity)
    row.version = version
    view.rows.set(identity, row)
    return row
  }

  private createStepRow(view: TurnView, step: Step, identity: string): StepRow {
    const node = document.createElement('li')
    if (step.kind === 'tool') return this.createToolRow(view, node, step, identity)
    if (step.kind === 'thinking') {
      node.className = 'ws-transcript-think'
      const button = createButton('ws-transcript-expand', 'Thinking')
      const text = document.createElement('div')
      text.className = 'ws-transcript-thinking-text'
      text.textContent = step.text
      text.hidden = !view.expandedRows.has(identity)
      button.setAttribute('aria-expanded', String(!text.hidden))
      button.addEventListener('click', () => {
        const expanded = view.expandedRows.has(identity)
        if (expanded) view.expandedRows.delete(identity)
        else view.expandedRows.add(identity)
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
    button.setAttribute('aria-expanded', String(view.expandedRows.has(identity)))
    const content = document.createElement('div')
    content.className = 'ws-transcript-event-text'
    content.textContent = text ?? ''
    content.hidden = !view.expandedRows.has(identity) || !text
    button.addEventListener('click', () => {
      if (!text) return
      const expanded = view.expandedRows.has(identity)
      if (expanded) view.expandedRows.delete(identity)
      else view.expandedRows.add(identity)
      content.hidden = expanded
      button.setAttribute('aria-expanded', String(!expanded))
    })
    node.append(button, content)
    return { version: 0, node }
  }

  private createToolRow(view: TurnView, node: HTMLLIElement, step: ToolStep, identity: string): StepRow {
    node.className = 'ws-transcript-tool'
    const line = createButton('ws-transcript-tool-line', '')
    line.setAttribute('aria-expanded', String(view.expandedRows.has(identity)))
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
      const expanded = view.expandedRows.has(identity)
      if (expanded) view.expandedRows.delete(identity)
      else view.expandedRows.add(identity)
      line.setAttribute('aria-expanded', String(!expanded))
      if (!row.detail && !expanded) {
        row.detail = buildToolInput(step)
        node.append(row.detail)
      }
      if (row.detail) row.detail.hidden = expanded
      if (!expanded) this.buildToolResult(row, step)
      this.refreshToolRow(row, step)
    })
    if (view.expandedRows.has(identity)) {
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
    row.detail?.querySelectorAll('.ws-transcript-output-wrap, .ws-transcript-no-result, .ws-transcript-pictures').forEach(el => el.remove())
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
    if (full || !step.result.pictures?.length) row.detail?.append(wrap)
    if (step.result.pictures?.length) row.detail?.append(this.pictures(step, step.result.pictures))
  }

  /** The images a step's result carries, drawn only now that the step is open; a press opens one full size. */
  private pictures(step: ToolStep, pictures: readonly ResultImage[]): HTMLElement {
    const strip = document.createElement('div')
    strip.className = 'ws-transcript-pictures'
    const path = pictures.length === 1 ? stepPath(step) : undefined
    const name = path?.split('/').pop()
    for (const picture of pictures) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'ws-transcript-picture'
      button.title = path && this.onFile ? `Open ${name} in the viewer` : 'Open full size'
      const img = document.createElement('img')
      img.loading = 'lazy'; img.decoding = 'async'; img.alt = name ?? 'Image from the tool result'
      img.src = imageSource(picture)
      button.append(img)
      button.addEventListener('click', event => {
        event.stopPropagation()
        if (path && this.onFile) this.onFile(path, name)
        else openPicture(picture)
      })
      strip.append(button)
    }
    return strip
  }

  private updateLiveMarks(): void {
    this.previewKey = ''
    this.paintPreview()
    for (const view of this.views.values()) {
      const turn = this.model.turns[view.index]
      if (turn) {
        this.updateTurnView(view, turn)
        for (const step of turn.steps) {
          const row = view.rows.get(this.stepIdentity(step))
          if (step.kind === 'tool' && row) this.refreshToolRow(row, step)
        }
      }
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

  // ── Finding words ────────────────────────────────────────────────────

  private currentKey(): string {
    const match = this.matches[this.currentMatch]
    return match ? `${match.turn}:${match.step ?? 'p'}` : ''
  }

  private matchKey(match: Match): string { return `${match.turn}:${match.step ?? 'p'}` }

  /** Mark a board Find hit and stand on its nearest match. */
  private setQuery(text: string, at?: number): void {
    const terms = queryTerms(text)
    this.findPattern = termPattern(terms)
    this.findKey = terms.join(' ')
    this.matches = findMatches(this.model.turns, terms)
    this.currentMatch = -1
    this.markAll()
    if (this.matches.length) this.revealMatch(at === undefined ? 0 : nearestMatch(this.matches, at))
  }

  private clearQuery(): void {
    this.findPattern = null
    this.findKey = ''
    this.matches = []
    this.currentMatch = -1
    this.pendingHit = null
    this.markAll()
  }

  /** Stand on a match: draw its turn if it is not drawn, open what hides it, and bring it into view. */
  private revealMatch(index: number): void {
    const match = this.matches[index]
    if (!match || !this.hasInitialRender) return
    this.currentMatch = index
    if (!this.fullRendered) return
    if (match.turn < this.visibleStart) {
      const previous = this.visibleStart
      this.visibleStart = match.turn
      for (let turn = this.visibleStart; turn < previous; turn++) this.renderTurn(turn)
      this.updateEarlierButton()
    }
    this.renderTurn(match.turn)
    this.markAll()
    const view = this.views.get(match.turn)
    const step = match.step === undefined ? undefined : this.model.turns[match.turn]?.steps[match.step]
    const message = match.step === undefined ? view?.prompt : step ? view?.texts.get(this.stepIdentity(step)) : undefined
    if (!message) return
    this.unfold(message)
    this.fullFollowing = false
    this.scroller.scrollTop += message.node.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - 3 * ANCHOR_MARGIN
    this.fullScroll = this.scroller.scrollTop
  }

  /** A clamped prompt or a folded brief shows its words whole when a match stands in it. */
  private unfold(message: Message): void {
    if (message.node.classList.contains('ws-transcript-msg-brief')) {
      message.unclamped = true
      paintBrief(message)
    } else if (message.prose.classList.contains('ws-transcript-prompt-text') && !message.unclamped) {
      message.unclamped = true
      message.prose.classList.add('ws-transcript-unclamped')
      message.prose.classList.remove('ws-transcript-overflowing')
      message.prose.setAttribute('aria-expanded', 'true')
      message.prose.removeAttribute('aria-label')
    }
  }

  private markAll(): void {
    for (const view of this.views.values()) this.markView(view)
  }

  /** Bring every drawn message of a turn up to date with the words being sought. */
  private markView(view: TurnView): void {
    const current = this.matches[this.currentMatch]
    const turn = this.model.turns[view.index]
    const currentStep = current?.turn === view.index && current.step !== undefined ? turn?.steps[current.step] : undefined
    const currentIdentity = currentStep ? this.stepIdentity(currentStep) : undefined
    if (view.prompt) this.markMessage(view.prompt, !!current && current.turn === view.index && current.step === undefined)
    for (const [identity, message] of view.texts) {
      this.markMessage(message, !!current && current.turn === view.index && identity === currentIdentity)
    }
  }

  private markMessage(message: Message, current: boolean): void {
    if (message.marked !== this.findKey) {
      unmark(message.prose, FOUND_MARK)
      if (this.findPattern) markTerms(message.prose, this.findPattern, FOUND_MARK)
      message.marked = this.findKey
    }
    message.node.classList.toggle(FOUND_MESSAGE, current)
  }

  private scheduleFindRefresh(): void {
    if (this.findFrame !== null) return
    this.findFrame = requestAnimationFrame(() => {
      this.findFrame = null
      if (!this.disposed) this.refreshFind()
    })
  }

  /** The transcript grew or was read again: recount, staying on the match the reader was on. */
  private refreshFind(): void {
    if (!this.findPattern) return
    const standing = this.currentKey()
    this.matches = findMatches(this.model.turns, queryTerms(this.findKey))
    const kept = standing ? this.matches.findIndex((match) => this.matchKey(match) === standing) : -1
    this.currentMatch = kept
    this.markAll()
  }

  /** A first draw of a session lands on a pending board Find hit. */
  private settleFind(): void {
    const pending = this.pendingHit
    this.pendingHit = null
    if (pending) this.setQuery(pending.query, pending.at)
    else if (this.findKey) this.setQuery(this.findKey)
  }

  /** Read the session a hit came from, standing on the match nearest the hit's time. */
  openHit(hit: TranscriptHit, query: string): void {
    const time = Date.parse(hit.timestamp)
    const at = Number.isFinite(time) ? time : undefined
    // The index folds case and stems; the terms the snippet marked are what the transcript is searched for.
    const words = snippetTerms(hit.snippet)
    const text = words.length ? words.join(' ') : query
    if (this.target?.session === hit.session && this.hasInitialRender) {
      this.setQuery(text, at)
      return
    }
    this.pendingHit = { query: text, at }
    this.read({ session: hit.session, uid: this.target?.uid, host: this.target?.host, agent: hit.harness || undefined, live: false, ...(at === undefined ? {} : { at }) })
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
        this.previewScroll = settleScrollAtEnd(this.preview)
      }
      this.preview.classList.toggle('ws-transcript-scrolled', this.preview.scrollTop > 0)
      if (this.fullOpen && this.messageToReveal !== null) {
        const source = this.messageToReveal
        let match: Message | undefined
        for (let turnIndex = this.model.turns.length - 1; this.hasInitialRender && turnIndex >= 0 && !match; turnIndex--) {
          const turn = this.model.turns[turnIndex]
          const step = turn.steps.find(step => step.kind === 'text' && step.text.trim() === source)
          if (!step || step.kind !== 'text') continue
          const previousStart = this.visibleStart
          this.visibleStart = Math.min(previousStart, turnIndex)
          for (let index = this.visibleStart; index < previousStart; index++) this.renderTurn(index)
          this.renderTurn(turnIndex)
          this.updateEarlierButton()
          match = this.views.get(turnIndex)?.texts.get(this.stepIdentity(step))
        }
        if (match) {
          this.list.querySelector('.ws-transcript-outcome')?.remove()
          this.messageToReveal = null
          this.fullFollowing = false
          this.scroller.scrollTop += match.node.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - ANCHOR_MARGIN
          this.fullScroll = this.scroller.scrollTop
        } else if (!this.list.querySelector('.ws-transcript-outcome')) {
          // Outcomes can be authored independently of the worker's final reply.
          const outcome = createMessage('agent', 'li')
          outcome.node.classList.add('ws-transcript-outcome')
          paintText(outcome, 'Outcome', { kind: 'text', text: source })
          this.list.append(outcome.node)
          this.fullFollowing = false
          this.scroller.scrollTop += outcome.node.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top - ANCHOR_MARGIN
          this.fullScroll = this.scroller.scrollTop
        }
      }
      if (this.fullOpen && this.fullFollowing && this.scroller.clientHeight) this.fullScroll = settleScrollAtEnd(this.scroller)
    })
  }
}
