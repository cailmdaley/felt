import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sheet = (name: string): string => readFileSync(resolve(__dirname, '../src/board', name), 'utf8')
const deskRows = sheet('deskRows.css')
const frontier = sheet('deskFrontier.css')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`)
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0)
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '')
  return Object.fromEntries(body.split(';').map(d => d.split(':')).filter(p => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(':').trim()]))
}
const type = readFileSync(resolve(__dirname, '../src/styles/type.css'), 'utf8')
/** A length in px, reading a type role through styles/type.css. */
const px = (value: string): number => {
  const role = /var\((--(?:type|glyph)-[\w-]+)\)/.exec(value)?.[1]
  if (role) return px(new RegExp(`${role}:\\s*([^;]+);`).exec(type)?.[1] ?? '')
  return Number(/([\d.]+)px/.exec(value)?.[1])
}

describe('the Desk reads at the board label size', () => {
  it('sets a one-line row title at 14px or more, on a row of at least 34px', () => {
    const name = rule(deskRows, '.kbn-col-list .kbn-card .kbn-card-name')
    expect(px(name['font-size'])).toBeGreaterThanOrEqual(14)
    expect(name['white-space']).toBe('nowrap')
    expect(name['text-overflow']).toBe('ellipsis')
    const row = rule(deskRows, '.kbn-col-list .kbn-card')
    expect(px(row['min-height'])).toBeGreaterThanOrEqual(34)
    expect(px(row['min-height'])).toBeLessThanOrEqual(36)
  })

  it('steps the column heads down from the full-size 38px', () => {
    expect(px(rule(deskRows, '.kbn-now-board .kbn-col-title')['font-size'])).toBeLessThan(38)
  })

  it('draws a thread crumb smaller than the name and keeps it on one line', () => {
    const row = rule(frontier, '.kbn-card-crumb')
    expect(px(row['font-size'])).toBeLessThan(px(rule(deskRows, '.kbn-col-list .kbn-card .kbn-card-name')['font-size']))
    expect(row['white-space']).toBe('nowrap')
    expect(row.color).toBe('var(--kbn-ink-muted)')
  })
})

describe('pigment on the Desk is state', () => {
  it('uses gold for human turns, blue for work, muted for starting, and paper for quiet dots', () => {
    const dots = sheet('stateDot.css')
    expect(rule(dots, '.constitution-state-dot')['--state-dot']).toBe('var(--kbn-paper)')
    expect(rule(dots, ":is(.constitution-state-dot, .ws-transcript-spawn-chip)[data-turn='working']")['--state-dot']).toBe('var(--kbn-agent)')
    expect(rule(dots, ":is(.constitution-state-dot, .ws-transcript-spawn-chip):is([data-turn='idle'], [data-turn='question'])")['--state-dot']).toBe('var(--kbn-owed-bright)')
    expect(rule(dots, ":is(.constitution-state-dot, .ws-transcript-spawn-chip):is([data-turn='starting'], [data-turn='no-signal'], [data-turn='blocked'])")['--state-dot']).toBe('var(--kbn-ink-muted)')
  })
})

describe('Drafts recede behind the live columns', () => {
  it('sets a draft title in regular weight and softer ink, with no box of its own', () => {
    const live = rule(deskRows, '.kbn-col-list .kbn-card .kbn-card-name')
    const draft = rule(deskRows, '.kbn-col-list .kbn-card.kbn-card-drafts .kbn-card-name')
    expect(Number(draft['font-weight'])).toBeLessThan(Number(live['font-weight']))
    expect(draft.color).toBe('var(--kbn-ink-soft)')
    expect(rule(deskRows, '.kbn-col-list .kbn-card.kbn-card-drafts')['border-color']).toBe('transparent')
  })
})
