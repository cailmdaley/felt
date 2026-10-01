import { parseCompositeFeed } from '../board/KanbanComposite.js'
import { daemonFetch } from '../board/daemonApi.js'
import { deriveProjects, type ProjectModel } from './projectModel'

/** The host and project sets the forms pick from, and the tags in use. */
export interface LoadedFeed {
  model: ProjectModel
  tags: string[]
}

/**
 * Read the composite feed and the store registry, and derive the forms' hosts
 * and projects from them (see projectModel). Throws when the feed is out of
 * reach; the registry is optional.
 */
export async function loadFeed(shuttleBase: string): Promise<LoadedFeed> {
  const [res, storesRes] = await Promise.all([
    daemonFetch(`${shuttleBase}/api/v1/fibers/composite`),
    daemonFetch(`${shuttleBase}/api/v1/felt-stores`).catch(() => null),
  ])
  if (!res.ok) throw new Error(`composite ${res.status}`)
  const feed = parseCompositeFeed(await res.json())
  const storesJson: unknown = storesRes?.ok ? await storesRes.json().catch(() => undefined) : undefined
  const tagSet = new Set<string>()
  for (const e of feed.entries) for (const t of e.fiber.tags ?? []) tagSet.add(t)
  return { model: deriveProjects(feed, storesJson), tags: [...tagSet].sort() }
}
