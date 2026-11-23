import { DeskKeyboard } from '../board/DeskKeyboard.js'
import { deskOrder } from '../board/deskOrdering.js'
import '../board/elements/post.css'
import { KanbanSurfaceRenderer } from '../board/KanbanSurfaces.js'
import type { KanbanCard } from '../board/KanbanTypes.js'
import { keyIntent } from '../board/keymap.js'
import { onMobileChange } from '../board/mobile.js'
import { slug } from '../board/threadOutline.js'
import { cardNamed } from '../board/threads.js'
import type { PageFeed } from './feed.js'
import { go } from './go.js'
import { threadHref, type PageRoute } from './route.js'

export interface DeskPageOptions {
  base: string
  route: PageRoute
  /** Opens another page in this one: a browser tab's navigation. */
  navigate(href: string): void
}

interface PaletteItem {
  id: string
  kind: string
  title: string
  subtitle?: string | null
  detail?: string | null
  fiber_id?: string | null
  origin?: string | null
}

const PALETTE_STALE_MS = 15_000
const MAX_SEARCH_RESULTS = 30

/**
 * The Desk, alone at its own address (`/desk`): three columns (Waiting on you,
 * Working, Awaiting review) over a shelf of three (Drafts, Resting, Roles &
 * standing), with no depth, workspace, tabs, voice or Rex following. Clicking
 * a card or waiting line calls `POST /api/v1/go` when `in=rex`, and otherwise
 * navigates to that fiber's `/thread` page. Tempered and discarded fibers are
 * omitted by the feed; outside Rex, a compact search bar backed by
 * `/api/v1/palette` searches all threads (including tempered) and starts new
 * capture sessions.
 */
export class DeskPage {
  readonly el = document.createElement('main')
  private readonly status = document.createElement('p')
  private readonly deskEl = document.createElement('div')
  private readonly said = document.createElement('p')
  private readonly feed: PageFeed
  private readonly opts: DeskPageOptions
  private readonly surfaces: KanbanSurfaceRenderer
  private readonly keyboard: DeskKeyboard
  private readonly unsubscribe: () => void
  private readonly stopMobileWatch: () => void
  private searchEl?: HTMLDivElement
  private searchInput?: HTMLInputElement
  private searchResults?: HTMLDivElement
  private paletteItems: PaletteItem[] = []
  private paletteFetchedAt = 0
  private paletteInFlight: Promise<void> | null = null
  private saidTimer: number | undefined
  private disposed = false

  constructor(feed: PageFeed, opts: DeskPageOptions) {
    this.feed = feed
    this.opts = opts
    this.el.className = 'pg-desk'
    this.status.className = 'pg-status'
    this.deskEl.className = 'kbn-desk'
    this.said.className = 'pg-said'
    this.said.setAttribute('role', 'status')
    this.said.hidden = true

    this.surfaces = new KanbanSurfaceRenderer({
      waits: () => this.feed.board.waiting,
      openDetail: card => this.openCard(card),
      clear: card => {
        void this.feed.board.clear(card.uid ?? card.id).catch((error: unknown) => {
          this.say(error instanceof Error ? error.message : String(error))
        })
      },
    })

    this.keyboard = new DeskKeyboard(this.deskEl, address => {
      const card = cardNamed(this.feed.cards, address.uid, address.origin)
      if (card) this.openCard(card)
    })

    if (!this.opts.route.inRex) {
      this.buildSearch()
      this.el.append(this.status, this.searchEl!, this.deskEl, this.said)
      document.addEventListener('click', this.onDocumentClick)
    } else {
      this.el.append(this.status, this.deskEl, this.said)
    }

    document.addEventListener('keydown', this.onKeydown)
    this.stopMobileWatch = onMobileChange(() => { if (this.feed.loaded) this.render() })
    this.unsubscribe = feed.subscribe(() => this.render())
    this.render()
  }

  render(): void {
    document.title = 'Desk'
    if (!this.feed.loaded) {
      this.deskEl.hidden = true
      this.status.hidden = false
      this.status.textContent = this.feed.failure ?? 'Reading the board…'
      return
    }
    this.deskEl.hidden = false
    this.status.hidden = !this.feed.failure
    if (this.feed.failure) this.status.textContent = this.feed.failure

    const scroll = this.captureScroll()
    const focused = this.keyboard.focusedRow()
    const order = deskOrder(this.feed.index, this.feed.board.waiting)
    this.deskEl.replaceChildren(this.surfaces.renderDesk(order, this.feed.index))
    this.restoreScroll(scroll)
    this.keyboard.refresh()
    this.keyboard.refocus(focused)
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.saidTimer)
    document.removeEventListener('keydown', this.onKeydown)
    if (this.searchEl) document.removeEventListener('click', this.onDocumentClick)
    this.stopMobileWatch()
    this.unsubscribe()
    this.keyboard.dispose()
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (this.searchEl && (this.searchEl.contains(document.activeElement) || (event.target instanceof Node && this.searchEl.contains(event.target)))) {
      return
    }
    const intent = keyIntent(event, 'desk')
    if (intent && this.keyboard.handle(intent)) event.preventDefault()
  }

  private readonly onDocumentClick = (event: MouseEvent): void => {
    if (!this.searchEl || !this.searchResults || this.searchResults.hidden) return
    if (event.target instanceof Node && this.searchEl.contains(event.target)) return
    this.searchResults.hidden = true
  }

  private buildSearch(): void {
    const wrap = document.createElement('div')
    wrap.className = 'pg-desk-search'

    const input = document.createElement('input')
    input.type = 'search'
    input.className = 'pg-desk-search-input'
    input.placeholder = 'Search all threads (including tempered)…'
    input.setAttribute('aria-label', 'Search all threads')
    input.autocomplete = 'off'
    input.spellcheck = false

    const results = document.createElement('div')
    results.className = 'pg-desk-search-results'
    results.setAttribute('role', 'listbox')
    results.hidden = true

    input.addEventListener('focus', () => {
      void this.ensurePalette()
      this.renderSearchResults()
    })
    input.addEventListener('input', () => {
      void this.ensurePalette()
      this.renderSearchResults()
    })
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.clearSearch()
      }
    })

    wrap.append(input, results)
    this.searchEl = wrap
    this.searchInput = input
    this.searchResults = results
  }

  private async ensurePalette(): Promise<void> {
    if (this.paletteInFlight) return this.paletteInFlight
    if (this.paletteFetchedAt > 0 && Date.now() - this.paletteFetchedAt < PALETTE_STALE_MS) return

    const request = fetch(`${this.opts.base}/api/v1/palette`)
      .then(async response => {
        if (!response.ok) return
        const payload = await response.json() as { items?: unknown }
        if (!Array.isArray(payload.items)) return
        this.paletteItems = payload.items.filter(
          (item): item is PaletteItem =>
            typeof item === 'object' && item !== null &&
            ((item as PaletteItem).kind === 'thread' || (item as PaletteItem).kind === 'channel') &&
            typeof (item as PaletteItem).fiber_id === 'string' &&
            (item as PaletteItem).fiber_id!.length > 0,
        )
        this.paletteFetchedAt = Date.now()
        if (!this.disposed) this.renderSearchResults()
      })
      .catch(() => { /* Keep previous items; capture row still works. */ })
      .finally(() => { this.paletteInFlight = null })

    this.paletteInFlight = request
    return request
  }

  private renderSearchResults(): void {
    if (!this.searchInput || !this.searchResults) return
    const query = this.searchInput.value.trim()
    if (!query) {
      this.searchResults.hidden = true
      this.searchResults.replaceChildren()
      return
    }

    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matches: PaletteItem[] = []
    for (const item of this.paletteItems) {
      const hay = `${item.title ?? ''} ${item.subtitle ?? ''} ${item.detail ?? ''}`.toLowerCase()
      if (tokens.every(token => hay.includes(token))) {
        matches.push(item)
        if (matches.length >= MAX_SEARCH_RESULTS) break
      }
    }

    const fragment = document.createDocumentFragment()
    for (const item of matches) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pg-desk-search-item'
      btn.setAttribute('role', 'option')

      const main = document.createElement('span')
      main.className = 'pg-desk-search-main'

      const title = document.createElement('span')
      title.className = 'pg-desk-search-title'
      title.textContent = item.title
      main.append(title)

      if (item.subtitle) {
        const sub = document.createElement('span')
        sub.className = 'pg-desk-search-sub'
        sub.textContent = item.subtitle
        main.append(sub)
      }

      btn.append(main)

      if (item.detail) {
        const badge = document.createElement('span')
        badge.className = 'pg-desk-search-badge'
        badge.textContent = item.detail
        btn.append(badge)
      }

      btn.addEventListener('click', () => {
        this.clearSearch()
        this.opts.navigate(threadHref(window.location.href, {
          uid: item.fiber_id!,
          host: item.origin ?? '',
        }))
      })

      fragment.append(btn)
    }

    const captureBtn = document.createElement('button')
    captureBtn.type = 'button'
    captureBtn.className = 'pg-desk-search-item pg-desk-search-capture'
    captureBtn.setAttribute('role', 'option')

    const captureTitle = document.createElement('span')
    captureTitle.className = 'pg-desk-search-title'
    captureTitle.textContent = `Start new thread: “${query}”`

    const captureBadge = document.createElement('span')
    captureBadge.className = 'pg-desk-search-badge'
    captureBadge.textContent = 'capture'

    captureBtn.append(captureTitle, captureBadge)
    captureBtn.addEventListener('click', () => {
      this.clearSearch()
      void this.startCapture(query)
    })
    fragment.append(captureBtn)

    this.searchResults.replaceChildren(fragment)
    this.searchResults.hidden = false
  }

  private clearSearch(): void {
    if (this.searchInput) this.searchInput.value = ''
    if (this.searchResults) {
      this.searchResults.hidden = true
      this.searchResults.replaceChildren()
    }
  }

  private async startCapture(prompt: string): Promise<void> {
    try {
      const response = await fetch(`${this.opts.base}/api/v1/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      if (response.ok) {
        this.say('Started capture session…')
        return
      }
      let message = `Could not start capture (${response.status}).`
      try {
        const err = await response.json() as { error?: string; message?: string; reason?: string }
        const detail = err.error ?? err.message ?? err.reason
        if (detail) message = detail
      } catch { /* ignore non-JSON body */ }
      this.say(message)
    } catch (error: unknown) {
      this.say(error instanceof Error ? error.message : String(error))
    }
  }

  private openCard(card: KanbanCard): void {
    const fiber = { uid: card.uid ?? card.id, host: card.originId }
    const name = slug(card)
    if (!this.opts.route.inRex) {
      this.opts.navigate(threadHref(window.location.href, fiber))
      return
    }
    go(this.opts.base, fiber).then(
      answer => {
        if (!answer.went) {
          this.say(answer.place === 'live' || answer.place === 'view' ? `Rex could not show ${name}.` : `${name} is not running.`)
        }
      },
      (error: unknown) => this.say(error instanceof Error ? error.message : String(error)),
    )
  }

  private say(text: string): void {
    if (this.disposed) return
    clearTimeout(this.saidTimer)
    this.said.textContent = text
    this.said.hidden = false
    this.saidTimer = window.setTimeout(() => { this.said.hidden = true }, 4_000)
  }

  private captureScroll(): { top: number; columns: Record<string, number> } {
    const columns: Record<string, number> = {}
    for (const col of this.deskEl.querySelectorAll<HTMLElement>('.kbn-col[data-column]')) {
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      if (list) columns[col.dataset.column!] = list.scrollTop
    }
    return { top: this.el.scrollTop, columns }
  }

  private restoreScroll(snapshot: { top: number; columns: Record<string, number> }): void {
    this.el.scrollTop = snapshot.top
    for (const col of this.deskEl.querySelectorAll<HTMLElement>('.kbn-col[data-column]')) {
      const list = col.querySelector<HTMLElement>('.kbn-col-list')
      const top = snapshot.columns[col.dataset.column!]
      if (list && top !== undefined) list.scrollTop = top
    }
  }
}
