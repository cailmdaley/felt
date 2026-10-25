// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReceiptMotion } from './receiptMotion.js'
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('receipt motion', () => {
  it('uses a single 400 ms folio lift', () => {
    const el = document.createElement('div')
    const animation = { addEventListener: vi.fn(), cancel: vi.fn() }
    el.animate = vi.fn(() => animation as unknown as Animation)
    const motion = new ReceiptMotion()
    motion.folio(el)
    expect(el.animate).toHaveBeenCalledOnce()
    expect(vi.mocked(el.animate).mock.calls[0][1]).toEqual({ duration: 400, easing: 'ease' })
    expect(vi.mocked(el.animate).mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ transform: 'translateY(-4px)', offset: 0.5 }),
    ]))
    motion.dispose()
    expect(animation.cancel).toHaveBeenCalled()
  })
  it('skips animation under reduced motion and cancels when the preference changes', () => {
    let onChange!: () => void
    const preference = { matches: false, addEventListener: (_: string, fn: () => void) => { onChange = fn }, removeEventListener: vi.fn() }
    vi.stubGlobal('matchMedia', () => preference)
    const animation = { addEventListener: vi.fn(), cancel: vi.fn() }
    const el = document.createElement('div')
    el.animate = vi.fn(() => animation as unknown as Animation)
    const motion = new ReceiptMotion()
    motion.folio(el)
    preference.matches = true
    onChange()
    expect(animation.cancel).toHaveBeenCalledTimes(1)
    motion.folio(el)
    expect(el.animate).toHaveBeenCalledTimes(1)
    motion.dispose()
  })
})
