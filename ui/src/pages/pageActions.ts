import { openActionMenu, type ActionMenu, type ConversationAction } from '../board/conversationMenu.js'
import { postDaemonJson } from '../board/daemonApi.js'
import { HumanMessageIds } from '../board/humanMessageId.js'
import { isAgentCard } from '../board/KanbanModalShared.js'
import type { KanbanCard } from '../board/KanbanTypes.js'
import { keyIntent, type KeyIntent } from '../board/keymap.js'
import { restPopover } from '../board/RestPopover.js'
import { slug } from '../board/threadOutline.js'
import { blockingDialogOpen } from '../board/views/ViewRegistry.js'
import { confirmCut, dispatchWorkerStart } from '../board/workerStart.js'
import { schedulePaused, scheduled, standing } from '../board/workspace/fiberPageState.js'
import type { HeaderIcon } from '../board/workspace/headerIcon.js'
import { dressAction, dressVerb, lifecycleVerbsFor, verbSpec, VERB_KEY, type LifecycleVerb } from '../board/workspace/lifecycleVerbs.js'
import { confirmWorkerStop, type Verdict } from '../board/workspace/Verdicts.js'
import '../board/workspace/dock.css'

/** What a page can do to a constitution: the board's lifecycle verbs, withdrawing its question, and a fresh session. */
export type PageAct = LifecycleVerb | 'ask-clear' | 'new_session'

const VERDICT: Record<Exclude<LifecycleVerb, 'rest'>, Verdict> = { temper: 'tempered', review: 'awaitingReview', discard: 'composted' }

/** The ⌥⌘ chords, by physical key: on macOS Option changes the character a key types. They are Rex's own (`shuttle.lua`). */
const CHORD: Partial<Record<PageAct, string>> = { temper: 'T', rest: 'S', review: 'A', discard: 'X', new_session: 'N' }
const CHORD_ACT = new Map(Object.entries(CHORD).map(([act, letter]) => [`Key${letter}`, act as PageAct]))
/** The bare keys are the board's, read through its key table. */
const INTENT_ACT: Partial<Record<KeyIntent, PageAct>> = { temper: 'temper', rest: 'rest', toReview: 'review', discard: 'discard' }

const EXTRA: Record<'ask-clear' | 'new_session', { label: string; icon: HeaderIcon }> = {
  'ask-clear': { label: 'Clear question', icon: 'leave' },
  new_session: { label: 'New session', icon: 'newSession' },
}

/** The acts a card offers, in menu order. */
export function pageActsFor(card: KanbanCard): PageAct[] {
  return [
    ...lifecycleVerbsFor(card, true),
    ...card.ask?.text?.trim() ? ['ask-clear' as const] : [],
    ...isAgentCard(card) ? ['new_session' as const] : [],
  ]
}

/** An act's word on this card. */
export function pageActLabel(card: KanbanCard, act: PageAct): string {
  return act === 'ask-clear' || act === 'new_session' ? EXTRA[act].label : verbSpec(act, card).label
}

/** The keys an act answers to on a page, as they are drawn: its chord, then its bare key. */
export function pageActKeys(act: PageAct): string {
  const chord = CHORD[act]
  return [...chord ? [`⌥⌘${chord}`] : [], ...act in VERB_KEY ? [VERB_KEY[act as LifecycleVerb]] : []].join(' ')
}

export interface PageActionsOptions {
  base: string
  /** The constitution the keys act on, if any. */
  target(): KanbanCard | undefined
  /** A passing word to the human: what was done, or why it was not. */
  say(text: string): void
  /** An act landed: read the board again. */
  changed(): void
}

/**
 * A page's lifecycle acts: written at once through the daemon's owner-routed
 * routes, with a worker they would stop asked about first. The page's keys,
 * buttons and menus all end in {@link run}, which refuses what the card does
 * not offer. No key acts over an open dialog or menu.
 */
export class PageActions {
  private readonly opts: PageActionsOptions
  private readonly messageIds = new HumanMessageIds()
  /** Cards with a write under way, which take no other until it answers. */
  private readonly writing = new Set<string>()
  private closeRest?: () => void
  private openMenu?: ActionMenu

  constructor(opts: PageActionsOptions) {
    this.opts = opts
    document.addEventListener('keydown', this.onChord, true)
    document.addEventListener('keydown', this.onKey)
  }

  run(card: KanbanCard, act: PageAct): void {
    if (!pageActsFor(card).includes(act)) {
      this.opts.say(`${slug(card)} does not offer that now.`)
      return
    }
    if (act === 'new_session') {
      if (confirmCut(card)) void this.write(card, act, 'Started a new session', () => this.newSession(card))
    } else if (act === 'ask-clear') {
      void this.write(card, act, 'Cleared the question', () => this.lifecycle(card, 'ask-clear'))
    } else if (act !== 'rest') {
      const verdict = VERDICT[act]
      if (!confirmWorkerStop(card, verdict)) return
      void this.write(card, act, verdictDone(card, act), () =>
        postDaemonJson(this.opts.base, '/api/v1/transition', { fiber_id: card.id, target: verdict, origin: card.originId }, 'Transition failed'))
    } else if (scheduled(card)) {
      const paused = schedulePaused(card)
      void this.write(card, act, paused ? 'Resumed the schedule' : 'Paused the schedule', () => this.lifecycle(card, paused ? 'resume' : 'rest', { actor: 'board' }))
    } else {
      this.closeRest?.()
      this.closeRest = restPopover(card, until =>
        this.write(card, act, until ? `Resting until ${until}` : 'Resting', () => this.lifecycle(card, 'rest', { until, actor: 'board' })))
    }
  }

  /** Every act the card offers, as a menu at `point` or under `anchor`. */
  menu(card: KanbanCard, anchor: HTMLElement, point?: { x: number; y: number }): void {
    this.openMenu = openActionMenu(anchor, pageActsFor(card).map((act): ConversationAction => ({
      label: pageActLabel(card, act),
      dress: item => {
        if (act === 'ask-clear' || act === 'new_session') dressAction(item, EXTRA[act].icon, EXTRA[act].label)
        else dressVerb(item, act, card)
        const keys = pageActKeys(act)
        // The menu draws an item's keys from here (dock.css).
        if (keys) item.setAttribute('aria-keyshortcuts', keys)
      },
      run: () => this.run(card, act),
    })), `${slug(card)}'s actions`, point)
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onChord, true)
    document.removeEventListener('keydown', this.onKey)
    this.closeRest?.()
    this.openMenu?.close()
  }

  /** An ⌥⌘ chord, wherever the caret is: the message box keeps its keys from the page, so this hears them first. */
  private readonly onChord = (event: KeyboardEvent): void => {
    if (!event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey || blockingDialogOpen()) return
    const act = CHORD_ACT.get(event.code), card = this.opts.target()
    if (!act || !card) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) this.run(card, act)
  }

  /** A bare key outside a text field, where the card offers its act. */
  private readonly onKey = (event: KeyboardEvent): void => {
    if (blockingDialogOpen()) return
    const intent = keyIntent(event, 'desk'), act = intent && INTENT_ACT[intent], card = this.opts.target()
    if (!act || !card || !pageActsFor(card).includes(act)) return
    event.preventDefault()
    this.run(card, act)
  }

  private async write(card: KanbanCard, act: PageAct, done: string, post: () => Promise<unknown>): Promise<void> {
    const key = `${card.originId}:${card.uid ?? card.id}`
    if (this.writing.has(key)) return
    this.writing.add(key)
    try {
      await post()
      this.opts.say(`${done}: ${slug(card)}`)
    } catch (error) {
      this.opts.say(`${pageActLabel(card, act)} failed on ${slug(card)}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.writing.delete(key)
      this.opts.changed()
    }
  }

  private lifecycle(card: KanbanCard, action: string, fields: Record<string, string> = {}): Promise<unknown> {
    return postDaemonJson(this.opts.base, '/api/v1/lifecycle', { action, fiber: card.id, origin: card.originId, ...fields }, 'The daemon refused')
  }

  private async newSession(card: KanbanCard): Promise<void> {
    const result = await dispatchWorkerStart(this.opts.base, this.messageIds, card, 'fresh')
    if (!result.ok) throw new Error(result.error ?? 'The daemon refused')
  }
}

function verdictDone(card: KanbanCard, act: 'temper' | 'review' | 'discard'): string {
  if (act === 'review') return 'Moved to review'
  if (act === 'temper') return standing(card) ? 'Run tempered' : 'Tempered'
  return standing(card) ? 'Retired' : 'Discarded'
}
