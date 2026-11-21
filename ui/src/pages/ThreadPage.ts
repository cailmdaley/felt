import type { MapFile } from '../board/family/model.js'
import type { KanbanCard } from '../board/KanbanTypes.js'
import { lastSaid } from '../board/said.js'
import { slug } from '../board/threadOutline.js'
import { fileBytesUrl } from '../board/utils.js'
import { parseRoute } from '../board/workspace/boardRoute.js'
import { markSeen, unseenSince } from '../board/workspace/DocumentSeen.js'
import { docKey, fiberKey, isExternalHref, linkedFile, parseDocKey, type DocKey } from '../board/workspace/documents.js'
import { FamilyPage, type ViewFeeds } from '../board/workspace/FamilyPage.js'
import { Leads } from '../board/workspace/leads.js'
import type { PageFeed } from './feed.js'
import { go } from './go.js'
import { threadHref, type PageRoute } from './route.js'

export interface ThreadPageOptions {
  base: string
  route: PageRoute
  /** Opens another page in this one: a browser tab's navigation. */
  navigate(href: string): void
}

const owned = (card: KanbanCard): { uid: string; host: string } => ({ uid: card.uid ?? card.id, host: card.originId })

/**
 * One constitution, alone at its own address: the board's view of it
 * ({@link FamilyPage}) with no workspace around it. Going to another fiber
 * moves Rex there when the page stands in a Rex pane (`in=rex`), and otherwise
 * opens that fiber's page in its place. Its tapestry unfolds at full height in
 * place; a file shown full opens in a window of its own. It moves no history,
 * voice or swipe, and its head draws no lifecycle verbs.
 */
export class ThreadPage {
  readonly el = document.createElement('main')
  private readonly status = document.createElement('p')
  private readonly said = document.createElement('p')
  private readonly family: FamilyPage
  private readonly feed: PageFeed
  private readonly opts: ThreadPageOptions
  private readonly leads: Leads
  private saidTimer: number | undefined

  constructor(feed: PageFeed, opts: ThreadPageOptions) {
    this.feed = feed
    this.opts = opts
    this.leads = new Leads(opts.base)
    this.el.className = 'pg-thread'
    this.status.className = 'pg-status'
    this.said.className = 'pg-said'
    this.said.setAttribute('role', 'status')
    this.said.hidden = true
    this.family = new FamilyPage(this.feeds(), () => {})
    this.family.pulls = false
    this.family.unfoldLead = true
    this.el.append(this.status, this.family.el, this.said)
    feed.subscribe(() => this.render())
    this.render()
  }

  render(): void {
    const card = this.feed.card()
    this.family.el.hidden = !card
    this.status.hidden = !!card
    if (card) {
      this.family.update(card, this.feed.index)
      document.title = card.name
    } else this.status.textContent = this.feed.failure ?? (this.feed.loaded ? 'This thread is not on the board.' : 'Reading the board…')
  }

  private feeds(): ViewFeeds {
    const feed = this.feed
    return {
      shuttleBase: this.opts.base,
      marks: () => undefined,
      reach: () => feed.board.reachMs,
      files: card => feed.sends.sends(card).map(send => ({ key: send.key, name: send.basename, at: send.timestamp, unread: unseenSince(send.key, send.timestamp), caption: send.caption })),
      lead: card => this.leads.of(card),
      refresh: () => { void feed.sends.refresh() },
      said: card => { const root = feed.index.rootOf(card); return lastSaid(card, feed.index, feed.board.records([root.uid ?? root.id])) },
      waits: () => feed.board.waiting,
      seen: file => markSeen([file]),
      view: card => this.goTo(owned(card), slug(card)),
      link: (_card, source, href) => this.link(source, href),
      page: (card, doc) => this.constitution(card, doc),
      open: (_card, doc) => {
        const file = parseDocKey(doc)
        if (file) window.open(fileBytesUrl(this.opts.base, file.path, file.owner), '_blank', 'noopener')
      },
      edits: false,
    }
  }

  /** Its constitution, a file the view unfolds like its others. */
  private constitution(card: KanbanCard, doc: DocKey): MapFile | undefined {
    if (doc !== fiberKey(card.originId, card.uid ?? card.id) || !card.fiberDir || !card.path) return undefined
    const key = docKey(card.originId, `${card.fiberDir}/${card.path.split('/').at(-1)}`, card.originId), at = Date.parse(card.modifiedAt ?? '') || 0
    return { key, name: 'Constitution', at, unread: at > 0 && unseenSince(key, at) }
  }

  /** In Rex, Rex moves to the fiber's live worker, and says why when it cannot; in a browser, its page opens here. */
  private goTo(fiber: { uid: string; host: string }, name = fiber.uid): void {
    if (!this.opts.route.inRex) { this.opts.navigate(threadHref(window.location.href, fiber)); return }
    go(this.opts.base, fiber).then(
      answer => { if (!answer.went) this.say(answer.place === 'live' ? `Rex could not show ${name}.` : `${name} is not running.`) },
      (error: unknown) => this.say(error instanceof Error ? error.message : String(error)),
    )
  }

  /** A passing word at the foot of the page, over it: what `go` could not do. */
  private say(text: string): void {
    clearTimeout(this.saidTimer)
    this.said.textContent = text
    this.said.hidden = false
    this.saidTimer = window.setTimeout(() => { this.said.hidden = true }, 4_000)
  }

  /** A link followed in one of its files: a board address goes to that fiber; anything else opens in a window of its own. */
  private link(source: DocKey, href: string): void {
    const route = parseRoute(href)
    if (route?.kind === 'channel') { this.goTo({ uid: route.uid, host: route.owner }); return }
    if (route || href.startsWith('#')) return
    const from = parseDocKey(source)
    const file = from && linkedFile(from, href, window.location.href)
    if (file) window.open(fileBytesUrl(this.opts.base, file.path, file.owner) + file.hash, '_blank', 'noopener')
    else if (isExternalHref(href)) window.open(href, '_blank', 'noopener')
  }
}
