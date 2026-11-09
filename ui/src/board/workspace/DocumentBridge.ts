import { DOCUMENT_KEY_INTENTS, FOCUSED_DOCUMENT_KEY_INTENTS, keyIntent, shouldForwardDocumentKey, surfaceBindings, type KeyIntent } from '../keymap.js'
import { referenceRuntime, type ReferenceTarget, type ReferencePlayback } from './ChannelReferences.js'
import referenceStyles from './references.css?inline'
import { installPageSwipe, SWIPE } from './PhoneGestures.js'
import { mentionRuntime } from './bodyLinks.js'
import { reportMentionRuntime } from './reportMentions.js'
import mentionStyles from './mentions.css?inline'
import { parseRoute } from './route.js'

export const DOCUMENT_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms'
const PROTOCOL = 'shuttle-document'
const VERSION = 1
type ScrollPosition = { x: number; y: number }
export type DocumentKey = { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; repeat?: boolean }

/**
 * Replays a key a document passed up through the board's own handlers, from
 * `target`, when it is one documents may pass; `frame`, the document's, must
 * hold the human's focus for the intents only a focused document may pass.
 */
export function forwardDocumentKey(target: EventTarget, data: DocumentKey, frame?: Element | null): void {
  const forwarded = new KeyboardEvent('keydown', {
    key: data.key, altKey: data.altKey === true, ctrlKey: data.ctrlKey === true,
    metaKey: data.metaKey === true, shiftKey: data.shiftKey === true, repeat: data.repeat === true,
    bubbles: true, cancelable: true,
  })
  const intent = keyIntent(forwarded, 'reader')
  const focused = !!frame && document.hasFocus() && document.activeElement === frame
  if (intent && (DOCUMENT_KEY_INTENTS.includes(intent) || (focused && FOCUSED_DOCUMENT_KEY_INTENTS.includes(intent)))) target.dispatchEvent(forwarded)
}
export type DocumentMessage = { protocol: typeof PROTOCOL; version: typeof VERSION; type: string; payload: Record<string, unknown> }
export function envelope(type: string, payload: Record<string, unknown> = {}): DocumentMessage {
  return { protocol: PROTOCOL, version: VERSION, type, payload }
}
const REFERENCE_LIMIT = 500
const REFERENCE_LENGTH = 256
const REFERENCE_RATE = 4
const KEY_FIELDS = ['key', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'repeat']
const SCROLL_INTENTS = ['scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp']
function fields(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  for (const key in value) if (!Object.hasOwn(value, key) || !allowed.includes(key)) return false
  return true
}
const shortString = (value: unknown, max = REFERENCE_LENGTH): value is string => typeof value === 'string' && value.length <= max
const coordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 0x7fffffff
const travel = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8192
const boundedArray = (value: unknown, valid: (item: unknown) => boolean): boolean => Array.isArray(value) && value.length <= REFERENCE_LIMIT && Array.from(value).every(valid)

/** Fixed schemas bound work in both directions; unknown types and extra data are refused. */
export function documentMessage(data: unknown): data is DocumentMessage {
  if (!fields(data, ['protocol', 'version', 'type', 'payload']) || data.protocol !== PROTOCOL || data.version !== VERSION || typeof data.type !== 'string') return false
  const p = data.payload
  switch (data.type) {
    case 'ready': return fields(p, ['media']) && (p.media === undefined || typeof p.media === 'boolean')
    case 'media': case 'references:scan': case 'pdf:scan': return fields(p, [])
    case 'pause': return fields(p, []) || fields(p, ['candidate']) && shortString(p.candidate)
    case 'active': return fields(p, ['active']) && typeof p.active === 'boolean'
    case 'key': return fields(p, KEY_FIELDS) && shortString(p.key, 64) && p.key.length > 0
      && KEY_FIELDS.slice(1).every(key => p[key] === undefined || typeof p[key] === 'boolean')
    case 'scroll':
      if (fields(p, ['intent', 'instant']) && typeof p.intent === 'string') return SCROLL_INTENTS.includes(p.intent) && (p.instant === undefined || typeof p.instant === 'boolean')
      return fields(p, ['x', 'y']) && coordinate(p.x) && coordinate(p.y)
    case 'restore': return fields(p, ['x', 'y', 'clamp']) && coordinate(p.x) && coordinate(p.y) && (p.clamp === undefined || typeof p.clamp === 'boolean')
    case 'fit': return fields(p, [])
    case 'height': return fields(p, ['height']) && coordinate(p.height) && p.height > 0
    case 'swipe':
      if (fields(p, ['phase']) && p.phase === 'cancel') return true
      if (fields(p, ['phase', 'dx']) && p.phase === 'move') return travel(p.dx)
      return fields(p, ['phase', 'dx', 'velocity']) && p.phase === 'end' && travel(p.dx)
        && typeof p.velocity === 'number' && Number.isFinite(p.velocity) && Math.abs(p.velocity) <= 20
    case 'references': return fields(p, ['candidates']) && boundedArray(p.candidates, item => shortString(item))
    case 'fragment': return fields(p, ['hash']) && shortString(p.hash, 4096)
    case 'navigate': return fields(p, ['href']) && shortString(p.href, 4096) && !!p.href
    case 'select': case 'play': return fields(p, ['candidate']) && shortString(p.candidate)
    case 'references:resolved': return fields(p, ['targets']) && boundedArray(p.targets, item =>
      fields(item, ['candidate', 'title', 'audio']) && shortString(item.candidate) && shortString(item.title) && typeof item.audio === 'boolean')
    case 'references:playback': return fields(p, ['states']) && boundedArray(p.states, item =>
      fields(item, ['candidate', 'playing', 'progress']) && shortString(item.candidate) && typeof item.playing === 'boolean'
      && typeof item.progress === 'number' && Number.isFinite(item.progress) && item.progress >= 0 && item.progress <= 1)
    case 'pdf:layout': return fields(p, ['items']) && Array.isArray(p.items) && p.items.length <= 32 && boundedArray(p.items, item =>
      fields(item, ['id', 'src', 'x', 'y', 'width', 'height']) && shortString(item.id, 64) && shortString(item.src, 4096)
      && coordinate(item.x) && coordinate(item.y) && travel(item.width) && travel(item.height)
      && (item.width as number) > 0 && (item.height as number) > 0)
    default: return false
  }
}

/** This function is serialized, so every dependency arrives as an argument. */
function installEmbeddedPdfEmbeds(send: (type: string, payload?: Record<string, unknown>) => void): void {
  const known = new WeakMap<HTMLIFrameElement, { id: string; placeholder: HTMLElement; src: string }>()
  const embeds = new Map<string, { placeholder: HTMLElement; src: string }>()
  let nextId = 0
  let frame = 0
  const scan = (): void => {
    frame = 0
    const items: { id: string; src: string; x: number; y: number; width: number; height: number }[] = []
    for (const candidate of document.querySelectorAll<HTMLIFrameElement>('iframe[src]')) {
      const src = candidate.getAttribute('src') ?? ''
      if (!/\.pdf(?:[?#]|$)/i.test(src)) continue
      let item = known.get(candidate)
      if (!item) {
        const box = candidate.getBoundingClientRect()
        const placeholder = document.createElement('div')
        placeholder.className = candidate.className
        placeholder.setAttribute('role', 'region')
        placeholder.setAttribute('aria-label', candidate.title || 'Embedded PDF')
        placeholder.dataset.shuttlePdfEmbed = 'true'
        placeholder.style.cssText = candidate.getAttribute('style') ?? ''
        if (!placeholder.style.width && candidate.getAttribute('width')) placeholder.style.width = `${candidate.getAttribute('width')}px`
        if (!placeholder.style.height && candidate.getAttribute('height')) placeholder.style.height = `${candidate.getAttribute('height')}px`
        if (!placeholder.style.width) placeholder.style.width = `${Math.max(1, box.width)}px`
        if (!placeholder.style.height) placeholder.style.height = `${Math.max(1, box.height)}px`
        candidate.replaceWith(placeholder)
        item = { id: `pdf-${++nextId}`, placeholder, src }
        known.set(candidate, item)
        embeds.set(item.id, item)
      }
    }
    for (const [id, item] of embeds) {
      if (!item.placeholder.isConnected) { embeds.delete(id); continue }
      const box = item.placeholder.getBoundingClientRect()
      items.push({ id, src: item.src, x: box.left, y: box.top, width: box.width, height: box.height })
      if (items.length >= 32) break
    }
    send('pdf:layout', { items })
  }
  let stopped = false
  let observer: MutationObserver
  const schedule = (): void => {
    const hasPdfFrame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[src]')].some(candidate => /\.pdf(?:[?#]|$)/i.test(candidate.getAttribute('src') ?? ''))
    if (stopped || (!embeds.size && !hasPdfFrame)) return
    if (!frame) frame = requestAnimationFrame(scan)
  }
  observer = new MutationObserver(schedule)
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'style', 'class', 'width', 'height', 'hidden'] })
  document.addEventListener('scroll', schedule, true)
  document.addEventListener('load', schedule, true)
  window.addEventListener('resize', schedule)
  const rescan = (): void => scan()
  window.addEventListener('shuttle-pdf-scan', rescan)
  void document.fonts?.ready.then(schedule, () => {})
  document.fonts?.addEventListener('loadingdone', schedule)
  window.addEventListener('load', schedule, { once: true })
  window.addEventListener('pagehide', () => {
    stopped = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    document.removeEventListener('scroll', schedule, true)
    document.removeEventListener('load', schedule, true)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('shuttle-pdf-scan', rescan)
    document.fonts?.removeEventListener('loadingdone', schedule)
  }, { once: true })
}

function documentRuntime(intent: typeof keyIntent, forward: typeof shouldForwardDocumentKey, bindings: typeof surfaceBindings, allowed: readonly KeyIntent[], limits: { count: number; length: number; interval: number }, references: typeof referenceRuntime, css: string, protocol: string, version: number, swipe: typeof installPageSwipe, swipeLimits: typeof SWIPE, mentions: typeof mentionRuntime, mentionCss: string, reportMentions: typeof reportMentionRuntime, embeddedPdfs: typeof installEmbeddedPdfEmbeds, boardOrigin: string, parseBoardRoute: typeof parseRoute): void {
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
  let referencesAt = -Infinity
  let referencesTimer: ReturnType<typeof setTimeout> | undefined
  let pendingReferences: Record<string, unknown> | undefined
  const send = (type: string, payload: Record<string, unknown> = {}): void => {
    if (type === 'references') {
      // Coalesce ordinary rescans so the latest layout reaches the parent budget.
      // A monotonic clock, clamped, so a stubbed or stepped clock cannot defer a rescan.
      const wait = Math.min(limits.interval, Math.max(0, Math.ceil(limits.interval - (performance.now() - referencesAt))))
      if (wait > 0) {
        pendingReferences = payload
        if (referencesTimer === undefined) referencesTimer = setTimeout(() => {
          referencesTimer = undefined
          const latest = pendingReferences; pendingReferences = undefined
          if (latest) send('references', latest)
        }, wait)
        return
      }
      clearTimeout(referencesTimer); referencesTimer = undefined; pendingReferences = undefined
      referencesAt = performance.now()
    }
    parent.postMessage({ protocol, version, type, payload }, '*')
  }
  embeddedPdfs(send)
  const style = document.createElement('style'); style.textContent = css
  ;(document.head ?? document.documentElement).append(style)
  const disposeMentions = reportMentions(mentions, mentionCss, limits, () => active)
  let links: ReturnType<typeof references> | undefined
  window.addEventListener('pagehide', () => {
    clearTimeout(referencesTimer)
    links?.dispose()
    disposeMentions()
  }, { once: true })
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
    } else if (data.type === 'references:scan') links?.scan()
    else if (data.type === 'pdf:scan') window.dispatchEvent(new Event('shuttle-pdf-scan'))
    else if (data.type === 'references:resolved' && Array.isArray(payload.targets)) {
      links?.resolve(payload.targets.filter((target: ReferenceTarget) => target && typeof target.candidate === 'string' && typeof target.title === 'string' && typeof target.audio === 'boolean'))
    } else if (data.type === 'references:playback' && Array.isArray(payload.states)) {
      for (const state of payload.states as ReferencePlayback[]) {
        if (state && typeof state.candidate === 'string' && typeof state.playing === 'boolean' && Number.isFinite(state.progress)) links?.playback(state)
      }
    } else if (data.type === 'pause') pause()
    else if (data.type === 'fit') {
      // The host draws the page at its full height: report it whenever layout moves it.
      let sent = 0, frame = 0
      const measure = (): void => {
        frame = 0
        // The root's scroll height never falls below the frame's, so a page that
        // shrank is measured by its own box.
        const height = Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body?.scrollHeight ?? 0))
        if (height !== sent) { sent = height; send('height', { height }) }
      }
      const schedule = (): void => { if (!frame) frame = requestAnimationFrame(measure) }
      const observer = new ResizeObserver(schedule)
      observer.observe(document.documentElement)
      if (document.body) observer.observe(document.body)
      new MutationObserver(schedule).observe(document, { childList: true, subtree: true })
      measure()
    }
    else if (data.type === 'restore' && Number.isFinite(payload.x) && Number.isFinite(payload.y)) {
      cancelRestore()
      pendingRestore = { x: Math.max(0, payload.x), y: Math.max(0, payload.y) }
      // A loaded page clamps at once; one still laying out holds the offset a while.
      if (payload.clamp === true) return restore(true)
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
  // Touches inside an opaque frame never reach the board, so the frame
  // recognises a page swipe itself and reports its travel; follow updates are
  // coalesced to one per animation frame.
  let swipeMove: number | undefined
  let swipeFrame = 0
  swipe(document, signal => {
    if (signal.phase === 'move') {
      swipeMove = signal.dx
      if (!swipeFrame) swipeFrame = requestAnimationFrame(() => {
        swipeFrame = 0
        if (swipeMove !== undefined) send('swipe', { phase: 'move', dx: swipeMove })
        swipeMove = undefined
      })
      return
    }
    cancelAnimationFrame(swipeFrame); swipeFrame = 0; swipeMove = undefined
    send('swipe', signal)
  }, () => active, swipeLimits, true)
  document.addEventListener('play', event => {
    const media = event.target as HTMLMediaElement
    if (!['AUDIO', 'VIDEO'].includes(media.tagName)) return
    if (!active) { media.pause(); return }
    for (const other of document.querySelectorAll<HTMLMediaElement>('audio,video')) if (other !== media) other.pause()
    send('media')
  }, true)
  // Delegation prepares dynamically inserted links too. In-page anchors stay local.
  const fragment = (hash: string): void => {
    cancelRestore()
    let id: string
    try { id = decodeURIComponent(hash.replace(/^#/, '')) } catch { return }
    const target = document.getElementById(id) ?? document.getElementsByName(id)[0]
    if (target) target.scrollIntoView()
    else if (!id || id === 'top') window.scrollTo(0, 0)
  }
  window.addEventListener('message', event => {
    if (event.source === window.parent && event.data?.protocol === protocol && event.data?.version === version
      && event.data?.type === 'fragment' && typeof event.data.payload?.hash === 'string') fragment(event.data.payload.hash)
  })
  document.addEventListener('click', event => {
    const link = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || link.dataset.wsReference || link.hasAttribute('download')) return
    const href = link.getAttribute('href') ?? ''
    let routeHash = href.startsWith('#') ? href : ''
    if (!routeHash) {
      try { const url = new URL(href); if (url.origin === boardOrigin) routeHash = url.hash } catch { /* Relative files remain files. */ }
    }
    if (active && href.length <= 4096 && (routeHash === '#/desk' || routeHash === '#/chronicle' || parseBoardRoute(routeHash))) {
      event.preventDefault()
      event.stopImmediatePropagation()
      send('navigate', { href: routeHash })
      return
    }
    if (href.startsWith('#')) {
      event.preventDefault()
      event.stopImmediatePropagation()
      fragment(href)
      return
    }
    let shuttleFile = false
    try { const url = new URL(href, document.baseURI); shuttleFile = url.pathname === '/api/v1/file' && url.searchParams.has('path') } catch { /* Invalid links stay ordinary links. */ }
    if (active && href && href.length <= 4096 && (shuttleFile || !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href))) {
      event.preventDefault()
      event.stopImmediatePropagation()
      send('navigate', { href })
      return
    }
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }, true)
  window.addEventListener('load', () => {
    window.setTimeout(() => {
      if (!active) pause()
      send('ready', { media: !!document.querySelector('audio,video') })
      links = references(document, candidates => send('references', { candidates: candidates.filter(candidate => candidate.length <= limits.length).slice(0, limits.count) }),
        (type, candidate) => { if (active) send(type, { candidate }) })
      links.scan()
      const sendKey = (event: KeyboardEvent): void => {
        event.preventDefault()
        send('key', { key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          shiftKey: event.shiftKey, repeat: event.repeat })
      }
      window.addEventListener('keydown', event => {
        if (!event.isTrusted || event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return
        // Browsers normally consume native fullscreen Escape. If delivered, it
        // belongs only to fullscreen, before any deck handler or board message.
        if (document.fullscreenElement) {
          event.preventDefault()
          event.stopImmediatePropagation()
          void document.exitFullscreen().catch(() => {})
          return
        }
        // Reveal consumes Escape to OPEN overview even on an ordinary slide.
        // In the reader that key backs out instead. Existing deck layers and
        // editable targets keep their Escape; held keys cannot open overview.
        if (!active || event.altKey || event.ctrlKey || event.metaKey || !forward(event)
          || !document.querySelector('.reveal') || document.querySelector('.reveal.overview, .reveal .overlay')) return
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) sendKey(event)
      }, true)
      // Report handlers installed at load get first refusal for other keys.
      window.addEventListener('keydown', event => {
        if (!event.isTrusted || !forward(event)) return
        const action = intent(event, 'reader', bindings, target => !forward({ target, defaultPrevented: false } as KeyboardEvent))
        if (!action || !allowed.includes(action)) return
        sendKey(event)
      })
    }, 0)
  }, { once: true })
}

/** Inject after the doctype/base so standalone fragments keep standards mode. */
export function withWorkspaceKeyBridge(html: string): string {
  const bridge = `<script data-shuttle-workspace-bridge>(${documentRuntime.toString()})(${keyIntent.toString()},${shouldForwardDocumentKey.toString()},${JSON.stringify(surfaceBindings)},${JSON.stringify([...DOCUMENT_KEY_INTENTS, ...FOCUSED_DOCUMENT_KEY_INTENTS])},${JSON.stringify({ count: REFERENCE_LIMIT, length: REFERENCE_LENGTH, interval: Math.ceil(1000 / REFERENCE_RATE) + 10 })},${referenceRuntime.toString()},${JSON.stringify(referenceStyles)},${JSON.stringify(PROTOCOL)},${VERSION},${installPageSwipe.toString()},${JSON.stringify(SWIPE)},${mentionRuntime.toString()},${JSON.stringify(mentionStyles)},${reportMentionRuntime.toString()},${installEmbeddedPdfEmbeds.toString()},${JSON.stringify(window.location.origin)},${parseRoute.toString()});</script>`
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
  readonly active: boolean
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
  let referenceTimes: number[] = []
  let deferredReferences: MessageEvent | undefined
  let deferredTimer: ReturnType<typeof setTimeout> | undefined
  let active = false
  const bridge: FrameBridge = {
    get active() { return active },
    position: { x: 0, y: 0 },
    command: (type, payload = {}) => {
      // Titles are presentation text, not identity; keep long titles within the wire budget.
      if (type === 'references:resolved' && Array.isArray(payload.targets)) payload = {
        targets: payload.targets.slice(0, REFERENCE_LIMIT).map((target: ReferenceTarget) => ({ ...target, title: target.title.slice(0, REFERENCE_LENGTH) })),
      }
      const message = envelope(type, payload)
      if (!documentMessage(message)) return
      if (type === 'active' && typeof payload.active === 'boolean') active = payload.active
      if (type === 'restore' && typeof payload.x === 'number' && typeof payload.y === 'number') bridge.position = { x: payload.x, y: payload.y }
      frame.contentWindow?.postMessage(message, '*')
    },
    subscribeScroll: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => {
      window.removeEventListener('message', onMessage); listeners.clear(); bridges.delete(frame)
      clearTimeout(deferredTimer); deferredTimer = undefined; deferredReferences = undefined
    },
  }
  const onMessage = (event: MessageEvent): void => {
    if (!event.source || event.source !== frame.contentWindow) return
    // Defer excess batches before walking their candidates. Each frame owns its
    // budget; the newest deferred batch is delivered when the window reopens, so
    // the latest layout always arrives even though the frame never resends.
    if (event.data?.type === 'references') {
      const now = performance.now()
      referenceTimes = referenceTimes.filter(t => t <= now && now - t < 1000)
      if (referenceTimes.length >= REFERENCE_RATE) {
        deferredReferences = event
        if (deferredTimer === undefined) deferredTimer = setTimeout(() => {
          deferredTimer = undefined
          const latest = deferredReferences; deferredReferences = undefined
          if (latest) onMessage(latest)
        }, Math.min(1000, Math.max(0, Math.ceil(1000 - (now - referenceTimes[0])))))
        return
      }
      referenceTimes.push(now)
      clearTimeout(deferredTimer); deferredTimer = undefined; deferredReferences = undefined
    }
    if (!documentMessage(event.data)) return
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
