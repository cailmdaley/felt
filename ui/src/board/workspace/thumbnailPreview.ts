import { provesContent } from '../documentResources.js'

/** Inert first-screen markup, small enough to parse for a miniature page. */
export const PREVIEW_LIMIT = 48 * 1024
const MEDIA_LIMIT = 16 * 1024
const PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="360"%3E%3Cpath fill="currentColor" opacity=".12" d="M0 0h640v360H0z"/%3E%3C/svg%3E'
// Attribute quotes must stay encoded in both HTML attributes and CSS url().
const mediaPlaceholder = PLACEHOLDER.replaceAll('"', '%22')

const STYLE_LIMIT = PREVIEW_LIMIT - 32
/**
 * How many images and embedded pages a preview loads. A preview is drawn
 * without scripts, where the browser loads every image at once whatever its
 * `loading`, and shows only its first screen: a report's forty figures would
 * all be fetched and decoded for the two that show.
 */
export const PREVIEW_MEDIA = 4

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i').exec(tag)
  return match?.[1].replace(/^["']|["']$/g, '')
}

/** The stylesheet a `data:text/css` URI carries, or null when it cannot be read. */
function dataStylesheet(uri: string): string | null {
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const payload = uri.slice(comma + 1)
  try {
    if (!/;base64$/i.test(uri.slice(0, comma))) return decodeURIComponent(payload)
    return new TextDecoder().decode(Uint8Array.from(atob(payload), char => char.charCodeAt(0)))
  } catch { return null }
}

/**
 * A large embedded stylesheet link becomes the style block it carries, so the
 * miniature keeps its styling without a link the placeholder would break; one
 * too large for the head's budget is dropped.
 */
function inlineDataStylesheets(html: string): string {
  return html.replace(/<link\b[^>]*>/gi, link => {
    const href = attribute(link, 'href')
    if (!href || !/^data:text\/css[;,]/i.test(href) || href.length <= MEDIA_LIMIT) return link
    if (href.length > STYLE_LIMIT * 3) return ''
    const css = dataStylesheet(href)
    if (css === null || css.length > STYLE_LIMIT || /<\/style/i.test(css)) return ''
    const media = attribute(link, 'media')
    return `<style${media ? ` media="${media.replaceAll('"', '&quot;')}"` : ''}>${css}</style>`
  })
}

/** Where a large embedded image stands while the markup is cut: a token the cut cannot split it at. */
const TOKEN = /\u0000(\d+)\u0000/g

/**
 * A page's first screen as inert markup: its scripts removed, its head's
 * styles kept, its body cut to {@link PREVIEW_LIMIT}. For a thumbnail
 * (`keepMedia` false) every large embedded image, stylesheet link or inline
 * SVG becomes a grey placeholder, which reads the same at 176 by 116 and
 * keeps the miniature small; a larger preview keeps them whole, outside the
 * cut's count, so a figure or a cover draws as it is.
 */
export function buildThumbnailPreview(source: string, keepMedia = false): string {
  let html = inlineDataStylesheets(source.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ''))
  const kept: string[] = []
  const large = (whole: string, placeholder: string): string => {
    if (whole.length <= MEDIA_LIMIT) return whole
    if (!keepMedia) return placeholder
    kept.push(whole)
    return `\u0000${kept.length - 1}\u0000`
  }
  html = html.replace(/\b(src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (attribute, _name: string, value: string) => {
    const unquoted = value.replace(/^["']|["']$/g, '')
    return /^data:/i.test(unquoted) && unquoted.length > MEDIA_LIMIT ? attribute.replace(unquoted, () => large(unquoted, mediaPlaceholder)) : attribute
  })
  html = html.replace(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (url, value: string) => {
    const unquoted = value.trim().replace(/^["']|["']$/g, '')
    return /^data:/i.test(unquoted) && unquoted.length > MEDIA_LIMIT ? `url('${large(unquoted, mediaPlaceholder)}')` : url
  })
  html = html.replace(/(<svg\b[^>]*>)[\s\S]*?<\/svg\s*>/gi, (svg, opening: string) =>
    large(svg, `${opening}<rect width="100%" height="100%" fill="currentColor" opacity=".12"/></svg>`))
  // A token the cut split is dropped, a whole one at the end kept; a kept image inside a kept SVG holds its own token: restore until none is left.
  let preview = cut(html).replace(/(?<!\u0000\d+)\u0000\d*$/, ''), before = ''
  while (preview !== before) { before = preview; preview = preview.replace(TOKEN, (_, index: string) => kept[Number(index)]) }
  return loadFirstMedia(preview)
}

/** Past the first {@link PREVIEW_MEDIA}, an image draws the placeholder and an embedded page, video or source loads nothing. */
function loadFirstMedia(html: string): string {
  let seen = 0
  return html.replace(/<(img|source|video|audio|iframe|frame|object|embed|input)\b[^>]*>/gi, (tag, name: string) => {
    if (name.toLowerCase() === 'input' && attribute(tag, 'type')?.toLowerCase() !== 'image') return tag
    if (seen++ < PREVIEW_MEDIA) return tag
    const blank = /^(img|input)$/i.test(name) ? mediaPlaceholder : 'about:blank'
    return tag
      .replace(/\s(srcset|imagesrcset)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s(src|data|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (_, attr: string) => ` ${attr}="${attr.toLowerCase() === 'poster' ? mediaPlaceholder : blank}"`)
  })
}

/** Keep the head's styles and the first screen's structure, not the rest of a report. */
function cut(html: string): string {
  const body = /<body\b[^>]*>/i.exec(html)
  if (!body) return html.slice(0, PREVIEW_LIMIT)
  const start = body.index + body[0].length
  let head = html.slice(0, body.index)
  if (head.length > PREVIEW_LIMIT) {
    // Keep complete style blocks that fit; cutting inside a style hides the body.
    let styles = ''
    for (const match of head.matchAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi)) {
      if (styles.length + match[0].length <= STYLE_LIMIT) styles += match[0]
    }
    head = `<head>${styles}</head>`
  }
  return head + body[0] + html.slice(start, start + PREVIEW_LIMIT)
}

/** Cache only previews, one revision per owner-routed resource, within a byte budget, the least recently used leaving first. */
export class ThumbnailPreviewCache {
  private readonly entries = new Map<string, { etag: string; html: string }>()
  private readonly budget: number
  private bytes = 0
  /** `budget` in bytes, a string's UTF-16 code units at two each: a larger preview keeps its media whole, so its count alone bounds nothing. */
  constructor(budget = 4 * 1024 * 1024) { this.budget = budget }
  /** A resource's preview, for a thumbnail or (`keepMedia`) a larger preview: one entry each. */
  get(src: string, source: string, etag?: string, keepMedia = false): string {
    const key = keepMedia ? `keep:${src}` : src
    const prior = this.entries.get(key)
    if (provesContent(etag) && prior?.etag === etag) {
      this.entries.delete(key)
      this.entries.set(key, prior)
      return prior.html
    }
    const html = buildThumbnailPreview(source, keepMedia)
    if (provesContent(etag)) {
      if (prior) { this.entries.delete(key); this.bytes -= prior.html.length * 2 }
      this.entries.set(key, { etag, html })
      this.bytes += html.length * 2
      for (const [oldest, entry] of this.entries) {
        if (this.bytes <= this.budget) break
        this.entries.delete(oldest)
        this.bytes -= entry.html.length * 2
      }
    }
    return html
  }
}

export const thumbnailPreviews = new ThumbnailPreviewCache()
