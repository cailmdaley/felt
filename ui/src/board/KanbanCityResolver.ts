// The browser replica of the backend's per-card city attribution.
//
// When the kanban reads Shuttle's `/api/v1/fibers/composite` directly, each row
// carries its owning felt store (`feltStore`) and a store-relative file path
// (`path`) — but NOT which pinned Portolan city owns it. City attribution
// (`cityId` + project-relative `projectSlug`) is what the click-to-open-in-vellum
// flow pivots on, and it is a Portolan-local concept (it depends on which
// projects are pinned as cities on the map), so the daemon feed cannot carry it.
//
// The backend computes attribution by realpath-matching each fiber's `.md`
// file against every pinned city's `.felt` realpath, deepest match wins
// (`server/src/KanbanReadModel.ts` `resolveCityForCanonicalPath`). The browser
// can't `realpath`, but it doesn't need to: the composite row already gives the
// owning store plus the store-relative path, so the fiber's felt file path is
// `<feltStore>/.felt/<path>` — and that string equals exactly what the backend
// realpath-matches, because the daemon reports each row against its *own* store
// (a symlinked substore like the iCloud wedding store reports `felt_store` =
// that store, not the loom it's mounted into). So this resolver is a verbatim
// port of the backend match, operating on the composite fields instead of
// `realpathSync` output.
//
// The one input the browser still needs is each city's `.felt` REALPATH — the
// realpath resolves a project's `.felt → loom` symlink, so a city like
// `portolan` resolves to `…/loom/.felt/ai-futures/portolan` and thereby matches
// loom-served rows, while the iCloud `wedding` city resolves to its own store
// and matches the substore rows. That realpath is computed server-side (the
// browser receives it as a per-city field) and handed to `buildCityResolver`.
//
// Validated against the live board: with the real pinned-city realpaths, this
// reproduces the backend's `{cityId, projectSlug}` for every local composite
// row (82/82, including the wedding substore and the loom-root fallback).

import type { CompositeEntry } from './KanbanComposite.js';
import type { CityResolver } from './KanbanReadModel.js';

export interface CityFeltRoot {
  cityId: string;
  /**
   * Absolute realpath of the city's `.felt/` directory. `realpath` resolves the
   * project→loom symlink, so a project pinned as a city whose `.felt` symlinks
   * into loom yields its loom path (e.g. `…/loom/.felt/ai-futures/portolan`),
   * and a substore mounted elsewhere (the iCloud `wedding` store) yields its own
   * path. Empty/missing entries are ignored — a city with no resolvable `.felt`
   * cannot own a card.
   */
  feltRealPath: string;
  /**
   * The city's project directory (the map City's `path`). Not used for card
   * attribution — it's the `project_dir` a shuttle install needs (worker cwd),
   * threaded through so the fiber-detail modal can promote a card without a
   * server-side derivation. Optional: a city without one can still own cards;
   * promotion just installs without a project dir (paused drafts allow it).
   */
  projectPath?: string;
}

/**
 * Build a `CityResolver` from the pinned cities' `.felt` realpaths. Pure: the
 * returned resolver is a function of the city list alone, so it's trivially
 * unit-testable and injectable into `buildKanbanResponseFromComposite`.
 *
 * Match semantics mirror the backend exactly: longest `feltRealPath` prefix of
 * the row's felt file path wins (so `…/ai-futures/portolan` beats `…/ai-futures`
 * beats the loom-root `…/.felt`); ties (two cities whose `.felt` resolve to the
 * same path — e.g. a project symlinked from two checkouts) resolve to the first
 * city in input order, matching the backend's stable length-sort.
 */
export function buildCityResolver(cities: CityFeltRoot[]): CityResolver {
  // Longest realpath first; Array.prototype.sort is stable, so equal-length
  // entries keep input order — the first-pinned city wins a tie, as the backend
  // does. Drop cities with no resolvable `.felt`.
  const ranked = cities
    .filter((c) => typeof c.feltRealPath === 'string' && c.feltRealPath.length > 0)
    .slice()
    .sort((a, b) => b.feltRealPath.length - a.feltRealPath.length);

  return (entry: CompositeEntry) => {
    if (!entry.feltStore) return undefined;
    const basename = basenameNoMd(entry.path);
    if (basename === undefined) return undefined;

    const fileAbs = feltFilePath(entry.feltStore, entry.path);
    const fileSuffix = `${basename}.md`;
    const dirSuffix = `/${fileSuffix}`;

    for (const { cityId, feltRealPath } of ranked) {
      const prefix = feltRealPath.endsWith('/') ? feltRealPath : `${feltRealPath}/`;
      if (!fileAbs.startsWith(prefix)) continue;
      const rel = fileAbs.slice(prefix.length);
      // Entry-point fiber: `.felt/<slug>.md` → projectSlug = slug.
      if (rel === fileSuffix) return { cityId, projectSlug: basename };
      // Container fiber: `.../<slug>/<slug>.md` → projectSlug = the dir path.
      if (rel.endsWith(dirSuffix)) return { cityId, projectSlug: rel.slice(0, -dirSuffix.length) };
      // A prefix match whose tail isn't a fiber-container file (sibling .md,
      // unexpected shape) — same store, not this fiber's canonical file. Keep
      // scanning shallower cities rather than mis-attributing.
    }
    return undefined;
  };
}

/** `<feltStore>/.felt/<path>` — the row's felt file path, the string the backend
 * realpath-matches. Tolerates a trailing slash on the store and a leading slash
 * on the path. */
function feltFilePath(feltStore: string, path: string): string {
  const store = feltStore.endsWith('/') ? feltStore.slice(0, -1) : feltStore;
  const rel = path.startsWith('/') ? path.slice(1) : path;
  return `${store}/.felt/${rel}`;
}

/** Last path segment with its `.md` extension stripped, or undefined when the
 * path isn't a markdown file (so the caller skips it rather than mis-matching). */
function basenameNoMd(path: string): string | undefined {
  if (!path.endsWith('.md')) return undefined;
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.slice(0, -'.md'.length);
}
