import { describe, expect, it } from 'vitest'

import { coarsePointer, isMobileViewport } from './mobile.js'
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

/** The layout and primary-pointer predicates for the devices the board meets. */
const winFor = (d: Device): Pick<Window, 'matchMedia'> => ({ matchMedia: matchMediaFor(d) })

describe('the mobile contract, by device', () => {
  it.each([
    ['phone portrait', PHONE_PORTRAIT, { mobile: true, coarse: true }],
    ['phone landscape', PHONE_LANDSCAPE, { mobile: true, coarse: true }],
    ['iPad portrait', IPAD_PORTRAIT, { mobile: false, coarse: true }],
    ['iPad landscape', IPAD_LANDSCAPE, { mobile: false, coarse: true }],
    ['desktop', DESKTOP, { mobile: false, coarse: false }],
    ['narrow desktop window', DESKTOP_NARROW, { mobile: true, coarse: false }],
    ['short desktop window', DESKTOP_SHORT, { mobile: false, coarse: false }],
  ])('%s', (_name, device, want) => {
    const win = winFor(device)
    expect({ mobile: isMobileViewport(win), coarse: coarsePointer(win) }).toEqual(want)
  })

  it('answers false where matchMedia is missing', () => {
    const win = {} as Pick<Window, 'matchMedia'>
    expect(isMobileViewport(win)).toBe(false)
    expect(coarsePointer(win)).toBe(false)
  })
})
