// The standalone UI's "project" set — derived from the composite feed, not
// from Portolan's pinned-on-a-map cities.
//
// A Shuttle fiber's `shuttle.project_dir` is the worker's cwd AND (because
// Shuttle's `POST /api/v1/fiber/create` derives its felt root from
// `project_dir`) the felt store the fiber is created in. Each distinct
// `(origin, project_dir)` the feed already carries is therefore a place a new
// constitution can land. We surface exactly that set — no pinning, no map.
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
export function deriveProjects(feedBody: unknown): ProjectModel {
  const feed = parseCompositeFeed(feedBody)

  interface Acc {
    originId: string
    path: string
    feltStore: string
    slugs: string[]
    lastActivity: number
  }
  const groups = new Map<string, Acc>()

  for (const entry of feed.entries) {
    const projectDir = entry.fiber.shuttleProjectDir
    if (!projectDir) continue
    const key = `${entry.origin}:${projectDir}`
    const acc =
      groups.get(key) ??
      { originId: entry.origin, path: projectDir, feltStore: entry.feltStore, slugs: [], lastActivity: 0 }
    if (entry.fiber.id) acc.slugs.push(entry.fiber.id)
    const mtime = entry.fiber.modifiedAt ? Date.parse(entry.fiber.modifiedAt) : NaN
    if (!Number.isNaN(mtime)) acc.lastActivity = Math.max(acc.lastActivity, mtime)
    groups.set(key, acc)
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
