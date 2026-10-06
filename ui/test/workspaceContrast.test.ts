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

/** The board's palette in each appearance: light, then each dark theme laid over it. */
const palette = readFileSync(new URL('../src/board/palette.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const wsTokens = readFileSync(new URL('../src/board/workspace/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const blocks = [...palette.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => [m[1].trim(), m[2]] as const)
const declarations = (body: string): Array<[string, string]> => [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])
const dark = ":root[data-ws-appearance='dark']"
const APPEARANCES: Record<string, string[]> = {
  light: [':root'],
  'night chart': [':root', dark],
  lamplight: [':root', dark, `${dark}[data-ws-dark-theme='lamplight']`],
}
function appearanceColor(selectors: string[]): (token: string) => RGB {
  const map = new Map(declarations(wsTokens))
  for (const selector of selectors) for (const [, body] of blocks.filter(([s]) => s === selector)) for (const [k, v] of declarations(body)) map.set(k, v)
  const resolve = (value: string): RGB => {
    const hex = /^#([\da-f]{6})$/i.exec(value)
    if (hex) return hex[1].match(/../g)!.map(v => parseInt(v, 16) / 255) as RGB
    const alias = /^var\((--[\w-]+)\)$/.exec(value)
    if (alias) return resolve(map.get(alias[1])!)
    const mix = /^color-mix\(in srgb, (.+?) ([\d.]+)%, (.+?)(?: [\d.]+%)?\)$/.exec(value)
    if (!mix) throw new Error(`Unsupported palette value ${value}`)
    const a = resolve(mix[1]), b = resolve(mix[3]), weight = Number(mix[2]) / 100
    return a.map((v, i) => weight * v + (1 - weight) * b[i]) as RGB
  }
  return token => resolve(`var(${token})`)
}
const ratio = (a: RGB, b: RGB): number => {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}

describe('the board palette in every appearance', () => {
  for (const [name, selectors] of Object.entries(APPEARANCES)) {
    const c = appearanceColor(selectors)
    const grounds = ['--kbn-parchment', '--kbn-sheet', '--kbn-paper', '--kbn-form-paper']
    it(`${name}: body ink, soft ink and the graphite meet AA on every ground`, () => {
      for (const ink of ['--kbn-ink', '--kbn-ink-soft', '--kbn-graphite', '--kbn-graphite-deep', '--kbn-error'])
        for (const ground of grounds) expect(ratio(c(ink), c(ground)), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5)
    })
    if (name === 'light') continue
    it(`${name}: muted and faint ink, and every pigment set as text, meet AA on card paper`, () => {
      for (const ink of ['--kbn-ink-muted', '--kbn-ink-faint', '--kbn-graphite-muted', '--kbn-graphite-pale', '--kbn-you', '--kbn-agent',
        '--kbn-owed', '--kbn-owed-bright', '--kbn-tempered', '--kbn-tempered-ink', '--kbn-discarded', '--kbn-queue', '--kbn-slate', '--kbn-held'])
        for (const ground of grounds) expect(ratio(c(ink), c(ground)), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5)
    })
    it(`${name}: text set on a solid pigment stays legible`, () => {
      for (const pigment of ['--kbn-you', '--kbn-agent', '--kbn-owed-bright', '--kbn-tempered'])
        expect(ratio(c('--kbn-on-pigment'), c(pigment)), pigment).toBeGreaterThanOrEqual(4.5)
    })
  }
})
