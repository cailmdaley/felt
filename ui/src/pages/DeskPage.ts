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

/**
 * The Desk, alone at its own address (`/desk`): three columns (Waiting on you,
 * Working, Awaiting review) over a shelf of three (Drafts, Resting, Roles &
 * standing), with no depth, workspace, tabs, voice or Rex following. Clicking
 * a card or waiting line calls `POST /api/v1/go` when `in=rex`, and otherwise
 * navigates to that fiber's `/thread` page. Tempered and discarded fibers are
 * omitted by the feed.
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

    this.el.append(this.status, this.deskEl, this.said)
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
    this.stopMobileWatch()
    this.unsubscribe()
    this.keyboard.dispose()
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    const intent = keyIntent(event, 'desk')
    if (intent && this.keyboard.handle(intent)) event.preventDefault()
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
