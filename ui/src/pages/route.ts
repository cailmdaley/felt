/**
 * A page's address. Served by the daemon, the page is the path's one segment:
 * `/thread?f=<uid>@<host>[&in=rex]` or `/desk[?in=rex]`. Opened over file://
 * (the harness), it is the `page` parameter: `index.html?page=thread&f=…` or
 * `index.html?page=desk`. `in=rex` says the page stands in a Rex pane, where
 * going to a fiber moves Rex rather than the page.
 */
export interface PageRoute {
  page: string
  /** The fiber the page shows, by uid and owning host; absent when `f` names none. */
  fiber?: { uid: string; host: string }
  inRex: boolean
}

export function parsePageRoute(location: Pick<Location, 'protocol' | 'pathname' | 'search'>): PageRoute {
  const params = new URLSearchParams(location.search)
  const page = location.protocol === 'file:' ? params.get('page') ?? '' : location.pathname.replace(/^\/+|\/+$/g, '')
  const f = params.get('f') ?? '', at = f.lastIndexOf('@')
  const fiber = at > 0 && at < f.length - 1 ? { uid: f.slice(0, at), host: f.slice(at + 1) } : undefined
  return { page, fiber, inRex: params.get('in') === 'rex' }
}

/** The address of `fiber`'s thread page, from any page at `href`, keeping its other parameters (`in` among them). */
export function threadHref(href: string, fiber: { uid: string; host: string }): string {
  const url = new URL(href)
  if (url.protocol === 'file:') url.searchParams.set('page', 'thread')
  else url.pathname = url.pathname.replace(/[^/]*$/, 'thread')
  url.searchParams.set('f', `${fiber.uid}@${fiber.host}`)
  return url.href
}
