import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(`../src/board/${path}`, import.meta.url), 'utf8')
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')
const css = strip(read('workspace/overview.css'))
const reader = strip(read('workspace/reader.css'))
const tokens = strip(read('workspace/tokens.css'))
const desk = strip(read('KanbanModal.css'))

describe('Overview style contracts', () => {
  it('uses workspace tokens and scopes its rules away from the reader', () => {
    const declarations = new Set([...`${tokens}\n${css}`.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]))
    for (const token of [...css.matchAll(/var\((--(?:ws|overview)-[\w-]+)/g)].map(m => m[1])) expect(declarations.has(token), token).toBe(true)
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
    expect(css).not.toMatch(/\.ws-reader|\.ws-stage/)
    for (const [, selector] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) if (!selector.trim().startsWith('@')) expect(selector).toContain('.ws-overview')
  })
  it('keeps phone folios single-column with right thumbnails, scrolling ribbon, and 44px controls', () => {
    expect(css).toContain('@media (max-width: 700px), (max-height: 500px) and (pointer: coarse)')
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) 92px')
    expect(css).toContain('.ws-overview-folios { grid-template-columns: 1fr; gap: 0; }')
    expect(css).toMatch(/\.ws-overview-ribbon\s*\{[^}]*overflow-x: auto/)
    expect(css).toMatch(/\.ws-overview-find\s*\{[^}]*min-height: var\(--ws-phone-target\)/)
    expect(css).toMatch(/\.ws-overview-lens button\s*\{[^}]*min-height: var\(--ws-phone-target\)/)
    expect(tokens).toMatch(/--ws-phone-target:\s*44px/)
    expect(css).toContain('overflow-x: hidden')
  })
  it('makes thumbnails pointer-inert and marks freshness in gold', () => {
    expect(css).toMatch(/\.ws-overview-thumb\s*\{[^}]*pointer-events: none/)
    expect(css).toMatch(/\.ws-overview-folio\.ws-overview-unseen\s*\{[^}]*border-top-color: var\(--kbn-owed\)/)
    expect(css).toMatch(/\.ws-overview-folio\.ws-overview-seen \.ws-overview-stack\s*\{[^}]*filter: saturate\(\.55\) contrast\(\.9\); opacity: \.8/)
    expect(css).toMatch(/\.ws-overview-folio\[data-density='full'\]\s*\{[^}]*height: 310px/)
    expect(css).toMatch(/\.ws-overview-folio\[data-density='line'\]\s*\{[^}]*height: 36px/)
    expect(tokens).toMatch(/--ws-fresh:\s*var\(--kbn-owed/)
    expect(css).toContain('-webkit-line-clamp: 2')
  })
})

describe('workspace palette follows the Desk', () => {
  it('defines every workspace colour from a shared board token', () => {
    const colours = [...tokens.matchAll(/(--ws-[\w-]+):\s*([^;]+);/g)].filter(([, , v]) => /#|rgb|color-mix|--kbn-/.test(v))
    expect(colours.length).toBeGreaterThan(10)
    for (const [, name, value] of colours) {
      expect(value, name).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
      expect(value, name).toMatch(/var\(--kbn-/)
    }
  })
  it('declares the shared materials beside the pigments, and the Desk uses them', () => {
    for (const name of ['parchment', 'sheet', 'plate', 'paper', 'hairline', 'rule', 'ink', 'ink-muted']) {
      expect(desk, name).toMatch(new RegExp(`--kbn-${name}:`))
    }
    expect(desk).toMatch(/\.kbn-modal\s*\{[^}]*background-color: var\(--kbn-parchment\)/)
  })
  it('keeps the workspace to the serif and the mono, with no sans family', () => {
    for (const sheet of [tokens, reader, css]) expect(sheet).not.toMatch(/--ws-sans|sans-serif|system-ui/)
  })
  it('keeps cinnabar out of the workspace except for keyboard focus', () => {
    expect(`${reader}\n${css}`).not.toMatch(/--kbn-you/)
    expect(tokens.match(/--kbn-you/g)).toHaveLength(1)
    expect(tokens).toMatch(/--ws-focus:[^;]*--kbn-you/)
  })
  it('floats the workspace on a vellum veil, blurring only still layers', () => {
    for (const sheet of [tokens, reader, css]) expect(sheet).not.toMatch(/--ws-grid/)
    expect(tokens).toMatch(/--ws-veil:\s*color-mix\(in srgb, var\(--kbn-parchment\) 42%, transparent\)/)
    const blurred = [...`${reader}\n${css}`.matchAll(/([^{}]+)\{[^{}]*backdrop-filter:\s*var\(--ws-veil-filter\)/g)].map(m => m[1].trim())
    expect(blurred).toEqual(['.ws-veil', '.ws-overview'])
    expect(reader).toMatch(/\.ws-page\.ws-receded \.ws-sheet\s*\{[^}]*box-shadow: none/)
    expect(reader).toMatch(/\.ws-sheet\s*\{[^}]*box-shadow: var\(--ws-float\)/)
    for (const sheet of [reader, css]) expect(sheet).toMatch(/prefers-reduced-transparency: reduce[^]*backdrop-filter: none/)
  })
})
