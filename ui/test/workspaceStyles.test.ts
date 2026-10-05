import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../src/board/workspace/${name}`, import.meta.url), 'utf8')
const css = read('reader.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = read('tokens.css')

describe('workspace style contracts', () => {
  it('defines every workspace token that its reader uses', () => {
    const declarations = new Set([...`${tokens}\n${css}`.matchAll(/(--ws-[\w-]+)\s*:/g)].map(m => m[1]))
    for (const token of [...css.matchAll(/var\((--ws-[\w-]+)/g)].map(m => m[1])) expect(declarations.has(token), token).toBe(true)
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
  })
  it('draws the dock from workspace tokens alone', () => {
    const dock = read('dock.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const declarations = new Set([...`${tokens}\n${dock}`.matchAll(/(--(?:ws|ctl)-[\w-]+)\s*:/g)].map(m => m[1]))
    for (const token of [...dock.matchAll(/var\((--[\w-]+)/g)].map(m => m[1])) expect(declarations.has(token), token).toBe(true)
    expect(dock).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|url\(/i)
  })
  it('parks documents under an opaque cover without removing their layout', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].includes('.ws-parked')).map(m => m[2]).join('\n')
    expect(rules).toContain('background: var(--ws-paper)')
    expect(rules).not.toMatch(/display:\s*none|visibility:\s*hidden|content-visibility/)
    expect(css.match(/\.ws-reader\.ws-dormant\s*\{([^}]+)\}/)?.[1]).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })
  it('settles both track and pages for reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[^]*\.ws-track,\s*\.ws-page\s*\{\s*transition:\s*none/)
  })
})
