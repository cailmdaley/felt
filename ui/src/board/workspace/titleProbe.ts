import { readThumbnailMetadata } from '../FileViewerPanel.js'
import { liveFileWatched } from '../LiveFileRefresh.js'
import { RESOURCE_PRIORITY } from '../documentResources.js'
import { fileBytesUrl } from '../utils.js'
import { cacheDocumentTitle, titleIsCurrent } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'

/**
 * Kinds whose first bytes can declare a title, most likely first: an HTML or
 * Markdown heading, then PDF Info, then ID3 or Vorbis tags.
 */
const TITLED: Partial<Record<WorkspaceDocument['kind'], number>> = { html: 0, text: 1, pdf: 2, audio: 3 }
/** A peek that could not read waits this long before a render may try it again. */
export const PROBE_RETRY_MS = 60_000
/** The version each document was last peeked at; a changed file is peeked again. */
const probed = new Map<string, { version: string }>()
/** Probe memory stays bounded across a long session; the oldest entries are forgotten first. */
const PROBED_LIMIT = 2000

/** What the channel knows of a document's version: its modification time and its latest receipt. */
export function documentVersion(doc: WorkspaceDocument): string {
  const sent = doc.provenance.reduce((latest, p) => p.kind === 'sent' && Number.isFinite(p.time) ? Math.max(latest, p.time) : latest, 0)
  return `${doc.modifiedAt ?? ''}|${sent || ''}`
}

/**
 * Pages are named by their declared titles, so each titled document's first
 * 64 KiB is read once per version (revalidating any title recalled from an
 * earlier visit), reports first, through the shared peek. A report or text
 * page mounted in the same render reads its whole body and names itself, so it
 * is not peeked as well.
 */
export function probeDocumentTitles(shuttleBase: string, documents: WorkspaceDocument[]): void {
  const jobs: Array<{ rank: number; run: () => Promise<void> }> = []
  for (const doc of documents) {
    const rank = TITLED[doc.kind]
    if (rank === undefined) continue
    const version = documentVersion(doc)
    const seen = probed.get(doc.key)
    // A title read this session (by this probe or the page's own load) stands until the
    // document's version moves; one recalled from an earlier visit is revalidated.
    if (seen?.version === version) continue
    // An owner file time arriving for the same receipts names the version already peeked.
    if (seen?.version.startsWith('|') && version.endsWith(seen.version)) { seen.version = version; continue }
    const entry = { version }
    probed.delete(doc.key)
    probed.set(doc.key, entry)
    if (probed.size > PROBED_LIMIT) probed.delete(probed.keys().next().value!)
    if (seen === undefined && titleIsCurrent(doc.key)) continue
    // A version that moved past an earlier peek is read fresh, not from the shared peek.
    const fresh = seen !== undefined
    jobs.push({ rank, run: async () => {
      const src = fileBytesUrl(shuttleBase, doc.path, doc.owner)
      // A page mounted in the same render reads these bytes in full and names itself.
      await Promise.resolve()
      if ((doc.kind === 'html' || doc.kind === 'text') && liveFileWatched(src)) return
      let read = false
      await readThumbnailMetadata(src, new AbortController().signal, (source, etag) => {
        read = true
        // A newer version's peek supersedes this one.
        if (probed.get(doc.key) !== entry) return
        const text = doc.kind === 'html' || doc.kind === 'text'
        cacheDocumentTitle(doc.key, doc.path, text && typeof source !== 'string' ? new TextDecoder().decode(source) : source, etag)
      }, RESOURCE_PRIORITY.title, fresh)
      // A peek that could not read (an unreachable owner, a refused request) is tried again on a later render.
      if (!read) setTimeout(() => { if (probed.get(doc.key) === entry) probed.delete(doc.key) }, PROBE_RETRY_MS)
    } })
  }
  // Reports first: the shared peek queue keeps arrival order within a priority.
  jobs.sort((a, b) => a.rank - b.rank)
  for (const job of jobs) void job.run()
}
