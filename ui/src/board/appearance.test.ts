// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DARK_THEMES, appearanceTheme, resolveScheme, themeScheme, type AppearanceMode, type Scheme } from './appearance.js'

const bundled = Object.keys(import.meta.glob('./workspace/themes/*.css')).map(path => path.split('/').at(-1)!.replace('.css', '')).filter(name => name !== 'surface')

describe('appearance resolution', () => {
  it('names a scheme for every bundled theme, and every dark choice is bundled', () => {
    expect(bundled.filter(name => themeScheme(name) === 'dark').sort()).toEqual([...DARK_THEMES].sort())
    expect(bundled.filter(name => themeScheme(name) === 'light').sort()).toEqual(['blueprint', 'laboratory-paper', 'portolan'])
  })

  it('resolves Match system live and fixes Light and Dark', () => {
    const cases: Array<[AppearanceMode, Scheme, Scheme]> = [
      ['light', 'light', 'light'], ['light', 'dark', 'light'],
      ['dark', 'light', 'dark'], ['dark', 'dark', 'dark'],
      ['system', 'light', 'light'], ['system', 'dark', 'dark'],
    ]
    for (const [mode, system, expected] of cases) expect(resolveScheme(mode, system), `${mode} on a ${system} system`).toBe(expected)
  })

  it('keeps a declared theme of the resolved scheme and gives way otherwise', () => {
    const table: Array<[string, Scheme, string]> = [
      ['portolan', 'light', 'portolan'], ['blueprint', 'light', 'blueprint'], ['laboratory-paper', 'light', 'laboratory-paper'],
      ['night-chart', 'light', 'portolan'], ['lamplight', 'light', 'portolan'],
      ['portolan', 'dark', 'lamplight'], ['blueprint', 'dark', 'lamplight'], ['laboratory-paper', 'dark', 'lamplight'],
      ['night-chart', 'dark', 'night-chart'], ['lamplight', 'dark', 'lamplight'],
    ]
    for (const [declared, scheme, expected] of table) expect(appearanceTheme(declared, scheme, 'lamplight'), `${declared} in ${scheme}`).toBe(expected)
    expect(appearanceTheme('portolan', 'dark', 'night-chart')).toBe('night-chart')
    expect(appearanceTheme('lamplight', 'dark', 'night-chart'), 'a declared dark theme outranks the dark choice').toBe('lamplight')
  })
})

describe('appearance preference', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); delete document.documentElement.dataset.wsAppearance })
  const load = async () => import('./appearance.js')

  it('defaults to Match system with Night chart, and ignores malformed storage', async () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"mode":"sepia","dark":"neon"}', setItem: vi.fn() })
    expect((await load()).appearance()).toEqual({ mode: 'system', dark: 'night-chart' })
  })

  it('reads and saves this browser’s choice and announces it with the resolved scheme on the root', async () => {
    const storage = new Map<string, string>([['shuttle.appearance', '{"mode":"dark","dark":"lamplight"}']])
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
    const appearance = await load()
    appearance.watchAppearance()
    expect(appearance.appearance()).toEqual({ mode: 'dark', dark: 'lamplight' })
    expect(document.documentElement.dataset.wsAppearance).toBe('dark')
    const changed = vi.fn()
    window.addEventListener(appearance.APPEARANCE_CHANGED, changed)
    expect(appearance.saveAppearance({ mode: 'light', dark: 'lamplight' })).toBe(true)
    expect(JSON.parse(storage.get('shuttle.appearance')!)).toEqual({ mode: 'light', dark: 'lamplight' })
    expect(document.documentElement.dataset.wsAppearance).toBe('light')
    expect(changed).toHaveBeenCalledOnce()
    appearance.saveAppearance({ mode: 'light', dark: 'night-chart' })
    expect(changed).toHaveBeenCalledTimes(2)
    window.removeEventListener(appearance.APPEARANCE_CHANGED, changed)
  })

  it('applies the choice for the session when storage is blocked', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    const appearance = await load()
    expect(appearance.appearance().mode).toBe('system')
    expect(appearance.saveAppearance({ mode: 'dark', dark: 'night-chart' })).toBe(false)
    expect(appearance.appearance().mode).toBe('dark')
    expect(document.documentElement.dataset.wsAppearance).toBe('dark')
  })
})
