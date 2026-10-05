export interface DocumentTitle { title?: string; preview: string; etag?: string }
const titles = new Map<string, DocumentTitle>()
const versions = new Map<string, DocumentTitle>()
const listeners = new Set<(key: string) => void>()
export function declaredTitle(key: string): DocumentTitle | undefined { return titles.get(key) }
export function watchDocumentTitles(listener: (key: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const clean = (text: string): string => text.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, 240)

/** Cheap declared metadata only; compressed PDF objects and absent media tags fall back to filenames. */
export function extractDocumentTitle(path: string, source: string | Uint8Array): Omit<DocumentTitle, 'etag'> {
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

/** A source arrives from the thumbnail's own read; extraction is once per identity and ETag. */
export function cacheDocumentTitle(key: string, path: string, source: string | Uint8Array, etag?: string): DocumentTitle {
  let hash = 2166136261
  if (!etag) {
    for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ (typeof source === 'string' ? source.charCodeAt(i) : source[i]), 16777619)
  }
  const version = JSON.stringify([key, etag ?? hash])
  const next = versions.get(version) ?? { ...extractDocumentTitle(path, source), etag }
  versions.set(version, next)
  if (versions.size > 512) versions.delete(versions.keys().next().value!)
  const held = titles.get(key)
  titles.set(key, next)
  if (held !== next) for (const listener of listeners) listener(key)
  return next
}
