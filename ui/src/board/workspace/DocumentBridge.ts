import { keyIntent, shouldForwardDocumentKey, surfaceBindings, type KeyIntent } from '../keymap.js'
import { referenceRuntime, type ReferenceTarget } from './ChannelReferences.js'
import referenceStyles from './references.css?inline'

export const DOCUMENT_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms'
const PROTOCOL = 'shuttle-document'
const VERSION = 1
export type ScrollPosition = { x: number; y: number }
export type DocumentKey = { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; repeat?: boolean }
export type DocumentMessage = { protocol: typeof PROTOCOL; version: typeof VERSION; type: string; payload: Record<string, unknown> }
export function envelope(type: string, payload: Record<string, unknown> = {}): DocumentMessage {
  return { protocol: PROTOCOL, version: VERSION, type, payload }
}
export function documentMessage(data: unknown): data is DocumentMessage {
  if (!data || typeof data !== 'object') return false
  const message = data as DocumentMessage
  return message.protocol === PROTOCOL && message.version === VERSION && typeof message.type === 'string'
    && !!message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
}

/** This function is serialized, so every dependency arrives as an argument. */
function documentRuntime(intent: typeof keyIntent, forward: typeof shouldForwardDocumentKey, bindings: typeof surfaceBindings, references: typeof referenceRuntime, css: string, protocol: string, version: number): void {
  // Storage belongs to this document's lifetime, never the board's origin.
  // Decks and plotting libraries can keep preferences without escaping isolation.
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    try { void window[name].length } catch {
      const values = new Map<string, string>()
      const storage = {
        get length() { return values.size },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(String(key)) ?? null,
        setItem: (key: string, value: string) => { values.set(String(key), String(value)) },
        removeItem: (key: string) => { values.delete(String(key)) },
        clear: () => values.clear(),
      }
      Object.defineProperty(window, name, { configurable: true, value: storage })
    }
  }
  // Srcdoc has an opaque URL even when its assets have a network base. Keep
  // state changes local; a report's URL must never become a board address.
  for (const name of ['pushState', 'replaceState'] as const) {
    const native = window.history[name].bind(window.history)
    window.history[name] = (state: unknown, unused: string) => native(state, unused)
  }
  let active = false
  let scroller: HTMLElement | null = null
  let pendingRestore: ScrollPosition | null = null
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
  const send = (type: string, payload: Record<string, unknown> = {}): void => parent.postMessage({ protocol, version, type, payload }, '*')
  const style = document.createElement('style'); style.textContent = css
  ;(document.head ?? document.documentElement).append(style)
  const links = references(document, candidates => send('references', { candidates }),
    (type, candidate) => { if (active) send(type, { candidate }) })
  const resolveScroller = (): HTMLElement | null => {
    if (scroller?.isConnected && scroller.scrollHeight > scroller.clientHeight + 1) return scroller
    const root = document.scrollingElement as HTMLElement | null
    if (root && root.scrollHeight > root.clientHeight + 1) return (scroller = root)
    const nested = [...document.querySelectorAll<HTMLElement>('body *')].filter(el =>
      el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))
    scroller = nested.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null
    return scroller ?? root
  }
  const position = (): void => {
    if (pendingRestore) { send('scroll', pendingRestore); return }
    const el = resolveScroller()
    send('scroll', { x: el?.scrollLeft ?? 0, y: el?.scrollTop ?? 0 })
  }
  const cancelRestore = (): void => { pendingRestore = null; clearTimeout(restoreTimer) }
  const restore = (clamp = false): void => {
    if (!pendingRestore) return
    const el = resolveScroller()
    if (!el || (!clamp && el.scrollHeight - el.clientHeight < pendingRestore.y)) return
    el.scrollTo({ left: pendingRestore.x, top: pendingRestore.y, behavior: 'instant' })
    cancelRestore()
    position()
  }
  // Reports can create a nested scroller after load. Keep the requested offset
  // until layout can hold it; a shortened report clamps after a bounded wait.
  new MutationObserver(() => restore()).observe(document, { childList: true, subtree: true, attributes: true })
  window.addEventListener('resize', () => restore())
  document.addEventListener('wheel', cancelRestore, { capture: true, passive: true })
  document.addEventListener('touchstart', cancelRestore, { capture: true, passive: true })
  const pause = (): void => { for (const media of document.querySelectorAll<HTMLMediaElement>('audio,video')) media.pause() }
  window.addEventListener('message', event => {
    const data = event.data
    if (event.source !== parent || !data || data.protocol !== protocol || data.version !== version || !data.payload) return
    const payload = data.payload
    if (data.type === 'active' && typeof payload.active === 'boolean') {
      active = payload.active
      if (!active) { pause(); position() }
    } else if (data.type === 'references:scan') links.scan()
    else if (data.type === 'references:resolved' && Array.isArray(payload.targets)) {
      links.resolve(payload.targets.filter((target: ReferenceTarget) => target && typeof target.candidate === 'string' && typeof target.title === 'string' && typeof target.audio === 'boolean'))
    } else if (data.type === 'pause') pause()
    else if (data.type === 'restore' && Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
      cancelRestore()
      pendingRestore = { x: Math.max(0, payload.x), y: Math.max(0, payload.y) }
      restoreTimer = setTimeout(() => restore(true), 3000)
      restore()
    } else if (data.type === 'scroll' && active) {
      const key = payload.intent
      if (!['scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp'].includes(key)) return
      const el = resolveScroller()
      if (!el) return
      cancelRestore()
      const up = ['scrollUp', 'halfUp', 'pageUp'].includes(key)
      const line = parseFloat(getComputedStyle(el).lineHeight) || 24
      const amount = key.startsWith('half') ? el.clientHeight / 2 : key.startsWith('page') ? el.clientHeight : 3 * line
      el.scrollBy({ top: (up ? -1 : 1) * amount,
        behavior: payload.instant === true || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    }
  })
  document.addEventListener('scroll', position, { capture: true, passive: true })
  document.addEventListener('play', event => {
    const media = event.target as HTMLMediaElement
    if (!['AUDIO', 'VIDEO'].includes(media.tagName)) return
    if (!active) { media.pause(); return }
    for (const other of document.querySelectorAll<HTMLMediaElement>('audio,video')) if (other !== media) other.pause()
    send('media')
  }, true)
  // Delegation prepares dynamically inserted links too. In-page anchors stay local.
  document.addEventListener('click', event => {
    const link = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || link.dataset.wsReference || link.hasAttribute('download') || link.getAttribute('href')?.startsWith('#')) return
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }, true)
  window.addEventListener('load', () => {
    window.setTimeout(() => {
      if (!active) pause()
      send('ready', { media: !!document.querySelector('audio,video') })
      links.scan()
      // Report handlers installed at load get first refusal.
      window.addEventListener('keydown', event => {
        if (!forward(event) || !intent(event, 'reader', bindings, target => !forward({ target, defaultPrevented: false } as KeyboardEvent))) return
        event.preventDefault()
        send('key', { key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          shiftKey: event.shiftKey, repeat: event.repeat })
      })
    }, 0)
  }, { once: true })
}

/** Inject after the doctype/base so standalone fragments keep standards mode. */
export function withWorkspaceKeyBridge(html: string): string {
  const bridge = `<script data-shuttle-workspace-bridge>(${documentRuntime.toString()})(${keyIntent.toString()},${shouldForwardDocumentKey.toString()},${JSON.stringify(surfaceBindings)},${referenceRuntime.toString()},${JSON.stringify(referenceStyles)},${JSON.stringify(PROTOCOL)},${VERSION});</script>`
  let insertion = 0
  const doctype = /<!doctype\b[^>]*>/i.exec(html)
  if (doctype) insertion = doctype.index + doctype[0].length
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) insertion = Math.max(insertion, head.index + head[0].length)
  const bases = /<base\b[^>]*>/ig
  for (let base; (base = bases.exec(html));) if (base.index >= insertion) insertion = base.index + base[0].length
  return html.slice(0, insertion) + bridge + html.slice(insertion)
}

export interface FrameBridge {
  position: ScrollPosition
  command(type: string, payload?: Record<string, unknown>): void
  subscribeScroll(listener: (position: ScrollPosition) => void): () => void
  dispose(): void
}
const bridges = new WeakMap<HTMLIFrameElement, FrameBridge>()
export function frameBridge(frame: HTMLIFrameElement): FrameBridge | undefined { return bridges.get(frame) }

/** Opaque origins cannot authenticate by origin; only this top-frame Window can speak. */
export function connectDocumentFrame(frame: HTMLIFrameElement, receive: (message: DocumentMessage) => void): FrameBridge {
  const listeners = new Set<(position: ScrollPosition) => void>()
  const bridge: FrameBridge = {
    position: { x: 0, y: 0 },
    command: (type, payload = {}) => {
      if (type === 'restore' && typeof payload.x === 'number' && typeof payload.y === 'number') bridge.position = { x: payload.x, y: payload.y }
      frame.contentWindow?.postMessage(envelope(type, payload), '*')
    },
    subscribeScroll: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => { window.removeEventListener('message', onMessage); listeners.clear(); bridges.delete(frame) },
  }
  const onMessage = (event: MessageEvent): void => {
    if (!event.source || event.source !== frame.contentWindow || !documentMessage(event.data)) return
    const message = event.data
    if (message.type === 'scroll') {
      const { x, y } = message.payload
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
      bridge.position = { x: Math.max(0, x), y: Math.max(0, y) }
      for (const listener of listeners) listener(bridge.position)
    }
    receive(message)
  }
  bridges.set(frame, bridge)
  window.addEventListener('message', onMessage)
  return bridge
}
export function scrollHtmlViewer(viewer: HTMLElement, intent: KeyIntent, instant: boolean): void {
  const frame = viewer.querySelector('iframe')
  if (frame) frameBridge(frame)?.command('scroll', { intent, instant })
}
