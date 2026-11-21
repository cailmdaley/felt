import { composeStream, fiberOf, runningIn, type Channel } from '../board/channels.js'
import type { MapFile } from '../board/family/model.js'
import { HumanMessageIds } from '../board/humanMessageId.js'
import { isAgentCard } from '../board/KanbanModalShared.js'
import { hasLiveWorker, type KanbanCard } from '../board/KanbanTypes.js'
import { lastSaid } from '../board/said.js'
import { slug } from '../board/threadOutline.js'
import { fileBytesUrl } from '../board/utils.js'
import { ChannelStream } from '../board/views/ChannelStream.js'
import { createWorkerStarter, dispatchWorkerStart } from '../board/workerStart.js'
import { parseRoute } from '../board/workspace/boardRoute.js'
import { markSeen, unseenSince } from '../board/workspace/DocumentSeen.js'
import { docKey, fiberKey, isExternalHref, linkedFile, parseDocKey, type DocKey } from '../board/workspace/documents.js'
import { FamilyPage, type ViewFeeds } from '../board/workspace/FamilyPage.js'
import { Leads } from '../board/workspace/leads.js'
import { WorkerActions, type StartWorker } from '../board/workspace/workerActions.js'
import type { PageFeed } from './feed.js'
import { go } from './go.js'
import { threadHref, type PageRoute } from './route.js'

export interface ThreadPageOptions {
  base: string
  route: PageRoute
  /** Opens another page in this one: a browser tab's navigation. */
  navigate(href: string): void
}

export type ThreadMode = 'posts' | 'files'

/** How long the page must be untouched before a new `show` file auto-advances. */
export const AUTO_ADVANCE_IDLE_MS = 60_000

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const

const owned = (card: KanbanCard): { uid: string; host: string } => ({ uid: card.uid ?? card.id, host: card.originId })

const archived = (card: KanbanCard): boolean => card.column === 'tempered' || card.column === 'composted'

const quietStartable = (card: KanbanCard): boolean =>
  isAgentCard(card) && !hasLiveWorker(card) && !archived(card)

/**
 * One constitution, alone at its own address: the board's view of it
 * ({@link FamilyPage}) with no workspace around it. When the constitution is a
 * family root or has sub-threads, a mode bar toggles between its **Posts**
 * stream (with a compact composer to its worker/chair) and **Tapestry / Files**
 * (defaulting to Posts on a family root). Going to another fiber moves Rex
 * there when the page stands in a Rex pane (`in=rex`), and otherwise opens
 * that fiber's page in its place. Its tapestry unfolds at full height in
 * place; a file shown full opens in a window of its own. When the thread has no
 * live worker (and is not tempered or discarded), a strip at the foot offers
 * Resume and New session. It moves no history, voice or swipe, and its head
 * draws no lifecycle verbs.
 */
export class ThreadPage {
  readonly el = document.createElement('main')
  private readonly status = document.createElement('p')
  private readonly modes = document.createElement('div')
  private readonly postsBtn = document.createElement('button')
  private readonly filesBtn = document.createElement('button')
  private readonly postsPane = document.createElement('section')
  private readonly stream: ChannelStream
  private readonly composer = document.createElement('form')
  private readonly composerInput = document.createElement('textarea')
  private readonly composerSend = document.createElement('button')
  private readonly strip = document.createElement('div')
  private readonly said = document.createElement('p')
  private readonly family: FamilyPage
  private readonly feed: PageFeed
  private readonly opts: ThreadPageOptions
  private readonly leads: Leads
  private readonly unsubscribe: () => void
  private readonly startWorker: StartWorker
  private readonly messageIds = new HumanMessageIds()
  private workerActions: WorkerActions | null = null
  private mode: ThreadMode = 'files'
  private modeCardUid: string | null = null
  private sending = false
  private saidTimer: number | undefined
  private lastInteraction = -Infinity
  private knownShowAt: number | null = null
  private readonly onInteract = (): void => { this.lastInteraction = Date.now() }

  constructor(feed: PageFeed, opts: ThreadPageOptions) {
    this.feed = feed
    this.opts = opts
    this.leads = new Leads(opts.base)
    this.startWorker = createWorkerStarter(opts.base, { onError: message => this.say(message) })
    this.el.className = 'pg-thread'
    this.status.className = 'pg-status'

    this.modes.className = 'pg-modes'
    this.modes.setAttribute('role', 'tablist')
    this.modes.setAttribute('aria-label', 'Thread view')
    this.modes.hidden = true
    this.postsBtn.type = 'button'
    this.postsBtn.className = 'pg-mode-pill'
    this.postsBtn.dataset.mode = 'posts'
    this.postsBtn.setAttribute('role', 'tab')
    this.postsBtn.textContent = 'Posts'
    this.postsBtn.addEventListener('click', () => this.setMode('posts'))
    this.filesBtn.type = 'button'
    this.filesBtn.className = 'pg-mode-pill'
    this.filesBtn.dataset.mode = 'files'
    this.filesBtn.setAttribute('role', 'tab')
    this.filesBtn.textContent = 'Tapestry / Files'
    this.filesBtn.addEventListener('click', () => this.setMode('files'))
    this.modes.append(this.postsBtn, this.filesBtn)

    this.postsPane.className = 'pg-posts'
    this.postsPane.hidden = true
    this.stream = new ChannelStream({
      shuttleBase: opts.base,
      awake: () => !this.postsPane.hidden,
      openCard: card => this.goTo(owned(card), slug(card)),
      openFile: (_from, _card, key) => {
        const file = parseDocKey(key)
        if (file) window.open(fileBytesUrl(this.opts.base, file.path, file.owner), '_blank', 'noopener')
      },
      lead: card => this.leads.of(card),
      said: card => { const root = feed.index.rootOf(card); return lastSaid(card, feed.index, feed.board.records([root.uid ?? root.id])) },
      onRedraw: () => this.render(),
    })

    this.composer.className = 'pg-composer'
    this.composer.hidden = true
    this.composerInput.className = 'pg-composer-input'
    this.composerInput.rows = 1
    this.composerInput.setAttribute('aria-label', 'Message family worker')
    this.composerInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void this.submitComposer()
      }
    })
    this.composerSend.type = 'submit'
    this.composerSend.className = 'pg-composer-send'
    this.composerSend.textContent = 'Send'
    this.composer.addEventListener('submit', event => {
      event.preventDefault()
      void this.submitComposer()
    })
    this.composer.append(this.composerInput, this.composerSend)
    this.postsPane.append(this.stream.el, this.composer)

    this.strip.className = 'pg-worker-strip'
    this.strip.hidden = true
    this.said.className = 'pg-said'
    this.said.setAttribute('role', 'status')
    this.said.hidden = true
    this.family = new FamilyPage(this.feeds(), () => {})
    this.family.pulls = false
    this.family.unfoldLead = true
    this.el.append(this.status, this.modes, this.postsPane, this.family.el, this.strip, this.said)
    for (const event of INTERACTION_EVENTS) document.addEventListener(event, this.onInteract, { capture: true, passive: true })
    this.unsubscribe = feed.subscribe(() => this.render())
    this.render()
  }

  render(): void {
    const card = this.feed.card()
    this.status.hidden = !!card
    if (card) {
      const uid = fiberOf(card)
      const isRoot = !this.feed.index.parentOf(card)
      const hasSubtree = this.feed.index.children(card).length > 0
      const hasPostsMode = !archived(card) && (isRoot || hasSubtree)
      if (this.modeCardUid !== uid) {
        this.modeCardUid = uid
        this.mode = hasPostsMode && isRoot ? 'posts' : 'files'
        this.stream.reset()
      }
      if (!hasPostsMode) this.mode = 'files'

      this.modes.hidden = !hasPostsMode
      this.postsBtn.setAttribute('aria-selected', String(this.mode === 'posts'))
      this.filesBtn.setAttribute('aria-selected', String(this.mode === 'files'))
      this.postsBtn.toggleAttribute('data-active', this.mode === 'posts')
      this.filesBtn.toggleAttribute('data-active', this.mode === 'files')

      this.family.update(card, this.feed.index)
      document.title = card.name
      this.checkAutoAdvance(card)

      const showPosts = hasPostsMode && this.mode === 'posts'
      this.postsPane.hidden = !showPosts
      this.family.el.hidden = showPosts
      if (showPosts) {
        this.renderPosts(card)
      }

      const showStrip = quietStartable(card) && !(showPosts && !this.composer.hidden)
      this.strip.hidden = !showStrip
      if (showStrip) {
        if (!this.workerActions) {
          this.workerActions = new WorkerActions(card, this.startWorker)
          this.strip.append(this.workerActions.el)
        } else {
          this.workerActions.update(card)
        }
      }
    } else {
      this.modes.hidden = true
      this.postsPane.hidden = true
      this.family.el.hidden = true
      this.strip.hidden = true
      this.status.textContent = this.feed.failure ?? (this.feed.loaded ? 'This thread is not on the board.' : 'Reading the board…')
    }
  }

  dispose(): void {
    clearTimeout(this.saidTimer)
    for (const event of INTERACTION_EVENTS) document.removeEventListener(event, this.onInteract, { capture: true })
    this.unsubscribe()
    this.stream.dispose()
    this.workerActions?.dispose()
    this.family.dispose()
  }

  private setMode(mode: ThreadMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.render()
  }

  private renderPosts(card: KanbanCard): void {
    const index = this.feed.index
    const everyone = [card, ...index.subtree(card)].filter(each => !archived(each))
    const root = index.rootOf(card)
    const familyUid = fiberOf(root)
    const now = Date.now()
    const waits = this.feed.board.waiting
    const records = this.feed.board.records([familyUid])
    const scope: Channel = {
      key: `family:${fiberOf(card)}`,
      name: slug(card),
      title: card.name,
      misc: false,
      seat: card,
      spelling: '',
      declarers: [],
      members: everyone,
      heads: [card],
      everyone,
      families: [familyUid],
      newest: 0,
      waiting: false,
      active: 0,
      pinned: false,
      hidden: 0,
      listed: true,
    }
    const whole = composeStream({
      channel: scope,
      records,
      files: this.feed.sends.files,
      waits,
      launches: () => [],
      cleared: new Map(),
      now,
      reachMs: this.feed.board.reachMs,
    })
    const parentOf = (each: KanbanCard): KanbanCard | undefined => {
      const parent = index.parentOf(each)
      return parent && fiberOf(parent) !== fiberOf(card) ? parent : undefined
    }
    this.stream.render({
      key: scope.key,
      label: slug(card),
      whole,
      everyone,
      running: runningIn(scope),
      waits,
      records,
      launches: () => [],
      parentOf,
      failed: this.feed.board.failed(familyUid),
      now,
    })
    const canCompose = isAgentCard(card) && !archived(card)
    this.composer.hidden = !canCompose
    if (canCompose) this.composerInput.placeholder = `Message ${slug(card)}…`
  }

  private async submitComposer(): Promise<void> {
    if (this.sending) return
    const card = this.feed.card()
    const message = this.composerInput.value.trim()
    if (!card || !message) return
    this.sending = true
    this.composerSend.disabled = true
    this.composerSend.textContent = 'Sending…'
    try {
      const result = await dispatchWorkerStart(this.opts.base, this.messageIds, card, 'continue', { message })
      if (result.ok) {
        this.composerInput.value = ''
        this.stream.following = true
        this.stream.toFoot()
      } else if (result.error) {
        this.say(result.error)
      }
    } finally {
      this.sending = false
      this.composerSend.disabled = false
      this.composerSend.textContent = 'Send'
    }
  }

  private checkAutoAdvance(card: KanbanCard): void {
    if (!this.feed.sends.loaded) return
    const shown = this.feed.sends.sends(card).filter(send => send.show)
    if (this.knownShowAt === null) {
      this.knownShowAt = shown.reduce((max, send) => Math.max(max, send.timestamp), 0)
      return
    }
    const fresh = shown.find(send => send.timestamp > this.knownShowAt!)
    if (!fresh) return
    this.knownShowAt = fresh.timestamp
    if (Date.now() - this.lastInteraction >= AUTO_ADVANCE_IDLE_MS) this.family.unfoldFile(fresh.key)
  }

  private feeds(): ViewFeeds {
    const feed = this.feed
    return {
      shuttleBase: this.opts.base,
      marks: () => undefined,
      reach: () => feed.board.reachMs,
      files: card => feed.sends.sends(card).map(send => ({ key: send.key, name: send.basename, at: send.timestamp, unread: unseenSince(send.key, send.timestamp), caption: send.caption, ...send.show ? { show: true } : {} })),
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
      answer => { if (!answer.went) this.say(answer.place === 'live' || answer.place === 'view' ? `Rex could not show ${name}.` : `${name} is not running.`) },
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
