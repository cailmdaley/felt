import type { KanbanCard } from '../KanbanTypes.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'
import { restReachable, reviewReachable, verdictsFor } from './fiberPageState.js'

/** A lifecycle verb a constitution offers wherever it is acted on: the opened card's header and the Desk row's menu. */
export type LifecycleVerb = 'review' | 'rest' | 'temper' | 'discard'
export interface LifecycleVerbSpec { verb: LifecycleVerb; label: string; icon: HeaderIcon; cls: string }

/** The one definition: header order, word, stroke icon and pigment class of each verb. */
export const LIFECYCLE_VERBS: readonly LifecycleVerbSpec[] = [
  { verb: 'review', label: 'Close for review', icon: 'close', cls: 'kbn-ctl-review' },
  { verb: 'rest', label: 'Rest', icon: 'rest', cls: 'kbn-ctl-rest' },
  { verb: 'temper', label: 'Temper', icon: 'temper', cls: 'kbn-ctl-temper' },
  { verb: 'discard', label: 'Discard', icon: 'discard', cls: 'kbn-ctl-discard' },
]
export const verbSpec = (verb: LifecycleVerb): LifecycleVerbSpec => LIFECYCLE_VERBS.find(spec => spec.verb === verb)!

/** The verbs a card offers, in header order; Rest only where a rest can be taken. */
export function lifecycleVerbsFor(card: KanbanCard, canRest: boolean): LifecycleVerb[] {
  const verdicts = verdictsFor(card)
  return LIFECYCLE_VERBS.map(spec => spec.verb).filter(verb =>
    verb === 'review' ? reviewReachable(card) : verb === 'rest' ? canRest && restReachable(card) : verdicts.includes(verb))
}

/** Draw a button as the header draws a lifecycle verb: its stroke icon, then its word, in its pigment. */
export function dressVerb(button: HTMLButtonElement, verb: LifecycleVerb): HTMLButtonElement {
  const spec = verbSpec(verb)
  button.classList.remove('kbn-ctl-btn')
  button.classList.add(spec.cls, 'ws-header-icon', 'ws-header-verb')
  button.title = spec.label; button.setAttribute('aria-label', spec.label)
  button.innerHTML = headerIcon(spec.icon)
  const word = document.createElement('span'); word.className = 'ws-header-word'; word.textContent = spec.label
  button.append(word)
  return button
}
