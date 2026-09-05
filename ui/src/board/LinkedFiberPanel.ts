/**
 * LinkedFiberPanel — the one window followed [[wikilinks]] open into.
 *
 * Following a reference used to open another floating card: follow three and
 * the screen was three cards deep, each with its own frame to move, size and
 * close, and the reader spent more attention arranging windows than reading
 * fibers. There are now exactly two panes for a reading, ever — the ORIGIN card
 * the reader opened from the board, and this panel beside it, where every
 * fiber reached by following a link lands as a TAB.
 *
 * The idiom is deliberately the sent-file viewer's, not a third one: the same
 * `kbn-fileview-window` frame, the same chrome bar that IS the tab strip, the
 * same `buildTabButton`/`buildViewCell` elements from `ReaderChrome`, the same
 * `ReaderTabs` arithmetic underneath (`linkedTabs` adds only the routing a
 * wikilink click needs). A reader who has opened a card's deliverables already
 * knows how this works, because it is the same thing holding fibers instead of
 * files.
 *
 * What it does NOT own: the fiber cards themselves. `mount` is supplied by the
 * card that opened the panel — it builds a `FiberDetailModal` hosted inside a
 * cell — so this module never imports the panel it fills, and the tab set stays
 * separable from what a tab happens to contain.
 *
 * Lifecycle: the panel is created on the first followed link and dies with its
 * last tab (or its ✕, or the origin card). Escape closes the tab being read,
 * so a reader retraces the path they walked one fiber per press.
 */

import { buildReaderWindow, buildTabButton, buildViewCell } from './ReaderChrome.js'
import { activateTab, emptyTabState, type TabState } from './ReaderTabs.js'
import { closeLinkedTab, insertTab, routeWikilink } from './linkedTabs.js'
import { isMobileViewport } from './mobile.js'
import { holdSheet, SHEET_LINKED } from './sheetHistory.js'
import {
  applyPanelGeometry,
  attachPanelDrag,
  attachPanelResize,
  bringPanelToFront,
  fittedGeometry,
  halfAndHalf,
  isTopPanel,
  readPanelGeometry,
  registerPanel,
  unregisterPanel,
  type PanelGeometry,
} from './FloatingPanelChrome.js'

/** A fiber card mounted in a tab's cell, as far as the panel needs to know it:
 *  what to write on the tab, and how to take it down. */
export interface LinkedCardHandle {
  label: string
  close(): void
}

export interface LinkedFiberPanelOpts {
  /** The fiber the origin card is showing. A link naming it raises that card
   *  rather than opening a tab of the page you are reading from. */
  originFiberId: () => string | null
  /** Raise the origin card — the answer to a link pointing back at it. */
  focusOrigin: () => void
  /**
   * Build the fiber's card inside `host`. Resolves null when the daemon cannot
   * serve the fiber, and the tab that was opened for it is withdrawn.
   * `requestClose` is handed to the card so its own × closes this tab.
   */
  mount: (
    fiberId: string,
    host: HTMLElement,
    requestClose: () => void,
  ) => Promise<LinkedCardHandle | null>
  /** Place the origin card when the panel first opens (the half-and-half
   *  glide). The card owns its own geometry bookkeeping, so it does the move. */
  placeOrigin: (g: PanelGeometry) => void
  /** The panel is gone — the card that opened it drops its reference. */
  onClosed: () => void
}

interface LinkedTabEntry {
  /** The fiber id — the tab's identity, named `path` for `ReaderTabs`. */
  path: string
  tab: HTMLElement
  cell: HTMLElement
  handle: LinkedCardHandle | null
}

export class LinkedFiberPanel {
  private readonly opts: LinkedFiberPanelOpts
  private win: HTMLElement | null = null
  private tabStrip: HTMLElement | null = null
  private views: HTMLElement | null = null
  private state: TabState<LinkedTabEntry> = emptyTabState<LinkedTabEntry>()
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null
  private resizeHandler: (() => void) | null = null
  private geom: PanelGeometry | null = null

  constructor(opts: LinkedFiberPanelOpts) {
    this.opts = opts
  }

  /** The window element, so the card that owns the panel can treat a click on
   *  it as a click inside the reading rather than away from it. */
  get element(): HTMLElement | null {
    return this.win
  }

  /**
   * Follow a reference. Already showing on the origin card → raise it; already
   * a tab → show that tab; otherwise open a tab and fill it.
   *
   * The tab appears BEFORE the fiber loads, carrying the id it was opened
   * under. A reader who clicks gets a visible answer immediately, and a second
   * click on the same reference finds the tab and focuses it rather than
   * starting a second load.
   */
  open(fiberId: string): void {
    const route = routeWikilink(this.state, this.opts.originFiberId(), fiberId)
    if (route === 'origin') {
      this.opts.focusOrigin()
      return
    }
    if (route === 'focus') {
      this.state = activateTab(this.state, fiberId)
      this.render()
      this.raise()
      return
    }

    this.ensureWindow()
    const label = fiberId.split('/').pop() || fiberId
    const { tab, closeBtn } = buildTabButton(label, fiberId)
    const cell = buildViewCell()
    cell.classList.add('kbn-linkview-cell')
    const entry: LinkedTabEntry = { path: fiberId, tab, cell, handle: null }

    tab.addEventListener('click', () => {
      this.state = activateTab(this.state, fiberId)
      this.render()
    })
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.closeFiber(fiberId)
    })

    const { state, kept } = insertTab(this.state, entry)
    this.state = state
    if (!kept) {
      // A second click resolved into a tab that already exists — throw away the
      // DOM built for it rather than mount a duplicate.
      this.render()
      return
    }
    this.tabStrip?.append(tab)
    this.views?.append(cell)
    this.render()
    this.raise()

    void this.opts.mount(fiberId, cell, () => this.closeFiber(fiberId)).then((handle) => {
      // The tab may have been closed (or the whole panel) while the fiber
      // loaded; a handle with nowhere to live is taken straight down.
      const live = this.state.tabs.find((t) => t.path === fiberId)
      if (!live) {
        handle?.close()
        return
      }
      if (!handle) {
        this.closeFiber(fiberId)
        return
      }
      live.handle = handle
      const name = live.tab.querySelector('.kbn-detail-tab-name')
      if (name) name.textContent = handle.label
      live.tab.setAttribute('aria-label', handle.label)
    })
  }

  /** Close one fiber's tab. The panel closes with its last one. */
  closeFiber(fiberId: string): void {
    const { state, closed, empty } = closeLinkedTab(this.state, fiberId)
    if (!closed) return
    this.state = state
    closed.handle?.close()
    closed.tab.remove()
    closed.cell.remove()
    if (empty) {
      this.close()
      return
    }
    this.render()
  }

  /** Tear the whole panel down — its ✕, its last tab, or the origin card
   *  closing. Every tab's card goes with it. */
  close(): void {
    for (const entry of this.state.tabs) entry.handle?.close()
    this.state = emptyTabState<LinkedTabEntry>()
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler, true)
      this.escapeHandler = null
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler)
      this.resizeHandler = null
    }
    if (this.win) {
      if (this.win.classList.contains('kbn-detail-sheet')) holdSheet(SHEET_LINKED, false)
      unregisterPanel(this.win)
      this.win.remove()
      this.win = null
    }
    this.tabStrip = null
    this.views = null
    this.opts.onClosed()
  }

  private raise(): void {
    if (this.win) bringPanelToFront(this.win)
  }

  /** Show the active tab's cell, hide the rest, light its tab. */
  private render(): void {
    for (const entry of this.state.tabs) {
      const on = entry.path === this.state.active
      entry.cell.hidden = !on
      entry.tab.classList.toggle('kbn-detail-tab-active', on)
      entry.tab.setAttribute('aria-selected', String(on))
    }
  }

  /** Build the window on the first followed link. Idempotent. */
  private ensureWindow(): void {
    if (this.win) return

    const { win, bar, tabs, closeBtn: winClose, views } = buildReaderWindow({
      ariaLabel: 'Followed references',
      extraClass: 'kbn-linkview-window',
      closeLabel: 'Close followed references',
      closeTitle: 'Close every followed fiber',
    })
    winClose.addEventListener('click', (e) => {
      e.stopPropagation()
      this.close()
    })

    // Placement: the reading splits the screen — the origin card takes the left
    // half, the followed references the right. Remembered within the panel's
    // life, so a reader who moves it keeps their arrangement across tabs.
    //
    // A PHONE HAS NO HALVES. Below the mobile threshold the panel becomes a
    // sheet over the card it was opened from — one full-viewport reading at a
    // time — and the card keeps its own place underneath, to be returned to
    // when the last followed reference is closed. No geometry is written in
    // this mode (an inline `left` would outrank the sheet's `inset`), the
    // origin card is not shoved aside, and there is nothing to drag or resize.
    const sheet = isMobileViewport()
    if (sheet) {
      win.classList.add('kbn-detail-sheet')
      // Its own back-entry, above the card's. Following a reference on a phone
      // is a navigation, so the back gesture must return to the fiber you came
      // from rather than dismissing it along with the reference.
      holdSheet(SHEET_LINKED, true, () => this.close())
    } else {
      const { card, other } = halfAndHalf()
      this.opts.placeOrigin(card)
      this.geom = other
      applyPanelGeometry(win, other)

      const remember = () => {
        this.geom = readPanelGeometry(win)
      }
      attachPanelDrag(win, bar, { onSettle: remember })
      attachPanelResize(win, {
        onSettle: remember,
      })
    }
    win.addEventListener('pointerdown', () => bringPanelToFront(win), true)

    // Escape closes the fiber being read, not the whole panel: a reading
    // unwinds one reference per press, the way following them built it up. Only
    // when this is the newest window on screen — otherwise the card or dialog
    // opened after it has the key.
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!this.win || !isTopPanel(this.win)) return
      if (document.activeElement?.closest('.kbn-detail-parent-dropdown')) return
      const active = this.state.active
      if (!active) return
      e.stopPropagation()
      this.closeFiber(active)
    }
    document.addEventListener('keydown', this.escapeHandler, true)

    // A shrinking window strands a fixed panel the same way a geometry saved on
    // a bigger display does — refit in place.
    this.resizeHandler = () => {
      // A sheet has no geometry; the viewport is its frame.
      if (!this.win || !this.geom || this.win.classList.contains('kbn-detail-sheet')) return
      this.geom = fittedGeometry(readPanelGeometry(this.win))
      applyPanelGeometry(this.win, this.geom)
    }
    window.addEventListener('resize', this.resizeHandler)

    this.win = win
    this.tabStrip = tabs
    this.views = views
    document.body.append(win)
    registerPanel(win)
    bringPanelToFront(win)
  }
}
