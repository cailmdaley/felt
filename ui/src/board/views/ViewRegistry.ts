/**
 * ViewRegistry — the contract between KanbanModal and the views plugged into it.
 *
 * The board is full-page views behind one hotkey row:
 *
 *   1  desk       the kanban page (Now board + Resting). Owned by
 *                 KanbanModal itself, NOT a plugin.
 *   2… plugins    every registered `BoardViewPlugin`, in registration order:
 *                 each mounts into a full-width host where the Desk surfaces
 *                 would otherwise be, with a tab (unless `optional`) and a
 *                 hotkey of its own. Channels, one channel per office, is
 *                 the board's own and registers first.
 *
 * A plugin registers at any time, before the board mounts or after it, and
 * may be unregistered; the board's tabs and hotkeys follow the registry.
 *
 * The bar's Find searches where the board stands: a view says where with
 * `findScope` (a list of what it searches and what a pick does, or a handler
 * that answers the field in place), and none searches the whole board; a pick
 * that lands in a view goes through its `show`.
 *
 * A view is a plain object with a three-call lifecycle. KanbanModal owns the
 * host element and the data; the view owns everything inside the host.
 *
 *   mount(host, ctx)   build your DOM into `host` (empty when you get it)
 *   refresh(ctx)       new board data landed — patch in place, do not rebuild
 *   unmount()          drop timers/listeners; the host is emptied for you
 *
 * `refresh` fires on every successful 15s poll, INCLUDING polls where the
 * fiber data is byte-identical (the Desk skips those re-renders; views do not,
 * because their content also moves with the clock). Keep it cheap and
 * idempotent.
 */

import type { BoardFeed } from '../boardFeed.js'
import type { MapFeeds, MapFile } from '../family/model.js'
import type { FindScope } from '../search/scope.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import type { DocKey } from '../workspace/documents.js'
import type { Library } from '../workspace/Library.js'
import type { ConsoleOptions, Dock } from '../workspace/Dock.js'
import type { FiberSends } from '../fiberSends.js'
import type { SwipeSignal } from '../workspace/PhoneGestures.js'

export interface BoardViewPlugin {
  /** Its id: the tab's value, its `?view=` and `#/<id>` address. Letters, digits, `-` and `_`, and none of the board's own addresses (`desk`, `board`, `chronicle`, `globe`). */
  id: string
  title: string
  /** Its key on the hotkey row, a digit from 2 to 9; without one it takes the first free one. */
  hotkey?: string
  /** Draws no tab: reached by its hotkey, its address, or code. */
  optional?: boolean
  mount(host: HTMLElement, ctx: ViewContext): void
  refresh(ctx: ViewContext): void
  unmount(): void
  /** Offers the view a keystroke the chassis left alone; true when it took it. */
  keydown?(event: KeyboardEvent): boolean
  /** Rex moved to this fiber: show it here, leaving Rex be; false to leave it to the reader. */
  reveal?(id: string, origin: string): boolean
  /** Rex moved to this fiber's worker, and only then: show where it speaks here; false to leave it to the reader. */
  followRex?(id: string, origin: string): boolean
  /** Where the bar's Find searches on this view, now; none searches the whole board. */
  findScope?(): FindScope | undefined
  /** Find picked a place in this view (a channel, a line in it): show it, whether or not the view is mounted yet. */
  show?(target: { channel: string; item?: string }): void
}

/** A registered view. */
export type TemporalView = BoardViewPlugin

/**
 * What a view is handed: the board's own response, cards, workspace handles and gestures.
 */
export interface ViewContext {
  /** The shared fleet sent-files store. */
  sends?: FiberSends
  response: KanbanResponse
  /** The board's document reader and the fleet's documents. */
  workspace?: {
    readonly isActive: boolean
    /** Leaves the reader for the view beneath it, from any page, full screen included (`Workspace.returnToOrigin`). */
    returnToOrigin(): void
    /** The view beneath the reader that owns its page swipe: true when it took the swipe. */
    swipeBeneath: ((signal: SwipeSignal) => boolean) | null
    readonly dock: { openConversation(card: KanbanCard): boolean }
    /** A console of the view's own, built and wired as the reader's (`Workspace.console`). */
    console(options: ConsoleOptions): Dock
    readonly library: Library
    /** The board looks at a fiber, or at none: voice and Rex follow it together (`Workspace.look`). */
    look(card: KanbanCard | null): Promise<boolean>
    openFromDesk(card: KanbanCard): void
    /** A fiber's page, or one of its documents; a fiber the board does not hold is read from its owner first. */
    openPage(card: KanbanCard, doc?: DocKey): void
    /** A link followed in a file unfolded in the view, routed as the reader routes its own (`Workspace.openLink`). */
    openLink(card: KanbanCard, source: DocKey, href: string): boolean
    /** The fleet's marks, files and tapestry leads. */
    readonly feeds: MapFeeds & { refresh(): void; lead(card: KanbanCard): Promise<MapFile | null | undefined> }
    /** The family board's records, which Channels reads its streams from. */
    readonly board: BoardFeed
    /** The last thing a constitution said to anyone, with when; undefined when it said nothing. */
    said(card: KanbanCard): { text: string; at: number } | undefined
    /** Empty the bar's Find and put away whatever it did. */
    clearFind(): void
    /** The bar's Find, serving, follows the view to where it stands now. */
    followFind(): void
  }
  /**
   * WORK — every card on the eight lifecycle/planning surfaces, deduped. This
   * is the list to walk for due-marks and lane building.
   *
   * It deliberately EXCLUDES cycles. A cycle is an annotation, a named span of
   * time, and its `due` is the span's closing edge rather than a deadline — so
   * a cycle in here would draw a due-mark that means something else. Read
   * `response.cycles` for those, and `cycleSpan` (KanbanRules) to resolve one
   * into two civil days.
   */
  cards: KanbanCard[]
  /**
   * The daemon origin every request is built on — '' for the same-origin
   * bundle the daemon serves, an absolute origin when the host was given one.
   * The board resolves it once; a view must never re-resolve it from the env.
   */
  shuttleBase: string
  /**
   * Open a fiber in the workspace reader. Resolves against `cards` AND `response.cycles`,
   * so a cycle band or chip can hand over its id directly — the split above is
   * about what a view iterates, not about what it can open.
   *
   * An id matching neither warns to the console and does nothing.
   */
  openCard(cardId: string): void
  /** Re-fetch the board's own feed now, rather than on the next poll. */
  requestRefresh(): void
}

/** A registered view's id. */
export type ViewId = string
/** `desk`, the kanban page KanbanModal renders itself, or a registered view's id. */
export type BoardViewId = string
export const DESK_VIEW = 'desk'
/** The Desk's key on the hotkey row. */
export const DESK_HOTKEY = '1'
/** The keys views take: the letters and punctuation are the board's and the reader's. */
const VIEW_HOTKEYS = ['2', '3', '4', '5', '6', '7', '8', '9']

// ── Registry ─────────────────────────────────────────────────────────────────
//
// Module-global. The board's own views register at import time (see
// ./index.ts), so their import order is the start of the strip's order; a
// plugin registered later joins its end.

const registry = new Map<ViewId, BoardViewPlugin>()
const listeners = new Set<() => void>()
const changed = (): void => { for (const listener of [...listeners]) listener() }

/** Addresses the board answers itself: its Desk, the reader's root, and the two that lead to the Desk. */
const RESERVED_IDS = [DESK_VIEW, 'board', 'chronicle', 'globe']
/** What a view's id may be: one segment of an address, the same encoded or not. */
const VIEW_ID = /^[a-z0-9][a-z0-9_-]*$/i

/** Register a view. Re-registering an id replaces it (hot-reload friendly)
 *  while keeping its original position in the strip. Throws on an id or a
 *  hotkey the board cannot give it. */
export function registerView(view: BoardViewPlugin): void {
  if (!VIEW_ID.test(view.id)) throw new Error(`A view's id is letters, digits, - and _, starting with a letter or digit, not ${JSON.stringify(view.id)}`)
  if (RESERVED_IDS.includes(view.id.toLowerCase())) throw new Error(`\`${view.id}\` is the board's own address, not a view to register`)
  if (view.hotkey !== undefined && !VIEW_HOTKEYS.includes(view.hotkey)) throw new Error(`A view's hotkey is a digit from 2 to 9, not ${JSON.stringify(view.hotkey)}`)
  registry.set(view.id, view)
  changed()
}

/** Take a view out of the board; true when it was registered. */
export function unregisterView(id: ViewId): boolean {
  const had = registry.delete(id)
  if (had) changed()
  return had
}

export function getView(id: ViewId): BoardViewPlugin | undefined {
  return registry.get(id)
}

/** Every registered view, in registration order. */
export function listViews(): BoardViewPlugin[] {
  return [...registry.values()]
}

/** Call `listener` whenever a view is registered or unregistered; returns its unsubscribe. */
export function onViewsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Each view with the key that switches to it: its own `hotkey`, else the first
 * digit from 2 to 9 no view has claimed, in registration order. A view whose
 * key another took first, or that finds no digit free, has none.
 */
export function viewHotkeys(): Array<{ view: BoardViewPlugin; hotkey?: string }> {
  const views = listViews()
  const taken = new Set<string>([DESK_HOTKEY])
  const own = new Map<BoardViewPlugin, string>()
  for (const view of views) {
    if (view.hotkey && !taken.has(view.hotkey)) { taken.add(view.hotkey); own.set(view, view.hotkey) }
  }
  return views.map(view => {
    if (own.has(view)) return { view, hotkey: own.get(view) }
    if (view.hotkey) return { view }
    const free = VIEW_HOTKEYS.find(key => !taken.has(key))
    if (free) taken.add(free)
    return { view, hotkey: free }
  })
}

/** The view a bare key switches to, if any. */
export function viewForHotkey(key: string): BoardViewPlugin | undefined {
  return viewHotkeys().find(each => each.hotkey === key)?.view
}

/** The view an id names, or the Desk when no registered view answers to it. */
export function viewOrDesk(id: BoardViewId): BoardViewId {
  return getView(id) ? id : DESK_VIEW
}

/** What the board calls a view: a registered view's title, else `Desk`. */
export function viewTitle(id: BoardViewId): string {
  return getView(id)?.title ?? 'Desk'
}

// ── View fallback ────────────────────────────────────────────────────────────

/** What the chassis should put in the view host when a view cannot be given a
 *  context: nothing (mount the real view), or one of two stand-in pages. */
export type ViewFallbackKind = 'none' | 'loading' | 'error'

/**
 * Which stand-in a temporal view needs right now.
 *
 * A view is only ever mounted with a real `KanbanResponse`, so before the first
 * one lands there is nothing to mount. A blank page cannot be told from a
 * broken one, so the chassis puts up a stand-in that says which it is.
 *
 * `error` outranks `loading`: once a fetch has failed, "waiting" is a lie, and
 * a stale error is still the truest thing we know.
 */
export function viewFallbackKind(state: {
  onDesk: boolean
  hasResponse: boolean
  lastFetchFailed: boolean
}): ViewFallbackKind {
  if (state.onDesk) return 'none'
  if (state.hasResponse) return 'none'
  return state.lastFetchFailed ? 'error' : 'loading'
}

// ── Hotkey guard ─────────────────────────────────────────────────────────────
//
// The chassis runs bare-key hotkeys — the 1-9 view switch and the bare `,` for
// settings — and each must agree on when a keystroke is NOT theirs. These are
// the shared predicates, so the next dialog added to the app is covered by
// every bare key at once.

/** The board's own root. It carries `role="dialog" aria-modal="true"`, so a
 *  naive "is a modal dialog open?" query matches the board itself. */
const BOARD_ROOT_CLASS = 'kbn-modal'

/** Is the keystroke going into a text field? */
export function isTypingTarget(
  el: { tagName: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true
}

/**
 * Is this dialog element something layered OVER the board, rather than the
 * board itself?
 *
 * The exclusion is the whole subtlety. `.kbn-modal` is `role="dialog"
 * aria-modal="true"` — it is the board — so a query broad enough to catch a
 * form dialog also catches the page it is protecting, and the
 * hotkeys would be dead permanently rather than only while a form is open.
 */
export function isBlockingDialog(
  el: { classList: { contains(token: string): boolean } } | null | undefined,
): boolean {
  if (!el) return false
  return !el.classList.contains(BOARD_ROOT_CLASS)
}

/**
 * Selector for anything that takes keystrokes away from the board.
 *
 * `[data-open]` is the SDK dialog's open stamp — Stash, Capture and the
 * settings sheet all render through `AppDialog`. `[aria-modal="true"]` catches
 * every modal dialog, a hand-rolled one included: without this clause
 * `1`-`2` would switch views out from under it. Matching on aria rather than on
 * a library's attribute means a dialog built outside AppDialog is covered
 * without a code change here. A native `<dialog>` the board opens with
 * `showModal()` exposes its modality without the attribute, so `dialog[open]`
 * names it. An open menu owns keys too, despite being non-modal: SDK menus and
 * Listen's options both mark it with `data-open`.
 */
export const BLOCKING_DIALOG_SELECTOR =
  '[role="dialog"][data-open], [role="dialog"][aria-modal="true"], [role="menu"][data-open], dialog[open]'

/**
 * Is a dialog or SDK menu currently taking keys away from the board?
 *
 * The second half of `keystrokeIsSpokenFor` on its own, because a modifier
 * CHORD wants this half without the first: `⌘,` is not typing, wherever the
 * caret happens to be, but it must still not stack a second dialog on top of
 * an open one.
 */
export function blockingDialogOpen(): boolean {
  for (const el of document.querySelectorAll(BLOCKING_DIALOG_SELECTOR)) {
    if (isBlockingDialog(el)) return true
  }
  return false
}

/**
 * True when a bare keystroke belongs to something other than the board: a text
 * field has focus, or a dialog is layered over it.
 *
 * THE predicate — every bare-key handler calls this rather than keeping its own
 * copy, so they cannot drift apart.
 */
export function keystrokeIsSpokenFor(): boolean {
  if (isTypingTarget(document.activeElement as HTMLElement | null)) return true
  return blockingDialogOpen()
}

/** What kind of settings keystroke this is, if any. */
export type SettingsHotkey = 'chord' | 'bare'

/** The shape `settingsHotkey` reads — a `KeyboardEvent`, or a test's stand-in. */
export interface HotkeyLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * Does this keystroke ask for settings, and in which of the two ways?
 *
 * Two openings, because the board is two things at once. On a keyboard it is
 * an application, and an application's preferences are `⌘,` — the one chord
 * a Mac user tries without being told. On the board itself every other page is
 * a BARE key (`1`–`2`), and a phone's keyboard has no `⌘` at all, so a bare `,`
 * opens it too. `,` is free: the chassis owns only the digits.
 *
 * Pure, and it deliberately does NOT consult the DOM — the two kinds are
 * guarded differently and the caller applies the guard:
 *
 *   - `'chord'` is inert only while another dialog is layered over the board
 *     (`blockingDialogOpen`), not while a field has focus. A modifier chord is
 *     never typing, and refusing it inside the Find box would
 *     make the one universal shortcut the least reliable one.
 *   - `'bare'` follows the same rule as every other bare key
 *     (`keystrokeIsSpokenFor`), because a lone `,` in a text field is a comma.
 *
 * `Alt`/`Shift` disqualify both: `⌥,` and `⇧,` are keystrokes someone meant for
 * something else, and on several layouts `⌥,` is a character.
 */
export function settingsHotkey(e: HotkeyLike): SettingsHotkey | null {
  if (e.key !== ',') return null
  if (e.altKey || e.shiftKey) return null
  if (e.metaKey || e.ctrlKey) return 'chord'
  return 'bare'
}

/**
 * Flatten a board response into one card list — the `cards` a ViewContext
 * carries. Surface order is the page's own top-to-bottom reading order
 * (timeline, then the Now lanes, Roles, then stash); a card that
 * projects onto two surfaces appears once, at its first.
 */
export function collectCards(response: KanbanResponse): KanbanCard[] {
  const seen = new Set<string>()
  const out: KanbanCard[] = []
  const take = (list: KanbanCard[]): void => {
    for (const card of list) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      out.push(card)
    }
  }
  take(response.timeline.past)
  take(response.timeline.futureDated)
  take(response.now.drafts)
  take(response.now.inFlight)
  take(response.now.awaitingReview)
  take(response.roles)
  take(response.stash)
  return out
}
