import { provesContent } from '../documentResources.js'

/** Inert first-screen markup, small enough to parse for a miniature page. */
export const PREVIEW_LIMIT = 48 * 1024
const MEDIA_LIMIT = 16 * 1024
const PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="360"%3E%3Cpath fill="currentColor" opacity=".12" d="M0 0h640v360H0z"/%3E%3C/svg%3E'
// Attribute quotes must stay encoded in both HTML attributes and CSS url().
const mediaPlaceholder = PLACEHOLDER.replaceAll('"', '%22')

const STYLE_LIMIT = PREVIEW_LIMIT - 32

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

export function buildThumbnailPreview(source: string): string {
  let html = inlineDataStylesheets(source.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ''))
  html = html.replace(/\b(src|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (attribute, name: string, value: string) => {
    const unquoted = value.replace(/^["']|["']$/g, '')
    return /^data:/i.test(unquoted) && unquoted.length > MEDIA_LIMIT ? `${name}="${mediaPlaceholder}"` : attribute
  })
  html = html.replace(/url\(\s*("[^"]*"|'[^']*'|[^)]*)\s*\)/gi, (url, value: string) => {
    const unquoted = value.trim().replace(/^["']|["']$/g, '')
    return /^data:/i.test(unquoted) && unquoted.length > MEDIA_LIMIT ? `url('${mediaPlaceholder}')` : url
  })
  html = html.replace(/(<svg\b[^>]*>)[\s\S]*?<\/svg\s*>/gi, (svg, opening: string) =>
    svg.length > MEDIA_LIMIT ? `${opening}<rect width="100%" height="100%" fill="currentColor" opacity=".12"/></svg>` : svg)
  // Keep the head's styles and the first screen's structure, not the rest of a report.
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

/** Cache only previews, one revision per owner-routed resource, with bounded retention. */
export class ThumbnailPreviewCache {
  private readonly entries = new Map<string, { etag: string; html: string }>()
  private readonly capacity: number
  constructor(capacity = 128) { this.capacity = capacity }
  get(src: string, source: string, etag?: string): string {
    const prior = this.entries.get(src)
    if (provesContent(etag) && prior?.etag === etag) return prior.html
    const html = buildThumbnailPreview(source)
    if (provesContent(etag)) {
      this.entries.delete(src)
      this.entries.set(src, { etag, html })
      if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!)
    }
    return html
  }
}

export const thumbnailPreviews = new ThumbnailPreviewCache()
