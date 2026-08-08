// Two chassis guards, both fixing a state that rendered as SILENCE.
//
// D1 — a temporal tab with no board response painted a completely blank page:
//      no heading, no message, no way back. A blank page and a broken app are
//      indistinguishable, so the two states now name themselves.
// M1 — bare hotkeys 1-4 switched views out from under an open Stash form,
//      because the guard only knew Radix's `data-state` and StashForm is
//      hand-rolled with `aria-modal` and no data-state.
//
// The DOM glue is verified in the browser; what is pinned here is the decision
// logic, which is where both defects actually lived.

import { describe, expect, it } from 'vitest'
import {
  BLOCKING_DIALOG_SELECTOR,
  isBlockingDialog,
  isTypingTarget,
  viewFallbackKind,
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
