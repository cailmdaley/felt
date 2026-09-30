import { describe, expect, it } from 'vitest'

import { coarsePointer, isMobileViewport, readerFillsScreen } from './mobile.js'
import {
  DESKTOP,
  DESKTOP_NARROW,
  DESKTOP_SHORT,
  IPAD_LANDSCAPE,
  IPAD_PORTRAIT,
  PHONE_LANDSCAPE,
  PHONE_PORTRAIT,
  matchMediaFor,
  type Device,
} from './testDevices.js'

/** The three predicates, answered for the devices the board actually meets. */
const winFor = (d: Device): Pick<Window, 'matchMedia'> => ({ matchMedia: matchMediaFor(d) })

describe('the mobile contract, by device', () => {
  it.each([
    ['phone portrait', PHONE_PORTRAIT, { mobile: true, reader: true, coarse: true }],
    ['phone landscape', PHONE_LANDSCAPE, { mobile: true, reader: true, coarse: true }],
    ['iPad portrait', IPAD_PORTRAIT, { mobile: false, reader: true, coarse: true }],
    ['iPad landscape', IPAD_LANDSCAPE, { mobile: false, reader: true, coarse: true }],
    ['desktop', DESKTOP, { mobile: false, reader: false, coarse: false }],
    ['narrow desktop window', DESKTOP_NARROW, { mobile: true, reader: true, coarse: false }],
    ['short desktop window', DESKTOP_SHORT, { mobile: false, reader: false, coarse: false }],
  ])('%s', (_name, device, want) => {
    const win = winFor(device)
    expect({
      mobile: isMobileViewport(win),
      reader: readerFillsScreen(win),
      coarse: coarsePointer(win),
    }).toEqual(want)
  })

  // Wherever the card is a sheet, a file opened from it must be one too, or a
  // phone would get a floating window over a full-screen card.
  it('every mobile viewport also fills the screen with the reader', () => {
    for (const d of [PHONE_PORTRAIT, PHONE_LANDSCAPE, DESKTOP_NARROW]) {
      expect(isMobileViewport(winFor(d))).toBe(true)
      expect(readerFillsScreen(winFor(d))).toBe(true)
    }
  })

  it('answers false where matchMedia is missing', () => {
    expect(readerFillsScreen({} as Pick<Window, 'matchMedia'>)).toBe(false)
  })
})
