// The standalone UI's "project" set — derived from Shuttle's registered
// felt-store list plus current card working dirs, not from historical cards.
//
// `GET /api/v1/felt-stores` is the canonical store registry. The composite feed
// is still useful for recency, substore-prefix inference, and current working
// directories: a remote may intentionally register only `~/loom` as its felt
// store while active/open Shuttle fibers run from project dirs such as `cmbx`.
// Local project dirs stay registry-curated because local historical cards still
// include retired checkouts.
// Closed historical fibers are not authority: they carry old `project_dir`
// values forever, so closed-only dirs would resurrect retired checkouts like
// Portolan/Shuttle.
//
// The one inferred quantity is `loomPrefix`: the loom-relative path the
// project's `.felt` symlinks to (e.g. `…/projects/portolan/.felt` →
// `loom/.felt/ai-futures/portolan`, so `loomPrefix = "ai-futures/portolan"`).
// `felt -C <project_dir> add <id> --top-level` expects `id` *relative to that
// substore*, so the Stash form derives ids project-relative; `loomPrefix` is
// what lets the parent picker scope to the project and strip loom paths down
// to project-relative slugs. Top-level stash never needs it (the id is the
// bare child slug and the daemon resolves the substore from `project_dir`); it
// only governs parent-nesting candidates.
//
// We infer it from the project's fibers' (loom-relative) slugs by exploiting
// the symlink *convention*: `…/projects/<name>/.felt → loom/.felt/<…>/<name>`,
// so the substore's last path segment IS the project_dir basename. We find the
// `<name>` segment in the project's fibers and take the prefix up to and
// including it (majority vote over the fibers that carry it). This is robust to
// scattering — `shuttle.project_dir` is the worker cwd, *independent* of where
// a fiber physically lives, so a project's fibers can be spread across the tree
// (a fiber worked from the shuttle checkout may sit at loom-root
// `workflow-era-rework`); a plain longest-common-prefix collapses to `''` on
// any such set, and a greedy majority over-deepens past the substore root into
// the dominant sub-cluster. Basename-matching sidesteps both. No basename
// segment (a store-root project like `~/loom`, or a private store like the
// iCloud `wedding`) → `''`, which is correct: the substore IS the store root.
// The residual mis-inference never mis-places a top-level stash (the daemon
// resolves the substore from `project_dir`); only nesting candidates are
// affected. A fully exact project_dir→substore map needs a daemon-side
// resolution (slice-4 server work).

import { parseCompositeFeed } from '../board/KanbanComposite.js'

/**
 * Normalize a project's `originId` to the owner-routing key the daemon's
 * `OriginRouter` expects on a write. The standalone feed always carries bare
 * host names (`origin || host`), so this is defense-in-depth: it strips a stray
 * `remote-` prefix (Portolan's old `'remote-<host>'` city-origin shape) that
 * would otherwise match no configured remote and silently fall through to a
 * mis-routed LOCAL write. Both owner-routed forms (Stash + Capture) send their
 * origin through here, so the guard is enforced in exactly one place.
 */
export const shuttleOrigin = (originId: string): string => originId.replace(/^remote-/, '')

export interface ProjectEntry {
  /** Stable key: `${originId}:${path}`. */
  id: string
  /** Display name — the project_dir basename. */
  name: string
  /** `shuttle.project_dir` — the worker cwd AND the create endpoint's felt root. */
  path: string
  /** Owning host/remote (bare name, e.g. `dapmcw68`, `candide`). */
  originId: string
  /** This origin is the local daemon's own host. Owner-routed writes (Stash
   *  create, Capture spawn) send `origin: 'local'` for these; remote projects
   *  send their bare host name and the daemon forwards. */
  isLocal: boolean
  /** Loom-relative substore prefix; `''` when the project is a store root. */
  loomPrefix: string
  /** Owning felt store path (the store the project's `.felt` resolves into). */
  feltStore: string
  /** Newest fiber mtime in the project (unix-ms) — recency ranking. */
  lastActivity: number
}

export interface ProjectModel {
  /** The local daemon's own host id. */
  host: string
  /** Every distinct project across all origins, recency-ranked. */
  projects: ProjectEntry[]
  /** `{projectId: lastActivity}` — feeds the forms' city-picker recency sort. */
  activityById: Record<string, number>
}

export interface StoreRegistryOrigin {
  kind?: 'local' | 'remote' | string
  stale?: boolean
  felt_stores?: string[]
  feltStores?: string[]
  /** Curated picker-project list (Stash/Capture cities). When present it is
   *  authoritative for this origin — it replaces the felt-store + current-cards
   *  derivation. Absent → fall back to that derivation, so an uncurated host is
   *  unchanged. Separate from `felt_stores`, which stays TCC-scoped for polling. */
  projects?: string[]
  last_error?: string
}

export interface StoreRegistry {
  host?: string
  origins?: Record<string, StoreRegistryOrigin>
}

/** Last path segment of an absolute dir (`/a/b/c` → `c`), tolerating a
 *  trailing slash. Empty string falls back to the whole path. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return seg || trimmed || path
}

/**
 * The project's loom substore prefix, inferred from the symlink convention:
 * the substore's last segment is the project_dir basename. Among the project's
 * fibers, find the `<basename>` segment and take the prefix up to and including
 * it; majority vote across the fibers that carry it (so a coincidental match
 * doesn't win). No fiber carries the segment → `''` (the project is a store
 * root). Case-insensitive (e.g. `MySTRA` ↔ loom path `mystra`).
 */
function substorePrefix(slugs: string[], projectBasename: string): string {
  const target = projectBasename.toLowerCase()
  const counts = new Map<string, number>()
  let withSegment = 0
  for (const slug of slugs) {
    const segs = slug.split('/')
    const idx = segs.findIndex((s) => s.toLowerCase() === target)
    if (idx < 0) continue
    withSegment++
    const prefix = segs.slice(0, idx + 1).join('/')
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  if (withSegment === 0) return ''
  const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  // The dominant prefix must cover a majority of the basename-bearing fibers,
  // else the segment is coincidental rather than the substore root.
  return n > withSegment / 2 ? best : ''
}

/**
 * Derive the project set from a raw composite-feed body (`GET
 * /api/v1/fibers/composite`). Groups every fiber by `(origin, project_dir)`,
 * infers each group's `loomPrefix`, and ranks by recency.
 */
export function deriveProjects(feedBody: unknown, registryBody?: unknown): ProjectModel {
  const feed = parseCompositeFeed(feedBody)

  interface Acc {
    originId: string
    path: string
    feltStore: string
    slugs: string[]
    lastActivity: number
    current: boolean
  }
  const groups = new Map<string, Acc>()

  for (const entry of feed.entries) {
    const projectDir = entry.fiber.shuttleProjectDir
    if (!projectDir) continue
    const key = `${entry.origin}:${projectDir}`
    const acc =
      groups.get(key) ??
      {
        originId: entry.origin,
        path: projectDir,
        feltStore: entry.feltStore,
        slugs: [],
        lastActivity: 0,
        current: false,
      }
    if (entry.fiber.id) acc.slugs.push(entry.fiber.id)
    const mtime = entry.fiber.modifiedAt ? Date.parse(entry.fiber.modifiedAt) : NaN
    if (!Number.isNaN(mtime)) acc.lastActivity = Math.max(acc.lastActivity, mtime)
    if (entry.fiber.status === 'open' || entry.fiber.status === 'active') acc.current = true
    groups.set(key, acc)
  }

  const registry = parseStoreRegistry(registryBody)
  const registryProjects = projectsFromRegistry(registry, groups, feed.host, feed.origins)
  if (registryProjects.length > 0) {
    const activityById: Record<string, number> = {}
    for (const p of registryProjects) activityById[p.id] = p.lastActivity
    return { host: registry.host || feed.host, projects: registryProjects, activityById }
  }

  const norm = (p: string): string => p.replace(/\/+$/, '')
  const projects: ProjectEntry[] = [...groups.values()].map((acc) => {
    const name = basename(acc.path)
    // When project_dir IS its own felt store (no substore symlink — e.g. the
    // loom root, or a private store like the iCloud wedding store), ids are
    // store-root-relative and the prefix is exactly `''`. This is structural,
    // so it overrides the basename heuristic (which a stray fiber pathed under
    // a `loom/` segment would otherwise mislead).
    const isStoreRoot = norm(acc.path) === norm(acc.feltStore)
    return {
      id: `${acc.originId}:${acc.path}`,
      name,
      path: acc.path,
      originId: acc.originId,
      isLocal: feed.origins[acc.originId]?.kind === 'local' || acc.originId === feed.host,
      loomPrefix: isStoreRoot ? '' : substorePrefix(acc.slugs, name),
      feltStore: acc.feltStore,
      lastActivity: acc.lastActivity,
    }
  })

  // Recency first, then name — the default-selection + picker order the forms expect.
  projects.sort((a, b) =>
    b.lastActivity - a.lastActivity ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )

  const activityById: Record<string, number> = {}
  for (const p of projects) activityById[p.id] = p.lastActivity

  return { host: feed.host, projects, activityById }
}

function parseStoreRegistry(body: unknown): StoreRegistry {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const root = body as Record<string, unknown>
  const host = typeof root.host === 'string' ? root.host : undefined
  const origins: Record<string, StoreRegistryOrigin> = {}

  if (root.origins && typeof root.origins === 'object' && !Array.isArray(root.origins)) {
    for (const [originId, raw] of Object.entries(root.origins as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const rec = raw as Record<string, unknown>
      const feltStores = stringArray(rec.felt_stores) ?? stringArray(rec.feltStores) ?? []
      origins[originId] = {
        kind: typeof rec.kind === 'string' ? rec.kind : undefined,
        stale: rec.stale === true,
        felt_stores: feltStores,
        projects: stringArray(rec.projects),
        last_error: typeof rec.last_error === 'string' ? rec.last_error : undefined,
      }
    }
  } else {
    const feltStores = stringArray(root.felt_stores) ?? stringArray(root.feltStores) ?? []
    if (feltStores.length > 0) origins[host || 'local'] = { kind: 'local', felt_stores: feltStores }
  }

  return { host, origins }
}

function projectsFromRegistry(
  registry: StoreRegistry,
  groups: Map<
    string,
    { originId: string; path: string; feltStore: string; slugs: string[]; lastActivity: number; current: boolean }
  >,
  feedHost: string,
  feedOrigins: Record<string, { kind: 'local' | 'remote'; stale?: boolean }>,
): ProjectEntry[] {
  const origins = registry.origins ?? {}
  const projects: ProjectEntry[] = []
  const seen = new Set<string>()
  // Origins that ship a curated `projects` list own their entries outright: the
  // list is the city set, and the felt-store + current-cards derivation is
  // skipped for them (below). An origin with no curated list keeps the old
  // behavior, so this is purely additive.
  const curatedOrigins = new Set<string>()

  for (const [originId, origin] of Object.entries(origins)) {
    const curated = origin.projects ?? []
    if (curated.length > 0) curatedOrigins.add(originId)
    const stores = curated.length > 0 ? curated : origin.felt_stores ?? origin.feltStores ?? []
    for (const rawPath of stores) {
      const path = rawPath.trim().replace(/\/+$/, '')
      if (!path) continue
      const key = `${originId}:${path}`
      if (seen.has(key)) continue
      seen.add(key)

      const acc = groups.get(key)
      const name = basename(path)
      const kind = origin.kind === 'remote' || feedOrigins[originId]?.kind === 'remote' ? 'remote' : 'local'
      const feltStore = acc?.feltStore ?? path
      // A project that IS its own felt store (the loom root, a private store)
      // has store-root-relative ids → prefix `''`. Structural, so it overrides
      // the basename heuristic (which a stray `loom/`-pathed fiber would mislead).
      const norm = (p: string): string => p.replace(/\/+$/, '')
      const isStoreRoot = norm(path) === norm(feltStore)
      projects.push({
        id: key,
        name,
        path,
        originId,
        isLocal: kind === 'local' || originId === feedHost || originId === registry.host,
        loomPrefix: isStoreRoot ? '' : acc ? substorePrefix(acc.slugs, name) : '',
        feltStore,
        lastActivity: acc?.lastActivity ?? 0,
      })
    }
  }

  // A remote's configured felt store can be its aggregate (`~/loom`) while the
  // worker cwd lives in a separate project directory. Current remote cards are
  // the authoritative signal for those working dirs; closed-only dirs are
  // historical and local dirs stay registry-curated.
  for (const acc of groups.values()) {
    // A curated origin's city set is closed — don't let a current card resurrect
    // a project dir the human deliberately left off the list.
    if (curatedOrigins.has(acc.originId)) continue
    const origin = origins[acc.originId]
    const feedOrigin = feedOrigins[acc.originId]
    if (!acc.current || origin?.stale === true || feedOrigin?.stale === true) continue
    const kind = origin?.kind === 'remote' || feedOrigin?.kind === 'remote' ? 'remote' : 'local'
    if (kind !== 'remote') continue

    const path = acc.path.trim().replace(/\/+$/, '')
    if (!path) continue
    const key = `${acc.originId}:${path}`
    if (seen.has(key)) continue
    seen.add(key)

    const name = basename(path)
    const norm = (p: string): string => p.replace(/\/+$/, '')
    const isStoreRoot = norm(path) === norm(acc.feltStore)
    projects.push({
      id: key,
      name,
      path,
      originId: acc.originId,
      isLocal: false,
      loomPrefix: isStoreRoot ? '' : substorePrefix(acc.slugs, name),
      feltStore: acc.feltStore,
      lastActivity: acc.lastActivity,
    })
  }

  projects.sort((a, b) =>
    b.lastActivity - a.lastActivity ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
  return projects
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}
