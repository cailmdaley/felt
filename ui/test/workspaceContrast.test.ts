import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = ['KanbanModal.css', 'workspace/tokens.css'].map(path =>
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

// Every workspace ink token, plus the agent ink, carries small text on each workspace
// surface; due and error text sit on the fiber page's paper; the focus ring is a
// non-text indicator (WCAG 1.4.11, 3:1).
const inks = [...tokens.keys()].filter(token => /^--ws-ink(-|$)/.test(token)).concat('--ws-agent')
const surfaces = ['--kbn-paper', '--kbn-parchment', '--kbn-plate']
const requirements: [ink: string, background: string, minimum: number][] = [
  ...inks.flatMap(ink => surfaces.map(background => [ink, background, 4.5] as [string, string, number])),
  ['--ws-owed', '--kbn-paper', 4.5],
  ['--ws-red', '--kbn-paper', 4.5],
  ['--ws-focus', '--kbn-paper', 3],
  ['--ws-focus', '--kbn-parchment', 3],
]

describe('workspace contrast', () => {
  it('meets each ink/background minimum', () => {
    expect(inks).toEqual(expect.arrayContaining(['--ws-ink', '--ws-ink-soft', '--ws-ink-muted', '--ws-ink-faint']))
    const failing = requirements
      .map(([ink, background, minimum]) => ({ pair: `${ink} on ${background}`, minimum, ratio: Number(contrast(ink, background).toFixed(2)) }))
      .filter(row => row.ratio < row.minimum)
    expect(failing).toEqual([])
  })
})
