import { VERDICT_DELAY_MS } from './workspace/verdictDelay.js'
import { DESK_SECTIONS } from './deskOrdering.js'

export type KeySurface = 'desk' | 'view' | 'reader'
export type KeyIntent = 'desk' | 'chronicle' | 'channels' | 'globe' | 'left' | 'right' | 'up' | 'down' | 'next' | 'prev' | 'nextChannel' | 'prevChannel' | 'nextGroup' | 'prevGroup' | 'open' | 'back' | 'first' | 'last' | 'scrollDown' | 'scrollUp' | 'pageDown' | 'pageUp' | 'halfDown' | 'halfUp' | 'find' | 'help' | 'audioPlay' | 'audioBack' | 'audioForward' | 'temper' | 'discard' | 'toReview' | 'undoVerdict' | 'conversation' | 'rest' | 'pin' | 'orchestrator' | 'tapestry'
/** Reports can request navigation only. New intents are excluded unless named here. */
export const DOCUMENT_KEY_INTENTS: readonly KeyIntent[] = [
  'prev', 'next', 'prevChannel', 'nextChannel', 'prevGroup', 'nextGroup', 'first', 'last',
  'scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp',
  'back', 'find', 'help', 'desk', 'chronicle', 'channels', 'globe', 'tapestry', 'next',
]
/**
 * Intents a document may pass up only while it holds the human's focus, so a
 * report's script cannot ask for them on its own: opening its thread's
 * conversation, as `c` does on the thread's row.
 */
export const FOCUSED_DOCUMENT_KEY_INTENTS: readonly KeyIntent[] = ['conversation']
export interface KeyBinding {
  keys: readonly string[]
  intent: KeyIntent
  label: string
  alt?: boolean
  command?: boolean
}
const VERDICT_UNDO = `${VERDICT_DELAY_MS / 1000} s`
const bind = (keys: string[], intent: KeyIntent, label: string, alt = false): KeyBinding => ({ keys, intent, label, alt })

/** Acting on the open constitution, from the reader: the same acts its view's head carries, through `constitutionAction`. */
const constitutionBindings: KeyBinding[] = [
  bind(['c', '.'], 'conversation', 'Open the open constitution\'s conversation'),
  bind(['t'], 'temper', `Temper the open constitution (${VERDICT_UNDO} undo)`),
  bind(['x'], 'discard', `Discard the open constitution, or retire a standing one (${VERDICT_UNDO} undo)`),
  bind(['a'], 'toReview', `Close the open constitution for review (${VERDICT_UNDO} undo)`),
  bind(['s'], 'rest', 'Rest the open constitution, with or without a date; pause or resume a standing one\'s schedule'),
  bind(['z'], 'undoVerdict', 'Undo latest pending verdict'),
]

/** The acts the Desk's selected card or line answers to: the verdicts and Rest its view's head carries. */
export const DESK_ACTS: readonly KeyIntent[] = ['temper', 'discard', 'toReview', 'rest']

/** Desk regions follow reading order: its six sections, the three columns
 * left to right then the shelf's three, each its family cards and their lines
 * in drawn order. Empty regions are skipped;
 * movement stops at the ends, never wraps. */
export const DESK_REGION_SELECTORS = DESK_SECTIONS.map(section => `[data-column="${section}"]`)

/** `1`–`4` switch views from every surface. */
const VIEW_KEYS: KeyBinding[] = [
  bind(['1'], 'desk', 'Switch to Desk'), bind(['2'], 'chronicle', 'Switch to Chronicle'), bind(['3'], 'channels', 'Switch to Channels'), bind(['4'], 'globe', 'Switch to Globe'),
]

/** The binding table is also the help overlay's source; surfaces consume intents,
 * not physical keys. Reader Alt-arrows remain guarded inside editable targets. */
export const surfaceBindings: Record<KeySurface, readonly KeyBinding[]> = {
  desk: [
    ...VIEW_KEYS,
    bind(['/'], 'find', 'Find a card or constitution'),
    bind(['h', 'ArrowLeft'], 'back', 'Clear selection'),
    bind(['j', 'ArrowDown'], 'down', 'Next card or line'), bind(['k', 'ArrowUp'], 'up', 'Previous card or line'),
    bind(['g'], 'first', 'First in column'), bind(['G'], 'last', 'Last in column'),
    bind(['l', 'ArrowRight', 'Enter', 'o'], 'open', 'Open constitution'), bind(['Escape'], 'back', 'Clear selection'), bind(['?'], 'help', 'Keyboard help'),
    // The selected card or line's lifecycle acts, as its view's head offers them.
    ...constitutionBindings.filter(binding => DESK_ACTS.includes(binding.intent)),
  ],
  view: [...VIEW_KEYS, bind(['/'], 'find', 'Find'), bind(['?'], 'help', 'Keyboard help')],
  reader: [
    ...VIEW_KEYS,
    bind(['p'], 'audioPlay', 'Audio: play / pause'),
    bind(['['], 'audioBack', 'Audio: back 5 seconds'),
    bind([']'], 'audioForward', 'Audio: forward 5 seconds'),
    ...constitutionBindings,
    bind(['/'], 'find', 'Find a constitution or transcript'),
    bind(['h', 'ArrowLeft', '‹'], 'back', 'Back to the view the reader was opened from'),
    bind(['ArrowDown'], 'scrollDown', 'Scroll document down (3 lines)'), bind(['ArrowUp'], 'scrollUp', 'Scroll document up (3 lines)'),
    bind(['d'], 'halfDown', 'Scroll half a viewport down'), bind(['u'], 'halfUp', 'Scroll half a viewport up'),
    bind([' '], 'pageDown', 'Page document down'), bind(['Shift+ '], 'pageUp', 'Page document up'),
    bind(['j'], 'nextChannel', 'Next constitution, across columns'), bind(['k'], 'prevChannel', 'Previous constitution, across columns'),
    bind(['J'], 'nextGroup', 'Next Desk column'), bind(['K'], 'prevGroup', 'Previous Desk column'),
    bind(['ArrowLeft'], 'back', 'Back to the view the reader was opened from', true),
    bind(['ArrowRight'], 'next', 'On a sent file, the older send'),
    bind(['ArrowDown'], 'nextChannel', 'Next constitution', true), bind(['ArrowUp'], 'prevChannel', 'Previous constitution', true),
    bind(['b'], 'orchestrator', 'Back to the thread’s orchestrator'),
    bind(['l'], 'tapestry', 'From the constitution\'s view, its tapestry'),
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
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key ?? '') && el?.closest?.('[role="menu"],[role="radiogroup"],[role="tablist"],[role="slider"],[role="listbox"],[role="tree"]')) return false
    // A file unfolded in place steps to its neighbours and folds with these.
    if (['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key ?? '') && el?.closest?.('[data-unfolded]')) return false
    // A constitution's page walks its tree a level at a time with these letters.
    if (['j', 'k', 'h', 'l'].includes(event.key ?? '') && el?.closest?.('[role="tree"]')) return false
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
  if (event.repeat && ['open', 'back', 'help', 'find', 'temper', 'discard', 'toReview', 'undoVerdict', 'conversation', 'rest', 'pin', 'orchestrator', 'tapestry'].includes(binding.intent)) return null
  return binding.intent
}

/** How one physical key of a binding reads in the help guide. */
export function keyLabels(binding: KeyBinding): string[] {
  const names: Record<string, string> = { PageDown: 'PgDn', PageUp: 'PgUp', ArrowLeft: '←', ArrowRight: '→', ArrowDown: '↓', ArrowUp: '↑', Escape: 'Esc', ' ': 'Space', 'Shift+ ': '⇧Space', J: '⇧J', K: '⇧K' }
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
  (['desk', 'view', 'reader'] as const).flatMap(surface => intents.map(intent => [surface, intent] as const))
const on = (surface: KeySurface, ...intents: KeyIntent[]): Array<readonly [KeySurface, KeyIntent]> => intents.map(intent => [surface, intent] as const)
const row = (keys: string[], label: string, covers: Array<readonly [KeySurface, KeyIntent]>): HelpRow => ({ keys, label, covers })

/** The guide `?` opens, by what a key is for rather than where it is pressed.
 * A test holds it to `surfaceBindings`: every binding appears in a row that
 * covers its surface and intent and shows each of its keys. */
export const helpSections: readonly HelpSection[] = [
  { title: 'Everywhere', rows: [
    row(['1', '2', '3', '4'], 'Desk, Chronicle, Channels, Globe', everywhere('desk', 'chronicle', 'channels', 'globe')),
    row(['/'], 'Find', everywhere('find')),
    row(['Esc'], 'Close a layer, then step back', [...on('desk', 'back'), ...on('reader', 'back')]),
    row(['?'], 'This guide', everywhere('help')),
  ] },
  { title: 'Moving', note: 'On the Desk.', rows: [
    row(['j', 'k', '↓', '↑'], 'Next / previous card or waiting line', on('desk', 'down', 'up')),
    row(['h', '←'], 'Clear selection', on('desk', 'back')),
    row(['g', 'G'], 'First / last in the column', on('desk', 'first', 'last')),
    row(['l', '→', 'Enter', 'o'], 'Open the selected constitution', on('desk', 'open')),
    row(['Enter', 'o'], 'On a fiber page, expand it', on('reader', 'open')),
  ] },
  { title: 'A constitution', note: `The open constitution, or the card or line selected on the Desk. Verdicts write after ${VERDICT_UNDO}; z or Undo cancels the latest.`, rows: [
    row(['c', '.'], 'Open its conversation', on('reader', 'conversation')),
    row(['t'], 'Temper', [...on('reader', 'temper'), ...on('desk', 'temper')]),
    row(['x'], 'Discard; retire a standing one', [...on('reader', 'discard'), ...on('desk', 'discard')]),
    row(['a'], 'Close for review', [...on('reader', 'toReview'), ...on('desk', 'toReview')]),
    row(['s'], 'Rest, with or without a date; pause or resume a standing one\'s schedule', [...on('reader', 'rest'), ...on('desk', 'rest')]),
    row(['z'], 'Undo the latest pending verdict', on('reader', 'undoVerdict')),
    row(['b'], 'Go to its orchestrator', on('reader', 'orchestrator')),
  ] },
  { title: 'Fiber page', rows: [
    row(['j', 'k', '⌥↓', '⌥↑'], 'Next / previous constitution in Desk order (⌥ only on a constitution\'s page)', on('reader', 'nextChannel', 'prevChannel')),
    row(['⇧J', '⇧K'], 'Next / previous Desk column', on('reader', 'nextGroup', 'prevGroup')),
    row(['h', '←', '‹', '⌥←'], 'Back a page', on('reader', 'back')),
    row(['←', '→'], 'On a sent file: the newer / older send in its place (← from the newest goes back)', on('reader', 'next')),
    row(['↓', '↑', 'd', 'u', 'Space', '⇧Space'], 'Scroll: line, half page, page', on('reader', 'scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp')),
    row(['p', '[', ']'], 'Audio: play or pause, back or forward 5 s', on('reader', 'audioPlay', 'audioBack', 'audioForward')),
  ] },
  { title: 'A constitution\'s view', note: 'Its orchestrators above, its threads below; choosing one opens its view, and that moves voice and Rex. Scrolling up past the top opens the orchestrator\'s.', rows: [
    row(['j', 'k', '↓', '↑'], 'Next / previous orchestrator or thread', []),
    row(['Enter', 'l'], 'Open the one in focus', []),
    row(['l'], 'Away from the rows: unfold its tapestry here, else its newest sent file', on('reader', 'tapestry')),
    row(['h'], 'Open its orchestrator\'s view; from the top of the family, back', []),
    row(['c'], 'Open its conversation in Rex', []),
  ] },
  { title: 'Channels', note: 'A channel holds what its workers addressed to you, with marks of threads starting and stopping; an item opens its constitution\'s view. On a phone, swipe sideways between the rail and a channel.', rows: [
    row(['j', 'k'], 'Next / previous channel', []),
    row(['['], 'Hide or show the channels', []),
    row(['/'], 'Jump to a channel or a file', []),
    row(['Enter'], 'Write to the channel\'s chair', []),
    row(['e'], 'Clear the post or files in focus; a question or a close is answered, not cleared', []),
    row(['⌥↑', '⌥↓'], 'Move the channel in the rail', []),
    row(['Menu', '⇧F10'], 'The channel\'s menu: hide, pin, move to the bottom; a long press on a phone', []),
  ] },
]
