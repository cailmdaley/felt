/**
 * Attachments — what a fiber body declares with `:::{embed} <path>`.
 *
 * A leaf module: parse only, no DOM and no fetch. An embed used to render
 * INLINE, which nested a scrolling document inside the scrolling constitution
 * — awkward on a desktop and unusable on a phone, where an embedded PDF could
 * never reach page 2. So the directive is now a DECLARATION, not a placement:
 * it names a file the fiber keeps current, and the panel draws every one of
 * them as a card in a strip above the prose. Where the directive sat in the
 * body no longer means anything, and nothing of it is left in the text.
 *
 * Attachments are deliberately not sent files. An attachment is evergreen and
 * central (the report the fiber IS about); a sent file is a one-off delivery
 * on a trail. The panel keeps them as two groups for that reason.
 */

/** One `:::{embed}` declaration, in body order. */
export interface Attachment {
  /** The path exactly as written — relative paths resolve against the fiber's
   *  own dir at render time, the same anchor inline embeds used. */
  path: string
  /** The `:title:` option, when the author gave one. */
  title?: string
}

// `:::{embed} <path>` then optional `:key: val` option lines, closed by `:::`.
const EMBED_RE =
  /^:::\{embed\}[ \t]+(\S+)[^\n]*\n((?:[ \t]*:[a-zA-Z-]+:[^\n]*\n)*)[ \t]*:::[ \t]*$/gim

/**
 * Split a markdown body into its attachments and the prose that remains.
 *
 * The directives are removed outright rather than replaced by a marker: the
 * card strip is the only place an attachment appears, and a "see above" stub
 * in the prose would be furniture. Collapsing the blank lines the removal
 * leaves behind keeps a body whose only content was an embed from rendering
 * as a page of whitespace.
 */
export function extractEmbeds(md: string): { body: string; attachments: Attachment[] } {
  const attachments: Attachment[] = []
  const body = md
    .replace(EMBED_RE, (_match, path: string, optionBlock: string) => {
      const title = parseEmbedTitle(optionBlock)
      attachments.push(title ? { path, title } : { path })
      return ''
    })
    // Three or more newlines can only be the hole a removed block left.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { body, attachments }
}

function parseEmbedTitle(block: string): string | undefined {
  for (const line of block.split('\n')) {
    const m = line.match(/^[ \t]*:([a-zA-Z-]+):[ \t]*(.*)$/)
    if (m && m[1].toLowerCase() === 'title') {
      const val = m[2].trim()
      if (val) return val
    }
  }
  return undefined
}

/** The extension glyph a card wears, mirroring the Shelf's card face: the
 *  suffix, lowercased, or `file` when there is none. */
export function attachmentGlyph(path: string): string {
  const base = path.split('/').filter(Boolean).pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'file'
  return base.slice(dot + 1).split(/[?#]/)[0].toLowerCase() || 'file'
}

/** A byte count in the fewest characters that stay true. `undefined` when the
 *  daemon didn't tell us — a card simply shows no size rather than a zero. */
export function formatBytes(size: number | undefined): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * What a single click/tap on a file card should do.
 *
 * The rule is one line and it belongs in one place, because two surfaces obey
 * it — the attachment strip and the sent-files trail. Under a mouse, `read`:
 * the Reader window has the tabs, the zoom and the ⤓. Under a finger,
 * `download`: on iOS that is what hands the file to the native viewer, the one
 * surface that can page a PDF, and it is exactly what the Reader's ⤓ did at a
 * cost of two taps.
 */
export function fileTapAction(coarse: boolean): 'read' | 'download' {
  return coarse ? 'download' : 'read'
}
