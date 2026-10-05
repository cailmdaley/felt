import { readThumbnailMetadata } from '../FileViewerPanel.js'
import { fileBytesUrl } from '../utils.js'
import { cacheDocumentTitle, titleIsCurrent } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'

/**
 * Kinds whose first bytes can declare a title, most likely first: an HTML or
 * Markdown heading, then PDF Info, then ID3 or Vorbis tags.
 */
const TITLED: Partial<Record<WorkspaceDocument['kind'], number>> = { html: 0, text: 1, pdf: 2, audio: 3 }
/** At most this many peeks are in flight; the rest wait by kind, then index order. */
const CONCURRENT = 2
/** A peek that could not read waits this long before a render may try it again. */
export const PROBE_RETRY_MS = 60_000
/** The version each document was last peeked at; a changed file is peeked again. */
const probed = new Map<string, string>()
/** Probe memory stays bounded across a long session; the oldest entries are forgotten first. */
const PROBED_LIMIT = 2000
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
 * document's first 64 KiB once per version, independent of any thumbnail
 * (revalidating any title recalled from an earlier visit),
 * ahead of the stage's images and frames competing for the same connections.
 */
/** What the channel knows of a document's version: its modification time and its latest receipt. */
export function documentVersion(doc: WorkspaceDocument): string {
  const sent = doc.provenance.reduce((latest, p) => p.kind === 'sent' && Number.isFinite(p.time) ? Math.max(latest, p.time) : latest, 0)
  return `${doc.modifiedAt ?? ''}|${sent || ''}`
}

export function probeDocumentTitles(shuttleBase: string, documents: WorkspaceDocument[]): void {
  for (const doc of documents) {
    const rank = TITLED[doc.kind]
    if (rank === undefined) continue
    const version = documentVersion(doc)
    const seen = probed.get(doc.key)
    // A title read this session (by this probe or the page's own load) stands until the
    // document's version moves; one recalled from an earlier visit is revalidated.
    if (seen === version) continue
    probed.delete(doc.key)
    probed.set(doc.key, version)
    if (probed.size > PROBED_LIMIT) probed.delete(probed.keys().next().value!)
    if (seen === undefined && titleIsCurrent(doc.key)) continue
    queue.push({ rank, run: async () => {
      let read = false
      await readThumbnailMetadata(fileBytesUrl(shuttleBase, doc.path, doc.owner), new AbortController().signal, (source, etag) => {
        read = true
        // A newer version's peek supersedes this one.
        if (probed.get(doc.key) !== version) return
        const text = doc.kind === 'html' || doc.kind === 'text'
        cacheDocumentTitle(doc.key, doc.path, text && typeof source !== 'string' ? new TextDecoder().decode(source) : source, etag)
      }, 'high')
      // A peek that could not read (an unreachable owner, a refused request) is tried again on a later render.
      if (!read) setTimeout(() => { if (probed.get(doc.key) === version) probed.delete(doc.key) }, PROBE_RETRY_MS)
    } })
  }
  queue.sort((a, b) => a.rank - b.rank)
  pump()
}
