import { nameRef, untilWords, type Until } from './blockedOn.js'
import type { KanbanCard } from './KanbanTypes.js'
import { normalizeRecord } from './transcript/records.js'
import { THREAD_LABEL, type ThreadState } from './threads.js'
import { turnOf } from './turn.js'
import { humanizeIdleAge } from './utils.js'

/** How far back from a transcript's end the last reply is looked for. */
export const REPLY_TAIL_BYTES = 128 * 1024

/**
 * The last thing a thread's agent said, read from the tail of its native
 * transcript: the size from the receipt, then one byte slice from near the
 * end. A reply is kept per session and activity instant, so a quiet thread is
 * read once and a busy one is read again only after it has moved.
 */
export class LastReplies {
  private readonly cache = new Map<string, Promise<string | undefined>>()
  private readonly base: string
  private readonly fetcher: typeof fetch
  constructor(base: string, fetcher?: typeof fetch) {
    this.base = base.replace(/\/$/, '')
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init))
  }

  /** The reply already read for `card`, without asking for it. */
  known(card: KanbanCard): Promise<string | undefined> | undefined {
    const key = replyKey(card)
    return key ? this.cache.get(key) : undefined
  }

  reply(card: KanbanCard): Promise<string | undefined> {
    const key = replyKey(card)
    if (!key) return Promise.resolve(undefined)
    let pending = this.cache.get(key)
    if (!pending) {
      // A miss (a booting daemon, an unreachable host) is asked again on the next hover.
      pending = this.read(card.sessionUuid!, card.shuttleHost).catch(() => undefined)
        .then(text => { if (text === undefined) this.cache.delete(key); return text })
      this.cache.set(key, pending)
    }
    return pending
  }

  private async read(session: string, host: string | undefined): Promise<string | undefined> {
    const query = `session=${encodeURIComponent(session)}${host ? `&host=${encodeURIComponent(host)}` : ''}`
    const receipt = await this.fetcher(`${this.base}/api/v1/transcript?${query}`, { cache: 'no-store' })
    if (!receipt.ok) return undefined
    const size = ((await receipt.json()) as { byte_count?: unknown }).byte_count
    if (typeof size !== 'number' || size <= 0) return undefined
    const offset = Math.max(0, size - REPLY_TAIL_BYTES)
    const raw = await this.fetcher(`${this.base}/api/v1/transcript/raw?${query}&offset=${offset}`, { cache: 'no-store' })
    if (!raw.ok) return undefined
    return lastReplyIn(await raw.text(), offset > 0)
  }
}

const replyKey = (card: KanbanCard): string | undefined =>
  card.sessionUuid ? JSON.stringify([card.sessionUuid, card.shuttleHost ?? '', card.lastActivityAt ?? card.modifiedAt ?? '']) : undefined

/** The last assistant text in a JSONL slice; a slice cut mid-record drops its first line. */
export function lastReplyIn(jsonl: string, cut: boolean): string | undefined {
  const lines = jsonl.split('\n')
  if (cut) lines.shift()
  for (let n = lines.length - 1; n >= 0; n--) {
    if (!lines[n].trim()) continue
    let entries
    try { entries = normalizeRecord(JSON.parse(lines[n]) as unknown) } catch { continue }
    for (let e = entries.length - 1; e >= 0; e--) {
      const entry = entries[e]
      if (entry.kind === 'text' && entry.text.trim()) return plainReply(entry.text)
    }
  }
  return undefined
}

/** Markdown read as a sentence: no fences, emphasis, headings or link targets; one line. */
export function plainReply(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, label?: string) => label ?? target)
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** When the thread last moved: its turn's start, else its worker's last event, else its file. */
function movedAt(card: KanbanCard): number | undefined {
  const turn = turnOf(card)
  if (turn.since !== undefined) return turn.since
  if (card.lastActivityAt !== undefined) return card.lastActivityAt
  const ms = Date.parse(card.closedAt ?? card.modifiedAt ?? '')
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * The quiet card a thread line shows under the pointer or the keyboard: its
 * state and age, then what its agent last said (the ask or the outcome until
 * the transcript answers). One per page, laid over the Desk.
 */
export class ThreadWhisper {
  private el: HTMLElement | null = null
  private for: HTMLElement | null = null
  private timer = 0
  private readonly replies: LastReplies | undefined
  constructor(replies?: LastReplies) { this.replies = replies }

  /** Show for `line` after a breath (the pointer passing over shows nothing), or at once. */
  show(line: HTMLElement, card: KanbanCard, state: ThreadState, delay: number, until?: Until | null): void {
    clearTimeout(this.timer)
    this.for = line
    if (delay <= 0) { this.draw(line, card, state, until); return }
    this.timer = window.setTimeout(() => { if (this.for === line && line.isConnected) this.draw(line, card, state, until) }, delay)
  }

  hide(line?: HTMLElement): void {
    if (line && this.for !== line) return
    clearTimeout(this.timer)
    this.for = null
    if (this.el) this.el.hidden = true
  }

  private draw(line: HTMLElement, card: KanbanCard, state: ThreadState, until?: Until | null): void {
    const el = this.element()
    const head = el.querySelector<HTMLElement>('.kbn-thread-whisper-head')!
    const body = el.querySelector<HTMLElement>('.kbn-thread-whisper-body')!
    const moved = movedAt(card)
    const stateLine = (name?: string): string =>
      [THREAD_LABEL[state], until ? untilWords(name ? { text: name } : until) : '', moved !== undefined ? humanizeIdleAge(Date.now() - moved) : ''].filter(Boolean).join(' · ')
    head.textContent = stateLine()
    if (until?.ref && !until.card) {
      void nameRef(until.ref).then(name => { if (name && this.for === line && !el.hidden) head.textContent = stateLine(name) })
    }
    el.dataset.threadState = state
    const fallback = card.ask?.text ?? card.outcome ?? ''
    body.textContent = plainReply(fallback)
    body.hidden = !body.textContent
    el.hidden = false
    this.place(line)
    const pending = this.replies?.reply(card)
    void pending?.then(text => {
      if (!text || this.for !== line || el.hidden) return
      body.textContent = text; body.hidden = false
      this.place(line)
    })
  }

  private element(): HTMLElement {
    if (this.el?.isConnected) return this.el
    const el = document.createElement('div')
    el.className = 'kbn-thread-whisper'
    el.setAttribute('role', 'tooltip')
    el.hidden = true
    const head = document.createElement('div'); head.className = 'kbn-thread-whisper-head'
    const body = document.createElement('p'); body.className = 'kbn-thread-whisper-body'
    el.append(head, body)
    document.body.append(el)
    this.el = el
    return el
  }

  /** Beside the tree, level with the line; under it where the window is too narrow. */
  private place(line: HTMLElement): void {
    const el = this.el!
    const row = line.getBoundingClientRect()
    const tree = (line.closest('.kbn-thread-tree') ?? line).getBoundingClientRect()
    const width = el.offsetWidth || 300, height = el.offsetHeight || 60
    const gap = 10, edge = 8, vw = window.innerWidth, vh = window.innerHeight
    let left: number, top: number
    const beside = tree.right + gap + width <= vw - edge ? tree.right + gap : tree.left - gap - width >= edge ? tree.left - gap - width : null
    if (beside !== null) {
      left = beside; top = Math.min(row.top - 5, vh - edge - height)
    } else {
      left = Math.min(Math.max(edge, row.left), vw - edge - width)
      top = row.bottom + 4 + height <= vh - edge ? row.bottom + 4 : row.top - 4 - height
    }
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(Math.max(edge, top))}px`
  }
}
