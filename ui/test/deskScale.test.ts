import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sheet = (name: string): string => readFileSync(resolve(__dirname, '../src/board', name), 'utf8')
const deskRows = sheet('deskRows.css')
const threads = sheet('threads.css')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`)
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '')
  return Object.fromEntries(body.split(';').map(d => d.split(':')).filter(p => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(':').trim()]))
}
const px = (value: string): number => Number(/([\d.]+)px/.exec(value)?.[1])

describe('the Desk reads at the board label size', () => {
  it('sets a row title at 14px or more, two lines at most, on a row of at least 34px', () => {
    const name = rule(deskRows, '.kbn-col-list .kbn-card .kbn-card-name')
    expect(px(name['font-size'])).toBeGreaterThanOrEqual(14)
    expect(name['-webkit-line-clamp']).toBe('2')
    expect(name['white-space']).toBeUndefined()
    const row = rule(deskRows, '.kbn-col-list .kbn-card')
    expect(px(row['min-height'])).toBeGreaterThanOrEqual(34)
    expect(px(row['min-height'])).toBeLessThanOrEqual(36)
  })

  it('steps the column heads down from the full-size 38px', () => {
    expect(px(rule(deskRows, '.kbn-now-board .kbn-col-title')['font-size'])).toBeLessThan(38)
  })

  it('draws a family tree line at 13–14px on a 24–26px line', () => {
    const line = px(rule(threads, '.kbn-thread-tree')['--tree-line'])
    expect(line).toBeGreaterThanOrEqual(24)
    expect(line).toBeLessThanOrEqual(26)
    const row = rule(threads, '.kbn-thread-tree .kbn-tree-line > .kbn-thread-row')
    expect(px(row['font-size'])).toBeGreaterThanOrEqual(13)
    expect(px(row['font-size'])).toBeLessThanOrEqual(14)
  })
})
