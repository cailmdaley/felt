/**
 * Shared renderer for document workspace pages and Board overview thumbnails.
 *
 * Images and audio use native elements, markdown and text render in a scrolling
 * pane, HTML renders in a scrollable iframe, and browser-native formats such
 * as PDF stay in their own iframe. HTML, markdown, and text subscribe to the
 * shared conditional file poller; their DOM changes only when the body does.
 *
 * Native elements stream owner-routed `GET /api/v1/file` by URL; every other
 * read of a document's content, existence or metadata goes through the
 * document cache (`documentResources`). HTML pages and thumbnails resolve
 * relative resources against `/api/v1/file-assets/:origin/*path`.
 */

import './FileViewerPanel.css'
import './prose.css'
import { watchLiveFile, type LiveFileSubscription } from './LiveFileRefresh.js'
import type { ReferenceTarget } from './workspace/ChannelReferences.js'
import { fileKind } from './attachments.js'
import { head, peek, recallText, RESOURCE_PRIORITY, text as documentText, type Head, type ResourcePriority } from './documentResources.js'
import { loadDuration } from './workspace/audioWaveform.js'
import { connectDocumentFrame, frameBridge, DOCUMENT_SANDBOX, withWorkspaceKeyBridge, type DocumentKey, type FrameBridge } from './workspace/DocumentBridge.js'
import type { SwipeSignal } from './workspace/PhoneGestures.js'
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  VIDEO_EXTS,
  MARKDOWN_EXTS,
  basename,
  escapeHtml,
  fileBytesUrl,
  fileExt,
  renderMarkdown,
} from './utils.js'

export type FileViewerState =
  | { status: 'ready' }
  | { status: 'error'; error: unknown; hasContent: boolean }

export interface FileViewerOptions {
  /** A document model can supply its classification instead of suffix dispatch. */
  kind?: 'html' | 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'other'
  /** Inert previews use the same kind dispatch within their host's load budget. */
  thumbnail?: boolean
  /** Captioned previews keep the filename outside the miniature page. */
  thumbnailLabel?: boolean
  /** Inactive viewers read once for a preview, without periodic subscriptions. */
  active?: boolean
  /** Transform HTML after its base URL is installed, before srcdoc assignment. */
  transformHtml?: (html: string) => string
  onDocumentKey?: (key: DocumentKey) => void
  /** A page swipe recognised inside the document; the reader decides whether it pages. */
  onDocumentSwipe?: (signal: SwipeSignal) => void
  onWeight?: (slots: number) => void
  onState?: (state: FileViewerState) => void
  /** Declared metadata shares the inert preview's source read. */
  onThumbnailSource?: (source: string | Uint8Array, etag?: string) => void
  /** Paint paper until load rather than a loading message. */
  quietLoading?: boolean
  /** Listening controls use the same native element and lifecycle as video. */
  decorateAudio?: (audio: HTMLAudioElement) => () => void
  /** Channel references are installed after every text-body replacement. */
  decorateText?: (pane: HTMLElement) => void
  resolveReferences?: (candidates: string[]) => ReferenceTarget[]
  onReferenceIntent?: (type: 'select' | 'play' | 'pause', candidate: string) => void
}

/**
 * Render a deliverable into a fresh element by extension — the shared dispatch
 * a reader mounts for each open file. The iframe variant carries a loading veil
 * (a remote `report.html` can be multi-MB over a slow tunnel; a blank frame
 * reads as broken) that lifts on `load` and flips to an error note on `error`.
 *
 * `onFrameLoad` fires after each HTML document update — the reader uses it
 * to restore scroll position on a persistence rehydrate and reconnect its
 * scroll listener. `onTextPane`
 * is its twin for the self-rendered text pane, which has no document and so no
 * `load`: it fires with the element that scrolls, once the text is in it. A
 * text deliverable is as scrollable as an HTML one, so it keeps its reading
 * position the same way. Image and audio viewers call neither.
 */
export function buildFileViewer(
  shuttleBase: string,
  fullPath: string,
  originId: string,
  onFrameLoad?: (iframe: HTMLIFrameElement, refreshed: boolean) => void,
  onTextPane?: (scroller: HTMLElement) => void,
  options: FileViewerOptions = {},
): HTMLElement {
  const ext = fileExt(fullPath)
  const src = fileBytesUrl(shuttleBase, fullPath, originId)
  const classified = fileKind(fullPath)
  const kind = options.kind ?? (classified === 'markdown' ? 'text' : classified)
  if (options.thumbnail) return buildThumbnail(src, fullPath, kind, options)

  if (kind === 'image') {
    // Mount the plate on a vellum mat so it reads as a mounted figure, centered
    // with breathing room, rather than a bitmap bled to the cell edge.
    const wrap = document.createElement('div')
    wrap.className = 'kbn-fileview-image-wrap'
    const img = document.createElement('img')
    img.className = 'kbn-fileview-image'
    img.src = src
    img.alt = basename(fullPath)
    let disposed = false
    img.addEventListener('load', () => {
      if (!disposed) options.onState?.({ status: 'ready' })
    })
    img.addEventListener('error', () => {
      void head(src, RESOURCE_PRIORITY.selected, { fresh: true }).then(info => {
        if (!disposed) options.onState?.({ status: 'error', error: info?.exists ? new Error('image format is not supported by this browser') : headError(info), hasContent: false })
      })
    })
    viewerDisposers.set(wrap, () => { disposed = true })
    wrap.append(img)
    return wrap
  }

  if (kind === 'audio' || kind === 'video') return buildMediaViewer(src, fullPath, kind, options)
  if (kind === 'other') return buildUnsupportedViewer(shuttleBase, fullPath, originId, options)

  // TEXT. An iframe is the wrong instrument here: the daemon serves most text
  // suffixes as `application/octet-stream`, so the frame either downloads the
  // file or shows unwrapped monospace source with no reading comfort at all —
  // and a `.md` deliverable, the most common thing a worker sends, would read
  // as raw markdown syntax. Fetching the bytes and rendering them in-page costs
  // one request and turns both into something readable: markdown through the
  // same `renderMarkdown` the fiber body uses, wearing the same
  // `.kbn-detail-prose` skin so a sent report looks like the fiber it came
  // from; anything else as a code block, reusing the `md-code-block` markup
  // the markdown renderer already emits for fenced code.
  if (kind === 'text') {
    return buildTextViewer(src, fullPath, ext, onTextPane, options)
  }

  if (kind === 'html') {
    return buildHtmlViewer(src, fullPath, onFrameLoad, options)
  }

  // The browser-native PDF viewer retains its layout while parked.
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-frame-wrap'

  const veil = loadingVeil(fullPath, options)
  let disposed = false
  let loaded = false
  let checked = false
  let faulted = false
  const controller = new AbortController()

  const iframe = document.createElement('iframe')
  iframe.className = 'kbn-fileview-frame'
  iframe.src = `${src}#navpanes=0&view=FitH`
  iframe.style.background = 'var(--ws-paper)'
  iframe.title = basename(fullPath)
  wrap.append(iframe, veil)

  const failed = (detail: string): void => {
    if (disposed) return
    faulted = true
    showLoadFailure(veil, wrap, fullPath, detail)
    options.onState?.({ status: 'error', error: new Error(`file request failed: ${detail}`), hasContent: false })
  }
  const ready = (): void => {
    if (!disposed && !faulted && loaded && checked) options.onState?.({ status: 'ready' })
  }

  iframe.addEventListener('load', () => {
    if (disposed) return
    loaded = true
    // The 404 document loads too, and it loads AFTER the probe has usually
    // answered. Lifting the veil unconditionally here would erase the error the
    // probe just wrote and leave a blank frame. Only a frame nobody has faulted
    // gets revealed.
    if (veil.classList.contains('kbn-fileview-loading-error')) return
    veil.remove()
    onFrameLoad?.(iframe, false)
    ready()
  })
  // `error` on an iframe fires for NETWORK failures only. An HTTP 404 is a
  // perfectly successful navigation to an error document, so `load` fires, the
  // veil lifts, and the reader would be left looking at an empty frame with
  // nothing saying why.
  iframe.addEventListener('error', () => failed('the daemon could not be reached'))

  // So ASK. The cache's head settles what the iframe's own events cannot tell
  // apart. Ordering is not a race: `failed` re-attaches the veil if `load`
  // already removed it, so whichever resolves second still tells the truth.
  void head(src, RESOURCE_PRIORITY.selected, { fresh: true }).then(info => {
    if (controller.signal.aborted) return
    checked = true
    if (!info) failed('the daemon could not be reached')
    else if (!info.exists) failed('404 Not Found')
    else ready()
  })
  viewerDisposers.set(wrap, () => { disposed = true; controller.abort() })

  return wrap
}

type MediaState = { media: HTMLMediaElement; active: boolean; inline: boolean }
const mediaViewers = new WeakMap<HTMLElement, MediaState>()
const players = new Set<HTMLMediaElement>()
type EmbeddedMediaState = { active: boolean; bridge: FrameBridge | null }
const embeddedMediaViewers = new WeakMap<HTMLElement, EmbeddedMediaState>()
const embeddedPlayers = new Set<EmbeddedMediaState>()
function pauseOtherPlayers(except?: EmbeddedMediaState): void {
  for (const media of players) media.pause()
  for (const state of embeddedPlayers) if (state !== except) state.bridge?.command('pause')
}

function buildMediaViewer(src: string, path: string, kind: 'audio' | 'video', options: FileViewerOptions): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = `kbn-fileview-media kbn-fileview-${kind}`
  const page = document.createElement('div')
  page.className = 'kbn-media-page'
  const media = document.createElement(kind)
  media.controls = true
  media.preload = 'metadata'
  media.setAttribute('aria-label', basename(path))
  if (media instanceof HTMLVideoElement) media.playsInline = true
  const state: MediaState = { media, active: options.active !== false, inline: false }
  mediaViewers.set(wrap, state)
  players.add(media)
  media.addEventListener('play', () => {
    if (!state.active && !state.inline) { media.pause(); return }
    for (const other of players) if (other !== media) other.pause()
    for (const embedded of embeddedPlayers) embedded.bridge?.command('pause')
  })
  media.addEventListener('pause', () => { state.inline = false })
  media.addEventListener('loadedmetadata', () => options.onState?.({ status: 'ready' }))
  let disposed = false
  media.addEventListener('error', () => {
    // The cache's head distinguishes a missing resource from a codec failure.
    void head(src, RESOURCE_PRIORITY.selected, { fresh: true }).then(info => {
      if (!disposed) options.onState?.({ status: 'error', error: info?.exists ? new Error('media format is not supported by this browser') : headError(info), hasContent: false })
    })
  })
  page.append(media)
  wrap.append(page)
  media.src = src
  const disposeAudio = media instanceof HTMLAudioElement ? options.decorateAudio?.(media) : undefined
  viewerDisposers.set(wrap, () => {
    disposeAudio?.()
    disposed = true
    media.pause()
    players.delete(media)
    mediaViewers.delete(wrap)
    media.removeAttribute('src')
    media.load()
  })
  return wrap
}

/** Why a document a native viewer could not show failed, from its head. */
function headError(info: Head | null): Error {
  return new Error(info ? 'file request failed: 404' : 'the daemon could not be reached')
}

function buildUnsupportedViewer(base: string, path: string, owner: string, options: FileViewerOptions): HTMLElement {
  const box = document.createElement('div')
  box.className = 'kbn-fileview-unsupported ws-document-state'
  const detail = document.createElement('p')
  detail.textContent = 'Not drawn here'
  const download = document.createElement('a')
  download.href = fileBytesUrl(base, path, owner)
  download.download = basename(path)
  download.textContent = 'Download'
  box.append(detail, download)
  let disposed = false
  viewerDisposers.set(box, () => { disposed = true })
  void head(fileBytesUrl(base, path, owner), RESOURCE_PRIORITY.selected).then(info => {
    if (disposed) return
    if (!info?.exists) { options.onState?.({ status: 'error', error: headError(info), hasContent: false }); return }
    if (info.size !== undefined) detail.textContent = `Not drawn here · ${new Intl.NumberFormat().format(info.size)} bytes`
    options.onState?.({ status: 'ready' })
  })
  return box
}

/** A budgeted, inert view of the same resource kind the reader renders. */
function buildThumbnail(src: string, path: string, kind: NonNullable<FileViewerOptions['kind']>, options: FileViewerOptions): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = `kbn-fileview-thumbnail kbn-thumbnail-${kind}`
  wrap.inert = true
  wrap.setAttribute('aria-hidden', 'true')
  const controller = new AbortController()
  let disposed = false
  let settled = false
  const finish = (ok: boolean): void => {
    if (disposed || settled) return
    settled = true
    options.onState?.(ok ? { status: 'ready' } : { status: 'error', error: new Error('Thumbnail unavailable'), hasContent: false })
  }
  const glyph = document.createElement('div')
  glyph.className = 'kbn-thumbnail-glyph'
  const kindMark = document.createElement('span'); kindMark.className = 'kbn-thumbnail-kind'
  kindMark.textContent = { audio: '♪', video: '▹', pdf: '▧', other: '□', image: '▨', html: '▣', text: '≡' }[kind]
  const name = document.createElement('span'); name.className = 'kbn-thumbnail-name'; name.textContent = options.thumbnailLabel === false ? '' : basename(path)
  const duration = document.createElement('span'); duration.className = 'kbn-thumbnail-duration'
  glyph.append(kindMark, name, duration)
  wrap.append(glyph)
  let native: HTMLMediaElement | null = null
  if (kind === 'image') {
    const image = document.createElement('img')
    image.alt = ''
    image.decoding = 'async'
    image.addEventListener('load', () => finish(true), { once: true })
    image.addEventListener('error', () => finish(false), { once: true })
    image.src = src
    wrap.append(image)
  } else if (kind === 'html' || kind === 'pdf') {
    const frame = document.createElement('iframe')
    frame.title = basename(path)
    frame.inert = true
    frame.tabIndex = -1
    frame.setAttribute('scrolling', 'no')
    frame.addEventListener('error', () => finish(false), { once: true })
    if (kind === 'html') {
      // The page's own text, from the cache the reader shares, drawn without scripts.
      frame.setAttribute('sandbox', '')
      frame.allow = "autoplay 'none'"
      void documentText(src, RESOURCE_PRIORITY.thumbnail, { signal: controller.signal }).then(body => {
        if (disposed) return
        if (!body) { finish(false); return }
        options.onThumbnailSource?.(body.text, body.etag)
        // An empty frame has already loaded about:blank; only the page's own load counts.
        frame.addEventListener('load', () => finish(true), { once: true })
        frame.srcdoc = htmlWithBase(body.text, src)
      })
    } else {
      // Native PDF viewers need their plugin; the host makes the whole slot inert.
      frame.addEventListener('load', () => {
        void head(src, RESOURCE_PRIORITY.thumbnail, { signal: controller.signal }).then(info => finish(!!info?.exists))
      }, { once: true })
      frame.src = `${src}#page=1&view=FitH&toolbar=0`
      if (options.onThumbnailSource) void readThumbnailMetadata(src, controller.signal, options.onThumbnailSource)
    }
    wrap.append(frame)
  } else if (kind === 'audio') {
    // A recording is its face: the title and the duration its peek declares, with no media element.
    void peek(src, RESOURCE_PRIORITY.thumbnail, { signal: controller.signal }).then(first => {
      if (disposed) return
      if (!first) { finish(false); return }
      options.onThumbnailSource?.(first.bytes, first.etag)
      finish(true)
      void loadDuration(src, controller.signal).then(seconds => {
        if (seconds !== null && !disposed) duration.textContent = formatMediaTime(seconds)
      })
    })
  } else if (kind === 'video') {
    const media = document.createElement('video')
    native = media
    media.preload = 'metadata'
    media.muted = true
    media.tabIndex = -1
    media.addEventListener('play', () => media.pause())
    media.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(media.duration)) duration.textContent = formatMediaTime(media.duration)
      finish(true)
    }, { once: true })
    media.addEventListener('error', () => finish(false), { once: true })
    if (media instanceof HTMLVideoElement) media.playsInline = true
    media.src = src
    wrap.append(media)
  } else if (kind === 'text') {
    void documentText(src, RESOURCE_PRIORITY.thumbnail, { signal: controller.signal }).then(body => {
      if (disposed) return
      if (!body) { finish(false); return }
      options.onThumbnailSource?.(body.text, body.etag)
      const pre = document.createElement('pre')
      pre.inert = true
      pre.textContent = body.text.slice(0, 12000)
      wrap.append(pre)
      finish(true)
    })
  } else queueMicrotask(() => finish(true))
  viewerDisposers.set(wrap, () => {
    disposed = true
    controller.abort()
    if (native) { native.pause(); native.removeAttribute('src'); native.load() }
  })
  return wrap
}

/** A document's first 64 KiB from the cache, so concurrent surfaces read it once. */
export async function readThumbnailMetadata(src: string, signal: AbortSignal, onSource: NonNullable<FileViewerOptions['onThumbnailSource']>, priority: ResourcePriority = RESOURCE_PRIORITY.thumbnail, fresh = false): Promise<void> {
  const first = await peek(src, priority, { fresh, signal })
  // Native playback and preview do not depend on metadata.
  if (first && !signal.aborted) onSource(first.bytes, first.etag)
}

function formatMediaTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

const liveViewSubscriptions = new WeakMap<HTMLElement, LiveFileSubscription>()
const viewerDisposers = new WeakMap<HTMLElement, () => void>()

/** Stop the shared poll when its viewer tab closes. */
export function disposeFileViewer(viewer: HTMLElement | null): void {
  if (!viewer) return
  liveViewSubscriptions.get(viewer)?.()
  liveViewSubscriptions.delete(viewer)
  viewerDisposers.get(viewer)?.()
  viewerDisposers.delete(viewer)
}

/** A report's explicit gesture lends playback to the channel's retained audio element. */
export function playFileViewerAudio(viewer: HTMLElement): void {
  const state = mediaViewers.get(viewer)
  if (!state || !(state.media instanceof HTMLAudioElement)) return
  state.inline = true
  void state.media.play().catch(() => { state.inline = false })
}

/** Pause a hidden reader tab without tearing down its viewer DOM. */
export function suspendFileViewer(viewer: HTMLElement | null): void {
  if (viewer) {
    liveViewSubscriptions.get(viewer)?.suspend()
    const state = mediaViewers.get(viewer)
    if (state) { state.active = false; state.inline = false; state.media.pause() }
    const embedded = embeddedMediaViewers.get(viewer)
    if (embedded) { embedded.active = false; embedded.bridge?.command('active', { active: false }) }
  }
}

/** Resume a reader tab and revalidate its file while retaining its DOM. */
export function resumeFileViewer(viewer: HTMLElement | null): void {
  if (viewer) {
    void liveViewSubscriptions.get(viewer)?.resume()
    const state = mediaViewers.get(viewer)
    if (state) state.active = true
    const embedded = embeddedMediaViewers.get(viewer)
    if (embedded) { embedded.active = true; embedded.bridge?.command('active', { active: true }) }
  }
}

/** Finish an inactive preview's initial read without activating its subscription. */
export function loadFileViewerOnce(viewer: HTMLElement | null): void {
  if (viewer) void liveViewSubscriptions.get(viewer)?.loadOnce()
}

function buildHtmlViewer(
  src: string,
  fullPath: string,
  onFrameLoad?: (iframe: HTMLIFrameElement, refreshed: boolean) => void,
  options: FileViewerOptions = {},
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-frame-wrap'
  const embedded: EmbeddedMediaState = { active: options.active !== false, bridge: null }
  embeddedMediaViewers.set(wrap, embedded)
  embeddedPlayers.add(embedded)
  const veil = loadingVeil(fullPath, options)
  let disposed = false
  let failed = false
  let hasContent = false
  let initialLoadHandled = false
  let generation = 0
  let stagingFrame: HTMLIFrameElement | null = null
  let stagingBridge: FrameBridge | null = null
  const byteWeights = new WeakMap<HTMLIFrameElement, number>()
  const createFrame = (ready: (frame: HTMLIFrameElement, bridge: FrameBridge) => void): HTMLIFrameElement => {
    const frame = document.createElement('iframe')
    frame.className = 'kbn-fileview-frame'
    frame.title = basename(fullPath)
    frame.setAttribute('sandbox', DOCUMENT_SANDBOX)
    let announced = false
    let charged = 0
    let resolved = new Set<string>()
    const charge = (media = false): void => {
      const weight = Math.max(charged, byteWeights.get(frame) ?? 1, media ? 2 : 1)
      if (weight <= charged) return
      charged = weight
      options.onWeight?.(weight)
    }
    const bridge = connectDocumentFrame(frame, message => {
      if (disposed) return
      if (message.type === 'ready') {
        if (announced) return
        announced = true
        charge(message.payload.media === true)
        ready(frame, bridge)
      } else if (message.type === 'references' && embedded.bridge === bridge) {
        // The frame bridge validates the bounded candidate batch before dispatch.
        const candidates = message.payload.candidates as string[]
        const targets = options.resolveReferences?.(candidates) ?? []
        resolved = new Set(targets.map(target => target.candidate))
        bridge.command('references:resolved', { targets })
      } else if (['select', 'play', 'pause'].includes(message.type) && embedded.bridge === bridge && embedded.active) {
        const candidate = message.payload.candidate
        if (typeof candidate !== 'string' || !resolved.has(candidate)) return
        options.onReferenceIntent?.(message.type as 'select' | 'play' | 'pause', candidate)
      } else if (message.type === 'key' && embedded.bridge === bridge && embedded.active && typeof message.payload.key === 'string') {
        options.onDocumentKey?.(message.payload as unknown as DocumentKey)
      } else if (message.type === 'swipe' && embedded.bridge === bridge && embedded.active) {
        options.onDocumentSwipe?.(message.payload as unknown as SwipeSignal)
      } else if (message.type === 'media') {
        charge(true)
        if (embedded.bridge !== bridge || !embedded.active) bridge.command('pause')
        else pauseOtherPlayers(embedded)
      }
    })
    return frame
  }
  let iframe = createFrame((frame, bridge) => {
    if (!hasContent || initialLoadHandled || iframe !== frame) return
    initialLoadHandled = true
    embedded.bridge = bridge
    bridge.command('active', { active: embedded.active })
    failed = false
    veil.remove()
    onFrameLoad?.(frame, false)
    options.onState?.({ status: 'ready' })
  })
  let currentBridge = frameBridge(iframe)!
  wrap.append(iframe, veil)

  const stop = watchLiveFile(
    src,
    (html) => {
      if (disposed) return
      options.onThumbnailSource?.(html, recallText(src)?.etag)
      veil.classList.remove('kbn-fileview-loading-error')
      const withBase = htmlWithBase(html, src)
      const srcdoc = options.transformHtml?.(withBase) ?? withWorkspaceKeyBridge(withBase)
      const weight = new Blob([html]).size > 2 * 1024 * 1024 || /<(?:audio|video)\b/i.test(html) ? 2 : 1
      if (!hasContent) {
        hasContent = true
        byteWeights.set(iframe, weight)
        iframe.srcdoc = srcdoc
        return
      }

      stagingBridge?.dispose()
      stagingFrame?.remove()
      const currentGeneration = ++generation
      let loaded = false
      const next = createFrame((frame, bridge) => {
        if (loaded || currentGeneration !== generation) return
        loaded = true
        const position = initialLoadHandled ? currentBridge.position : undefined
        currentBridge.command('pause')
        currentBridge.dispose()
        currentBridge = bridge
        embedded.bridge = bridge
        bridge.command('active', { active: embedded.active })
        if (position) bridge.command('restore', position)
        iframe.replaceWith(frame)
        iframe = frame
        stagingFrame = null
        stagingBridge = null
        frame.style.cssText = ''
        const firstVisibleContent = !initialLoadHandled
        if (firstVisibleContent) { initialLoadHandled = true; veil.remove() }
        failed = false
        onFrameLoad?.(iframe, !firstVisibleContent)
        options.onState?.({ status: 'ready' })
      })
      next.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none'
      stagingFrame = next
      byteWeights.set(next, weight)
      stagingBridge = frameBridge(next) ?? null
      wrap.append(next)
      next.srcdoc = srcdoc
    },
    (error) => {
      if (disposed) return
      failed = true
      if (!hasContent) showLoadError(veil, wrap, fullPath, error)
      options.onState?.({ status: 'error', error, hasContent: initialLoadHandled })
    },
    {
      active: options.active, loadOnce: options.active === false,
      onRecover: () => {
        if (!disposed && failed && initialLoadHandled && !stagingFrame) {
          failed = false
          options.onState?.({ status: 'ready' })
        }
      },
    },
  )
  liveViewSubscriptions.set(wrap, stop)
  viewerDisposers.set(wrap, () => {
    disposed = true
    generation++
    stagingBridge?.dispose()
    stagingFrame?.remove()
    currentBridge.command('pause')
    currentBridge.dispose()
    embeddedPlayers.delete(embedded)
    embeddedMediaViewers.delete(wrap)
  })
  return wrap
}

/** A path-shaped owner route lets the browser resolve CSS, scripts and sibling images. */
export function htmlAssetUrl(src: string): string {
  const url = new URL(src, document.baseURI)
  const path = url.searchParams.get('path')
  if (!url.pathname.endsWith('/api/v1/file') || !path?.startsWith('/')) return url.href
  const owner = url.searchParams.get('origin') || 'local'
  url.pathname = url.pathname.slice(0, -'/file'.length) + `/file-assets/${encodeURIComponent(owner)}` + path.split('/').map(encodeURIComponent).join('/')
  url.search = ''
  return url.href
}

/** Srcdoc inherits its parent's URL, so install the byte-owning report's asset base. */
export function htmlWithBase(html: string, src: string): string {
  const asset = htmlAssetUrl(src)
  const declared = /<base\b[^>]*>/i.exec(html)
  if (declared) {
    const template = document.createElement('template')
    template.innerHTML = declared[0]
    const base = template.content.querySelector('base')!
    base.href = new URL(base.getAttribute('href') ?? '', asset).href
    return html.slice(0, declared.index) + base.outerHTML + html.slice(declared.index + declared[0].length)
  }
  const base = `<base href="${escapeHtml(asset)}">`
  const head = /<head\b[^>]*>/i
  if (head.test(html)) return html.replace(head, (match) => `${match}${base}`)
  const htmlTag = /<html\b[^>]*>/i
  if (htmlTag.test(html)) return html.replace(htmlTag, (match) => `${match}<head>${base}</head>`)
  const doctype = /<!doctype\b[^>]*>/i
  if (doctype.test(html)) return html.replace(doctype, (match) => `${match}${base}`)
  return `${base}${html}`
}

/**
 * Render a text deliverable into a scrolling pane, with the same loading veil
 * and error note the iframe path carries — a slow tunnel and a missing file
 * look identical whichever instrument draws the file, so they read identically
 * too. Content arrives through the shared conditional poller, which also
 * updates the rendered pane only when its body changes.
 */
function buildTextViewer(
  src: string,
  fullPath: string,
  ext: string,
  onReady?: (scroller: HTMLElement) => void,
  options: FileViewerOptions = {},
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-text-wrap'

  const veil = loadingVeil(fullPath, options)

  const pane = document.createElement('div')
  pane.className = 'kbn-fileview-text'
  pane.dataset.part = 'prose'
  wrap.append(pane, veil)

  let hasContent = false
  let failed = false
  const stop = watchLiveFile(
    src,
    (text) => {
      options.onThumbnailSource?.(text, recallText(src)?.etag)
      const scrollTop = hasContent ? wrap.scrollTop : 0
      if (MARKDOWN_EXTS.has(ext)) {
        pane.classList.add('kbn-detail-prose')
        pane.innerHTML = renderMarkdown(text)
      } else {
        pane.innerHTML =
          `<pre class="md-code-block language-${escapeHtml(ext || 'plaintext')}">` +
          `<code class="language-${escapeHtml(ext || 'plaintext')}">${escapeHtml(text)}</code></pre>`
      }
      if (options.decorateText && !MARKDOWN_EXTS.has(ext)) {
        const block = pane.querySelector('code')!
        const parts = text.split(/(`[^`\n]+`)/g)
        if (parts.length > 1) {
          block.replaceChildren(...parts.map((part, index) => {
            if (index % 2 === 0) return document.createTextNode(part)
            const code = document.createElement('code'); code.className = 'md-inline-code'
            code.textContent = part.slice(1, -1)
            return code
          }))
        }
      }
      options.decorateText?.(pane)
      wrap.scrollTop = scrollTop
      veil.remove()
      if (!hasContent) onReady?.(wrap)
      hasContent = true
      failed = false
      options.onState?.({ status: 'ready' })
    },
    (error) => {
      failed = true
      if (!hasContent) showLoadError(veil, wrap, fullPath, error)
      options.onState?.({ status: 'error', error, hasContent })
    },
    {
      active: options.active, loadOnce: options.active === false,
      onRecover: () => {
        if (failed && hasContent) {
          failed = false
          options.onState?.({ status: 'ready' })
        }
      },
    },
  )
  liveViewSubscriptions.set(wrap, stop)
  return wrap
}

/** The "Loading <file>…" veil every instrument shows until its file lands. */
function loadingVeil(fullPath: string, options: FileViewerOptions = {}): HTMLElement {
  const veil = document.createElement('div')
  veil.className = 'kbn-fileview-loading'
  veil.textContent = options.quietLoading ? '' : `Loading ${basename(fullPath)}…`
  if (options.quietLoading) veil.style.animation = 'none'
  return veil
}

/** Turn the veil into the failure note, whether or not it was already lifted. */
function showLoadFailure(veil: HTMLElement, wrap: HTMLElement, fullPath: string, detail: string): void {
  veil.classList.add('kbn-fileview-loading-error')
  veil.textContent = `Couldn't load ${basename(fullPath)} — ${detail}`
  if (!veil.isConnected) wrap.append(veil)
}

/** The failure note for a live-file poll error: the HTTP status when the
 *  daemon answered, otherwise that it could not be reached. */
function showLoadError(veil: HTMLElement, wrap: HTMLElement, fullPath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : ''
  const detail = message.startsWith('file request failed: ')
    ? message.slice('file request failed: '.length)
    : 'the daemon could not be reached'
  showLoadFailure(veil, wrap, fullPath, detail)
}

/** True when a deliverable scrolls — an iframe (HTML/PDF) or the text
 *  pane, both of which can carry a restorable scroll offset. Images and audio
 *  cannot. */
export function isScrollableFile(path: string): boolean {
  const ext = fileExt(path)
  return !IMAGE_EXTS.has(ext) && !AUDIO_EXTS.has(ext) && !VIDEO_EXTS.has(ext)
}
