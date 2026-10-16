import { provesContent } from '../documentResources.js'

/** Inert first-screen markup, small enough to parse for a miniature page. */
export const PREVIEW_LIMIT = 48 * 1024
const MEDIA_LIMIT = 16 * 1024
const PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="360"%3E%3Cpath fill="currentColor" opacity=".12" d="M0 0h640v360H0z"/%3E%3C/svg%3E'
// Attribute quotes must stay encoded in both HTML attributes and CSS url().
const mediaPlaceholder = PLACEHOLDER.replaceAll('"', '%22')

export function buildThumbnailPreview(source: string): string {
  let html = source.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '')
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
      if (styles.length + match[0].length <= PREVIEW_LIMIT - 32) styles += match[0]
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
