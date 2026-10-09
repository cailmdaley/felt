// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * index.html marks <html> before first paint with an inline script; once the
 * bundle runs, appearance.ts owns the marks. The two must agree on every
 * stored choice and system scheme, or the page flashes one way and settles
 * the other.
 */
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')
const inline = html.match(/<script>([\s\S]*?)<\/script>/)![1]
const palette = readFileSync(resolve(__dirname, '../src/board/palette.css'), 'utf8')

let store = new Map<string, string>()
function stubSystem(dark: boolean): void {
  store = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && dark, addEventListener() {}, removeEventListener() {} }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.wsAppearance
  delete document.documentElement.dataset.wsDarkTheme
})

describe('first paint', () => {
  const stored = [null, 'not json', '{}', '{"mode":"light"}', '{"mode":"dark"}', '{"mode":"system"}', '{"mode":"sepia"}',
    '{"mode":"dark","dark":"lamplight"}', '{"mode":"dark","dark":"night-chart"}', '{"mode":"system","dark":"lamplight"}', '{"dark":"candle"}']
  for (const raw of stored) for (const system of [false, true]) it(`agrees with appearance.ts for ${raw} on a ${system ? 'dark' : 'light'} system`, async () => {
    stubSystem(system)
    if (raw !== null) localStorage.setItem('shuttle.appearance', raw)
    document.head.innerHTML = '<meta name="theme-color" content="#EDE2CE">'
    new Function(inline)()
    const early = { ...document.documentElement.dataset }
    vi.resetModules()
    const { currentScheme, appearance } = await import('../src/board/appearance.js')
    expect(early).toEqual({ wsAppearance: currentScheme(), wsDarkTheme: appearance().dark })
  })

  it('gives the browser chrome each dark theme’s ground', () => {
    const ground = (selector: string) => palette.split(selector)[1].match(/--kbn-parchment:\s*(#[\da-f]{6})/i)![1].toUpperCase()
    stubSystem(false)
    for (const [theme, selector] of [['night-chart', "/* NIGHT CHART"], ['lamplight', "/* LAMPLIGHT"]] as const) {
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: 'dark', dark: theme }))
      document.head.innerHTML = '<meta name="theme-color" content="#EDE2CE">'
      new Function(inline)()
      expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content.toUpperCase()).toBe(ground(selector))
    }
  })
})
