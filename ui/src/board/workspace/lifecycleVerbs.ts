import type { KanbanCard } from '../KanbanTypes.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'
import { onDesk, restReachable, reviewReachable, runAwaitsHuman, schedulePaused, scheduled, standing, verdictsFor } from './fiberPageState.js'

/** A lifecycle verb a constitution offers wherever it is acted on: the opened card's header and the Desk row's menu. */
export type LifecycleVerb = 'review' | 'rest' | 'temper' | 'discard'
export interface LifecycleVerbSpec { verb: LifecycleVerb; label: string; icon: HeaderIcon; cls: string }

/** The one definition: header order, word, stroke icon and pigment class of each verb. */
const LIFECYCLE_VERBS: readonly LifecycleVerbSpec[] = [
  { verb: 'review', label: 'Close for review', icon: 'close', cls: 'kbn-ctl-review' },
  { verb: 'rest', label: 'Rest', icon: 'rest', cls: 'kbn-ctl-rest' },
  { verb: 'temper', label: 'Temper', icon: 'temper', cls: 'kbn-ctl-temper' },
  { verb: 'discard', label: 'Discard', icon: 'discard', cls: 'kbn-ctl-discard' },
]
/** The key each verb answers to, on the Desk and the reader alike. */
export const VERB_KEY: Record<LifecycleVerb, string> = { review: 'a', rest: 's', temper: 't', discard: 'x' }

/**
 * A verb as this card names it. On a constitution with a schedule (a standing
 * one's cron, a seat's pulse) Rest pauses it, or resumes a paused one. On a
 * standing constitution Temper ends the run waiting on the human and keeps
 * the schedule, and Discard retires it.
 */
export function verbSpec(verb: LifecycleVerb, card?: KanbanCard): LifecycleVerbSpec {
  const spec = LIFECYCLE_VERBS.find(spec => spec.verb === verb)!
  if (!card) return spec
  if (verb === 'rest' && scheduled(card)) return schedulePaused(card)
    ? { ...spec, label: 'Resume schedule', icon: 'resume' }
    : { ...spec, label: 'Pause schedule', icon: 'pause' }
  if (verb === 'temper' && standing(card)) return { ...spec, label: 'Temper run' }
  if (verb === 'discard' && standing(card)) return { ...spec, label: 'Retire' }
  return spec
}

/** The verbs a card offers, in header order; Rest only where a rest can be
 *  taken. A standing run waiting on the human leads with Temper run, the
 *  gesture that ends it and keeps the schedule. */
export function lifecycleVerbsFor(card: KanbanCard, canRest: boolean): LifecycleVerb[] {
  if (!onDesk(card)) return []
  const verdicts = verdictsFor(card)
  const verbs = LIFECYCLE_VERBS.map(spec => spec.verb).filter(verb =>
    verb === 'review' ? reviewReachable(card) : verb === 'rest' ? canRest && restReachable(card) : verdicts.includes(verb))
  return standing(card) && verbs.includes('temper') ? ['temper', ...verbs.filter(verb => verb !== 'temper')] : verbs
}

/**
 * The verb a row's button wears on its face, of those it offers: Temper where
 * work waits on the human's review or a oneshot rests (opening its terminal is
 * how it resumes), else the first verb that moves the work on (Close for
 * review, then Rest or its schedule's pause and resume). Discard never leads;
 * undefined when it is all there is.
 */
export function leadVerb(card: KanbanCard, offered: readonly LifecycleVerb[]): LifecycleVerb | undefined {
  const restingOneshot = card.effectiveHorizon === 'stashed' && !scheduled(card)
  if (offered.includes('temper') && (card.column === 'awaitingReview' || runAwaitsHuman(card) || restingOneshot)) return 'temper'
  return offered.find(verb => verb !== 'discard')
}

/** Name a verb's button for the card it acts on: its word, an optional target, and its key. */
export function labelVerb(button: HTMLButtonElement, verb: LifecycleVerb, card?: KanbanCard, target = ''): void {
  const spec = verbSpec(verb, card)
  const label = `${spec.label}${target ? ` ${target}` : ''} (${VERB_KEY[verb]})`
  button.dataset.verb = spec.label
  button.title = label
  button.setAttribute('aria-label', label)
}

/** Draw a menu item as the header draws a lifecycle verb: its stroke icon, its word, in its pigment, and the key it answers to. */
export function dressVerb(button: HTMLButtonElement, verb: LifecycleVerb, card?: KanbanCard): HTMLButtonElement {
  const spec = verbSpec(verb, card)
  button.classList.add(spec.cls)
  dressAction(button, spec.icon, spec.label)
  button.dataset.verb = spec.label
  // The menu draws the key from here, beside the word (dock.css).
  button.setAttribute('aria-keyshortcuts', VERB_KEY[verb])
  return button
}

/** Draw a menu item as a header action: its stroke icon, then its word. */
export function dressAction(button: HTMLButtonElement, icon: HeaderIcon, label: string): HTMLButtonElement {
  button.classList.remove('kbn-ctl-btn')
  button.classList.add('ws-header-icon', 'ws-header-verb')
  button.title = label; button.setAttribute('aria-label', label)
  button.innerHTML = headerIcon(icon)
  const word = document.createElement('span'); word.className = 'ws-header-word'; word.textContent = label
  button.append(word)
  return button
}
