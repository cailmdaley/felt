import { readFileSync, readdirSync } from 'node:fs'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../src/board/workspace/${name}`, import.meta.url), 'utf8')
const css = read('reader.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = `${read('tokens.css')}\n${readFileSync(new URL('../src/styles/type.css', import.meta.url), 'utf8')}`

describe('workspace style contracts', () => {
  it('keeps the ready PDF thumbnail glyph visible', () => {
    const hidden = read('thumbnail.css').split('}').filter(rule => /display:\s*none/.test(rule)).join('}')
    expect(read('thumbnail.css').length).toBeGreaterThan(0)
    expect(hidden).not.toContain('.kbn-thumbnail-pdf')
  })
  it('gives back controls a hover background only on hover-capable devices', () => {
    let controls = 0
    postcss.parse(read('reader.css')).walkRules(rule => {
      if (!/:hover/.test(rule.selector) || !/\.ws-(return|document-back)/.test(rule.selector)) return
      if (!rule.nodes.some(node => node.type === 'decl' && node.prop === 'background')) return
      controls++
      const media: string[] = []
      for (let parent = rule.parent; parent; parent = parent.parent) {
        if (parent.type === 'atrule' && parent.name === 'media') media.push(parent.params)
      }
      expect(media.join(' '), rule.selector).toContain('(hover: hover)')
    })
    expect(controls).toBeGreaterThan(0)
  })
  it('holds the constitution name to the band\'s one line', () => {
    expect(read('dock.css')).toMatch(/\.ws-band-title\s*\{[^}]*text-overflow:\s*ellipsis;\s*white-space:\s*nowrap/)
  })
  it('defines every workspace token that its reader uses', () => {
    const declarations = new Set([...`${tokens}\n${css}`.matchAll(/(--ws-[\w-]+)\s*:/g)].map(m => m[1]))
    for (const token of [...css.matchAll(/var\((--ws-[\w-]+)/g)].map(m => m[1])) expect(declarations.has(token), token).toBe(true)
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
  })
  it('draws the dock from workspace tokens alone', () => {
    const dock = read('dock.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const declarations = new Set([...`${tokens}\n${css}\n${dock}`.matchAll(/(--tone|--(?:ws|ctl|type|font|glyph|leading|track)-[\w-]+)\s*:/g)].map(m => m[1]))
    declarations.add('--verdict-ink') // The Desk's verdict plate declares it for the verbs both surfaces share.
    declarations.add('--anchor-width').add('--available-height') // UI SDK writes these on the popups it positions.
    for (const token of [...dock.matchAll(/var\((--[\w-]+)/g)].map(m => m[1])) expect(declarations.has(token), token).toBe(true)
    expect(dock).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|url\(/i)
  })
  it('styles empty control states', () => {
    const dock = read('dock.css').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const selector of [
      '.ws-dock .kbn-ctl-date.kbn-ctl-empty',
      '.ws-dock .kbn-detail-parent-empty',
    ]) expect(dock).toContain(selector)
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
