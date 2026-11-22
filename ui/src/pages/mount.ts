import { DeskPage } from './DeskPage.js'
import { PageFeed } from './feed.js'
import type { PageRoute } from './route.js'
import { ThreadPage } from './ThreadPage.js'
import '../styles/type.css'
import '../board/palette.css'
import '../board/workspace/tokens.css'
import './pages.css'

/** Draws the page `route` names into `host` and starts its feed; an unknown page says so. */
export function mountPage(host: HTMLElement, route: PageRoute, base: string): void {
  const navigate = (href: string): void => window.location.assign(href)
  if (route.page === 'desk') {
    const feed = new PageFeed(base)
    host.append(new DeskPage(feed, { base, route, navigate }).el)
    feed.start()
    return
  }
  if (route.page === 'map') {
    void import('./MapPage.js')
      .then(({ MapPage }) => {
        const page = new MapPage({ base, route, navigate })
        host.append(page.el)
        page.start()
      })
      .catch((error: unknown) => {
        host.replaceChildren()
        host.textContent = `Could not load map: ${error instanceof Error ? error.message : String(error)}`
        host.className = 'pg-missing'
      })
    return
  }
  if (route.page !== 'thread' || !route.fiber) {
    host.textContent = route.page === 'thread' ? 'No thread named: add ?f=<uid>@<host>.' : `No page called “${route.page}”.`
    host.className = 'pg-missing'
    return
  }
  const feed = new PageFeed(base, route.fiber)
  host.append(new ThreadPage(feed, { base, route, navigate }).el)
  feed.start()
}
