/**
 * Boot-time HTTP prefetch.
 *
 * The inline script in `index.html` fires the modal's primary data
 * request before main.ts evaluates, then stashes the in-flight
 * `Promise<Response>` on `window.__bootPrefetch__` keyed by URL. Modal
 * data-fetchers consume it once, eliminating the otherwise-serial
 *
 *   main.ts load → vellum chunk load → modal mount → /kanban fetch
 *
 * waterfall on cold-load deep links: the data fetch now races the
 * vellum chunk download instead of waiting for it.
 *
 * Single-consume: the first matching URL pulls the stash; subsequent
 * fetches (e.g. the 15-second kanban poll) go through plain `fetch`.
 */

interface BootPrefetch {
  url: string
  promise: Promise<Response>
}

declare global {
  interface Window {
    __bootPrefetch__?: BootPrefetch
  }
}

/** Return the prefetched Response promise if its URL matches; consume on hit. */
export function consumeBootPrefetch(url: string): Promise<Response> | null {
  const stash = window.__bootPrefetch__
  if (!stash || stash.url !== url) return null
  delete window.__bootPrefetch__
  return stash.promise
}

/** Try the prefetch first, fall back to a fresh fetch on miss. */
export function fetchWithBootPrefetch(url: string): Promise<Response> {
  return consumeBootPrefetch(url) ?? fetch(url)
}
