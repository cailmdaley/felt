// The Stash and Capture forms' host and project sets — derived from Shuttle's
// registered felt-store list plus current card working dirs, not from
// historical cards.
//
// `GET /api/v1/felt-stores` is the canonical store registry. The composite feed
// is still useful for recency, substore-prefix inference, and current working
// directories: a remote may intentionally register only `~/loom` as its felt
// store while active/open Shuttle fibers run from project dirs such as `cmbx`.
// Local project dirs stay registry-curated because local historical cards still
// include retired checkouts.
// Closed historical fibers are not authority: they carry old `project_dir`
// values forever, so closed-only dirs would resurrect retired checkouts.
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
// segment (a store-root project like `~/loom`, or a separate private store)
// → `''`, which is correct: the substore IS the store root.
// The residual mis-inference never mis-places a top-level stash (the daemon
// resolves the substore from `project_dir`); only nesting candidates are
// affected. A fully exact project_dir→substore map needs a daemon-side
// resolution.

import type { CompositeFeed } from '../board/KanbanComposite.js'

/** Trailing-slash-insensitive path compare — store-root detection. */
const norm = (p: string): string => p.replace(/\/+$/, '')

/** A destination project, as both forms consume it. */
export interface Project {
  /** Stable key: `${owning origin}:${path}`. */
  id: string
  /** Display name — the project_dir basename. */
  name: string
  /** `shuttle.project_dir` — the worker cwd AND the create endpoint's felt root. */
  path: string
  /** The owner-routing key sent as `origin` on a create or capture: `'local'`
   *  for the daemon's own host, else the owning remote's bare name. Matches
   *  the `Host.id` it belongs to. */
  originId: string
  /** Loom-relative substore prefix; `''` when the project is a store root.
   *  Scopes and strips Stash's parent candidates to project-relative slugs. */
  loomPrefix: string
}

/** A host the pickers can point at — one origin of the store registry, whether
 *  or not it currently owns any projects (an empty host still needs to be
 *  reachable in the picker: that is where its first project gets added). */
export interface Host {
  /** `'local'` for the daemon's own host, else the bare remote name. Matches
   *  the projects' `originId`. */
  id: string
  /** How the host reads — a remote's `display`, else its bare name. */
  label: string
  isLocal: boolean
  /** This host can raise its own OS folder dialog. False for every remote:
   *  a dialog there would open on a desktop nobody is sitting at. */
  nativeFolderPicker: boolean
  /** This host can run browser automation. */
  browserCapable: boolean
}

export interface ProjectModel {
  /** Every origin the pickers can point at, local first. */
  hosts: Host[]
  /** Every distinct project across all origins, most recently active first,
   *  then by name — the picker order and default selection both forms use. */
  projects: Project[]
}

interface RankedProject extends Project {
  /** Newest fiber mtime in the project (unix-ms). */
  lastActivity: number
}

interface StoreRegistryOrigin {
  kind?: 'local' | 'remote' | string
  stale?: boolean
  felt_stores?: string[]
  /** Curated picker-project list. When present it is authoritative for this
   *  origin — it replaces the felt-store + current-cards derivation. Separate
   *  from `felt_stores`, which stays TCC-scoped for polling. */
  projects?: string[]
  /** This host can raise its own OS folder dialog (`POST /api/v1/choose-folder`). */
  native_folder_picker?: boolean
  /** This host can run browser automation. */
  browser_capable?: boolean
  /** Presentation label a remote carries for itself. */
  display?: string
}

interface StoreRegistry {
  host?: string
  origins?: Record<string, StoreRegistryOrigin>
}

/** The feed's per-origin block, as far as the host and project sets read it. */
type FeedOrigins = Record<string, { kind: 'local' | 'remote'; stale?: boolean }>

interface Acc {
  originId: string
  path: string
  feltStore: string
  slugs: string[]
  lastActivity: number
  current: boolean
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
 * root). Case-insensitive (e.g. `ProjectA` ↔ loom path `projecta`).
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
 * A project row. A project that IS its own felt store (the loom root, a
 * private store) has store-root-relative ids → prefix `''`. That is
 * structural, so it overrides the basename heuristic, which a stray
 * `loom/`-pathed fiber would mislead.
 */
function projectRow(
  key: string,
  path: string,
  isLocal: boolean,
  originId: string,
  acc: Acc | undefined,
): RankedProject {
  const name = basename(path)
  const isStoreRoot = norm(path) === norm(acc?.feltStore ?? path)
  return {
    id: key,
    name,
    path,
    originId: isLocal ? 'local' : originId,
    loomPrefix: isStoreRoot || !acc ? '' : substorePrefix(acc.slugs, name),
    lastActivity: acc?.lastActivity ?? 0,
  }
}

/** Most recently active first, then name. */
function rank(projects: RankedProject[]): Project[] {
  return projects.sort((a, b) =>
    b.lastActivity - a.lastActivity ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/**
 * Derive the host and project sets from the composite feed (`GET
 * /api/v1/fibers/composite`) and the store registry body (`GET
 * /api/v1/felt-stores`). Groups every fiber by `(origin, project_dir)`, infers
 * each group's `loomPrefix`, and ranks by recency.
 */
export function deriveProjects(feed: CompositeFeed, registryBody?: unknown): ProjectModel {
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
  const hosts = deriveHosts(registry, feed.host, feed.origins)
  const registryProjects = projectsFromRegistry(registry, groups, feed.host, feed.origins)
  if (registryProjects.length > 0) return { hosts, projects: registryProjects }

  const projects = [...groups.values()].map((acc) =>
    projectRow(
      `${acc.originId}:${acc.path}`,
      acc.path,
      feed.origins[acc.originId]?.kind === 'local' || acc.originId === feed.host,
      acc.originId,
      acc,
    ),
  )
  return { hosts, projects: rank(projects) }
}

/**
 * The host list the pickers offer, from the same store registry the projects
 * come from — so the two can never disagree about which origins exist.
 *
 * The local origin is normalized to the id `'local'` (matching a local
 * project's `originId`) and sorted first, because that is where the picker
 * defaults: a fresh form should point at the machine the human is sitting at,
 * never at whichever remote happened to be busiest.
 *
 * A registry that names no origins at all (an unreachable registry read)
 * still yields the local host, so the forms always have something to point at.
 */
export function deriveHosts(
  registry: StoreRegistry,
  feedHost: string,
  feedOrigins: FeedOrigins,
): Host[] {
  const localId = registry.host || feedHost
  const ids = new Set([...Object.keys(registry.origins ?? {}), ...Object.keys(feedOrigins)])
  const hosts: Host[] = []
  const seen = new Set<string>()
  let sawLocal = false

  for (const id of ids) {
    if (seen.has(id)) continue
    const origin = registry.origins?.[id]
    const isLocal =
      id === localId || origin?.kind === 'local' || feedOrigins[id]?.kind === 'local' || id === feedHost
    if (isLocal) {
      // Two ids can both look local (a registry host that disagrees with the
      // feed's); they collapse to the one `'local'` entry the projects use.
      if (sawLocal) continue
      sawLocal = true
      seen.add('local')
      hosts.push({
        id: 'local',
        label: id || 'local',
        isLocal: true,
        nativeFolderPicker: nativePicker(registry, feedHost),
        browserCapable: origin?.browser_capable === true,
      })
    } else {
      seen.add(id)
      hosts.push({
        id,
        label: origin?.display || id,
        isLocal: false,
        // Never native: the dialog would open on that host's own desktop.
        nativeFolderPicker: false,
        browserCapable: origin?.browser_capable === true,
      })
    }
  }

  if (!sawLocal) {
    hosts.push({
      id: 'local',
      label: localId || 'local',
      isLocal: true,
      nativeFolderPicker: nativePicker(registry, feedHost),
      browserCapable: false,
    })
  }

  hosts.sort((a, b) =>
    Number(b.isLocal) - Number(a.isLocal) ||
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  )
  return hosts
}

/** The local origin's `native_folder_picker`, found by host id or, failing
 *  that, by `kind: 'local'`. Absent → false: typing the path is the safe read. */
function nativePicker(registry: StoreRegistry, feedHost: string): boolean {
  const origins = registry.origins ?? {}
  const local =
    origins[registry.host ?? ''] ??
    origins[feedHost] ??
    Object.values(origins).find((o) => o.kind === 'local')
  return local?.native_folder_picker === true
}

function parseStoreRegistry(body: unknown): StoreRegistry {
  if (!isRecord(body)) return {}
  const host = typeof body.host === 'string' ? body.host : undefined
  const origins: Record<string, StoreRegistryOrigin> = {}

  if (isRecord(body.origins)) {
    for (const [originId, rec] of Object.entries(body.origins)) {
      if (!isRecord(rec)) continue
      origins[originId] = {
        kind: typeof rec.kind === 'string' ? rec.kind : undefined,
        stale: rec.stale === true,
        felt_stores: stringArray(rec.felt_stores) ?? [],
        projects: stringArray(rec.projects),
        native_folder_picker: rec.native_folder_picker === true,
        browser_capable: rec.browser_capable === true,
        display: typeof rec.display === 'string' ? rec.display : undefined,
      }
    }
  }

  return { host, origins }
}

function projectsFromRegistry(
  registry: StoreRegistry,
  groups: Map<string, Acc>,
  feedHost: string,
  feedOrigins: FeedOrigins,
): Project[] {
  const origins = registry.origins ?? {}
  const projects: RankedProject[] = []
  const seen = new Set<string>()
  // Origins that ship a curated `projects` list own their entries outright: the
  // list is the project set, and the felt-store + current-cards derivation is
  // skipped for them (below).
  const curatedOrigins = new Set<string>()

  for (const [originId, origin] of Object.entries(origins)) {
    const curated = origin.projects ?? []
    if (curated.length > 0) curatedOrigins.add(originId)
    const stores = curated.length > 0 ? curated : origin.felt_stores ?? []
    const kind = origin.kind === 'remote' || feedOrigins[originId]?.kind === 'remote' ? 'remote' : 'local'
    const isLocal = kind === 'local' || originId === feedHost || originId === registry.host
    for (const rawPath of stores) {
      const path = rawPath.trim().replace(/\/+$/, '')
      if (!path) continue
      const key = `${originId}:${path}`
      if (seen.has(key)) continue
      seen.add(key)
      projects.push(projectRow(key, path, isLocal, originId, groups.get(key)))
    }
  }

  // A remote's configured felt store can be its aggregate (`~/loom`) while the
  // worker cwd lives in a separate project directory. Current remote cards are
  // the authoritative signal for those working dirs; closed-only dirs are
  // historical and local dirs stay registry-curated.
  for (const acc of groups.values()) {
    // A curated origin's project set is closed — don't let a current card
    // resurrect a project dir the human deliberately left off the list.
    if (curatedOrigins.has(acc.originId)) continue
    const origin = origins[acc.originId]
    const feedOrigin = feedOrigins[acc.originId]
    if (!acc.current || origin?.stale === true || feedOrigin?.stale === true) continue
    if (origin?.kind !== 'remote' && feedOrigin?.kind !== 'remote') continue

    const path = acc.path.trim().replace(/\/+$/, '')
    if (!path) continue
    const key = `${acc.originId}:${path}`
    if (seen.has(key)) continue
    seen.add(key)
    projects.push(projectRow(key, path, false, acc.originId, acc))
  }

  return rank(projects)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}
