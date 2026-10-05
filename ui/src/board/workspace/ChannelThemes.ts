import type { KanbanCard } from '../KanbanTypes.js'
import { fileBytesUrl } from '../utils.js'
import { scopeTheme } from './themeScope.js'
import './themes/surface.css'

const bundled = import.meta.glob<string>('./themes/*.css', { query: '?raw', import: 'default', eager: true })
const PLAIN_STORAGE = 'shuttle:workspace:plain'
const REFRESH_MS = 15000
interface ThemeEntry {
  key: string
  scope: string
  card: KanbanCard
  base: string
  custom: string
  compiled: string
  etag?: string
  readAt: number
  pending?: Promise<void>
  style?: HTMLStyleElement
}

/** One owner-routed, ETag-revalidated theme per channel; styles exist only for bound surfaces. */
export class ChannelThemes {
  private readonly entries = new Map<string, ThemeEntry>()
  private readonly roots = new Map<HTMLElement, ThemeEntry>()
  private readonly readers = new Set<HTMLElement>()
  private readonly plain = new Set<string>()
  private readonly warnings = new Set<string>()
  private disposed = false
  private readonly actDefaults: HTMLStyleElement
  private readonly defaults = new Map<string, string>()
  private readonly changes = new Set<HTMLElement>()
  private changeQueued = false
  private readonly base: string
  constructor(base: string) {
    this.base = base
    // Snapshot the unthemed root, not the reader. Custom variables at a channel
    // root cannot bleed through the CSS scope limit by ordinary inheritance.
    this.actDefaults = document.createElement('style')
    this.actDefaults.dataset.wsActDefaults = ''
    const defaults = getComputedStyle(document.documentElement)
    for (let i = 0; i < defaults.length; i++) {
      const name = defaults.item(i)
      if (name.startsWith('--')) this.defaults.set(name, defaults.getPropertyValue(name).trim())
    }
    const declarations = (entries: Iterable<[string, string]>): string => [...entries].map(([name, value]) => `${name}: ${value || 'initial'};`).join('\n')
    this.actDefaults.textContent = `@layer shuttle-theme-defaults {
    :where([data-ws-theme-boundary]:not(.ws-reader)) {
      all: initial; display: revert; direction: ${defaults.direction || 'ltr'}; unicode-bidi: normal;
      ${declarations(this.defaults)}
      color: var(--ws-ink); font-family: var(--ws-serif); line-height: 1.4; box-sizing: border-box;
    }
    }
    :where([data-ws-theme] [data-part="act"], [data-ws-act-material]) {
      ${declarations([...this.defaults].filter(([name]) => name !== '--ws-paper' && name !== '--ws-ink'))}
      --ws-ink-soft: var(--ws-ink); --ws-ink-muted: var(--ws-ink); --ws-ink-faint: var(--ws-ink);
      --ws-hairline: color-mix(in srgb, var(--ws-ink) 35%, transparent);
      --ws-hairline-soft: color-mix(in srgb, var(--ws-ink) 20%, transparent);
      --ws-fill: color-mix(in srgb, var(--ws-ink) 10%, var(--ws-paper));
      --ws-hover: color-mix(in srgb, var(--ws-ink) 8%, transparent);
      --ws-agent: color-mix(in srgb, var(--kbn-agent) 50%, var(--ws-ink));
      --ws-you: color-mix(in srgb, var(--kbn-you) 55%, var(--ws-ink));
      --ws-owed: color-mix(in srgb, var(--kbn-owed) 40%, var(--ws-ink));
      --ws-verdict: color-mix(in srgb, var(--kbn-tempered-ink) 40%, var(--ws-ink));
      --ws-red: var(--ws-owed); --ws-machine: var(--ws-agent);
      --ws-machine-halo: color-mix(in srgb, var(--ws-agent) 20%, transparent);
      color: var(--ws-ink); font-style: normal; font-weight: normal; text-shadow: none;
      direction: ${defaults.direction || 'ltr'}; unicode-bidi: normal;
    }`
    document.head.append(this.actDefaults)
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(PLAIN_STORAGE) ?? '[]')
      if (Array.isArray(stored)) for (const key of stored) if (typeof key === 'string') this.plain.add(key)
    } catch { /* Storage is optional. */ }
  }
  isPlain(card: KanbanCard): boolean { return this.plain.has(this.key(card)) }
  togglePlain(card: KanbanCard): void {
    const key = this.key(card)
    if (this.plain.has(key)) this.plain.delete(key)
    else this.plain.add(key)
    try { localStorage.setItem(PLAIN_STORAGE, JSON.stringify([...this.plain])) } catch { /* Storage is optional. */ }
    const entry = this.entries.get(key)
    if (entry) {
      this.paint(entry)
      if (!this.plain.has(key) && [...this.readers].some(root => this.roots.get(root) === entry)) void this.refresh(entry)
    }
  }
  /** Only a reader requests custom CSS. Context surfaces consume the session cache. */
  bind(root: HTMLElement, card: KanbanCard, mode: 'reader' | 'cached' = 'cached'): void {
    if (this.disposed) return
    root.dataset.wsThemeBoundary = ''
    const key = this.key(card)
    const old = this.roots.get(root)
    if (old?.key !== key) this.unbind(root)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { key, scope: themeScopeId(key), card, base: '', custom: '', compiled: '', readAt: -Infinity }
      this.entries.set(key, entry)
    }
    this.roots.set(root, entry)
    if (mode === 'reader') this.readers.add(root)
    else this.readers.delete(root)
    const oldDir = entry.card.fiberDir
    entry.card = card
    const base = this.baseName(card)
    if (entry.base !== base || oldDir !== card.fiberDir) {
      entry.base = base
      if (oldDir !== card.fiberDir) { entry.custom = ''; entry.etag = undefined; entry.readAt = -Infinity }
      this.compile(entry)
    }
    this.paint(entry)
    if (mode === 'reader' && !this.isPlain(card)) void this.refresh(entry)
  }
  unbind(root: HTMLElement): void {
    const old = this.roots.get(root)
    this.roots.delete(root)
    this.readers.delete(root)
    const changed = root.hasAttribute('data-ws-theme') || root.hasAttribute('data-ws-theme-name')
    delete root.dataset.wsTheme
    delete root.dataset.wsThemeName
    if (old) this.paint(old)
    if (changed) this.changed(root)
  }
  /** Only the queued verdict's paper and ink cross into the body-level ACT toast. */
  material(root: HTMLElement): { paper: string; ink: string } | undefined {
    const entry = this.roots.get(root)
    if (!entry || this.plain.has(entry.key) || !root.classList.contains('ws-reader')) return
    const style = getComputedStyle(root)
    return { paper: style.getPropertyValue('--ws-paper').trim(), ink: style.getPropertyValue('--ws-ink').trim() }
  }
  private changed(root: HTMLElement): void {
    this.changes.add(root)
    if (this.changeQueued) return
    this.changeQueued = true
    queueMicrotask(() => {
      this.changeQueued = false
      const roots = [...this.changes]; this.changes.clear()
      if (!this.disposed) for (const el of roots) el.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
    })
  }
  private key(card: KanbanCard): string { return JSON.stringify([card.originId, card.uid ?? card.id]) }
  private baseName(card: KanbanCard): string {
    const previews = import.meta.env.DEV ? new URLSearchParams(location.search).getAll('theme-preview') : []
    const preview = previews.find(value => value.startsWith(`${card.uid ?? card.id}:`))?.slice((card.uid ?? card.id).length + 1)
    const declared = preview ?? card.theme ?? 'portolan'
    const name = declared.toLowerCase().replaceAll(' ', '-')
    if (bundled[`./themes/${name}.css`] && name !== 'surface') return name
    if (!this.warnings.has(declared)) { console.warn(`Shuttle theme: unknown theme “${declared}”; using Portolan`); this.warnings.add(declared) }
    return 'portolan'
  }
  private compile(entry: ThemeEntry): void {
    const selector = `[data-ws-theme="${entry.scope}"]`
    if (typeof CSSStyleSheet.prototype.replaceSync !== 'function') { entry.compiled = ''; return }
    const base = bundled[`./themes/${entry.base}.css`] ?? ''
    const asset = new URL(fileBytesUrl(this.base, '', entry.card.originId), document.baseURI)
    asset.pathname = asset.pathname.replace(/\/file$/, `/file-assets/${encodeURIComponent(entry.card.originId)}`)
      + `${entry.card.fiberDir ?? ''}/theme.css`.split('/').map(encodeURIComponent).join('/')
    asset.search = ''
    const assetBase = entry.card.fiberDir ? asset.href : undefined
    try {
      if (entry.custom) scopeTheme(entry.custom, selector, entry.scope, this.defaults, assetBase)
      entry.compiled = scopeTheme(base + '\n' + entry.custom, selector, entry.scope, this.defaults, assetBase)
    } catch (error) {
      console.warn('Shuttle theme: CSS could not be parsed; using the bundled base', error)
      entry.custom = ''
      entry.compiled = scopeTheme(base, selector, entry.scope, this.defaults, assetBase)
    }
  }
  private paint(entry: ThemeEntry): void {
    const roots = [...this.roots].filter(([, theme]) => theme === entry).map(([root]) => root)
    const plain = this.plain.has(entry.key)
    for (const root of roots) {
      const scope = plain ? undefined : entry.scope, name = plain ? 'plain' : entry.base
      if (root.dataset.wsTheme !== scope || root.dataset.wsThemeName !== name) this.changed(root)
      if (plain) delete root.dataset.wsTheme
      else root.dataset.wsTheme = entry.scope
      root.dataset.wsThemeName = name
    }
    if (!roots.length || plain) {
      if (entry.style) for (const root of roots) this.changed(root)
      entry.style?.remove(); entry.style = undefined
      return
    }
    let installed = false
    if (!entry.style) {
      entry.style = document.createElement('style')
      entry.style.dataset.wsThemeSheet = entry.scope
      document.head.append(entry.style)
      installed = true
    }
    if (entry.style.textContent !== entry.compiled) { entry.style.textContent = entry.compiled; installed = true }
    if (installed) for (const root of roots) this.changed(root)
  }
  private refresh(entry: ThemeEntry): Promise<void> {
    if (entry.pending) return entry.pending
    if (!entry.card.fiberDir || entry.card.uid?.startsWith('other:') || Date.now() - entry.readAt < REFRESH_MS) return Promise.resolve()
    entry.readAt = Date.now()
    const path = `${entry.card.fiberDir}/theme.css`
    const owner = entry.card.originId
    entry.pending = (async () => {
      try {
        const res = await fetch(fileBytesUrl(this.base, path, owner), {
          cache: 'no-store', signal: AbortSignal.timeout(25000),
          headers: entry.etag ? { 'If-None-Match': entry.etag } : undefined,
        })
        if (this.disposed || entry.card.fiberDir + '/theme.css' !== path || entry.card.originId !== owner || res.status === 304) return
        if (!res.ok) {
          if (res.status !== 404) console.warn(`Shuttle theme: ${path} on ${owner} could not be loaded; using the bundled base`)
          entry.custom = ''; entry.etag = undefined
        } else {
          entry.custom = await res.text()
          entry.etag = res.headers.get('ETag') ?? undefined
        }
      } catch (error) {
        console.warn(`Shuttle theme: ${path} on ${owner} could not be loaded; using the bundled base`, error)
        entry.custom = ''; entry.etag = undefined
      }
      if (!this.disposed) { this.compile(entry); this.paint(entry) }
    })().finally(() => { entry.pending = undefined })
    return entry.pending
  }
  dispose(): void {
    this.disposed = true
    for (const root of [...this.roots.keys()]) this.unbind(root)
    this.entries.clear()
    this.actDefaults.remove()
  }
}

/** Stable, selector-safe identity; two 32-bit hashes keep hosts with mirrored ids distinct. */
export function themeScopeId(key: string): string {
  let a = 2166136261, b = 5381
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    a = Math.imul(a ^ code, 16777619); b = Math.imul(b, 33) ^ code
  }
  return `ws-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`
}
