// First, so that no module's queries run before it.
import '../runtime/installUncachedQueries.js'
import { mountPage } from './mount.js'
import { parsePageRoute } from './route.js'

/**
 * The pages entry: one small page per address (`/thread?f=…`), each shown in
 * a Rex pane or a browser tab, with none of the board's workspace, voice or
 * Rex following. The daemon serves this bundle's `pages.html` at each page's
 * path.
 */
const webfonts = document.getElementById('webfonts')
if (webfonts instanceof HTMLLinkElement) webfonts.rel = 'stylesheet'

mountPage(document.getElementById('app')!, parsePageRoute(window.location), (import.meta.env.VITE_SHUTTLE_BASE as string | undefined) ?? '')
