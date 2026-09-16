// The chassis guards. Two of them fix a state that rendered as SILENCE; the
// third — the settings hotkey — is the same family of hazard caught before it
// had a chance to.
//
// D1 — a temporal tab with no board response painted a completely blank page:
//      no heading, no message, no way back. A blank page and a broken app are
//      indistinguishable, so the two states now name themselves.
// M1 — bare hotkeys 1-4 switched views out from under an open Stash form,
//      because the guard only knew Radix's `data-state` and StashForm is
//      hand-rolled with `aria-modal` and no data-state.
// S1 — `⌘,` and bare `,` both open settings, and they are guarded
//      DIFFERENTLY: the chord survives a focused text field, the bare key does
//      not. That asymmetry is the whole reason `settingsHotkey` reports WHICH
//      it saw and the reason `blockingDialogOpen` exists as the dialog half of
//      `keystrokeIsSpokenFor` without the typing half. Guard the chord with
//      the whole predicate and the one shortcut a Mac user tries unprompted is
//      dead in the Chronicle's search box — the single place a person is most
//      likely to be typing when they reach for it.
// S2 — settings is dispatched BEFORE the view hotkeys, so every key
//      `settingsHotkey` answers for is a key `1`-`5` never sees. A predicate
//      that got generous would shadow the view strip without a word.
//
// KanbanModal composes S1 as `kind === 'chord' ? blockingDialogOpen() :
// keystrokeIsSpokenFor()`; both halves of that ternary are pinned below, side
// by side, because the composition is only correct if they DISAGREE about a
// focused field.
//
// The DOM glue is verified in the browser; what is pinned here is the decision
// logic, which is where the defects lived. The one exception is the dialog
// scan, which is handed hand-made elements and evaluates the real selector
// against them — there the selector IS the decision.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLOCKING_DIALOG_SELECTOR,
  blockingDialogOpen,
  isBlockingDialog,
  isTypingTarget,
  keystrokeIsSpokenFor,
  settingsHotkey,
  viewFallbackKind,
  type HotkeyLike,
} from './ViewRegistry.js'

describe('viewFallbackKind', () => {
  it('shows nothing on the Desk, which renders its own error surface', () => {
    expect(viewFallbackKind({ onDesk: true, hasResponse: false, lastFetchFailed: true }))
      .toBe('none')
  })

  it('shows nothing once a response exists — the real view mounts', () => {
    expect(viewFallbackKind({ onDesk: false, hasResponse: true, lastFetchFailed: false }))
      .toBe('none')
  })

  it('waits before the first response rather than claiming a failure', () => {
    expect(viewFallbackKind({ onDesk: false, hasResponse: false, lastFetchFailed: false }))
      .toBe('loading')
  })

  it('reports the error once a fetch has failed', () => {
    // THE defect: this combination used to render nothing at all.
    expect(viewFallbackKind({ onDesk: false, hasResponse: false, lastFetchFailed: true }))
      .toBe('error')
  })

  it('lets a landed response outrank a past failure', () => {
    // A stale error over a page that has data would be the wrong claim.
    expect(viewFallbackKind({ onDesk: false, hasResponse: true, lastFetchFailed: true }))
      .toBe('none')
  })
})

describe('isTypingTarget', () => {
  it('claims the keystroke for text-entry elements', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName })).toBe(true)
    }
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('leaves it to the board for everything else', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false)
    expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })
})

describe('isBlockingDialog', () => {
  const el = (...classes: string[]) => ({
    classList: { contains: (t: string) => classes.includes(t) },
  })

  it('treats a dialog layered over the board as blocking', () => {
    expect(isBlockingDialog(el('kbn-detail-overlay'))).toBe(true)
    expect(isBlockingDialog(el('stash-form'))).toBe(true)
    expect(isBlockingDialog(el())).toBe(true)
  })

  it('does NOT treat the board root as blocking', () => {
    // `.kbn-modal` is itself role=dialog aria-modal=true. Without this
    // exclusion the broadened selector matches the very page it protects and
    // the hotkeys die permanently instead of only while a form is open.
    expect(isBlockingDialog(el('kbn-modal'))).toBe(false)
  })

  it('is false for nothing', () => {
    expect(isBlockingDialog(null)).toBe(false)
  })
})

describe('BLOCKING_DIALOG_SELECTOR', () => {
  it('covers Radix, hand-rolled aria dialogs, and the fiber panel', () => {
    // StashForm is the hand-rolled case that M1 missed: role="dialog"
    // aria-modal="true", no data-state anywhere.
    expect(BLOCKING_DIALOG_SELECTOR).toContain('[role="dialog"][data-state="open"]')
    expect(BLOCKING_DIALOG_SELECTOR).toContain('[role="dialog"][aria-modal="true"]')
    expect(BLOCKING_DIALOG_SELECTOR).toContain('.kbn-detail-overlay')
  })
})

describe('settingsHotkey', () => {
  const stroke = (key: string, mods: Omit<HotkeyLike, 'key'> = {}): HotkeyLike => ({ key, ...mods })

  it('reads a bare comma as the board-native opening', () => {
    // A phone's keyboard has no ⌘ at all, and every other page on this board
    // is already a bare key — so the sheet has to be reachable without one.
    expect(settingsHotkey(stroke(','))).toBe('bare')
  })

  it('reads ⌘, and Ctrl+, as the application chord', () => {
    // The two are one gesture, not two: whichever key a platform calls its
    // own, a user pressing it means "preferences".
    expect(settingsHotkey(stroke(',', { metaKey: true }))).toBe('chord')
    expect(settingsHotkey(stroke(',', { ctrlKey: true }))).toBe('chord')
  })

  it('refuses ⌥, and ⇧, — they are someone else’s keystroke', () => {
    // ⌥, is a CHARACTER on several layouts, so a layout that types one would
    // otherwise open settings every time it was typed.
    expect(settingsHotkey(stroke(',', { altKey: true }))).toBeNull()
    expect(settingsHotkey(stroke(',', { shiftKey: true }))).toBeNull()
  })

  it('lets the disqualifiers outrank the chord, not the other way round', () => {
    // Order inside the predicate, pinned: alt/shift are checked BEFORE
    // meta/ctrl, so ⌘⌥, and ⌘⇧, are nobody's preferences shortcut. Swap the
    // two lines in `settingsHotkey` and these become 'chord'.
    expect(settingsHotkey(stroke(',', { metaKey: true, altKey: true }))).toBeNull()
    expect(settingsHotkey(stroke(',', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('answers for no other key, bare or chorded', () => {
    // S2. `1`-`5` are here because the settings dispatch runs first: if this
    // predicate ever answered for a digit, the view strip would go dead and
    // nothing would say why. `<` is here because it is what a US layout
    // actually reports for ⇧, — the modifier check above is the second line
    // of defence, not the only one. `.` is the neighbouring key.
    for (const key of ['.', '<', ';', '1', '2', '3', '4', '5', 't', 'Escape', 'Tab']) {
      expect(settingsHotkey(stroke(key))).toBeNull()
      expect(settingsHotkey(stroke(key, { metaKey: true }))).toBeNull()
    }
  })
})

describe('blockingDialogOpen beside keystrokeIsSpokenFor', () => {
  interface FakeEl {
    tagName: string
    isContentEditable: boolean
    classList: { contains(token: string): boolean }
    attrs: Record<string, string>
  }

  const el = (sketch: {
    tag?: string
    classes?: string[]
    attrs?: Record<string, string>
  }): FakeEl => ({
    tagName: sketch.tag ?? 'DIV',
    isContentEditable: false,
    classList: { contains: (token: string) => (sketch.classes ?? []).includes(token) },
    attrs: sketch.attrs ?? {},
  })

  /** Attribute and class tokens, which is all the selector is allowed to be. */
  const token = (): RegExp => /\[([\w-]+)="([^"]*)"\]|\.([\w-]+)/g

  /**
   * Really evaluate `BLOCKING_DIALOG_SELECTOR` against the sketches rather than
   * hand the guard a pre-filtered list. A pre-filtered list would pin nothing:
   * the question these cases ask is whether the selector REACHES a Radix
   * settings sheet and whether the board's own root survives it, and the
   * matching is the whole of the answer. Anything the matcher does not
   * understand throws, so a selector that outgrows it fails loudly instead of
   * quietly matching everything or nothing.
   */
  function matches(node: FakeEl, selector: string): boolean {
    return selector.split(',').some((group) => {
      const compound = group.trim()
      if (compound === '' || compound.replace(token(), '') !== '') {
        throw new Error(`the test matcher does not understand "${compound}"`)
      }
      for (const [, attr, value, cls] of compound.matchAll(token())) {
        if (cls) {
          if (!node.classList.contains(cls)) return false
        } else if (node.attrs[attr] !== value) return false
      }
      return true
    })
  }

  const stubDOM = (layered: FakeEl[], focused: FakeEl | null = null): void => {
    vi.stubGlobal('document', {
      activeElement: focused,
      querySelectorAll: (selector: string) => layered.filter((n) => matches(n, selector)),
    })
  }

  afterEach(() => vi.unstubAllGlobals())

  // The board itself. It is `role="dialog" aria-modal="true"`, so it matches
  // the selector — and it is always in the list, under everything else.
  const boardRoot = el({ classes: ['kbn-modal'], attrs: { role: 'dialog', 'aria-modal': 'true' } })
  // The settings sheet as AppDialog renders it: Radix, so `data-state`.
  const settingsSheet = el({
    classes: ['app-dialog-card', 'app-dialog-card-wide'],
    attrs: { role: 'dialog', 'data-state': 'open' },
  })
  // StashForm: hand-rolled, aria-modal, no data-state. M1's element.
  const stashForm = el({ classes: ['stash-form'], attrs: { role: 'dialog', 'aria-modal': 'true' } })
  const searchBox = el({ tag: 'INPUT' })

  it('both read a bare board as free', () => {
    stubDOM([boardRoot])
    expect(blockingDialogOpen()).toBe(false)
    expect(keystrokeIsSpokenFor()).toBe(false)
  })

  it('sweep up neither ordinary board chrome nor a dialog on its way out', () => {
    // The control case, and the one that keeps the three above honest: a guard
    // that matched everything would pass all of them. A card is not a dialog,
    // and a Radix sheet mid-exit still carries `data-state`, only "closed" —
    // which is why the selector pins the VALUE rather than the attribute.
    stubDOM([
      boardRoot,
      el({ classes: ['kbn-card'] }),
      el({ classes: ['app-dialog-card'], attrs: { role: 'dialog', 'data-state': 'closed' } }),
    ])
    expect(blockingDialogOpen()).toBe(false)
    expect(keystrokeIsSpokenFor()).toBe(false)
  })

  it('DISAGREE about a focused text field — which is what makes ⌘, work', () => {
    // S1, exactly. A caret in a search box speaks for `,` (there it is a
    // comma) and for `1`-`5`, but never for a modifier chord.
    stubDOM([boardRoot], searchBox)
    expect(keystrokeIsSpokenFor()).toBe(true)
    expect(blockingDialogOpen()).toBe(false)
  })

  it('both see the settings sheet, with no change to the selector', () => {
    // A Radix `AppDialog` is already what `[role="dialog"][data-state="open"]`
    // describes, so `,` and `1`-`5` go dead while settings is open — including
    // the `,` that would otherwise stack a second sheet on the first.
    //
    // The board root is listed FIRST, as it is in the document: it matches the
    // selector too, and a scan that answered from its first match alone would
    // report "nothing open" with a dialog sitting on top of it.
    stubDOM([boardRoot, settingsSheet])
    expect(blockingDialogOpen()).toBe(true)
    expect(keystrokeIsSpokenFor()).toBe(true)
  })

  it('both see a hand-rolled dialog too — M1 at the element it happened to', () => {
    stubDOM([boardRoot, stashForm], searchBox)
    expect(blockingDialogOpen()).toBe(true)
    expect(keystrokeIsSpokenFor()).toBe(true)
  })
})
