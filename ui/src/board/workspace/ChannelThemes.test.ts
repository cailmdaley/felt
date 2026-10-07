// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelThemes, themeScopeId } from './ChannelThemes.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { parseCompositeFeed } from '../KanbanComposite.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'
import { scopeTheme } from './themeScope.js'

vi.mock('./themeScope.js', () => ({ scopeTheme: vi.fn((css: string, scope: string) => {
  if (css === 'broken') throw new Error('Invalid CSS')
  return `${scope} { /* ${css} */ }`
}) }))
const card: KanbanCard = { id: 'work/report', uid: 'theme-fixture', name: 'A report', originId: 'remote-fixture', path: 'work/report/report.md', fiberDir: '/store/work/report', status: 'closed', createdAt: '', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null }
let themes: ChannelThemes
beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('CSSStyleSheet', class { replaceSync() {} })
  themes = new ChannelThemes('https://daemon.invalid')
})
afterEach(() => { themes?.dispose(); document.body.replaceChildren(); document.documentElement.removeAttribute('style'); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const root = (): HTMLElement => { const el = document.createElement('div'); document.body.append(el); return el }

describe('channel theme lifetime and owner reads', () => {
  it('paints bundled folios without IO and reuses reader-loaded custom CSS without revalidation', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(':scope { --cached-theme: 1 }', { headers: { ETag: 'cached' } }))
    vi.stubGlobal('fetch', fetcher)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
    const folio = root(), reader = root()
    themes.bind(folio, { ...card, theme: 'blueprint' })
    expect(folio.dataset.wsTheme).toBeTruthy()
    themes.togglePlain(card); themes.togglePlain(card)
    expect(fetcher).not.toHaveBeenCalled()
    themes.bind(reader, { ...card, theme: 'blueprint' }, 'reader')
    await vi.waitFor(() => expect(document.querySelector('style[data-ws-theme-sheet]')?.textContent).toContain('--cached-theme'))
    expect(fetcher).toHaveBeenCalledOnce()
    themes.unbind(reader)
    clock.mockReturnValue(200000)
    themes.bind(folio, { ...card, theme: 'blueprint' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(document.querySelector('style[data-ws-theme-sheet]')?.textContent).toContain('--cached-theme')
    themes.togglePlain(card); themes.togglePlain(card)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('offers Plain for declared themes, including the bundled default', () => {
    expect(themes.hasTheme(card)).toBe(false)
    expect(themes.hasTheme({ ...card, theme: 'portolan' })).toBe(true)
    expect(themes.hasTheme({ ...card, theme: 'Night Chart' })).toBe(true)
    expect(themes.hasTheme({ ...card, theme: '  ' })).toBe(false)
  })

  it('discovers a beside-fiber theme while the saved Plain choice is active', async () => {
    const otherCard = { ...card, uid: 'unrelated-theme', fiberDir: undefined }
    const other = root()
    const unrelatedChange = vi.fn()
    other.addEventListener('workspace-theme-change', unrelatedChange)
    themes.bind(other, otherCard)
    await Promise.resolve()
    unrelatedChange.mockClear()
    const el = root()
    const becameAvailable = vi.fn()
    el.addEventListener('workspace-theme-change', () => {
      if (themes.hasTheme(card)) becameAvailable()
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(':root { --ws-paper: ivory; }')))
    themes.togglePlain(card)
    expect(themes.isPlain(card)).toBe(true)
    expect(themes.hasTheme(card)).toBe(false)
    themes.bind(el, card, 'reader')
    await vi.waitFor(() => expect(themes.hasTheme(card)).toBe(true))
    expect(themes.isPlain(card)).toBe(true)
    expect(el.dataset.wsTheme).toBeUndefined()
    expect(becameAvailable).toHaveBeenCalled()
    expect(unrelatedChange).not.toHaveBeenCalled()
    themes.togglePlain(card)
    expect(el.dataset.wsTheme).toBeTruthy()
  })

  it('keeps boundaries on Plain and unbound surfaces and supplies captured defaults to the compiler', () => {
    themes.dispose()
    document.documentElement.style.setProperty('--ws-paper', 'white')
    document.documentElement.style.setProperty('--ws-ink', 'black')
    document.documentElement.style.setProperty('--fixture-known', '12px')
    themes = new ChannelThemes('')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    const el = root()
    themes.bind(el, card)
    const calls = vi.mocked(scopeTheme).mock.calls as unknown as Array<[string, string, string, Map<string, string>]>
    expect(calls.at(-1)?.[3].get('--fixture-known')).toBe('12px')
    expect(calls.at(-1)?.[3].get('--ws-paper')).toBe('white')
    const defaults = document.querySelector<HTMLStyleElement>('style[data-ws-act-defaults]')!.textContent!
    expect(defaults).toContain(':where([data-ws-theme-boundary]:not(.ws-reader))')
    expect(defaults).toContain('@layer shuttle-theme-defaults')
    expect(defaults).toContain('--ws-paper: white;')
    themes.togglePlain(card)
    expect(el.hasAttribute('data-ws-theme-boundary')).toBe(true)
    expect(el.hasAttribute('data-ws-theme')).toBe(false)
    themes.unbind(el)
    expect(el.hasAttribute('data-ws-theme-boundary')).toBe(true)
  })
  it('emits coalesced bubbling changes only for marker or installed stylesheet changes', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetcher)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
    const el = root(), events: Event[] = []
    const listener = (event: Event): void => { if (event.target === el) events.push(event) }
    document.addEventListener('workspace-theme-change', listener)
    try {
      themes.bind(el, card, 'reader'); themes.bind(el, card, 'reader')
      await Promise.resolve()
      expect(events).toHaveLength(1)
      expect(document.querySelector('style[data-ws-theme-sheet]')).not.toBeNull()
      themes.bind(el, card, 'reader'); await Promise.resolve()
      expect(events).toHaveLength(1)
      finish(new Response(':scope { --ws-custom-ready: 1; }', { headers: { ETag: 'one' } }))
      await vi.waitFor(() => expect(document.querySelector('style[data-ws-theme-sheet]')?.textContent).toContain('--ws-custom-ready'))
      expect(events).toHaveLength(2)
      clock.mockReturnValue(115000); themes.bind(el, card, 'reader')
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
      await Promise.resolve()
      expect(events).toHaveLength(2)
      themes.togglePlain(card); themes.togglePlain(card)
      await Promise.resolve()
      expect(events).toHaveLength(3)
      themes.unbind(el); await Promise.resolve()
      expect(events).toHaveLength(4)
    } finally { document.removeEventListener('workspace-theme-change', listener) }
  })
  it('coalesces reader and folio reads, revalidates by ETag only on the refresh cadence', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(':scope { --ws-paper: white; }', { headers: { ETag: '"one"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetcher)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
    const reader = root(), folio = root()
    themes.bind(reader, card, 'reader'); themes.bind(folio, card)
    await vi.waitFor(() => expect(document.querySelector('style[data-ws-theme-sheet]')?.textContent).toContain('--ws-paper: white'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url] = fetcher.mock.calls[0]
    expect(new URL(url).searchParams.get('origin')).toBe('remote-fixture')
    expect(new URL(url).searchParams.get('path')).toBe('/store/work/report/theme.css')
    themes.bind(reader, card, 'reader')
    expect(fetcher).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(115000)
    themes.bind(reader, card, 'reader')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(fetcher.mock.calls[1][1].headers).toEqual({ 'If-None-Match': '"one"' })
    expect(reader.dataset.wsTheme).toBe(folio.dataset.wsTheme)
    themes.unbind(reader)
    expect(document.querySelectorAll('style[data-ws-theme-sheet]')).toHaveLength(1)
    themes.unbind(folio)
    expect(document.querySelectorAll('style[data-ws-theme-sheet]')).toHaveLength(0)
  })
  it('Plain removes every surface and persists by owner without touching fiber metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    const reader = root(), folio = root()
    themes.bind(reader, card); themes.bind(folio, card)
    themes.togglePlain(card)
    expect(reader.dataset.wsTheme).toBeUndefined()
    expect(folio.dataset.wsTheme).toBeUndefined()
    expect(themes.isPlain({ ...card, originId: 'another-host' })).toBe(false)
    expect(card.theme).toBeUndefined()
    const other = new ChannelThemes('')
    expect(other.isPlain(card)).toBe(true)
    other.dispose()
    themes.togglePlain(card)
    expect(reader.dataset.wsTheme).toBeTruthy()
  })
  it('keeps the bundled base after parse or transport failure', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('broken')))
    const el = root()
    themes.bind(el, card, 'reader')
    await vi.waitFor(() => expect(warnings).toHaveBeenCalledWith(expect.stringContaining('could not be parsed'), expect.any(Error)))
    expect(el.dataset.wsThemeName).toBe('portolan')
    expect(document.querySelector('style[data-ws-theme-sheet]')?.textContent).not.toContain('broken')
  })
  it('falls back for unknown declarations, with one warning per name', () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    themes.bind(root(), { ...card, theme: 'not-a-place' })
    themes.bind(root(), { ...card, theme: 'not-a-place' })
    expect(warnings).toHaveBeenCalledTimes(1)
  })
  it('preserves the declared theme from frontmatter through the owner card model', () => {
    const entry = parseCompositeFeed({ host: 'fixture-owner', fibers: [{ origin: 'fixture-owner', felt_store: '/store', path: 'work/report.md', fiber: { id: 'report', theme: '  Laboratory Paper  ' } }] }).entries[0]
    expect(cardFromCompositeEntry(entry).theme).toBe('Laboratory Paper')
  })
  it('keeps identities deterministic and distinguishes mirrored owners', () => {
    expect(themeScopeId('first')).toBe(themeScopeId('first'))
    expect(themeScopeId('first')).not.toBe(themeScopeId('second'))
    expect(themeScopeId('🌟')).not.toBe(themeScopeId('🌙'))
  })
})

describe('appearance', () => {
  type Listener = () => void
  let systemDark = true
  const listeners = new Set<Listener>()
  const setSystem = (dark: boolean): void => { systemDark = dark; for (const listener of listeners) listener() }
  async function fresh() {
    vi.resetModules()
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query.includes('dark') && systemDark },
      addEventListener: (_: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
    }))
    const appearance = await import('../appearance.js')
    const { ChannelThemes: Themes } = await import('./ChannelThemes.js')
    themes.dispose()
    themes = new Themes('https://daemon.invalid')
    return appearance
  }
  afterEach(() => { listeners.clear(); systemDark = true; history.replaceState(null, '', '/'); vi.resetModules() })
  const bound = (theme: string, uid = theme): HTMLElement => { const el = root(); themes.bind(el, { ...card, uid, theme }); return el }
  const names = (roots: HTMLElement[]): Array<string | undefined> => roots.map(el => el.dataset.wsThemeName)

  it('gives each declared theme way to the resolved scheme, following the system live', async () => {
    const appearance = await fresh()
    const roots = ['portolan', 'blueprint', 'laboratory-paper', 'night-chart', 'lamplight'].map(theme => bound(theme))
    expect(names(roots)).toEqual(['night-chart', 'night-chart', 'night-chart', 'night-chart', 'lamplight'])
    expect(document.documentElement.dataset.wsAppearance).toBe('dark')
    const changed = vi.fn()
    roots[3].addEventListener('workspace-theme-change', changed)
    setSystem(false)
    expect(names(roots)).toEqual(['portolan', 'blueprint', 'laboratory-paper', 'portolan', 'portolan'])
    expect(document.documentElement.dataset.wsAppearance).toBe('light')
    await vi.waitFor(() => expect(changed).toHaveBeenCalled())
    appearance.saveAppearance({ mode: 'dark', dark: 'lamplight' })
    expect(names(roots)).toEqual(['lamplight', 'lamplight', 'lamplight', 'night-chart', 'lamplight'])
    setSystem(true); setSystem(false)
    expect(names(roots), 'Dark ignores the system').toEqual(['lamplight', 'lamplight', 'lamplight', 'night-chart', 'lamplight'])
    appearance.saveAppearance({ mode: 'light', dark: 'lamplight' })
    setSystem(true)
    expect(names(roots), 'Light ignores the system').toEqual(['portolan', 'blueprint', 'laboratory-paper', 'portolan', 'portolan'])
    expect(document.documentElement.dataset.wsAppearance).toBe('light')
  })

  it('layers a custom theme.css over whichever base the appearance resolves', async () => {
    const appearance = await fresh()
    appearance.saveAppearance({ mode: 'dark', dark: 'lamplight' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(':scope { --custom-marker: 1 }', { headers: { ETag: 'custom' } })))
    const reader = root()
    themes.bind(reader, { ...card, theme: 'portolan' }, 'reader')
    const sheet = (): string => document.querySelector(`style[data-ws-theme-sheet="${reader.dataset.wsTheme}"]`)?.textContent ?? ''
    await vi.waitFor(() => expect(sheet()).toContain('--custom-marker'))
    expect(reader.dataset.wsThemeName).toBe('lamplight')
    appearance.saveAppearance({ mode: 'light', dark: 'lamplight' })
    expect(reader.dataset.wsThemeName).toBe('portolan')
    expect(sheet(), 'the custom layer survives the base change').toContain('--custom-marker')
  })

  it('shows a previewed theme as named whatever the appearance', async () => {
    history.replaceState(null, '', '/?theme-preview=previewed:night-chart')
    const appearance = await fresh()
    appearance.saveAppearance({ mode: 'light', dark: 'lamplight' })
    expect(bound('portolan', 'previewed').dataset.wsThemeName).toBe('night-chart')
  })
})
