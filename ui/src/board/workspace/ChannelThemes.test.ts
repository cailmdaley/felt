// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelThemes, themeScopeId } from './ChannelThemes.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { parseCompositeFeed } from '../KanbanComposite.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'

vi.mock('./themeScope.js', () => ({ scopeTheme: (css: string, scope: string) => {
  if (css === 'broken') throw new Error('Invalid CSS')
  return `${scope} { /* ${css} */ }`
} }))
const card: KanbanCard = { id: 'work/report', uid: 'theme-fixture', name: 'A report', originId: 'remote-fixture', path: 'work/report/report.md', fiberDir: '/store/work/report', status: 'closed', createdAt: '', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null }
let themes: ChannelThemes
beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('CSSStyleSheet', class { replaceSync() {} })
  themes = new ChannelThemes('https://daemon.invalid')
})
afterEach(() => { themes?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const root = (): HTMLElement => { const el = document.createElement('div'); document.body.append(el); return el }

describe('channel theme lifetime and owner reads', () => {
  it('coalesces reader and folio reads, revalidates by ETag only on the refresh cadence', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(':scope { --ws-paper: white; }', { headers: { ETag: '"one"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetcher)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
    const reader = root(), folio = root()
    themes.bind(reader, card); themes.bind(folio, card)
    await vi.waitFor(() => expect(document.querySelector('style[data-ws-theme-sheet]')?.textContent).toContain('--ws-paper: white'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url] = fetcher.mock.calls[0]
    expect(new URL(url).searchParams.get('origin')).toBe('remote-fixture')
    expect(new URL(url).searchParams.get('path')).toBe('/store/work/report/theme.css')
    themes.bind(reader, card)
    expect(fetcher).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(115000)
    themes.bind(reader, card)
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
    themes.bind(el, card)
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
  })
})
