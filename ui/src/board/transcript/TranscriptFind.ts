import { DATE_AND_TIME, formatInstant } from '../civilDay.js'
import {
  ago, hitLocation, projectName, searchTranscripts, snippetPieces,
  type TranscriptHit, type TranscriptSearchResult,
} from './find.js'

export interface FindHost {
  shuttleBase: string
  fetch?: typeof fetch
  /** The words in the field changed; the transcript marks them and reports back through `setCount`. */
  query(text: string): void
  /** Move to the next (+1) or previous (-1) match. */
  step(direction: 1 | -1): void
  /** The reader chose a hit from the host's whole record. */
  open(hit: TranscriptHit, query: string): void
  /** The field was cleared: drop the marks. */
  cleared(): void
}

const QUERY_DELAY_MS = 120
const PLACEHOLDER = 'Find in this transcript'
const HINT = 'Enter: next · Shift+Enter: previous · ⌘/Ctrl+Enter: search every transcript · Esc: clear'

function control(className: string, label: string, text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = text
  button.setAttribute('aria-label', label)
  button.title = label
  return button
}

/**
 * The transcript's search field: matches in the open transcript (the host
 * marks and steps through them), and, on request, every transcript on the
 * machine through the daemon's index, listed under the field.
 */
export class TranscriptFind {
  readonly el: HTMLElement
  private readonly input: HTMLInputElement
  private readonly count: HTMLElement
  private readonly previous: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly everywhere: HTMLButtonElement
  private readonly results: HTMLElement
  private readonly host: FindHost
  private timer: number | null = null
  private request: AbortController | null = null
  private resultsFor = ''

  constructor(host: FindHost) {
    this.host = host
    this.el = document.createElement('div')
    this.el.className = 'ws-transcript-find'
    this.el.setAttribute('role', 'search')

    const bar = document.createElement('div')
    bar.className = 'ws-transcript-find-bar'
    this.input = document.createElement('input')
    this.input.type = 'search'
    this.input.className = 'ws-transcript-find-input'
    this.input.placeholder = PLACEHOLDER
    this.input.title = HINT
    this.input.setAttribute('aria-label', PLACEHOLDER)
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.count = document.createElement('span')
    this.count.className = 'ws-transcript-find-count'
    this.count.setAttribute('aria-live', 'polite')
    this.previous = control('ws-transcript-find-step', 'Previous match', '▴')
    this.next = control('ws-transcript-find-step', 'Next match', '▾')
    this.everywhere = control('ws-transcript-find-all', 'Search every transcript on this machine', 'all transcripts')
    this.everywhere.title = 'Search every transcript on this machine (⌘/Ctrl+Enter)'
    this.previous.disabled = this.next.disabled = this.everywhere.disabled = true
    bar.append(this.input, this.count, this.previous, this.next, this.everywhere)

    this.results = document.createElement('div')
    this.results.className = 'ws-transcript-find-results'
    this.results.hidden = true
    this.results.setAttribute('role', 'listbox')
    this.results.setAttribute('aria-label', 'Matches in every transcript')
    this.el.append(bar, this.results)

    this.input.addEventListener('input', () => this.typed())
    this.input.addEventListener('keydown', (event) => this.keydown(event))
    this.previous.addEventListener('click', () => this.host.step(-1))
    this.next.addEventListener('click', () => this.host.step(1))
    this.everywhere.addEventListener('click', () => void this.searchEverywhere())
    this.results.addEventListener('keydown', (event) => this.resultKey(event))
    this.el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.isComposing && this.results.contains(event.target as Node)) {
        event.preventDefault(); event.stopPropagation(); this.input.focus()
      }
    })
  }

  get value(): string { return this.input.value }

  focus(): void {
    this.input.focus({ preventScroll: true })
    this.input.select()
  }

  hasFocus(): boolean { return this.el.contains(document.activeElement) }

  /** Put words in the field without asking the host to search them again. */
  set(text: string): void {
    this.input.value = text
    this.everywhere.disabled = !text.trim()
  }

  /** The host's tally: `current` is the 1-based match in view, 0 when none is. */
  setCount(current: number, total: number): void {
    const asked = this.input.value.trim() !== ''
    this.previous.disabled = this.next.disabled = total < 2
    this.count.textContent = !asked ? '' : total === 0 ? 'no matches' : `${current} of ${total}`
    if (asked && total === 0) this.count.dataset.empty = 'true'
    else delete this.count.dataset.empty
  }

  /** Empty the field and close the list. */
  clear(): void {
    this.cancel()
    this.input.value = ''
    this.everywhere.disabled = true
    this.hideResults()
    this.setCount(0, 0)
    this.host.cleared()
  }

  hideResults(): void {
    this.request?.abort()
    this.request = null
    this.results.hidden = true
    this.results.replaceChildren()
    this.resultsFor = ''
  }

  dispose(): void {
    this.cancel()
    this.request?.abort()
  }

  private cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }

  private typed(): void {
    const text = this.input.value
    this.everywhere.disabled = !text.trim()
    if (this.resultsFor && text.trim() !== this.resultsFor) this.hideResults()
    this.cancel()
    if (!text.trim()) { this.clear(); return }
    this.timer = window.setTimeout(() => { this.timer = null; this.host.query(text) }, QUERY_DELAY_MS)
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.metaKey || event.ctrlKey) { void this.searchEverywhere(); return }
      // A pending keystroke is searched first so Enter lands on what is typed.
      if (this.timer !== null) { this.cancel(); this.host.query(this.input.value) }
      this.host.step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      if (!this.input.value && this.results.hidden) return
      event.preventDefault()
      event.stopPropagation()
      this.clear()
    } else if (event.key === 'ArrowDown' && !this.results.hidden) {
      event.preventDefault()
      this.results.querySelector<HTMLElement>('.ws-transcript-find-hit')?.focus()
    }
  }

  private resultKey(event: KeyboardEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.ws-transcript-find-hit')
    if (!target) return
    const rows = [...this.results.querySelectorAll<HTMLElement>('.ws-transcript-find-hit')]
    const at = rows.indexOf(target)
    if (event.key === 'ArrowDown') { event.preventDefault(); rows[Math.min(rows.length - 1, at + 1)]?.focus() }
    else if (event.key === 'ArrowUp') { event.preventDefault(); if (at === 0) this.input.focus(); else rows[at - 1]?.focus() }
  }

  private async searchEverywhere(): Promise<void> {
    const query = this.input.value.trim()
    if (!query) return
    this.cancel()
    this.request?.abort()
    const request = this.request = new AbortController()
    this.resultsFor = query
    this.showStatus('searching every transcript…')
    try {
      const result = await searchTranscripts(this.host.shuttleBase, query, { limit: 30 }, { fetch: this.host.fetch, signal: request.signal })
      if (this.request !== request) return
      this.showResults(query, result)
    } catch (error) {
      if (this.request !== request || request.signal.aborted) return
      this.showStatus(`search failed — ${error instanceof Error ? error.message : String(error)}`, true)
    }
  }

  private showStatus(text: string, problem = false): void {
    const note = document.createElement('p')
    note.className = 'ws-transcript-find-note'
    note.textContent = text
    if (problem) note.dataset.problem = 'true'
    this.results.hidden = false
    this.results.replaceChildren(note)
  }

  private showResults(query: string, result: TranscriptSearchResult): void {
    const rows: Node[] = []
    if (!result.hits.length) {
      const none = document.createElement('p')
      none.className = 'ws-transcript-find-note'
      none.textContent = 'Nothing in any transcript matches.'
      rows.push(none)
    }
    for (const hit of result.hits) rows.push(this.row(hit, query))
    const foot = this.foot(result)
    if (foot) rows.push(foot)
    this.results.hidden = false
    this.results.replaceChildren(...rows)
  }

  private foot(result: TranscriptSearchResult): HTMLElement | null {
    const pieces: string[] = []
    const { index } = result
    if (index?.sessions !== undefined) pieces.push(`${index.sessions.toLocaleString('en-US')} sessions indexed`)
    const updated = index?.updated_at ? Date.parse(index.updated_at) : NaN
    if (Number.isFinite(updated)) pieces.push(`as of ${ago(updated)}`)
    pieces.push(...result.errors)
    if (!pieces.length) return null
    const foot = document.createElement('p')
    foot.className = 'ws-transcript-find-foot'
    foot.textContent = pieces.join(' · ')
    return foot
  }

  private row(hit: TranscriptHit, query: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'ws-transcript-find-hit'
    row.tabIndex = 0
    row.setAttribute('role', 'option')
    row.title = hitLocation(hit)

    const snippet = document.createElement('p')
    snippet.className = 'ws-transcript-find-snippet'
    for (const piece of snippetPieces(hit.snippet)) {
      if (!piece.hit) { snippet.append(piece.text); continue }
      const mark = document.createElement('mark')
      mark.className = 'ws-transcript-find-mark'
      mark.textContent = piece.text
      snippet.append(mark)
    }

    const meta = document.createElement('div')
    meta.className = 'ws-transcript-find-meta'
    const facts: string[] = [hit.harness || 'session']
    if (hit.role.startsWith('tool')) facts.push('tool output')
    const project = projectName(hit.project)
    if (project) facts.push(project)
    const when = Date.parse(hit.timestamp)
    const stamp = document.createElement('time')
    if (Number.isFinite(when)) {
      stamp.textContent = ago(when)
      stamp.dateTime = hit.timestamp
      stamp.title = formatInstant(when, DATE_AND_TIME)
    }
    meta.append(facts.join(' · '))
    if (Number.isFinite(when)) meta.append(' · ', stamp)

    for (const fiber of hit.fibers) {
      const chip = document.createElement('a')
      chip.className = 'kbn-wikilink ws-transcript-find-fiber'
      chip.dataset.fiber = fiber.id
      chip.textContent = fiber.name || fiber.id
      chip.title = fiber.id
      meta.append(chip)
    }

    const copy = control('ws-transcript-find-copy', 'Copy the transcript path and line', 'copy path')
    copy.addEventListener('click', (event) => {
      event.stopPropagation()
      void navigator.clipboard?.writeText(hitLocation(hit)).then(() => { copy.textContent = 'copied' }, () => { copy.textContent = 'not copied' })
    })
    meta.append(copy)

    row.append(snippet, meta)
    const open = (): void => this.host.open(hit, query)
    row.addEventListener('click', (event) => {
      if ((event.target as Element).closest('a, button')) return
      if (window.getSelection?.()?.toString()) return
      open()
    })
    row.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); open() }
    })
    return row
  }
}
