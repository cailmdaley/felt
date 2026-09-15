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
 * It is not quite a leaf any more: it imports the extension VOCABULARY from
 * utils (the same sets the Reader dispatches on) so that a card face and the
 * Reader can never disagree about what kind a file is. Still no DOM, no fetch.
 *
 * Attachments are deliberately not sent files. An attachment is evergreen and
 * central (the report the fiber IS about); a sent file is a one-off delivery
 * on a trail. The panel keeps them as two groups for that reason.
 */

import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  MARKDOWN_EXTS,
  TEXT_EXTS,
  fileExt,
  isAstraYaml,
} from './utils.js'

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
 * What KIND a file is, for the two decisions that turn on it: what a tap does,
 * and what face its card wears. One classifier so those two can't drift.
 *
 * `other` is the honest bucket — a `.docx`, a `.zip`, a suffixless name. The
 * browser has nothing to show for it, which is precisely why it behaves
 * differently from the kinds that do.
 */
export type FileKind = 'image' | 'audio' | 'html' | 'markdown' | 'text' | 'pdf' | 'other'

export function fileKind(path: string): FileKind {
  const ext = fileExt(path)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'pdf') return 'pdf'
  // An `astra.yaml` is a paper, not YAML: it renders in an iframe through the
  // Lightcone entry, so it must not be claimed by the text branch its suffix
  // would otherwise put it in.
  if (isAstraYaml(path)) return 'html'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'other'
}

/**
 * What a single click/tap on a file card should do.
 *
 * The rule is one line and it belongs in one place, because two surfaces obey
 * it — the attachment strip and the sent-files trail. Under a mouse, always
 * `read`: the Reader window has the tabs, the zoom and the ⤓.
 *
 * Under a FINGER it used to be `download`, always — because the Reader could
 * only ever hand a phone an iframe, and an iframed PDF cannot reach page 2.
 * But that indicted the iframe, not the Reader: an image, an audio file, a
 * rendered HTML report and now a rendered markdown/text pane all read fine in
 * the Reader's mobile sheet, and downloading them instead throws away the
 * tabs and the zoom to no purpose. So the download escape is narrowed to the
 * kinds that genuinely need the native viewer — a PDF, and anything the
 * browser can't lay out at all.
 */
export function fileTapAction(coarse: boolean, path: string): 'read' | 'download' {
  if (!coarse) return 'read'
  const kind = fileKind(path)
  return kind === 'pdf' || kind === 'other' ? 'download' : 'read'
}

/** How many bytes of a text file a card face needs. Generous enough that ~6
 *  lines survive even a file of long lines, small enough that a strip of them
 *  costs nothing. The daemon's file route answers a `Range` request with the
 *  whole body (no `Accept-Ranges`), so the slice happens here, not there. */
export const PREVIEW_BYTES = 2048

/**
 * The first few lines of a text file, trimmed for a card face.
 *
 * Leading blank lines are dropped (a file that opens with them would otherwise
 * show an empty face), each line is capped so one very long line can't push
 * the others out of view, and a truncated line says so with an ellipsis. A
 * trailing partial line — the near-certain result of slicing at a byte count —
 * is dropped only when there's enough above it to be worth reading.
 */
export function previewText(raw: string, maxLines = 6, maxCols = 90): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && lines[0].trim() === '') lines.shift()
  const kept = lines.slice(0, maxLines)
  return kept
    .map((line) => (line.length > maxCols ? `${line.slice(0, maxCols - 1)}…` : line))
    .join('\n')
    .trimEnd()
}
