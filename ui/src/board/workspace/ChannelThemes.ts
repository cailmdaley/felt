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
  private readonly plain = new Set<string>()
  private readonly warnings = new Set<string>()
  private disposed = false
  private readonly actDefaults: HTMLStyleElement
  private readonly base: string
  constructor(base: string) {
    this.base = base
    // Snapshot the unthemed root, not the reader. Custom variables at a channel
    // root cannot bleed through the CSS scope limit by ordinary inheritance.
    this.actDefaults = document.createElement('style')
    this.actDefaults.dataset.wsActDefaults = ''
    const defaults = getComputedStyle(document.documentElement)
    const reset: string[] = []
    for (let i = 0; i < defaults.length; i++) {
      const name = defaults.item(i)
      if (name.startsWith('--ws-') && name !== '--ws-paper' && name !== '--ws-ink') reset.push(`${name}: ${defaults.getPropertyValue(name)};`)
    }
    this.actDefaults.textContent = `[data-ws-theme] [data-part="act"] {
      ${reset.join('\n')}
      --ws-ink-soft: var(--ws-ink); --ws-ink-muted: var(--ws-ink); --ws-ink-faint: var(--ws-ink);
      --ws-hairline: color-mix(in srgb, var(--ws-ink) 35%, transparent);
      --ws-hairline-soft: color-mix(in srgb, var(--ws-ink) 20%, transparent);
      --ws-fill: color-mix(in srgb, var(--ws-ink) 10%, var(--ws-paper));
      --ws-hover: color-mix(in srgb, var(--ws-ink) 8%, transparent);
      --ws-agent: color-mix(in srgb, var(--kbn-agent) 50%, var(--ws-ink));
      --ws-you: color-mix(in srgb, var(--kbn-you) 55%, var(--ws-ink));
      --ws-owed: color-mix(in srgb, var(--kbn-owed) 40%, var(--ws-ink));
      --ws-verdict: color-mix(in srgb, var(--kbn-tempered-ink) 40%, var(--ws-ink));
      color: var(--ws-ink); font-style: normal; font-weight: normal; text-shadow: none;
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
    if (entry) { this.paint(entry); if (!this.plain.has(key)) void this.refresh(entry) }
  }
  bind(root: HTMLElement, card: KanbanCard): void {
    if (this.disposed) return
    const key = this.key(card)
    const old = this.roots.get(root)
    if (old?.key !== key) this.unbind(root)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { key, scope: themeScopeId(key), card, base: '', custom: '', compiled: '', readAt: -Infinity }
      this.entries.set(key, entry)
    }
    this.roots.set(root, entry)
    const oldDir = entry.card.fiberDir
    entry.card = card
    const base = this.baseName(card)
    if (entry.base !== base || oldDir !== card.fiberDir) {
      entry.base = base
      if (oldDir !== card.fiberDir) { entry.custom = ''; entry.etag = undefined; entry.readAt = -Infinity }
      this.compile(entry)
    }
    this.paint(entry)
    if (!this.isPlain(card)) void this.refresh(entry)
  }
  unbind(root: HTMLElement): void {
    const old = this.roots.get(root)
    this.roots.delete(root)
    delete root.dataset.wsTheme
    delete root.dataset.wsThemeName
    if (old) this.paint(old)
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
    try {
      if (entry.custom) scopeTheme(entry.custom, selector, entry.scope)
      entry.compiled = scopeTheme(base + '\n' + entry.custom, selector, entry.scope)
    } catch (error) {
      console.warn('Shuttle theme: CSS could not be parsed; using the bundled base', error)
      entry.custom = ''
      entry.compiled = scopeTheme(base, selector, entry.scope)
    }
  }
  private paint(entry: ThemeEntry): void {
    const roots = [...this.roots].filter(([, theme]) => theme === entry).map(([root]) => root)
    const plain = this.plain.has(entry.key)
    for (const root of roots) {
      if (plain) { delete root.dataset.wsTheme; root.dataset.wsThemeName = 'plain' }
      else { root.dataset.wsTheme = entry.scope; root.dataset.wsThemeName = entry.base }
    }
    if (!roots.length || plain) { entry.style?.remove(); entry.style = undefined; return }
    if (!entry.style) {
      entry.style = document.createElement('style')
      entry.style.dataset.wsThemeSheet = entry.scope
      document.head.append(entry.style)
    }
    if (entry.style.textContent !== entry.compiled) entry.style.textContent = entry.compiled
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
  for (const c of key) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0) }
  return `ws-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`
}
