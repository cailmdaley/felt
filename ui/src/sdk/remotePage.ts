/**
 * A tapestry that stands for a page published elsewhere names it in its head:
 *
 *     <meta name="shuttle-page" content="https://example.org/deck/">
 *
 * The board then frames that address itself, at the page's own origin, rather
 * than the served file. Only a public https page qualifies: a page on the
 * board's host, a loopback, private or tailnet name, or an IP address could be
 * a daemon's, so it stays in the served file's sandbox.
 */

/**
 * The public page `html` declares itself to be, as an absolute URL, or null.
 * `homes` are the addresses it must not share a host with: the board's, and
 * the daemon's that served it.
 */
export function remotePage(html: string, homes: readonly string[] = [location.href]): string | null {
  // Read only up to the body, in an inert document: nothing in it loads or runs.
  const body = html.search(/<body\b/i)
  const head = new DOMParser().parseFromString(body < 0 ? html : html.slice(0, body), 'text/html').head
  const meta = [...head.querySelectorAll('meta[name]')].find(each => each.getAttribute('name')!.toLowerCase() === 'shuttle-page')
  return meta ? publicPage(meta.getAttribute('content') ?? '', homes) : null
}

const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/\.$/, '')

/** `raw` as an https URL on a public host none of `homes` is on, or null. */
export function publicPage(raw: string, homes: readonly string[] = [location.href]): string | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  const host = hostOf(url)
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (homes.some(home => hostOf(new URL(home, location.href)) === host)) return null
  // The URL parser writes every IPv4 spelling as a dotted quad and every IPv6 address in brackets.
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null
  if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|intranet|home\.arpa|ts\.net)$/.test(host)) return null
  return url.href
}

/**
 * A remote page's frame: its own origin and storage, as in a tab of its own;
 * its popups and downloads leave as from a tab, but it can never navigate the
 * window that frames it, and it is told nothing of where it is framed.
 */
export function remotePageFrame(url: string, title: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals')
  frame.setAttribute('allow', 'fullscreen')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = title
  frame.src = url
  return frame
}
