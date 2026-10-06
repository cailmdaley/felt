import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = ['palette.css', 'workspace/tokens.css'].map(path =>
  readFileSync(new URL(`../src/board/${path}`, import.meta.url), 'utf8')).join('\n')
const tokens = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]))
type RGB = [number, number, number]
function color(token: string): RGB {
  const value = tokens.get(token)!
  if (/^#[\da-f]{6}$/i.test(value)) return value.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255) as RGB
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (alias) return color(alias[1])
  const mix = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\)$/.exec(value)
  if (!mix) throw new Error(`Unsupported contrast token ${token}: ${value}`)
  const a = color(mix[1]), b = color(mix[3]), weight = Number(mix[2]) / 100
  return a.map((v, i) => weight * v + (1 - weight) * b[i]) as RGB
}
function luminance(rgb: RGB): number {
  const [r, g, b] = rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return .2126 * r + .7152 * g + .0722 * b
}
function contrast(ink: string, paper: string): number {
  const a = luminance(color(ink)), b = luminance(color(paper))
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
}

describe('workspace small-text contrast', () => {
  for (const ink of ['--ws-ink', '--ws-ink-soft', '--ws-ink-muted', '--ws-ink-faint', '--ws-agent']) {
    for (const background of ['--kbn-paper', '--kbn-parchment', '--kbn-plate']) {
      it(`${ink} meets WCAG AA on ${background}`, () => {
        expect(contrast(ink, background)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
  it('keeps keyboard focus visible against paper and vellum', () => {
    expect(contrast('--ws-focus', '--kbn-paper')).toBeGreaterThanOrEqual(3)
    expect(contrast('--ws-focus', '--kbn-parchment')).toBeGreaterThanOrEqual(3)
  })
  it('keeps due and error text legible on the fiber page', () => {
    expect(contrast('--ws-owed', '--kbn-paper')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('--ws-red', '--kbn-paper')).toBeGreaterThanOrEqual(4.5)
  })
})
