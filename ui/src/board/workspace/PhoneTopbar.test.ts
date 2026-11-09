// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneTopbar } from './PhoneGestures.js'

describe('PhoneTopbar', () => {
  let frames: FrameRequestCallback[]
  const flush = (): void => { for (let n = 0; n < 2; n++) frames.splice(0).forEach(frame => frame(0)) }
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('hides going down and shows going up, past a small reversal', () => {
    const shown: boolean[] = [], bar = new PhoneTopbar(hidden => shown.push(hidden))
    bar.select('page')
    bar.scroll('page', 20); flush()
    bar.scroll('page', 16)
    bar.scroll('page', 8); flush()
    expect(shown).toEqual([false, true, false])
  })

  it('ignores the scroll its own coming and going causes at the bottom of a page', () => {
    const shown: boolean[] = [], bar = new PhoneTopbar(hidden => shown.push(hidden))
    bar.select('page')
    bar.scroll('page', 64)
    // Hiding the bar heightens the page: the bottom clamps up, then anchoring brings it back.
    bar.scroll('page', 15)
    bar.scroll('page', 64)
    flush()
    expect(shown).toEqual([false, true])
    bar.scroll('page', 40)
    expect(shown).toEqual([false, true, false])
  })
})
