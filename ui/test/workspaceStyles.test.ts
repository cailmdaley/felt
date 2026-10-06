import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../src/board/workspace/${name}`, import.meta.url), 'utf8')
const css = read('reader.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = read('tokens.css')

describe('workspace style contracts', () => {
  it('keeps the default type scale named and workspace font sizes on those tokens', () => {
    for (const [token, size] of Object.entries({
      'small-size': 11, 'label-size': 15, 'chrome-size': 15, 'prose-size': 18,
      'section-size': 21, 'lede-size': 21.6, 'heading-size': 34,
    })) expect(tokens).toMatch(new RegExp(`--ws-${token}:\\s*${size}px;`))
    const styleFiles = [...readdirSync(new URL('../src/board/workspace/', import.meta.url)).filter(name => name.endsWith('.css') && name !== 'tokens.css'), '../keymap.css']
    for (const name of styleFiles) {
      const styles = read(name).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const declaration of styles.matchAll(/\bfont(?:-size)?\s*:\s*([^;{}]+)/g)) {
        expect(declaration[1], `${name}: ${declaration[0]}`).not.toMatch(/\b\d+(?:\.\d+)?(?:px|rem)\b/)
      }
    }
  })
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
  it('styles empty control states and the Resume action', () => {
    const dock = read('dock.css').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const selector of [
      '.ws-dock .kbn-ctl-date.kbn-ctl-empty',
      '.ws-dock .kbn-ctl-resume',
      '.ws-dock .kbn-detail-parent-empty',
    ]) expect(dock).toContain(selector)
    expect(dock).not.toContain('.kbn-meeting-stamp')
  })
  it('parks documents under an opaque cover without removing their layout', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => m[1].includes('.ws-parked')).map(m => m[2]).join('\n')
    expect(rules).toContain('background: var(--ws-paper)')
    expect(rules).not.toMatch(/display:\s*none|visibility:\s*hidden|content-visibility/)
    expect(css.match(/\.ws-reader\.ws-dormant\s*\{([^}]+)\}/)?.[1]).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })
  it('lets prose and text follow a resized frame rather than capping the reading column', () => {
    expect(css).toMatch(/\.ws-prose,\s*\.ws-content \.kbn-detail-prose\s*\{[^}]*width:\s*100%;\s*max-width:\s*none/)
    expect(tokens).toContain('clamp(24px, 4%, 64px)')
    expect(css).toMatch(/\.ws-content \.kbn-fileview-text > \.md-code-block[^}]*padding:\s*var\(--ws-prose-padding\)/)
  })
  it('limits chrome rings to keyboard focus', () => {
    expect(css).toMatch(/button:focus,\s*\.ws-reader a:focus\s*\{[^}]*outline:\s*none/)
    expect(css).toContain('button:focus-visible')
  })
  it('settles both track and pages for reduced motion', () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[^]*\.ws-track,\s*\.ws-page\s*\{\s*transition:\s*none/)
  })
})
