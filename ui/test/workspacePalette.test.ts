import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(new URL(`../src/board/${path}`, import.meta.url), 'utf8')
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')
const reader = strip(read('workspace/reader.css'))
const tokens = strip(read('workspace/tokens.css'))
const desk = strip(read('KanbanModal.css'))
const palette = strip(read('palette.css'))

describe('workspace palette follows the Desk', () => {
  it('defines every workspace colour from a shared board token', () => {
    const colours = [...tokens.matchAll(/(--ws-[\w-]+):\s*([^;]+);/g)].filter(([, , v]) => /#|rgb|color-mix|--kbn-/.test(v))
    expect(colours.length).toBeGreaterThan(10)
    for (const [, name, value] of colours) {
      expect(value, name).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
      expect(value, name).toMatch(/var\(--(?:kbn|ws)-/)
    }
  })
  it('declares the shared materials beside the pigments, and the Desk uses them', () => {
    for (const name of ['parchment', 'sheet', 'plate', 'paper', 'hairline', 'rule', 'ink', 'ink-muted']) {
      expect(palette, name).toMatch(new RegExp(`--kbn-${name}:`))
    }
    expect(desk).toMatch(/\.kbn-modal\s*\{[^}]*background-color: var\(--kbn-parchment\)/)
  })
  it('keeps the workspace to the serif and the mono, with no sans family', () => {
    for (const sheet of [tokens, reader]) expect(sheet).not.toMatch(/--ws-sans|sans-serif|system-ui/)
  })
  it('reserves cinnabar for keyboard focus and the human pigment', () => {
    expect(reader).not.toMatch(/--kbn-you/)
    expect(tokens.match(/--kbn-you/g)).toHaveLength(2)
    expect(tokens).toMatch(/--ws-focus:[^;]*--kbn-you/)
    expect(tokens).toMatch(/--ws-you:[^;]*--kbn-you/)
  })
  it('floats the workspace on a vellum veil, blurring only still layers', () => {
    for (const sheet of [tokens, reader]) expect(sheet).not.toMatch(/--ws-grid/)
    expect(tokens).toMatch(/--ws-veil:\s*color-mix\(in srgb, var\(--kbn-parchment\) 42%, transparent\)/)
    const blurred = [...reader.matchAll(/([^{}]+)\{[^{}]*backdrop-filter:\s*var\(--ws-veil-filter\)/g)].map(m => m[1].trim())
    expect(blurred).toEqual(['.ws-veil'])
    expect(tokens).toContain('--ws-desk-filter: saturate(0.25) brightness(1.04)')
    expect(reader.match(/\.ws-page\.ws-receded[^{]*\{/g)).toEqual(['.ws-page.ws-receded {', '.ws-page.ws-receded {'])
    // The selected page is one frame: the sheet draws no box of its own, and its header line is ruled beneath.
    expect(reader).not.toMatch(/\.ws-sheet\s*\{[^}]*(box-shadow|border|border-radius):/)
    expect(reader).toMatch(/\.ws-labelbar\s*\{[^}]*border-bottom:/)
    // No theme draws a box back onto the page frame.
    for (const file of readdirSync(new URL('../src/board/workspace/themes/', import.meta.url)).filter(f => f.endsWith('.css'))) {
      const theme = strip(read(`workspace/themes/${file}`))
      for (const [, body] of theme.matchAll(/\[data-part="page-frame"\]\s*\{([^}]*)\}/g)) expect(body, file).not.toMatch(/(^|[\s;])(clip-path|box-shadow|border(-[a-z]+)*|outline)\s*:/)
    }
    expect(reader).toMatch(/prefers-reduced-transparency: reduce[^]*backdrop-filter: none/)
  })
})
