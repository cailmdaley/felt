import { readThumbnailMetadata } from '../FileViewerPanel.js'
import { fileBytesUrl } from '../utils.js'
import { cacheDocumentTitle, declaredTitle } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'

/**
 * Kinds whose first bytes can declare a title, most likely first: an HTML or
 * Markdown heading, then PDF Info, then ID3 or Vorbis tags.
 */
const TITLED: Partial<Record<WorkspaceDocument['kind'], number>> = { html: 0, text: 1, pdf: 2, audio: 3 }
/** At most this many peeks are in flight; the rest wait by kind, then index order. */
const CONCURRENT = 2
const probed = new Set<string>()
const queue: Array<{ rank: number; run: () => Promise<void> }> = []
let running = 0

function pump(): void {
  while (running < CONCURRENT && queue.length) {
    const job = queue.shift()!
    running++
    void job.run().finally(() => { running--; pump() })
  }
}

/**
 * The index names pages by their declared titles, so it reads each titled
 * document's first 64 KiB once per session, independent of any thumbnail.
 */
export function probeDocumentTitles(shuttleBase: string, documents: WorkspaceDocument[]): void {
  for (const doc of documents) {
    const rank = TITLED[doc.kind]
    if (rank === undefined || probed.has(doc.key) || declaredTitle(doc.key)) continue
    probed.add(doc.key)
    queue.push({ rank, run: () => readThumbnailMetadata(fileBytesUrl(shuttleBase, doc.path, doc.owner), new AbortController().signal, (source, etag) => {
      if (declaredTitle(doc.key)) return
      const text = doc.kind === 'html' || doc.kind === 'text'
      cacheDocumentTitle(doc.key, doc.path, text && typeof source !== 'string' ? new TextDecoder().decode(source) : source, etag)
    }) })
  }
  queue.sort((a, b) => a.rank - b.rank)
  pump()
}
