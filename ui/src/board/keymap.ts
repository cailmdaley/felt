export type KeySurface = 'desk' | 'overview' | 'reader'
export type KeyIntent = 'left' | 'right' | 'up' | 'down' | 'next' | 'prev' | 'nextChannel' | 'prevChannel' | 'open' | 'back' | 'first' | 'last' | 'scrollDown' | 'scrollUp' | 'pageDown' | 'pageUp' | 'halfDown' | 'halfUp' | 'sidebar' | 'help'
export interface KeyBinding {
  keys: readonly string[]
  intent: KeyIntent
  label: string
  alt?: boolean
  command?: boolean
}
const bind = (keys: string[], intent: KeyIntent, label: string, alt = false): KeyBinding => ({ keys, intent, label, alt })

/** Desk regions follow reading order: the three Now columns left-to-right,
 * then Pinned, then Resting. In flight's Needs you and Working bands form one
 * column. Pinned and Resting each form one list in their drawn reading order.
 * Empty regions are skipped; movement stops at the ends, never wraps. */
export const DESK_REGION_SELECTORS = ['[data-column="drafts"]', '[data-column="inFlight"]', '[data-column="awaitingReview"]', '.kbn-section-pinned', '.kbn-section-stash'] as const

/** The binding table is also the help overlay's source; surfaces consume intents,
 * not physical keys. Alt-arrows are reader chords and bypass the typing guard. */
export const surfaceBindings: Record<KeySurface, readonly KeyBinding[]> = {
  desk: [
    bind(['h', 'ArrowLeft'], 'left', 'Previous column / region'), bind(['l', 'ArrowRight'], 'right', 'Next column / region'),
    bind(['j', 'ArrowDown'], 'down', 'Next card'), bind(['k', 'ArrowUp'], 'up', 'Previous card'),
    bind(['g'], 'first', 'First card in column'), bind(['G'], 'last', 'Last card in column'),
    bind(['Enter', 'o'], 'open', 'Open channel'), bind(['Escape', 'u'], 'back', 'Clear selection'), bind(['?'], 'help', 'Keyboard help'),
  ],
  overview: [
    bind(['h', 'ArrowLeft'], 'left', 'Move left'), bind(['l', 'ArrowRight'], 'right', 'Move right'),
    bind(['j', 'ArrowDown'], 'down', 'Move down'), bind(['k', 'ArrowUp'], 'up', 'Move up'),
    bind(['g'], 'first', 'First folio'), bind(['G'], 'last', 'Last folio'), bind(['Enter', 'o'], 'open', 'Open channel'), bind(['?'], 'help', 'Keyboard help'),
  ],
  reader: [
    { ...bind(['\\'], 'sidebar', 'Toggle channel sidebar'), command: true },
    bind(['h', 'ArrowLeft'], 'prev', 'Previous tab'), bind(['l', 'ArrowRight'], 'next', 'Next tab'),
    bind(['j', 'ArrowDown'], 'scrollDown', 'Scroll document down (3 lines)'), bind(['k', 'ArrowUp'], 'scrollUp', 'Scroll document up (3 lines)'),
    bind(['d'], 'halfDown', 'Scroll half a viewport down'), bind(['u'], 'halfUp', 'Scroll half a viewport up'),
    bind([' '], 'pageDown', 'Page document down'), bind(['Shift+ '], 'pageUp', 'Page document up'),
    bind(['J'], 'nextChannel', 'Next channel'), bind(['K'], 'prevChannel', 'Previous channel'),
    bind(['ArrowLeft'], 'prev', 'Previous page', true), bind(['ArrowRight'], 'next', 'Next page', true),
    bind(['ArrowDown'], 'nextChannel', 'Next channel', true), bind(['ArrowUp'], 'prevChannel', 'Previous channel', true),
    bind(['Enter', 'o'], 'open', 'Toggle expand'), bind(['Escape'], 'back', 'Return to origin view'),
    bind(['g'], 'first', 'First page'), bind(['G'], 'last', 'Last page'), bind(['?'], 'help', 'Keyboard help'),
  ],
}

/** Uses the target's own realm, including ancestors of contenteditable nodes. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return !shouldForwardDocumentKey({ target, defaultPrevented: false })
}

/** A document gets first refusal; native viewers don't install this bridge. */
export function shouldForwardDocumentKey(event: Pick<KeyboardEvent, 'defaultPrevented' | 'target'>): boolean {
  const el = event.target as HTMLElement | null
  const field = el?.closest?.('input,textarea,select,[role="textbox"],[contenteditable]')
  return !event.defaultPrevented && (!field || field.getAttribute('contenteditable') === 'false')
}

export function keyIntent(event: KeyboardEvent, surface: KeySurface,
  bindings = surfaceBindings, editable = isEditableTarget): KeyIntent | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null
  const command = event.metaKey || event.ctrlKey
  if (!command && !event.altKey && editable(event.target)) return null
  const key = event.key === ' ' && event.shiftKey ? 'Shift+ ' : event.key
  const binding = bindings[surface].find(b => !!b.command === command && !!b.alt === event.altKey && b.keys.includes(key))
  if (!binding) return null
  if (event.repeat && ['open', 'back', 'help'].includes(binding.intent)) return null
  return binding.intent
}

export function bindingKeyLabel(binding: KeyBinding): string {
  const names: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc', ' ': 'Space', 'Shift+ ': '⇧Space', J: '⇧J', K: '⇧K' }
  return binding.keys.map(key => `${binding.command ? '⌘' : ''}${binding.alt ? '⌥' : ''}${names[key] ?? key}`).join(' / ')
}
