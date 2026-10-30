import { describe, expect, it } from 'vitest'
import { ago, clockTime, zone } from './civilDay.js'

describe('board clocks', () => {
  it('formats wall time in the requested zone', () => {
    const ms = Date.UTC(2026, 0, 1, 0, 20)
    expect(clockTime(ms, zone('UTC'))).toBe('00:20')
    expect(clockTime(ms, zone('Asia/Kathmandu'))).toBe('06:05')
  })
  it('uses elapsed-time thresholds, with optional seconds', () => {
    const now = 100 * 86_400_000
    for (const [elapsed, expected] of [
      [0, 'just now'], [59_999, 'just now'], [60_000, '1m ago'],
      [3_599_999, '59m ago'], [3_600_000, '1h ago'],
      [48 * 3_600_000 - 1, '47h ago'], [48 * 3_600_000, '2d ago'],
      [60 * 86_400_000 - 1, '59d ago'], [60 * 86_400_000, '2mo ago'],
    ] as const) expect(ago(now - elapsed, now)).toBe(expected)
    expect(ago(now - 4_000, now, { seconds: true })).toBe('4s ago')
    expect(ago(now + 1_000, now)).toBe('just now')
  })
})
