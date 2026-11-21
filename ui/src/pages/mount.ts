import { PageFeed } from './feed.js'
import type { PageRoute } from './route.js'
import { ThreadPage } from './ThreadPage.js'
import '../styles/type.css'
import '../board/palette.css'
import '../board/workspace/tokens.css'
import './pages.css'

/** Draws the page `route` names into `host` and starts its feed; an unknown page says so. */
export function mountPage(host: HTMLElement, route: PageRoute, base: string): void {
  if (route.page !== 'thread' || !route.fiber) {
    host.textContent = route.page === 'thread' ? 'No thread named: add ?f=<uid>@<host>.' : `No page called “${route.page}”.`
    host.className = 'pg-missing'
    return
  }
  const feed = new PageFeed(base, route.fiber)
  host.append(new ThreadPage(feed, { base, route, navigate: href => window.location.assign(href) }).el)
  feed.start()
}
