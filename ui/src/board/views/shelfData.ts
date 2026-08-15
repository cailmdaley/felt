/**
 * shelfData — what the Shelf is a canvas OF.
 *
 * A leaf module: the fleet-wide sent-file record, its wire coercion, and the
 * pure transforms the view reads it through. No DOM, no layout — those are
 * ShelfView and shelfLayout.
 *
 * The record is `SentFile` (../sentFiles.ts) widened by the three facts a
 * card needs and a card's trail never did: WHICH FIBER sent it (`uid`, the
 * caption the fiber lens clusters under), WHICH DAEMON holds the bytes
 * (`host`, which `/api/v1/file` needs to route a remote read), and the
 * worker's own words for it (`caption`) when it left any. All three are
 * optional, because a daemon older than the composite answers without them
 * and a shelf of unattributed cards is still a shelf.
 */

import { normalizeSentFiles, type SentFile } from '../sentFiles.js'
import type { TemporalOrigins } from './TemporalData.js'

/** One file on the shelf. */
export interface ShelfFile extends SentFile {
  /** The fiber that sent it — the fiber lens's cluster key. */
  uid?: string
  /** The daemon holding the bytes. Absent means "this one". */
  host?: string | null
  /** The worker's own words, when it sent any. */
  caption?: string
}

export interface ShelfResult {
  files: ShelfFile[]
  /** Per-origin freshness, verbatim the composite's block. Empty when the
   *  daemon serves none — which reads as "nothing claims to be stale". */
  origins: TemporalOrigins
}

const EMPTY_SHELF: ShelfResult = { files: [], origins: {} }

/**
 * Coerce a composite body into shelf records.
 *
 * Built ON `normalizeSentFiles` rather than beside it: the path/basename/
 * timestamp coercion (including an older writer's ISO string where a number
 * belongs) is the same job, and a second dialect of "a sent file" is exactly
 * what that module exists to prevent. This pass only adds the three shelf
 * fields back on, index-aligned — which holds because the normalizer drops
 * only pathless records, so we filter the same way first.
 */
export function normalizeShelfFiles(raw: unknown): ShelfFile[] {
  const items = pickItems(raw)
  const kept = items.filter(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).fullPath === 'string' &&
      (item as Record<string, unknown>).fullPath !== '',
  )
  const base = normalizeSentFiles(kept)
  return base.map((file, i) => {
    const rec = (kept[i] ?? {}) as Record<string, unknown>
    const out: ShelfFile = { ...file }
    const uid = str(rec.uid) ?? str(rec.fiber)
    if (uid) out.uid = uid
    const host = str(rec.host) ?? str(rec.origin)
    if (host) out.host = host
    const caption = str(rec.caption) ?? str(rec.description)
    if (caption) out.caption = caption
    return out
  })
}

/**
 * Pull the record array out of whatever shape answered.
 *
 * The composite envelopes its payload; the single-host route has historically
 * answered with a bare array. Accepting both means the view never branches on
 * which daemon it is talking to.
 */
function pickItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return []
  const rec = raw as Record<string, unknown>
  for (const key of ['items', 'files', 'sentFiles', 'sent_files', 'events']) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[]
  }
  return []
}

/** The composite's origins block, or an empty one. */
export function pickOrigins(raw: unknown): TemporalOrigins {
  if (!raw || typeof raw !== 'object') return {}
  const origins = (raw as Record<string, unknown>).origins
  if (!origins || typeof origins !== 'object' || Array.isArray(origins)) return {}
  return origins as TemporalOrigins
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * One card per PATH, newest send winning, newest first.
 *
 * A file sent five times is one thing that was revised five times, not five
 * things — and the shelf is a surface of things. The surviving record keeps
 * the latest send's metadata (its fiber, its host, its caption), because that
 * is the state the card will actually render.
 */
export function dedupeByPath(files: readonly ShelfFile[]): ShelfFile[] {
  const best = new Map<string, ShelfFile>()
  for (const file of files) {
    const prior = best.get(file.fullPath)
    if (!prior || file.timestamp >= prior.timestamp) best.set(file.fullPath, file)
  }
  return [...best.values()].sort((a, b) => b.timestamp - a.timestamp || a.fullPath.localeCompare(b.fullPath))
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Read the fleet's sent files since `sinceMs`.
 *
 * Cross-host first, single-host as the fallback a daemon older than the
 * composite needs, and EMPTY for everything else — a 404, a 5xx, a network
 * error, a body that is not a list. The Shelf's empty state is a quiet line of
 * marginalia, so an unreachable daemon and a fleet that has sent nothing land
 * in the same honest place instead of an error splash.
 */
export async function fetchShelf(shuttleBase: string, sinceMs: number): Promise<ShelfResult> {
  // `since_ms`, an INSTANT, for the same reason every other temporal route
  // takes one: a civil day resolved in the daemon's zone is a different window
  // from the same day resolved in the browser's.
  const since = Math.floor(sinceMs)
  const urls = [
    `${shuttleBase}/api/v1/sent-files/all/composite?since_ms=${since}`,
    `${shuttleBase}/api/v1/sent-files/all?since_ms=${since}`,
  ]
  for (const url of urls) {
    let body: unknown
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      body = await res.json()
    } catch {
      continue
    }
    // An OK response is the answer, including an empty one — a fleet that has
    // sent nothing is a fact, not a reason to ask the older route for a second
    // opinion. Only a route that isn't there falls through to the next.
    return { files: dedupeByPath(normalizeShelfFiles(body)), origins: pickOrigins(body) }
  }
  return EMPTY_SHELF
}

// ── File kind ────────────────────────────────────────────────────────────────

/** What a card can put in its body. */
export type ShelfKind = 'page' | 'image' | 'pdf' | 'text' | 'opaque'

const KIND_BY_EXT: Record<string, ShelfKind> = {
  html: 'page', htm: 'page', svg: 'page',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image',
  pdf: 'pdf',
  txt: 'text', log: 'text', csv: 'text', json: 'text', md: 'text',
}

/**
 * Which face a path wears. `opaque` is the honest answer for everything the
 * browser would offer to download rather than draw — a tarball, a notebook, a
 * binary — and those get the quiet file card with an open-in-new-tab escape
 * instead of an iframe that renders as a blank rectangle or, worse, a
 * download prompt.
 */
export function shelfKind(path: string): ShelfKind {
  const base = path.split('/').filter(Boolean).pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'opaque'
  return KIND_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? 'opaque'
}

/** The `/api/v1/file` read for a card, owner-routed when the file is remote. */
export function fileUrl(shuttleBase: string, file: ShelfFile): string {
  const origin = file.host ? `&origin=${encodeURIComponent(file.host)}` : ''
  return `${shuttleBase}/api/v1/file?path=${encodeURIComponent(file.fullPath)}${origin}`
}
