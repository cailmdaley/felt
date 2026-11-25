import type { ShuttleClient } from './client.js'

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

/** A document's declarations stand in its head: only its first 64 KiB is read for them. */
export const DOCUMENT_HEAD = 65536

/**
 * The public page `html` declares itself to be, as an absolute URL, or null.
 * `homes` are the addresses it must not share a host with: the board's, and
 * the daemon's that served it.
 */
export function remotePage(html: string, homes: readonly string[] = [location.href]): string | null {
  // An inert document: nothing in it loads or runs, and a meta tag after the head's end is the body's.
  const head = new DOMParser().parseFromString(html.slice(0, DOCUMENT_HEAD), 'text/html').head
  const meta = [...head.querySelectorAll('meta[name]')].find(each => each.getAttribute('name')!.toLowerCase() === 'shuttle-page')
  return meta ? publicPage(meta.getAttribute('content') ?? '', homes) : null
}

/** The public page a page on its owner declares, from its head; null when it declares none or cannot be read. */
export async function declaredPageOf(client: ShuttleClient, path: string, origin?: string): Promise<string | null> {
  const head = await client.fileHead(path, origin).catch(() => '')
  return remotePage(head, [location.href, client.htmlAssetUrl(path, origin)])
}

const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/\.+$/, '')
const homeHost = (home: string): string | null => { try { return hostOf(new URL(home, location.href)) } catch { return null } }

/** `raw` as an https URL on a public host none of `homes` is on, or null; a home that cannot be read refuses every page. */
export function publicPage(raw: string, homes: readonly string[] = [location.href]): string | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  const host = hostOf(url)
  if (url.protocol !== 'https:' || url.username || url.password) return null
  if (homes.some(home => [null, host].includes(homeHost(home)))) return null
  // The URL parser writes every IPv4 spelling as a dotted quad and every IPv6 address in brackets.
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null
  if (!host.includes('.') || host.includes('..') || /(?:^|\.)(?:localhost|local|internal|lan|intranet|home\.arpa|ts\.net)$/.test(host)) return null
  return url.href
}

/**
 * A remote page's frame: its own origin and storage, as in a tab of its own;
 * its popups and downloads leave as from a tab, but it can never navigate the
 * window that frames it, and it is told nothing of where it is framed. A page
 * that lands on the board's own origin (a redirect) is `refused` once it loads.
 */
export function remotePageFrame(url: string, title: string, refused: () => void): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads')
  frame.setAttribute('allow', 'fullscreen')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = title
  frame.src = url
  frame.addEventListener('load', () => {
    // A document on another origin is out of reach; one the board can read is its own.
    const landed = frame.contentDocument?.URL
    if (landed && landed !== 'about:blank') refused()
  })
  return frame
}
