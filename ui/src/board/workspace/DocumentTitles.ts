import { provesContent } from '../documentResources.js'
export interface DocumentTitle { title?: string; preview: string; etag?: string }
const titles = new Map<string, DocumentTitle>()
const versions = new Map<string, DocumentTitle>()
const listeners = new Set<(key: string) => void>()
/** Keys whose title was read from the document in this session, not recalled from storage. */
const current = new Set<string>()

/**
 * Declared titles outlive the session so a return visit names its tabs at
 * once: the most recently used titles, each with the validator it was read
 * under, kept in localStorage. Storage is optional; every access may throw.
 */
export const TITLE_STORAGE = 'shuttle:workspace:titles'
export const TITLE_STORAGE_LIMIT = 300
type StoredTitle = [key: string, title: string, etag: string | null]
let saveTimer: ReturnType<typeof setTimeout> | undefined
function recall(): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(TITLE_STORAGE) ?? '[]')
    if (!Array.isArray(stored)) return
    for (const entry of stored.slice(-TITLE_STORAGE_LIMIT)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') continue
      titles.set(entry[0], { title: entry[1], preview: '', etag: typeof entry[2] === 'string' ? entry[2] : undefined })
    }
  } catch { /* Storage is optional. */ }
}
function save(): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const entries: StoredTitle[] = []
    for (const [key, value] of titles) if (value.title) entries.push([key, value.title, value.etag ?? null])
    try { localStorage.setItem(TITLE_STORAGE, JSON.stringify(entries.slice(-TITLE_STORAGE_LIMIT))) } catch { /* Storage is optional. */ }
  }, 500)
}
/** Most recently used last: a read or a write moves a title to the end; storage keeps the newest. */
let latest: string | undefined
function touch(key: string, value: DocumentTitle): void {
  titles.delete(key)
  titles.set(key, value)
  latest = key
}
recall()
latest = [...titles.keys()].at(-1)

export function declaredTitle(key: string): DocumentTitle | undefined {
  const value = titles.get(key)
  if (value && key !== latest) { touch(key, value); if (value.title) save() }
  return value
}
/** A recalled title names a tab until the document itself is read again; only then is it current. */
export function titleIsCurrent(key: string): boolean { return current.has(key) }
export function watchDocumentTitles(listener: (key: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
/** Titles and previews are read from a document's head, so it is all that is parsed or versioned. */
const VERSION_HEAD = 65536
const clean = (text: string): string => text.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)

/**
 * Cheap declared metadata only; compressed PDF objects and absent media tags
 * fall back to filenames. Titles and previews live in a document's head, so
 * only its first 64 KiB is ever parsed, whatever length of source arrives.
 */
export function extractDocumentTitle(path: string, whole: string | Uint8Array): Omit<DocumentTitle, 'etag'> {
  const source = typeof whole === 'string' ? whole.slice(0, VERSION_HEAD) : whole.subarray(0, VERSION_HEAD)
  if (typeof source === 'string') {
    if (/\.html?$/i.test(path)) {
      const parsed = new DOMParser().parseFromString(source, 'text/html')
      for (const node of parsed.querySelectorAll('script,style,nav')) node.remove()
      const title = clean(parsed.querySelector('title')?.textContent ?? '') || clean(parsed.querySelector('h1')?.textContent ?? '')
      return { title: title || undefined, preview: clean(parsed.body.textContent ?? '').slice(0, 800) }
    }
    const title = /\.(?:md|markdown)$/i.test(path) ? clean(/^#\s+(.+?)(?:\s+#+)?\s*$/m.exec(source)?.[1] ?? '') : ''
    return { title: title || undefined, preview: source.slice(0, 800) }
  }
  const ascii = new TextDecoder('latin1').decode(source)
  if (/\.pdf$/i.test(path)) {
    const value = /\/Title\s*\(((?:\\.|[^\\)])*)\)/s.exec(ascii)?.[1]
    let decoded = value?.replace(/\\([()\\])/g, '$1').replace(/\\[nr]/g, ' ').replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))) ?? ''
    if (decoded.startsWith('\u00fe\u00ff') || decoded.startsWith('\u00ff\u00fe')) {
      const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
      decoded = new TextDecoder(decoded.charCodeAt(0) === 0xfe ? 'utf-16be' : 'utf-16le').decode(bytes)
    }
    const title = clean(decoded)
    return { title: title || undefined, preview: '' }
  }
  if (ascii.startsWith('ID3')) {
    const version = source[3]
    let offset = 10
    const sync = (at: number): number => (source[at] << 21) | (source[at + 1] << 14) | (source[at + 2] << 7) | source[at + 3]
    if (source[5] & 0x40) {
      offset += version === 4 ? sync(offset) : new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset) + 4
    }
    while (offset + 10 < source.length) {
      const id = ascii.slice(offset, offset + (version === 2 ? 3 : 4))
      const length = version === 2 ? (source[offset + 3] << 16) | (source[offset + 4] << 8) | source[offset + 5]
        : version === 4 ? sync(offset + 4) : new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset + 4)
      const header = version === 2 ? 6 : 10
      if (!length || offset + header + length > source.length) break
      if (id === 'TIT2' || id === 'TT2') {
        const encoding = source[offset + header]
        const bytes = source.subarray(offset + header + 1, offset + header + length)
        const codec = encoding === 3 ? 'utf-8' : encoding === 2 ? 'utf-16be' : encoding === 1 ? (bytes[0] === 0xfe ? 'utf-16be' : 'utf-16le') : 'latin1'
        return { title: clean(new TextDecoder(codec).decode(bytes).replace(/^\uFEFF/, '')) || undefined, preview: '' }
      }
      offset += header + length
    }
  }
  // Vorbis comments in Ogg and FLAC carry a little-endian length before each UTF-8 field.
  const at = ascii.toUpperCase().indexOf('TITLE=')
  if (at >= 4) {
    const length = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(at - 4, true)
    if (length >= 6 && length < 4096 && at + length <= source.length) return { title: clean(new TextDecoder().decode(source.subarray(at + 6, at + length))) || undefined, preview: '' }
  }
  return { preview: '' }
}

/**
 * A source arrives from the thumbnail's own read; extraction is once per
 * identity and content version: the digest ETag, else a hash of the source's
 * first 64 KiB and its length, since a stat validator can stay put while the
 * bytes change. A whole body is never hashed in full.
 */
export function cacheDocumentTitle(key: string, path: string, source: string | Uint8Array, etag?: string): DocumentTitle {
  let content: string
  if (provesContent(etag)) content = etag
  else {
    let hash = 2166136261
    const end = Math.min(source.length, VERSION_HEAD)
    for (let i = 0; i < end; i++) hash = Math.imul(hash ^ (typeof source === 'string' ? source.charCodeAt(i) : source[i]), 16777619)
    content = `${etag ?? ''}|${source.length}|${hash >>> 0}`
  }
  const version = JSON.stringify([key, content])
  const next = versions.get(version) ?? { ...extractDocumentTitle(path, source), etag }
  versions.set(version, next)
  if (versions.size > 512) versions.delete(versions.keys().next().value!)
  const held = titles.get(key)
  current.delete(key)
  current.add(key)
  // Bounded for a long session: a forgotten key only means its next render peeks it again.
  if (current.size > 2000) current.delete(current.values().next().value!)
  touch(key, next)
  save()
  if (held !== next && (held?.title !== next.title || held?.preview !== next.preview)) for (const listener of listeners) listener(key)
  return next
}
