import { bindAvoidKeyboard } from '@ui-sdk/core'
import { composeStream, fiberOf, runningIn, type Channel } from '../board/channels.js'
import { clockTime } from '../board/civilDay.js'
import type { MapFile } from '../board/family/model.js'
import { isAgentCard } from '../board/KanbanModalShared.js'
import type { KanbanCard } from '../board/KanbanTypes.js'
import { lastSaid } from '../board/said.js'
import { slug } from '../board/threadOutline.js'
import { fileBytesUrl } from '../board/utils.js'
import { ChannelStream } from '../board/views/ChannelStream.js'
import { Voice } from '../board/voice.js'
import { createWorkerStarter } from '../board/workerStart.js'
import { parseRoute } from '../board/workspace/boardRoute.js'
import { markSeen, unseenSince } from '../board/workspace/DocumentSeen.js'
import { docKey, fiberKey, isExternalHref, linkedFile, parseDocKey, type DocKey } from '../board/workspace/documents.js'
import { FamilyPage, type ViewFeeds } from '../board/workspace/FamilyPage.js'
import { Leads } from '../board/workspace/leads.js'
import { ListenControl } from '../board/workspace/ListenControl.js'
import { fetchTranscriptUsage, paintUsage, warmUntil, type TranscriptUsage } from '../board/workspace/transcriptUsage.js'
import { VoiceStrip, voiceLine } from '../board/workspace/voiceStrip.js'
import { WorkerActions, type StartWorker } from '../board/workspace/workerActions.js'
import '../board/workspace/dock.css'
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

/** Minimum cadence between transcript usage refreshes, matching the page feed. */
const USAGE_REFRESH_MS = 15_000

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const

const owned = (card: KanbanCard): { uid: string; host: string } => ({ uid: card.uid ?? card.id, host: card.originId })

const archived = (card: KanbanCard): boolean => card.column === 'tempered' || card.column === 'composted'

/**
 * One constitution, alone at its own address: the board's view of it
 * ({@link FamilyPage}) with no workspace around it. When the constitution is a
 * family root or has sub-threads, a mode bar toggles between its **Posts**
 * stream and **Tapestry / Files** (defaulting to Posts on a family root). Going
 * to another fiber moves Rex there when the page stands in a Rex pane
 * (`in=rex`), and otherwise opens that fiber's page in its place. Its lead
 * tapestry sits full-bleed in place with no fold chrome; a file shown full
 * opens in a window of its own. For any non-archived constitution, the board's
 * docked console footer sits flush at the bottom edge across both modes,
 * holding its context/cache warmth meter, Listen mic control and voice strip,
 * and {@link WorkerActions} (message box, Send/Resume, and New session). It
 * moves no history or swipe, and its head draws no lifecycle verbs.
 */
export class ThreadPage {
  readonly el = document.createElement('main')
  private readonly status = document.createElement('p')
  private readonly modes = document.createElement('div')
  private readonly postsBtn = document.createElement('button')
  private readonly filesBtn = document.createElement('button')
  private readonly postsPane = document.createElement('section')
  private readonly stream: ChannelStream
  private readonly dockBand = document.createElement('div')
  private readonly dock = document.createElement('div')
  private readonly dockBody = document.createElement('div')
  private readonly meter = document.createElement('span')
  private readonly contextFact = document.createElement('span')
  private readonly cacheFact = document.createElement('span')
  private readonly said = document.createElement('p')
  private readonly family: FamilyPage
  private readonly feed: PageFeed
  private readonly opts: ThreadPageOptions
  private readonly leads: Leads
  private readonly unsubscribe: () => void
  private readonly startWorker: StartWorker
  private workerActions: WorkerActions | null = null
  private voice: Voice | null = null
  private listen: ListenControl | null = null
  private voiceStrip: VoiceStrip | null = null
  private voiceUnsub: (() => void) | null = null
  private unbindKeyboard: (() => void) | null = null
  private mode: ThreadMode = 'files'
  private modeCardUid: string | null = null
  private usage: TranscriptUsage | null = null
  private usageSession: string | undefined
  private usageReadAt = -Infinity
  private usageTimer: number | undefined
  private disposed = false
  private saidTimer: number | undefined
  private lastInteraction = -Infinity
  private knownShowAt: number | null = null
  private readonly onInteract = (): void => { this.lastInteraction = Date.now() }

  constructor(feed: PageFeed, opts: ThreadPageOptions) {
    this.feed = feed
    this.opts = opts
    this.leads = new Leads(opts.base)
    this.startWorker = createWorkerStarter(opts.base, {
      onStarted: () => {
        if (this.mode === 'posts') {
          this.stream.following = true
          this.stream.toFoot()
        }
      },
      onError: message => this.say(message),
    })
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
    this.stream.el.classList.add('pg-posts-scroll')
    this.postsPane.append(this.stream.el)

    this.dockBand.className = 'ws-stage-band'
    this.dockBand.dataset.part = 'thread-dock'
    this.dockBand.hidden = true
    this.dock.className = 'ws-dock'
    this.dock.dataset.part = 'act'
    this.dock.dataset.act = 'band'
    this.dock.toggleAttribute('data-echoed', true)
    this.dockBody.className = 'ws-dock-body'
    this.meter.className = 'ws-band-meter'
    this.meter.dataset.part = 'context-meter'
    this.meter.hidden = true
    this.contextFact.dataset.part = 'context'
    this.contextFact.hidden = true
    this.cacheFact.className = 'ws-band-cache'
    this.cacheFact.dataset.part = 'cache'
    this.cacheFact.hidden = true
    this.meter.append(this.contextFact, this.cacheFact)
    this.dock.append(this.dockBody)
    this.dockBand.append(this.dock)

    this.said.className = 'pg-said'
    this.said.setAttribute('role', 'status')
    this.said.hidden = true
    this.family = new FamilyPage(this.feeds(), () => {})
    this.family.pulls = false
    this.family.unfoldLead = true
    this.family.pinLead = true
    this.el.append(this.status, this.modes, this.postsPane, this.family.el, this.dockBand, this.said)
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

      const showDock = isAgentCard(card) && !archived(card)
      this.dockBand.hidden = !showDock
      this.el.toggleAttribute('data-dock', showDock)
      if (showDock) {
        this.followUsage(card)
        this.paintDock(card)
      }
    } else {
      this.modes.hidden = true
      this.postsPane.hidden = true
      this.family.el.hidden = true
      this.dockBand.hidden = true
      this.el.removeAttribute('data-dock')
      this.status.textContent = this.feed.failure ?? (this.feed.loaded ? 'This thread is not on the board.' : 'Reading the board…')
    }
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.saidTimer)
    clearInterval(this.usageTimer)
    for (const event of INTERACTION_EVENTS) document.removeEventListener(event, this.onInteract, { capture: true })
    this.unsubscribe()
    this.stream.dispose()
    this.listen?.dispose()
    this.voiceUnsub?.()
    this.voice?.dispose()
    this.unbindKeyboard?.()
    this.workerActions?.dispose()
    this.family.dispose()
  }

  private setMode(mode: ThreadMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.render()
  }

  private followUsage(card: KanbanCard): void {
    const session = card.sessionUuid
    if (session !== this.usageSession) {
      this.usageSession = session
      this.usage = null
      this.usageReadAt = -Infinity
    }
    if (!session) return
    if (Date.now() - this.usageReadAt < USAGE_REFRESH_MS) return
    this.usageReadAt = Date.now()
    void this.readUsage(card, session)
  }

  private async readUsage(card: KanbanCard, session: string): Promise<void> {
    const usage = await fetchTranscriptUsage(this.opts.base, session, card.shuttleHost)
    if (this.disposed || this.usageSession !== session) return
    this.usage = usage ?? this.usage
    const current = this.feed.card()
    if (current && isAgentCard(current) && !archived(current)) this.paintDock(current)
  }

  private paintDock(card: KanbanCard): void {
    this.dock.dataset.column = card.column
    paintUsage(this.contextFact, this.cacheFact, this.usage, card.workerAgent ?? card.shuttleAgent)
    this.meter.hidden = this.contextFact.hidden && this.cacheFact.hidden
    const warm = warmUntil(this.usage)
    const note = warm !== undefined ? `cache warm until ${clockTime(warm)}` : ''
    if (warm !== undefined && this.usageTimer === undefined) {
      this.usageTimer = window.setInterval(() => {
        const current = this.feed.card()
        if (this.disposed || !current || !isAgentCard(current) || archived(current)) {
          clearInterval(this.usageTimer)
          this.usageTimer = undefined
          return
        }
        paintUsage(this.contextFact, this.cacheFact, this.usage, current.workerAgent ?? current.shuttleAgent)
        this.meter.hidden = this.contextFact.hidden && this.cacheFact.hidden
        if (warmUntil(this.usage) === undefined) {
          clearInterval(this.usageTimer)
          this.usageTimer = undefined
        }
      }, USAGE_REFRESH_MS)
    }
    if (!this.workerActions) {
      this.workerActions = new WorkerActions(card, this.startWorker, { prompt: true })
      this.voice = new Voice(this.opts.base)
      this.voice.mount()
      this.listen = new ListenControl({
        card: () => this.feed.card() ?? card,
        voice: this.voice,
        shuttleBase: this.opts.base,
        fiberSlug: (fiber, origin) => this.fiberSlug(fiber, origin),
      })
      this.voiceStrip = new VoiceStrip()
      this.voiceUnsub = this.voice.subscribe(() => this.paintVoice())
      this.workerActions.seat(this.listen.el, this.voiceStrip.el)
      this.workerActions.seatPlaceholder(this.meter)
      this.dockBody.append(this.workerActions.el)
      this.unbindKeyboard = bindAvoidKeyboard(this.dock)
    }
    this.paintVoice(card)
    this.workerActions.update(card, note)
  }

  private fiberSlug(fiber: string, origin?: string | null): string | undefined {
    const cards = this.feed.cards.filter(card => card.id === fiber || card.uid === fiber)
    const match = cards.find(card => card.originId === origin) ?? cards[0]
    return match && slug(match)
  }

  private paintVoice(card?: KanbanCard): void {
    const status = this.voice?.status ?? null
    const spoken = status?.destination ?? status?.target
    const typed = card ?? this.feed.card()
    const here = !!spoken && !!typed && (spoken.fiber_id === typed.uid || spoken.fiber_id === typed.id) && (spoken.origin ?? null) === (typed.originId ?? null)
    this.voiceStrip?.paint(voiceLine(status, (fiber, origin) => this.fiberSlug(fiber, origin)), here)
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
