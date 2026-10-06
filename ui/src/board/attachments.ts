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

/**
 * Classify a file by the content its extension identifies.
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
