// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
// @ts-expect-error Node types are excluded from the browser UI's tsconfig.
import { readFileSync } from 'node:fs'
import { instantStamp } from '../../sdk/civilDay.js'
import { relative, retime, timeEl } from './time.js'

const now = 1_800_000_000_000, minute = 60_000, hour = 60 * minute, day = 24 * hour

describe('the elements\' time', () => {
  it('reads now, then minutes, hours under a day, then days, all ago', () => {
    expect([0.5 * minute, minute, 59 * minute, hour, 23 * hour + 59 * minute, day, 30 * day].map(span => relative(now - span, now)))
      .toStrictEqual(['now', '1m ago', '59m ago', '1h ago', '23h ago', '1d ago', '30d ago'])
    expect([relative(now + hour, now), relative(0, now), relative(NaN, now)]).toStrictEqual(['now', '', ''])
  })
  it('is drawn relative with the instant in full on hover, and brought up to date in place', () => {
    const time = timeEl(now - 5 * minute, now, 'kbn-ch-age')
    expect([time.tagName, time.className, time.textContent, time.title]).toStrictEqual(['TIME', 'el-time kbn-ch-age', '5m ago', instantStamp(now - 5 * minute)])
    const box = document.createElement('div')
    box.append(time)
    retime(box, now + 2 * hour)
    expect(time.textContent).toBe('2h ago')
  })
  it('is set in mono at meta size, muted, with tabular numerals', () => {
    const css: string = readFileSync('src/board/elements/time.css', 'utf8')
    expect(css).toContain('font: var(--type-meta)/var(--leading-ui) var(--font-mono)')
    expect(css).toContain('font-variant-numeric: tabular-nums')
    expect(css).toContain('color: var(--ws-ink-muted)')
  })
})
