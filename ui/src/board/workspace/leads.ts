import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import type { MapFile } from '../family/model.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { fileBytesUrl } from '../utils.js'
import { unseenSince } from './DocumentSeen.js'
import { COMPANION_NAMES, docKey } from './documents.js'

/**
 * The first companion page a fiber's directory holds, skipping past any
 * `listed` already names, which ends the search: undefined when it holds
 * none, null when its owner could not say.
 */
export async function companion(base: string, fiberDir: string, owner: string, listed: (path: string) => boolean = () => false): Promise<{ path: string; name: string; modifiedAt?: string } | null | undefined> {
  let unknown = false
  for (const file of COMPANION_NAMES) {
    const path = `${fiberDir}/${file}`
    if (listed(path)) return undefined
    const result = await head(fileBytesUrl(base, path, owner), RESOURCE_PRIORITY.neighbour, { fresh: true })
    if (result?.exists) return { path, name: file[0].toUpperCase() + file.slice(1, -5), modifiedAt: result.modifiedAt ?? undefined }
    unknown ||= !result
  }
  return unknown ? null : undefined
}

/** Each constitution's tapestry or report, read once and again when its card's file changes or its owner could not say. */
export class Leads {
  private readonly reads = new Map<string, { modified?: string; read: Promise<MapFile | null | undefined> }>()
  private readonly base: string
  constructor(base: string) { this.base = base }

  of(card: KanbanCard): Promise<MapFile | null | undefined> {
    const key = `${card.originId}:${card.uid ?? card.id}`, known = this.reads.get(key)
    if (known && known.modified === card.modifiedAt) return known.read
    const read = this.read(card)
    this.reads.set(key, { modified: card.modifiedAt, read })
    void read.then(found => { if (found === null && this.reads.get(key)?.read === read) this.reads.delete(key) })
    return read
  }

  private async read(card: KanbanCard): Promise<MapFile | null | undefined> {
    if (!card.fiberDir) return undefined
    const found = await companion(this.base, card.fiberDir, card.originId)
    if (!found) return found
    const key = docKey(card.originId, found.path, card.originId, card.fiberDir), at = Date.parse(found.modifiedAt ?? '') || 0
    return { key, name: found.name, at, unread: at > 0 && unseenSince(key, at) }
  }
}
