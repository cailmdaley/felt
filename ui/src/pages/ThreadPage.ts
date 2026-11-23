import { bindAvoidKeyboard } from '@ui-sdk/core'
import { clearLineKey, clearedLines, composeStream, fiberOf, lineIds, runningIn, type Channel, type Item } from '../board/channels.js'
import { clockTime } from '../board/civilDay.js'
import { attachConversationPicker } from '../board/conversationMenu.js'
import { conversationDestinations, conversationDevice, conversationOpening, linkDestination, openDestination, resolveDestination, type ConversationDestination, type WorkerOpener } from '../board/conversationOpening.js'
import { getDaemonJson, postDaemonJson } from '../board/daemonApi.js'
import type { MapFile } from '../board/family/model.js'
import { buildFileViewer, disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../board/FileViewerPanel.js'
import { HumanMessageIds, repeatNotice } from '../board/humanMessageId.js'
import { dispatchFailureMessage, isAgentCard, postForceDispatch, type DispatchFailureBody } from '../board/KanbanModalShared.js'
import { hasLiveWorker, type KanbanCard } from '../board/KanbanTypes.js'
import { lastSaid } from '../board/said.js'
import { attachConversation, workerOpener } from '../board/sessionHistory.js'
import { slug } from '../board/threadOutline.js'
import { basename, fileBytesUrl } from '../board/utils.js'
import { ChannelStream, withdraws } from '../board/views/ChannelStream.js'
import { Voice } from '../board/voice.js'
import { createWorkerStarter } from '../board/workerStart.js'
import { parseRoute } from '../board/workspace/boardRoute.js'
import { changeReviewTarget } from '../board/workspace/changeReviewTarget.js'
import { markSeen, unseenSince } from '../board/workspace/DocumentSeen.js'
import { changeKey, docKey, fiberKey, isExternalHref, linkedFile, parseDocKey, type DocKey } from '../board/workspace/documents.js'
import type { FiberActs } from '../board/workspace/Dock.js'
import { FamilyPage, type ViewFeeds } from '../board/workspace/FamilyPage.js'
import { headerIcon } from '../board/workspace/headerIcon.js'
import { Leads } from '../board/workspace/leads.js'
import { ListenControl } from '../board/workspace/ListenControl.js'
import { fetchTranscriptUsage, paintUsage, warmUntil, type TranscriptUsage } from '../board/workspace/transcriptUsage.js'
import { VoiceStrip, voiceLine } from '../board/workspace/voiceStrip.js'
import { WorkerActions, type StartWorker } from '../board/workspace/workerActions.js'
import '../board/workspace/dock.css'
import type { PageFeed } from './feed.js'
import { go } from './go.js'
import { threadHref, type PageRoute } from './route.js'
import { ThreadSettings } from './ThreadSettings.js'

export interface ThreadPageOptions {
  base: string
  route: PageRoute
  /** Opens another page in this one: a browser tab's navigation. */
  navigate(href: string): void
}

export type ThreadMode = 'posts' | 'files' | 'changes'

/** How long the page must be untouched before a new `show` file auto-advances. */
export const AUTO_ADVANCE_IDLE_MS = 60_000

/** Minimum cadence between transcript usage refreshes, matching the page feed. */
const USAGE_REFRESH_MS = 15_000

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll'] as const

const owned = (card: KanbanCard): { uid: string; host: string } => ({ uid: card.uid ?? card.id, host: card.originId })

const archived = (card: KanbanCard): boolean => card.column === 'tempered' || card.column === 'composted'

const isChangeFile = (path: string): boolean => /\.change\.json$/i.test(path)

const canBakeChanges = (card: KanbanCard): boolean => Boolean(card.shuttleProjectDir || card.shuttleChangePRs?.length)

const fiberPath = (card: KanbanCard): string => {
  if (card.fiberDir) return `${card.fiberDir}/${card.path.endsWith('.md') ? card.path.split('/').at(-1) : `${card.id.split('/').at(-1)}.md`}`
  return card.path.startsWith('/') ? card.path : `${card.feltStore ?? ''}/${card.path}`
}

/** Opens a file in a 3/4-screen floating window (RexWeb Popup on Mac, normal window/tab in browsers). */
const openFloating = (url: string): void => {
  const availW = typeof window.screen?.availWidth === 'number' && window.screen.availWidth > 0 ? window.screen.availWidth : 1440
  const availH = typeof window.screen?.availHeight === 'number' && window.screen.availHeight > 0 ? window.screen.availHeight : 900
  const w = Math.max(640, Math.round(availW * 0.75))
  const h = Math.max(480, Math.round(availH * 0.75))
  window.open(url, '_blank', `width=${w},height=${h}`)
}

/**
 * One constitution, alone at its own address: the board's view of it
 * ({@link FamilyPage}) with no workspace around it. When the constitution is a
 * family root or has sub-threads, a mode bar toggles between its **Posts**
 * stream and **Tapestry / Files** (defaulting to Posts on a family root). Going
 * to another fiber moves Rex there when the page stands in a Rex pane
 * (`in=rex`), and otherwise opens that fiber's page in its place. Its lead
 * tapestry sits full-bleed in place with no fold chrome; a file shown full
 * opens in a window of its own. For any constitution, the board's
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
  private readonly changesBtn = document.createElement('button')
  private readonly postsPane = document.createElement('section')
  private readonly changesPane = document.createElement('section')
  private readonly changesBar = document.createElement('div')
  private readonly changesBack = document.createElement('button')
  private readonly changesName = document.createElement('span')
  private readonly changesSlot = document.createElement('div')
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
  private readonly openWorker: WorkerOpener
  private readonly reviewMessageIds = new HumanMessageIds()
  private workerActions: WorkerActions | null = null
  private voice: Voice | null = null
  private listen: ListenControl | null = null
  private voiceStrip: VoiceStrip | null = null
  private voiceUnsub: (() => void) | null = null
  private settings: ThreadSettings | null = null
  private unbindKeyboard: (() => void) | null = null
  private mode: ThreadMode = 'files'
  private modeCardUid: string | null = null
  private selectedChangeFile: { path: string; owner: string } | null = null
  private changesViewer: HTMLElement | null = null
  private changesKey: string | null = null
  private usage: TranscriptUsage | null = null
  private usageSession: string | undefined
  private usageReadAt = -Infinity
  private usageTimer: number | undefined
  private dismissed: string[] = []
  private pendingDismiss: string[] = []
  private dismissedReadAt = -Infinity
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
    this.openWorker = workerOpener(opts.base, message => this.say(message))
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
    this.changesBtn.type = 'button'
    this.changesBtn.className = 'pg-mode-pill'
    this.changesBtn.dataset.mode = 'changes'
    this.changesBtn.setAttribute('role', 'tab')
    this.changesBtn.textContent = 'Changes'
    this.changesBtn.addEventListener('click', () => this.openChangesTab())
    this.modes.append(this.postsBtn, this.filesBtn, this.changesBtn)

    this.postsPane.className = 'pg-posts'
    this.postsPane.hidden = true
    this.changesPane.className = 'pg-changes'
    this.changesPane.hidden = true
    this.changesBar.className = 'pg-changes-bar'
    this.changesBar.hidden = true
    this.changesBack.type = 'button'
    this.changesBack.className = 'pg-changes-back'
    this.changesBack.addEventListener('click', () => {
      const card = this.feed.card()
      this.selectedChangeFile = null
      if (!card || !canBakeChanges(card)) this.mode = 'files'
      this.render()
    })
    this.changesName.className = 'pg-changes-name'
    this.changesBar.append(this.changesBack, this.changesName)
    this.changesSlot.className = 'pg-changes-slot'
    this.changesPane.append(this.changesBar, this.changesSlot)
    this.stream = new ChannelStream({
      shuttleBase: opts.base,
      awake: () => !this.postsPane.hidden,
      openCard: card => this.goTo(owned(card), slug(card)),
      openFile: (_from, _card, key) => {
        const file = parseDocKey(key)
        if (!file) return
        if (isChangeFile(file.path)) { this.openChangeFile(file); return }
        openFloating(fileBytesUrl(this.opts.base, file.path, file.owner))
      },
      lead: card => this.leads.of(card),
      said: card => { const root = feed.index.rootOf(card); return lastSaid(card, feed.index, feed.board.records([root.uid ?? root.id])) },
      clearLine: item => { void this.clearLine(item) },
      inPlace: true,
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
    this.family = new FamilyPage(this.feeds(), () => {}, target => this.buildConsole(target))
    this.family.pulls = false
    this.family.unfoldLead = true
    this.family.pinLead = true
    this.el.append(this.status, this.modes, this.postsPane, this.family.el, this.changesPane, this.dockBand, this.said)
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
      const hasPostsMode = !archived(card) && isRoot
      if (this.modeCardUid !== uid) {
        this.modeCardUid = uid
        this.selectedChangeFile = null
        this.disposeChanges()
        this.mode = hasPostsMode ? 'posts' : 'files'
        this.stream.reset()
      }
      const hasChangeFile = this.feed.sends.sends(card).some(send => isChangeFile(send.fullPath))
      const hasChangesMode = canBakeChanges(card) || hasChangeFile || this.selectedChangeFile !== null
      if (this.mode === 'posts' && !hasPostsMode) this.mode = 'files'
      if (this.mode === 'changes' && !hasChangesMode) this.mode = hasPostsMode ? 'posts' : 'files'

      this.postsBtn.hidden = !hasPostsMode
      this.changesBtn.hidden = !hasChangesMode
      this.modes.hidden = !hasPostsMode && !hasChangesMode
      this.postsBtn.setAttribute('aria-selected', String(this.mode === 'posts'))
      this.filesBtn.setAttribute('aria-selected', String(this.mode === 'files'))
      this.changesBtn.setAttribute('aria-selected', String(this.mode === 'changes'))
      this.postsBtn.toggleAttribute('data-active', this.mode === 'posts')
      this.filesBtn.toggleAttribute('data-active', this.mode === 'files')
      this.changesBtn.toggleAttribute('data-active', this.mode === 'changes')

      this.family.update(card, this.feed.index)
      document.title = card.name
      this.checkAutoAdvance(card)

      const showPosts = hasPostsMode && this.mode === 'posts'
      const showChanges = hasChangesMode && this.mode === 'changes'
      this.postsPane.hidden = !showPosts
      this.family.el.hidden = showPosts || showChanges
      this.changesPane.hidden = !showChanges
      if (showPosts) {
        this.renderPosts(card)
      }
      if (showChanges) {
        this.renderChanges(card)
      } else {
        suspendFileViewer(this.changesViewer)
      }

      const showDock = isAgentCard(card)
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
      this.changesPane.hidden = true
      this.disposeChanges()
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
    this.disposeChanges()
    this.stream.dispose()
    this.listen?.dispose()
    this.voiceUnsub?.()
    this.voice?.dispose()
    this.settings?.dispose()
    this.unbindKeyboard?.()
    this.workerActions?.dispose()
    this.family.dispose()
  }

  private setMode(mode: ThreadMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.render()
  }

  private openChangesTab(): void {
    const card = this.feed.card()
    if (this.selectedChangeFile && card && canBakeChanges(card)) {
      this.selectedChangeFile = null
      this.mode = 'changes'
      this.render()
      return
    }
    this.setMode('changes')
  }

  private openChangeFile(file: { path: string; owner: string }): void {
    this.selectedChangeFile = { path: file.path, owner: file.owner }
    this.mode = 'changes'
    this.render()
  }

  private renderChanges(card: KanbanCard): void {
    const bakeable = canBakeChanges(card)
    const sentChange = !this.selectedChangeFile && !bakeable
      ? this.feed.sends.sends(card).find(send => isChangeFile(send.fullPath))
      : undefined
    const targetFile = this.selectedChangeFile ?? (sentChange ? parseDocKey(sentChange.key) : null)

    if (this.selectedChangeFile) {
      this.changesBar.hidden = false
      this.changesBack.textContent = bakeable ? '← All changes' : '← Tapestry / Files'
      this.changesName.textContent = basename(this.selectedChangeFile.path)
      this.changesName.title = this.selectedChangeFile.path
    } else {
      this.changesBar.hidden = true
    }

    const resolveReviewCard = (): KanbanCard | undefined => {
      if (targetFile) {
        const matched = changeReviewTarget(targetFile, this.feed.cards)
        if (matched) return matched.card
      }
      return this.feed.card()
    }
    const reviewOpts = {
      canReview: () => {
        const target = resolveReviewCard()
        return !!target && hasLiveWorker(target)
      },
      reviewTarget: () => {
        const target = resolveReviewCard()
        return target ? `${target.id} on ${target.originId}` : 'this fiber'
      },
      onReview: async (message: string) => {
        const target = resolveReviewCard()
        if (!target) throw new Error('The fiber holding this bundle is no longer available. Your draft is saved.')
        await this.sendReview(target, message)
      },
    }

    if (targetFile) {
      const key = `file:${targetFile.owner}:${targetFile.path}`
      if (this.changesKey === key && this.changesViewer) {
        resumeFileViewer(this.changesViewer)
        return
      }
      this.disposeChanges()
      this.changesKey = key
      this.changesViewer = buildFileViewer(this.opts.base, targetFile.path, targetFile.owner, undefined, undefined, {
        kind: 'change',
        active: true,
        ...reviewOpts,
      })
      this.changesSlot.replaceChildren(this.changesViewer)
      return
    }

    if (!bakeable) {
      this.disposeChanges()
      return
    }
    const uid = card.uid ?? card.id
    const prs = card.shuttleChangePRs ?? []
    const key = `bake:${card.originId}:${uid}:${prs.join(',')}`
    if (this.changesKey === key && this.changesViewer) {
      resumeFileViewer(this.changesViewer)
      return
    }
    this.disposeChanges()
    this.changesKey = key
    this.changesViewer = buildFileViewer(this.opts.base, fiberPath(card), card.originId, undefined, undefined, {
      bake: { uid, prs },
      active: true,
      ...reviewOpts,
    })
    this.changesSlot.replaceChildren(this.changesViewer)
  }

  private disposeChanges(): void {
    disposeFileViewer(this.changesViewer)
    this.changesViewer = null
    this.changesKey = null
    this.changesSlot.replaceChildren()
  }

  private async sendReview(card: KanbanCard, message: string): Promise<void> {
    if (!hasLiveWorker(card)) throw new Error('No live worker. Start or resume one before sending a review.')
    let res: Response
    try {
      res = await postForceDispatch(this.opts.base, card, {
        user_message: message,
        message_id: this.reviewMessageIds.for(['review', card.originId, card.id, message].join('\0')),
        resume_mode: 'previous',
        existing_only: true,
      })
    } catch (err: unknown) {
      throw new Error(`Shuttle did not answer (${(err as { message?: string })?.message ?? String(err)}), so this may still arrive. Check the worker's conversation before sending again.`)
    }
    const body = (await res.json().catch(() => ({}))) as DispatchFailureBody & { duplicate?: boolean; disposition?: string }
    if (res.ok) {
      this.reviewMessageIds.sent()
      const notice = repeatNotice(body)
      if (notice) throw new Error(notice)
      return
    }
    throw new Error(res.status === 409 ? 'A worker is already running for this fiber.' : dispatchFailureMessage(body, `Requeue failed (${res.status})`, res.status))
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
    if (current && isAgentCard(current)) this.paintDock(current)
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
        if (this.disposed || !current || !isAgentCard(current)) {
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
      this.settings = new ThreadSettings(this.opts.base, this.dock, card)
      this.workerActions.seat(this.listen.el, this.voiceStrip.el, this.settings.button)
      this.workerActions.seatPlaceholder(this.meter)
      this.dockBody.append(this.workerActions.el)
      this.unbindKeyboard = bindAvoidKeyboard(this.dock)
    }
    this.paintVoice(card)
    this.settings?.update(card)
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
    this.followDismissed()
    const whole = composeStream({
      channel: scope,
      records,
      files: this.feed.sends.files,
      waits,
      launches: () => [],
      cleared: clearedLines([...this.dismissed, ...this.pendingDismiss]),
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

  private followDismissed(): void {
    if (Date.now() - this.dismissedReadAt < USAGE_REFRESH_MS) return
    this.dismissedReadAt = Date.now()
    void getDaemonJson<{ dismissed?: string[] }>(`${this.opts.base}/api/v1/channels/dismissed`)
      .then(data => {
        if (this.disposed || !Array.isArray(data.dismissed)) return
        this.dismissed = data.dismissed
        if (this.mode === 'posts') this.render()
      })
      .catch(() => {})
  }

  private async clearLine(item: Item): Promise<void> {
    const at = Date.now()
    const fiber = fiberOf(item.card)
    const keys = lineIds(item).map(id => clearLineKey(id, at))
    this.pendingDismiss.push(...keys)
    this.render()
    try {
      if (withdraws(item)) {
        await postDaemonJson(this.opts.base, '/api/v1/lifecycle', { action: 'ask-clear', fiber: item.card.id, origin: item.card.originId }, 'Clear failed')
      } else if (item.clears) {
        await this.feed.board.clear(item.clears)
      }
      await Promise.all(keys.map(key => postDaemonJson(this.opts.base, '/api/v1/channels/dismiss', { key, fiber }, 'Clear failed')))
      this.dismissed = [...this.dismissed, ...keys]
      this.pendingDismiss = this.pendingDismiss.filter(key => !keys.includes(key))
      this.render()
    } catch {
      this.pendingDismiss = this.pendingDismiss.filter(key => !keys.includes(key))
      this.render()
      this.say(`Could not clear ${slug(item.card)}'s line.`)
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
      open: (card, doc) => {
        if (doc === changeKey(card.originId, card.uid ?? card.id)) { this.openChangesTab(); return }
        const file = parseDocKey(doc)
        if (!file) return
        if (isChangeFile(file.path)) { this.openChangeFile(file); return }
        openFloating(fileBytesUrl(this.opts.base, file.path, file.owner))
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

  /** Whether the header console button opens a live worker, reopens the last session, or has nowhere to go. */
  private conversationRoute(card: KanbanCard): { reopen: false; destination: ConversationDestination } | { reopen: true } | null {
    const device = conversationDevice()
    const destination = resolveDestination(conversationDestinations(card, device, this.openWorker))
    if (device.desktop && card.sessionUuid && !hasLiveWorker(card) && destination?.id !== conversationOpening()) return { reopen: true }
    return destination ? { reopen: false, destination } : null
  }

  /** Console button in the thread view's head, beside Constitution, Tapestry, and Sent Files. */
  private buildConsole(target: () => KanbanCard): FiberActs {
    const el = document.createElement('a')
    el.className = 'ws-doc-button pg-console'
    el.dataset.part = 'console'
    el.tabIndex = 0
    el.innerHTML = headerIcon('console')
    let pending = false
    const open = (): void => {
      if (pending) return
      const card = target(), route = this.conversationRoute(card)
      if (!route) return
      if (route.reopen) {
        pending = true
        el.dataset.pending = ''
        void attachConversation(this.opts.base, { session: card.sessionUuid!, shuttle_host: card.shuttleHost ?? null }, message => this.say(message))
          .finally(() => { pending = false; delete el.dataset.pending })
      } else {
        openDestination(route.destination)
      }
    }
    el.addEventListener('click', event => {
      event.stopPropagation()
      if (el.hasAttribute('href')) return
      event.preventDefault()
      open()
    })
    el.addEventListener('keydown', event => {
      if (el.hasAttribute('href') || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault()
      el.click()
    })
    const dispose = attachConversationPicker(el, () => conversationDestinations(target(), conversationDevice(), this.openWorker))
    const paint = (): void => {
      const card = target(), route = this.conversationRoute(card)
      el.hidden = !route
      const href = route && !route.reopen ? route.destination.href : undefined
      el.removeAttribute('href'); el.removeAttribute('target'); el.removeAttribute('rel')
      if (href) { linkDestination(el, href); el.removeAttribute('role') }
      else el.setAttribute('role', 'button')
      if (!route) return
      const who = slug(card)
      const label = route.reopen
        ? `Reopen ${who}'s last session${card.shuttleHost ? ` on ${card.shuttleHost}` : ''}`
        : `Open ${who}'s conversation in ${route.destination.label}`
      el.setAttribute('aria-label', label)
      el.title = route.reopen ? label : `${label}\nLong-press or right-click to choose where to open.`
    }
    return { el, paint, dispose }
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
    if (file) {
      if (isChangeFile(file.path)) { this.openChangeFile(file); return }
      window.open(fileBytesUrl(this.opts.base, file.path, file.owner) + file.hash, '_blank', 'noopener')
    } else if (isExternalHref(href)) window.open(href, '_blank', 'noopener')
  }
}
