// Client-side parent-picker search over the Shuttle daemon's fiber index.
//
// Replaces Portolan's retired `/kanban/fiber-search` endpoint: the caller
// fetches `GET :4000/api/v1/fibers` once (ids + names, a few hundred rows)
// and filters per keystroke with `filterParentCandidates` — the same rule
// the backend used, ported verbatim.

export interface FiberSearchResult {
  id: string
  name: string
  depth: number
}

/**
 * Fetch the daemon's fiber index, reduced to `{id, name}` rows. The response
 * envelope is `{host, fibers: [{fiber: {...felt JSON...}, ...}]}`.
 */
export async function fetchFiberIndex(
  shuttleBase: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${shuttleBase}/api/v1/fibers`)
  if (!res.ok) throw new Error(`${res.status}`)
  const body = (await res.json()) as {
    fibers?: Array<{ fiber?: { id?: unknown; slug?: unknown; name?: unknown } }>
  }
  const out: Array<{ id: string; name: string }> = []
  const seen = new Set<string>()
  for (const row of body.fibers ?? []) {
    // Same id rule as `mapFeltJsonToFiber`: felt's wire `id` may be the
    // intrinsic ULID; `slug` carries the addressable path when present.
    const wireId = typeof row.fiber?.id === 'string' ? row.fiber.id : ''
    const slug = typeof row.fiber?.slug === 'string' && row.fiber.slug ? row.fiber.slug : undefined
    const id = slug ?? wireId
    // The index serves overlapping stores (loom + the project stores it
    // symlinks) — dedupe by id so candidates appear once.
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof row.fiber?.name === 'string' && row.fiber.name ? row.fiber.name : id
    out.push({ id, name })
  }
  return out
}

/**
 * Parent-candidate filter: scope to the excluded fiber's project prefix
 * (none when `excludeId` is empty — the stash form's brand-new fiber can
 * nest anywhere), drop self + descendants; an empty query lists structural
 * anchors (direct children of the prefix), a query substring-matches
 * name/id capped at 30. Top-level first, then alphabetical.
 */
export function filterParentCandidates(
  allFibers: Array<{ id: string; name: string }>,
  q: string,
  excludeId: string,
): FiberSearchResult[] {
  const query = q.trim().toLowerCase()

  const excludeSegments = excludeId ? excludeId.split('/') : []
  const projectPrefix = excludeSegments.length >= 2
    ? excludeSegments.slice(0, -1).join('/')
    : excludeSegments[0] ?? ''

  const candidateFilter = (f: { id: string }): boolean => {
    if (!f.id) return false
    if (f.id === excludeId) return false
    if (excludeId && f.id.startsWith(excludeId + '/')) return false
    if (projectPrefix && !f.id.startsWith(projectPrefix)) return false
    return true
  }

  let results: Array<{ id: string; name: string }>
  if (!query) {
    const prefixDepth = projectPrefix ? projectPrefix.split('/').length : 0
    results = allFibers
      .filter(candidateFilter)
      .filter((f) => f.id.split('/').length === prefixDepth + 1)
  } else {
    results = allFibers
      .filter(candidateFilter)
      .filter((f) =>
        f.name.toLowerCase().includes(query) || f.id.toLowerCase().includes(query),
      )
      .slice(0, 30)
  }

  results.sort((a, b) => {
    const da = a.id.split('/').length
    const db = b.id.split('/').length
    if (da !== db) return da - db
    return a.name.localeCompare(b.name)
  })

  return results.map((f) => ({
    id: f.id,
    name: f.name,
    depth: f.id.split('/').length,
  }))
}
