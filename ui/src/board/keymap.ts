import { VERDICT_DELAY_MS } from './workspace/verdictDelay.js'

export type KeySurface = 'desk' | 'overview' | 'reader'
export type KeyIntent = 'left' | 'right' | 'up' | 'down' | 'next' | 'prev' | 'nextChannel' | 'prevChannel' | 'nextGroup' | 'prevGroup' | 'open' | 'back' | 'first' | 'last' | 'scrollDown' | 'scrollUp' | 'pageDown' | 'pageUp' | 'halfDown' | 'halfUp' | 'sidebar' | 'find' | 'help' | 'audioPlay' | 'audioBack' | 'audioForward' | 'temper' | 'discard' | 'undoVerdict' | 'compose' | 'conversation'
/** Reports can request navigation only. New intents are excluded unless named here. */
export const DOCUMENT_KEY_INTENTS: readonly KeyIntent[] = [
  'prev', 'next', 'prevChannel', 'nextChannel', 'prevGroup', 'nextGroup', 'first', 'last',
  'scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp',
  'back', 'sidebar', 'find', 'help',
]
export interface KeyBinding {
  keys: readonly string[]
  intent: KeyIntent
  label: string
  alt?: boolean
  command?: boolean
}
const VERDICT_UNDO = `${VERDICT_DELAY_MS / 1000} s`
const bind = (keys: string[], intent: KeyIntent, label: string, alt = false): KeyBinding => ({ keys, intent, label, alt })

/** Desk regions follow reading order: the three Now columns left-to-right,
 * then Pinned, then Resting. In flight's Aloft and Holding bands form one
 * column. Pinned and Resting each form one list in their drawn reading order.
 * Empty regions are skipped; movement stops at the ends, never wraps. */
export const DESK_REGION_SELECTORS = ['[data-column="drafts"]', '[data-column="inFlight"]', '[data-column="awaitingReview"]', '.kbn-section-pinned', '.kbn-section-stash'] as const

/** The binding table is also the help overlay's source; surfaces consume intents,
 * not physical keys. Reader Alt-arrows remain guarded inside editable targets. */
export const surfaceBindings: Record<KeySurface, readonly KeyBinding[]> = {
  desk: [
    bind(['/'], 'find', 'Find a card or constitution'),
    bind(['h', 'ArrowLeft'], 'left', 'Previous column / region'), bind(['l', 'ArrowRight'], 'right', 'Next column / region'),
    bind(['j', 'ArrowDown'], 'down', 'Next card'), bind(['k', 'ArrowUp'], 'up', 'Previous card'),
    bind(['g'], 'first', 'First card in column'), bind(['G'], 'last', 'Last card in column'),
    bind(['c', '.'], 'conversation', 'Open selected conversation'),
    bind(['z'], 'undoVerdict', 'Undo latest pending verdict'),
    bind(['Enter', 'o'], 'open', 'Open constitution'), bind(['Escape'], 'back', 'Clear selection'), bind(['?'], 'help', 'Keyboard help'),
  ],
  overview: [
    bind(['/'], 'find', 'Find work or files'),
    bind(['h', 'ArrowLeft'], 'left', 'Move left'), bind(['l', 'ArrowRight'], 'right', 'Move right'),
    bind(['j', 'ArrowDown'], 'down', 'Move down'), bind(['k', 'ArrowUp'], 'up', 'Move up'),
    bind(['g'], 'first', 'First folio'), bind(['G'], 'last', 'Last folio'), bind(['Enter', 'o'], 'open', 'Open constitution'), bind(['?'], 'help', 'Keyboard help'),
  ],
  reader: [
    bind(['p'], 'audioPlay', 'Audio: play / pause'),
    bind(['['], 'audioBack', 'Audio: back 5 seconds'),
    bind([']'], 'audioForward', 'Audio: forward 5 seconds'),
    bind(['c', '.'], 'conversation', 'Open conversation'),
    bind(['r'], 'compose', 'Focus composer on the fiber page'),
    bind(['t'], 'temper', `Temper the open fiber (${VERDICT_UNDO} undo)`),
    bind(['x'], 'discard', `Discard the open fiber (${VERDICT_UNDO} undo)`),
    bind(['z'], 'undoVerdict', 'Undo latest pending verdict'),
    bind(['s'], 'sidebar', 'Toggle constitution sidebar'),
    bind(['/'], 'find', 'Find a constitution or file'),
    { ...bind(['\\'], 'sidebar', 'Toggle constitution sidebar'), command: true },
    bind(['h', 'ArrowLeft'], 'prev', 'Previous tab'), bind(['l', 'ArrowRight'], 'next', 'Next tab'),
    bind(['ArrowDown'], 'scrollDown', 'Scroll document down (3 lines)'), bind(['ArrowUp'], 'scrollUp', 'Scroll document up (3 lines)'),
    bind(['d'], 'halfDown', 'Scroll half a viewport down'), bind(['u'], 'halfUp', 'Scroll half a viewport up'),
    bind([' '], 'pageDown', 'Page document down'), bind(['Shift+ '], 'pageUp', 'Page document up'),
    bind(['j'], 'nextChannel', 'Next constitution'), bind(['k'], 'prevChannel', 'Previous constitution'),
    bind(['J'], 'nextGroup', 'Next sidebar group'), bind(['K'], 'prevGroup', 'Previous sidebar group'),
    bind(['ArrowLeft'], 'prev', 'Previous page', true), bind(['ArrowRight'], 'next', 'Next page', true),
    bind(['ArrowDown'], 'nextChannel', 'Next constitution', true), bind(['ArrowUp'], 'prevChannel', 'Previous constitution', true),
    bind(['Enter', 'o'], 'open', 'Toggle expand'), bind(['Escape'], 'back', 'Return to origin view'),
    bind(['g', 'Home'], 'first', 'First page'), bind(['G', 'End'], 'last', 'Last page'), bind(['?'], 'help', 'Keyboard help'),
  ],
}

/** Uses the target's own realm, including ancestors of contenteditable nodes. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return !shouldForwardDocumentKey({ target, defaultPrevented: false })
}

/** A document gets first refusal; native viewers don't install this bridge. */
export function shouldForwardDocumentKey(event: Pick<KeyboardEvent, 'defaultPrevented' | 'target'> & Partial<Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>>): boolean {
  if (event.defaultPrevented) return false
  const el = event.target as HTMLElement | null
  if (el?.closest?.('input,textarea,select,[role="textbox"],audio,video,iframe,embed,object')) return false
  const editable = el?.closest?.('[contenteditable]')
  if (editable && editable.getAttribute('contenteditable') !== 'false') return false
  if (!event.altKey && !event.ctrlKey && !event.metaKey) {
    if (['Enter', ' '].includes(event.key ?? '') && el?.closest?.('button,a[href],summary,[role="button"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"]')) return false
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key ?? '') && el?.closest?.('[role="menu"],[role="radiogroup"],[role="tablist"],[role="slider"],[role="listbox"]')) return false
  }
  return true
}

export function keyIntent(event: KeyboardEvent, surface: KeySurface,
  bindings = surfaceBindings, editable = isEditableTarget): KeyIntent | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null
  const command = event.metaKey || event.ctrlKey
  if ((event.altKey || !command) && editable(event.target)) return null
  const key = event.key === ' ' && event.shiftKey ? 'Shift+ ' : event.key
  const binding = bindings[surface].find(b => !!b.command === command && !!b.alt === event.altKey && b.keys.includes(key))
  if (!binding) return null
  if (event.repeat && ['open', 'back', 'help', 'find', 'sidebar', 'temper', 'discard', 'undoVerdict', 'compose', 'conversation'].includes(binding.intent)) return null
  return binding.intent
}

export function bindingKeyLabel(binding: KeyBinding): string {
  const names: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc', ' ': 'Space', 'Shift+ ': '⇧Space', J: '⇧J', K: '⇧K' }
  return binding.keys.map(key => `${binding.command ? '⌘' : ''}${binding.alt ? '⌥' : ''}${names[key] ?? key}`).join(' / ')
}
