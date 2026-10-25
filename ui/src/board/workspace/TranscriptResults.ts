import { ago, hitLocation, projectName, searchTranscripts, snippetPieces, type TranscriptHit } from '../transcript/find.js'
import './transcriptResults.css'

/** Session hits below the bar Find's constitution rows; owns its debounce and request lifetime. */
export class TranscriptResults {
  readonly el = document.createElement('section')
  private readonly rows = document.createElement('div')
  private query: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private request: AbortController | null = null

  private readonly opts: {
    shuttleBase: string
    canOpen(hit: TranscriptHit): boolean
    open(hit: TranscriptHit, query: string): void
  }
  constructor(opts: TranscriptResults['opts']) {
    this.opts = opts
    this.el.className = 'ws-search-transcripts'
    this.el.hidden = true
    const caption = document.createElement('h3')
    caption.className = 'kbn-flight-caption'
    caption.textContent = 'Transcripts'
    this.el.append(caption, this.rows)
  }

  refresh(text: string): void {
    const query = text.trim()
    if (query === this.query) return
    this.close()
    this.query = query
    if (query.replace(/\s/g, '').length < 3) return
    this.timer = setTimeout(() => { this.timer = null; void this.search(query) }, 300)
  }
  close(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.request?.abort()
    this.request = null
    this.query = null
    this.rows.replaceChildren()
    this.el.hidden = true
  }
  dispose(): void { this.close() }

  private async search(query: string): Promise<void> {
    const request = this.request = new AbortController()
    try {
      const result = await searchTranscripts(this.opts.shuttleBase, query, { limit: 8 }, { signal: request.signal })
      if (this.request !== request || request.signal.aborted) return
      this.rows.replaceChildren(...result.hits.map(hit => this.row(hit, query)))
      this.el.hidden = result.hits.length === 0
    } catch {
      if (this.request !== request || request.signal.aborted) return
      const note = document.createElement('p')
      note.className = 'ws-search-note'
      note.textContent = 'Transcript search unavailable.'
      this.rows.replaceChildren(note)
      this.el.hidden = false
    }
  }

  private row(hit: TranscriptHit, query: string): HTMLElement {
    const canOpen = this.opts.canOpen(hit)
    const row = document.createElement('div')
    row.className = 'ws-search-result'
    row.title = hitLocation(hit)
    if (canOpen) {
      row.classList.add('ws-search-hit')
      row.tabIndex = 0
      row.setAttribute('role', 'button')
      row.addEventListener('click', event => {
        if ((event.target as Element).closest('button')) return
        this.opts.open(hit, query)
      })
      row.addEventListener('keydown', event => {
        if (event.target === row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); this.opts.open(hit, query) }
      })
    }
    const snippet = document.createElement('p')
    snippet.className = 'ws-search-snippet'
    for (const piece of snippetPieces(hit.snippet)) {
      if (!piece.hit) { snippet.append(piece.text); continue }
      const mark = document.createElement('mark')
      mark.textContent = piece.text
      snippet.append(mark)
    }
    const meta = document.createElement('small')
    meta.className = 'ws-search-meta'
    const when = Date.parse(hit.timestamp)
    meta.textContent = [hit.harness || 'session', projectName(hit.project), Number.isFinite(when) ? ago(when) : '', `${hit.matches} ${hit.matches === 1 ? 'match' : 'matches'}`, ...hit.fibers.map(fiber => fiber.name || fiber.id)].filter(Boolean).join(' · ')
    if (!canOpen) {
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.textContent = 'copy path'
      copy.setAttribute('aria-label', 'Copy the transcript path and line')
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(hitLocation(hit)).then(() => { copy.textContent = 'copied' }, () => { copy.textContent = 'not copied' })
      })
      meta.append(' · ', copy)
    }
    row.append(snippet, meta)
    return row
  }
}
