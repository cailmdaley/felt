import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const sheet = (name: string): string => readFileSync(resolve(__dirname, '../src/board', name), 'utf8')
const desk = sheet('desk.css')

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
  it('sets a family as dense mono lines: the slug at the meta size, on a row of 22px, cut by an ellipsis', () => {
    expect(rule(desk, '.kbn-family').font).toMatch(/var\(--type-meta\).*var\(--font-mono\)/)
    const name = rule(desk, '.kbn-family-name')
    expect([name['white-space'], name['text-overflow']]).toEqual(['nowrap', 'ellipsis'])
    expect(rule(desk, '.kbn-family-head')['min-height']).toBe('var(--kbn-desk-row)')
    expect(/--kbn-desk-row:\s*22px/.test(desk)).toBe(true)
  })

  it('gives what a waiting member wants one line, cut short by an ellipsis', () => {
    const want = rule(desk, '.kbn-family-want')
    expect([want['white-space'], want['text-overflow']]).toEqual(['nowrap', 'ellipsis'])
  })
})

describe('pigment on the Desk is state', () => {
  it('uses gold for what waits on the human, blue for work, and paper for quiet dots', () => {
    const dots = sheet('stateDot.css')
    expect(rule(dots, '.constitution-state-dot')['--state-dot']).toBe('var(--kbn-paper)')
    expect(rule(dots, ".constitution-state-dot[data-attention='waiting']")['--state-dot']).toBe('var(--kbn-owed-bright)')
    expect(rule(dots, ".constitution-state-dot[data-attention='working']")['--state-dot']).toBe('var(--kbn-agent)')
  })
})

describe('quiet families recede behind the live ones', () => {
  it('sets a quiet family\'s name in regular weight and softer ink', () => {
    const quiet = rule(desk, ".kbn-family[data-attention='quiet'] .kbn-family-name")
    expect(Number(quiet['font-weight'])).toBeLessThan(Number(rule(desk, '.kbn-family-name')['font-weight']))
    expect(quiet.color).toBe('var(--kbn-ink-soft)')
  })
})
