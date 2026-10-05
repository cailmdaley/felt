import { documentActivity, type Channel, type DocKey } from './documents.js'

const PREFIX = 'shuttle.workspace.document-seen:'
const VISIT = 'shuttle.workspace.channel-seen:'
function read(key: string): number | undefined {
  try {
    const value = localStorage.getItem(key)
    const number = value === null ? NaN : Number(value)
    return Number.isFinite(number) ? number : undefined
  } catch { return undefined }
}
function write(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)) } catch { /* Storage is optional. */ }
}

/** First visits establish a quiet baseline; subsequent activity belongs to each document. */
export class DocumentSeen {
  private readonly seen = new Map<DocKey, number>()
  private readonly visited = new Set<string>()

  observe(channel: Channel, selected: DocKey, ready = true): Set<DocKey> {
    if (!ready) return new Set()
    const id = JSON.stringify([channel.owner, channel.uid])
    const first = !this.visited.has(id) && read(VISIT + id) === undefined
    this.visited.add(id)
    write(VISIT + id, Date.now())
    const fresh = new Set<DocKey>()
    for (const doc of channel.documents) {
      const activity = documentActivity(doc)
      const before = this.seen.get(doc.key) ?? read(PREFIX + doc.key)
      if (first || doc.key === selected) {
        const at = Math.max(Date.now(), activity ?? 0, before ?? 0)
        this.seen.set(doc.key, at)
        write(PREFIX + doc.key, at)
      } else if (activity !== undefined && (before === undefined || activity > before)) fresh.add(doc.key)
    }
    return fresh
  }
}
