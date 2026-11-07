import { VERDICT_DELAY_MS } from './workspace/verdictDelay.js'

export type KeySurface = 'desk' | 'overview' | 'reader'
export type KeyIntent = 'desk' | 'chronicle' | 'board' | 'left' | 'right' | 'up' | 'down' | 'next' | 'prev' | 'nextChannel' | 'prevChannel' | 'nextGroup' | 'prevGroup' | 'open' | 'back' | 'first' | 'last' | 'scrollDown' | 'scrollUp' | 'pageDown' | 'pageUp' | 'halfDown' | 'halfUp' | 'find' | 'help' | 'audioPlay' | 'audioBack' | 'audioForward' | 'temper' | 'discard' | 'toReview' | 'undoVerdict' | 'conversation' | 'rest' | 'pin' | 'orchestrator' | 'drawing' | 'tapestry'
/** Reports can request navigation only. New intents are excluded unless named here. */
export const DOCUMENT_KEY_INTENTS: readonly KeyIntent[] = [
  'prev', 'next', 'prevChannel', 'nextChannel', 'prevGroup', 'nextGroup', 'first', 'last',
  'scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp',
  'back', 'find', 'help', 'desk', 'chronicle', 'board', 'tapestry',
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

/** Acting on one constitution: the reader's open fiber, the Desk's selected
 * card. Both surfaces bind these same keys and run them through
 * `constitutionAction`, so what a key does to a constitution cannot drift
 * between them. */
const constitutionBindings = (subject: string): KeyBinding[] => [
  bind(['c', '.'], 'conversation', `Open ${subject}'s conversation`),
  bind(['t'], 'temper', `Temper ${subject} (${VERDICT_UNDO} undo)`),
  bind(['x'], 'discard', `Discard ${subject} (${VERDICT_UNDO} undo)`),
  bind(['a'], 'toReview', `Move ${subject} to Awaiting review (${VERDICT_UNDO} undo)`),
  bind(['s'], 'rest', `Rest ${subject}, with or without a date`),
  bind(['z'], 'undoVerdict', 'Undo latest pending verdict'),
]

/** Desk regions follow reading order: the three Now columns left-to-right,
 * then Roles, then Resting. In flight's Your turn and Working bands form one
 * column. Roles and Resting each form one list in their drawn reading order.
 * Empty regions are skipped; movement stops at the ends, never wraps. */
export const DESK_REGION_SELECTORS = ['[data-column="drafts"]', '[data-column="inFlight"]', '[data-column="awaitingReview"]', '.kbn-section-roles', '.kbn-section-stash'] as const

/** The binding table is also the help overlay's source; surfaces consume intents,
 * not physical keys. Reader Alt-arrows remain guarded inside editable targets. */
export const surfaceBindings: Record<KeySurface, readonly KeyBinding[]> = {
  desk: [
    bind(['1'], 'desk', 'Switch to Desk'), bind(['2'], 'chronicle', 'Switch to Chronicle'), bind(['3'], 'board', 'Switch to Board'),
    bind(['/'], 'find', 'Find a card or constitution'),
    bind(['h', 'ArrowLeft'], 'left', 'Previous column / region'), bind(['l', 'ArrowRight'], 'right', 'Next column / region'),
    bind(['j', 'ArrowDown'], 'down', 'Next card'), bind(['k', 'ArrowUp'], 'up', 'Previous card'),
    bind(['g'], 'first', 'First card in column'), bind(['G'], 'last', 'Last card in column'),
    ...constitutionBindings('the selected card'),
    bind(['Enter', 'o'], 'open', 'Open constitution'), bind(['Escape'], 'back', 'Clear selection'), bind(['?'], 'help', 'Keyboard help'),
  ],
  overview: [
    bind(['1'], 'desk', 'Switch to Desk'), bind(['2'], 'chronicle', 'Switch to Chronicle'), bind(['3'], 'board', 'Switch to Board'),
    bind(['/'], 'find', 'Find work or files'), bind(['Escape'], 'back', 'Return to Desk when nothing is open'),
    bind(['h', 'ArrowLeft'], 'left', 'Move left'), bind(['l', 'ArrowRight'], 'right', 'Move right'),
    bind(['j', 'ArrowDown'], 'down', 'Move down'), bind(['k', 'ArrowUp'], 'up', 'Move up'),
    bind(['g'], 'first', 'First folio'), bind(['G'], 'last', 'Last folio'),
    bind(['c', '.'], 'conversation', 'Open conversation'), bind(['Enter', 'o'], 'open', 'Open file'), bind(['?'], 'help', 'Keyboard help'),
  ],
  reader: [
    bind(['1'], 'desk', 'Switch to Desk'), bind(['2'], 'chronicle', 'Switch to Chronicle'), bind(['3'], 'board', 'Switch to Board'),
    bind(['p'], 'audioPlay', 'Audio: play / pause'),
    bind(['['], 'audioBack', 'Audio: back 5 seconds'),
    bind([']'], 'audioForward', 'Audio: forward 5 seconds'),
    ...constitutionBindings('the open fiber'),
    bind(['/'], 'find', 'Find a constitution or transcript'),
    bind(['h', 'ArrowLeft', '‹'], 'back', 'Back to the previous page'),
    bind(['ArrowDown'], 'scrollDown', 'Scroll document down (3 lines)'), bind(['ArrowUp'], 'scrollUp', 'Scroll document up (3 lines)'),
    bind(['d'], 'halfDown', 'Scroll half a viewport down'), bind(['u'], 'halfUp', 'Scroll half a viewport up'),
    bind([' '], 'pageDown', 'Page document down'), bind(['Shift+ '], 'pageUp', 'Page document up'),
    bind(['j'], 'nextChannel', 'Next constitution, across columns'), bind(['k'], 'prevChannel', 'Previous constitution, across columns'),
    bind(['J'], 'nextGroup', 'Next Desk column'), bind(['K'], 'prevGroup', 'Previous Desk column'),
    bind(['ArrowLeft'], 'back', 'Back to the previous page', true),
    bind(['ArrowDown'], 'nextChannel', 'Next constitution', true), bind(['ArrowUp'], 'prevChannel', 'Previous constitution', true),
    bind(['b'], 'orchestrator', 'Back to the thread’s orchestrator'),
    bind(['l'], 'tapestry', 'Between the family map and its tapestry'), bind(['v'], 'drawing', 'Next drawing of the family map'),
    bind(['Enter', 'o'], 'open', 'Toggle expand'), bind(['Escape'], 'back', 'Close a layer, then go back'),
    bind(['?'], 'help', 'Keyboard help'),
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
    if (['Enter', ' '].includes(event.key ?? '') && el?.closest?.('button,a[href],summary,[role="link"],[role="button"],[role="option"],[role="treeitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"]')) return false
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
  if (event.repeat && ['open', 'back', 'help', 'find', 'temper', 'discard', 'toReview', 'undoVerdict', 'conversation', 'rest', 'pin', 'orchestrator', 'drawing', 'tapestry'].includes(binding.intent)) return null
  return binding.intent
}

/** How one physical key of a binding reads in the help guide. */
export function keyLabels(binding: KeyBinding): string[] {
  const names: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc', ' ': 'Space', 'Shift+ ': '⇧Space', J: '⇧J', K: '⇧K' }
  return binding.keys.map(key => `${binding.command ? '⌘' : ''}${binding.alt ? '⌥' : ''}${names[key] ?? key}`)
}

export interface HelpRow {
  keys: readonly string[]
  label: string
  /** The bindings this row explains, as surface and intent. */
  covers: ReadonlyArray<readonly [KeySurface, KeyIntent]>
}
export interface HelpSection { title: string; note?: string; rows: readonly HelpRow[] }

const everywhere = (...intents: KeyIntent[]): Array<readonly [KeySurface, KeyIntent]> =>
  (['desk', 'overview', 'reader'] as const).flatMap(surface => intents.map(intent => [surface, intent] as const))
const on = (surface: KeySurface, ...intents: KeyIntent[]): Array<readonly [KeySurface, KeyIntent]> => intents.map(intent => [surface, intent] as const)
const row = (keys: string[], label: string, covers: Array<readonly [KeySurface, KeyIntent]>): HelpRow => ({ keys, label, covers })

/** The guide `?` opens, by what a key is for rather than where it is pressed.
 * A test holds it to `surfaceBindings`: every binding appears in a row that
 * covers its surface and intent and shows each of its keys. */
export const helpSections: readonly HelpSection[] = [
  { title: 'Everywhere', rows: [
    row(['1', '2', '3'], 'Desk, Chronicle, Board', everywhere('desk', 'chronicle', 'board')),
    row(['/'], 'Find', everywhere('find')),
    row(['Esc'], 'Close a layer, then step back', everywhere('back')),
    row(['?'], 'This guide', everywhere('help')),
  ] },
  { title: 'Moving', note: 'On the Desk and the Board.', rows: [
    row(['j', 'k', '↓', '↑'], 'Next / previous card or folio', [...on('desk', 'down', 'up'), ...on('overview', 'down', 'up')]),
    row(['h', 'l', '←', '→'], 'Previous / next column', [...on('desk', 'left', 'right'), ...on('overview', 'left', 'right')]),
    row(['g', 'G'], 'First / last in the column', [...on('desk', 'first', 'last'), ...on('overview', 'first', 'last')]),
    row(['Enter', 'o'], 'Open; on a fiber page, expand it', everywhere('open')),
  ] },
  { title: 'A constitution', note: `The selected card, or the open fiber. Verdicts write after ${VERDICT_UNDO}; z or Undo cancels the latest.`, rows: [
    row(['c', '.'], 'Open its conversation', everywhere('conversation')),
    row(['t'], 'Temper', [...on('desk', 'temper'), ...on('reader', 'temper')]),
    row(['x'], 'Discard', [...on('desk', 'discard'), ...on('reader', 'discard')]),
    row(['a'], 'Move to Awaiting review', [...on('desk', 'toReview'), ...on('reader', 'toReview')]),
    row(['s'], 'Rest, with or without a date', [...on('desk', 'rest'), ...on('reader', 'rest')]),
    row(['z'], 'Undo the latest pending verdict', [...on('desk', 'undoVerdict'), ...on('reader', 'undoVerdict')]),
    row(['b'], 'Go to its orchestrator', on('reader', 'orchestrator')),
  ] },
  { title: 'Fiber page', rows: [
    row(['j', 'k', '⌥↓', '⌥↑'], 'Next / previous constitution', on('reader', 'nextChannel', 'prevChannel')),
    row(['⇧J', '⇧K'], 'Next / previous Desk column', on('reader', 'nextGroup', 'prevGroup')),
    row(['h', '←', '‹', '⌥←'], 'Back a page', on('reader', 'back')),
    row(['↓', '↑', 'd', 'u', 'Space', '⇧Space'], 'Scroll: line, half page, page', on('reader', 'scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp')),
    row(['p', '[', ']'], 'Audio: play or pause, back or forward 5 s', on('reader', 'audioPlay', 'audioBack', 'audioForward')),
  ] },
  { title: 'Family map', note: 'With the map focused, the arrows walk its threads from the most urgent, and Enter opens one.', rows: [
    row(['l'], 'To its tapestry, and back to the map', on('reader', 'tapestry')),
    row(['v'], 'Next drawing', on('reader', 'drawing')),
  ] },
]
