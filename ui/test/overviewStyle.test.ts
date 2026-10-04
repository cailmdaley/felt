import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../src/board/workspace/${name}`, import.meta.url), 'utf8')
const css = read('overview.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = read('tokens.css')

describe('Overview style contracts', () => {
  it('uses workspace tokens and scopes its rules away from the reader', () => {
    const declarations = new Set([...`${tokens}\n${css}`.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]))
    for (const token of [...css.matchAll(/var\((--[\w-]+)/g)].map(m => m[1])) expect(declarations.has(token), token).toBe(true)
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
    expect(css).not.toMatch(/\.ws-reader|\.ws-stage/)
    for (const [, selector] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) if (!selector.trim().startsWith('@')) expect(selector).toContain('.ws-overview')
  })
  it('keeps phone folios single-column with right thumbnails, scrolling ribbon, and 44px controls', () => {
    expect(css).toContain('@media (max-width: 700px)')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) 92px')
    expect(css).toContain('.ws-overview-folios { grid-template-columns: 1fr; gap: 0; }')
    expect(css).toMatch(/\.ws-overview-ribbon\s*\{[^}]*overflow-x: auto/)
    expect(css).toMatch(/\.ws-overview-find, .ws-overview-lens\s*\{[^}]*min-height: var\(--ws-phone-target\)/)
    expect(tokens).toMatch(/--ws-phone-target:\s*44px/)
    expect(css).toContain('overflow-x: hidden')
    expect(css).toContain('minmax(min(100%, var(--overview-folio-floor)), 1fr)')
  })
  it('makes thumbnails pointer-inert and reserves red for the freshness mark', () => {
    expect(css).toMatch(/\.ws-overview-thumb\s*\{[^}]*pointer-events: none/)
    expect(css.match(/var\(--ws-red\)/g)).toHaveLength(1)
    expect(css).toMatch(/\.ws-overview-fresh\s*\{[^}]*background: var\(--ws-red\)/)
    expect(css).toContain('-webkit-line-clamp: 2')
  })
})
