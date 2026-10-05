// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChannel } from './documents.js'
import { ReceiptArrivals, ReceiptMotion } from './receiptMotion.js'

const channel = (time: number, owner = 'host') => buildChannel({
  uid: 'music', owner, name: 'Music', path: '/music/music.md', fiberDir: '/music', body: '',
  sent: [{ path: 'report.html', time, session: 'worker' }],
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('receipt arrival baselines', () => {
  it('does not animate first-load hydration, metadata, or receipt feed order', () => {
    const arrivals = new ReceiptArrivals()
    expect(arrivals.observe(channel(10), false).size).toBe(0)
    expect(arrivals.observe(channel(10), true).size).toBe(0)
    expect(arrivals.observe({ ...channel(10), name: 'Renamed music' }, true).size).toBe(0)
    expect([...arrivals.observe(channel(20), true)]).toEqual(['host:/music/report.html'])
    expect(arrivals.observe(channel(20), true).size).toBe(0)
  })
  it('separates owner/channel identities and receipts from file mtime', () => {
    const arrivals = new ReceiptArrivals()
    arrivals.observe(channel(10), true)
    expect(arrivals.observe(channel(20, 'other'), true).size).toBe(0)
    const next = channel(10)
    next.documents[1].modifiedAt = '2026-10-04T14:00:00Z'
    expect(arrivals.observe(next, true).size).toBe(0)
  })
})
describe('receipt motion', () => {
  it('uses one 280 ms crossing for tabs and a single 400 ms folio lift', () => {
    const el = document.createElement('div')
    const animation = { addEventListener: vi.fn(), cancel: vi.fn() }
    el.animate = vi.fn(() => animation as unknown as Animation)
    const motion = new ReceiptMotion()
    motion.tab(el); motion.folio(el)
    expect(el.animate).toHaveBeenNthCalledWith(1, [
      { transform: 'translateX(-24px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 },
    ], { duration: 280, easing: 'ease' })
    expect(vi.mocked(el.animate).mock.calls[1][1]).toEqual({ duration: 400, easing: 'ease' })
    expect(vi.mocked(el.animate).mock.calls[1][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ transform: 'translateY(-4px)', offset: 0.5 }),
    ]))
    motion.dispose()
    expect(animation.cancel).toHaveBeenCalled()
  })
  it('runs neither animation under reduced motion and cancels when the preference changes', () => {
    let onChange!: () => void
    const preference = { matches: false, addEventListener: (_: string, fn: () => void) => { onChange = fn }, removeEventListener: vi.fn() }
    vi.stubGlobal('matchMedia', () => preference)
    const animation = { addEventListener: vi.fn(), cancel: vi.fn() }
    const el = document.createElement('div')
    el.animate = vi.fn(() => animation as unknown as Animation)
    const motion = new ReceiptMotion()
    motion.tab(el)
    preference.matches = true
    onChange()
    expect(animation.cancel).toHaveBeenCalledTimes(1)
    motion.tab(el); motion.folio(el)
    expect(el.animate).toHaveBeenCalledTimes(1)
    motion.dispose()
  })
})
