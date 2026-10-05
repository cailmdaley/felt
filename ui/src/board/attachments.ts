/**
 * Parse `:::{embed}` declarations from a fiber body.
 *
 * The parser has no DOM or network work. The document workspace lists declared
 * artifacts on the fiber page and keeps them distinct from sent-file receipts.
 * Extension sets from `utils` give the overview and reader one file taxonomy.
 */

import {
  AUDIO_EXTS,
  VIDEO_EXTS,
  IMAGE_EXTS,
  MARKDOWN_EXTS,
  TEXT_EXTS,
  fileExt,
} from './utils.js'

/** One `:::{embed}` declaration, in body order. */
export interface Attachment {
  /** The path exactly as written; the reader resolves relative paths against
   *  the fiber's directory. */
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

/** The lowercased extension shown on a document card, or `file` when absent. */
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
export type FileKind = 'image' | 'audio' | 'video' | 'html' | 'markdown' | 'text' | 'pdf' | 'other'

export function fileKind(path: string): FileKind {
  const ext = fileExt(path)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'pdf') return 'pdf'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'other'
}

/**
 * Choose whether a file opens in the Board reader or downloads.
 * Fine pointers open every kind in the reader. Coarse pointers download PDFs
 * and unsupported formats; other documents remain readable in the reader.
 */
export function fileTapAction(coarse: boolean, path: string): 'read' | 'download' {
  if (!coarse) return 'read'
  const kind = fileKind(path)
  return kind === 'pdf' || kind === 'other' ? 'download' : 'read'
}

/** Text preview budget: enough for six opening lines on a card face. */
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
