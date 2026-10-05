/**
 * Shared renderer for document workspace pages and Board overview thumbnails.
 *
 * Images and audio use native elements, markdown and text render in a scrolling
 * pane, HTML renders in a scrollable iframe, and browser-native formats such
 * as PDF stay in their own iframe. HTML, markdown, and text subscribe to the
 * shared conditional file poller; their DOM changes only when the body does.
 *
 * Every file URL uses the daemon's owner-routed `GET /api/v1/file` endpoint.
 */

import './FileViewerPanel.css'
import './prose.css'
import { watchLiveFile, type LiveFileSubscription } from './LiveFileRefresh.js'
import { fileKind } from './attachments.js'
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  VIDEO_EXTS,
  MARKDOWN_EXTS,
  basename,
  escapeHtml,
  fileBytesUrl,
  fileExt,
  fileInfoUrl,
  prepareIframeExternalLinks,
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
  /** Inactive viewers read once for a preview, without periodic subscriptions. */
  active?: boolean
  /** Transform HTML after its base URL is installed, before srcdoc assignment. */
  transformHtml?: (html: string) => string
  onState?: (state: FileViewerState) => void
  /** Declared metadata shares the inert preview's source read. */
  onThumbnailSource?: (source: string | Uint8Array, etag?: string) => void
  /** Paint paper until load rather than a loading message. */
  quietLoading?: boolean
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
    const controller = new AbortController()
    img.addEventListener('load', () => {
      if (!disposed) options.onState?.({ status: 'ready' })
    })
    img.addEventListener('error', () => {
      void fetch(src, { method: 'HEAD', signal: controller.signal }).then((res) => {
        if (!disposed) options.onState?.({ status: 'error', error: new Error(`file request failed: ${res.status}`), hasContent: false })
      }).catch((error: unknown) => {
        if (!disposed) options.onState?.({ status: 'error', error, hasContent: false })
      })
    })
    viewerDisposers.set(wrap, () => { disposed = true; controller.abort() })
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
  iframe.src = src
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
    prepareIframeExternalLinks(iframe)
    onFrameLoad?.(iframe, false)
    ready()
  })
  // `error` on an iframe fires for NETWORK failures only. An HTTP 404 is a
  // perfectly successful navigation to an error document, so `load` fires, the
  // veil lifts, and the reader would be left looking at an empty frame with
  // nothing saying why.
  iframe.addEventListener('error', () => failed('the daemon could not be reached'))

  // So ASK. A HEAD settles what the iframe's own events cannot tell us apart.
  // Ordering is not a race: `failed` re-attaches the veil if `load` already
  // removed it, so whichever resolves second still tells the truth.
  void fetch(src, { method: 'HEAD', signal: controller.signal })
    .then((res) => {
      checked = true
      if (!res.ok) failed(`${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
      else ready()
    })
    .catch(() => failed('the daemon could not be reached'))
  viewerDisposers.set(wrap, () => { disposed = true; controller.abort() })

  return wrap
}

type MediaState = { media: HTMLMediaElement; active: boolean }
const mediaViewers = new WeakMap<HTMLElement, MediaState>()
const players = new Set<HTMLMediaElement>()
type EmbeddedMediaState = { active: boolean; players: Set<HTMLMediaElement>; unbind: () => void }
const embeddedMediaViewers = new WeakMap<HTMLElement, EmbeddedMediaState>()

function bindEmbeddedMedia(wrap: HTMLElement, iframe: HTMLIFrameElement): void {
  const state = embeddedMediaViewers.get(wrap)
  if (!state) return
  state.unbind()
  for (const media of state.players) { media.pause(); players.delete(media) }
  state.players.clear()
  try {
    const content = iframe.contentDocument
    if (!content) return
    const play = (event: Event): void => {
      const media = event.target as HTMLMediaElement
      if (!['AUDIO', 'VIDEO'].includes(media.tagName)) return
      state.players.add(media)
      players.add(media)
      if (!state.active) { media.pause(); return }
      for (const other of players) if (other !== media) other.pause()
    }
    content.addEventListener('play', play, true)
    for (const media of content.querySelectorAll<HTMLMediaElement>('audio,video')) {
      state.players.add(media)
      players.add(media)
      if (!state.active) media.pause()
      else if (!media.paused) for (const other of players) if (other !== media) other.pause()
    }
    state.unbind = () => content.removeEventListener('play', play, true)
  } catch { /* Cross-origin frames keep their browser-owned controls. */ }
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
  const state: MediaState = { media, active: options.active !== false }
  mediaViewers.set(wrap, state)
  players.add(media)
  media.addEventListener('play', () => {
    if (!state.active) { media.pause(); return }
    for (const other of players) if (other !== media) other.pause()
  })
  media.addEventListener('loadedmetadata', () => options.onState?.({ status: 'ready' }))
  let disposed = false
  const controller = new AbortController()
  media.addEventListener('error', () => {
    // The metadata probe distinguishes a missing resource from a codec failure.
    void fetch(src, { method: 'HEAD', signal: controller.signal }).then(res => {
      if (!disposed) options.onState?.({ status: 'error', error: new Error(res.ok ? 'media format is not supported by this browser' : `file request failed: ${res.status}`), hasContent: false })
    }).catch(error => { if (!disposed) options.onState?.({ status: 'error', error, hasContent: false }) })
  })
  page.append(media)
  wrap.append(page)
  media.src = src
  viewerDisposers.set(wrap, () => {
    disposed = true
    controller.abort()
    media.pause()
    players.delete(media)
    mediaViewers.delete(wrap)
    media.removeAttribute('src')
    media.load()
  })
  return wrap
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
  const controller = new AbortController()
  viewerDisposers.set(box, () => controller.abort())
  void fetch(fileInfoUrl(base, path, owner), { signal: controller.signal, cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error(`file request failed: ${response.status}`)
    const info = await response.json() as { exists?: boolean; size?: number }
    if (controller.signal.aborted) return
    if (!info.exists) throw new Error('file request failed: 404')
    if (typeof info.size === 'number' && Number.isFinite(info.size)) detail.textContent = `Not drawn here · ${info.size.toLocaleString()} bytes`
    options.onState?.({ status: 'ready' })
  }).catch(error => { if (!controller.signal.aborted) options.onState?.({ status: 'error', error, hasContent: false }) })
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
  const name = document.createElement('span'); name.className = 'kbn-thumbnail-name'; name.textContent = basename(path)
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
    if (kind === 'html') {
      frame.setAttribute('sandbox', '')
      frame.allow = "autoplay 'none'"
    }
    // Native PDF viewers need their plugin; the host makes the whole slot inert.
    const loaded = (): void => {
      if (kind === 'html' && !frame.hasAttribute('srcdoc')) return
      frame.removeEventListener('load', loaded)
      if (kind === 'html') finish(true)
      else void fetch(src, { method: 'HEAD', signal: controller.signal }).then(res => finish(res.ok)).catch(() => finish(false))
    }
    frame.addEventListener('load', loaded)
    frame.addEventListener('error', () => finish(false), { once: true })
    if (kind === 'html') {
      void fetch(src, { signal: controller.signal }).then(async res => {
        if (!res.ok) throw new Error('Thumbnail unavailable')
        const source = await res.text()
        if (disposed) return
        options.onThumbnailSource?.(source, res.headers.get('ETag') ?? undefined)
        frame.srcdoc = htmlWithBase(source, src)
      }).catch(() => finish(false))
    } else {
      frame.src = `${src}#page=1&view=FitH&toolbar=0`
      if (options.onThumbnailSource) void readThumbnailMetadata(src, controller.signal, options.onThumbnailSource)
    }
    wrap.append(frame)
  } else if (kind === 'audio' || kind === 'video') {
    const media = document.createElement(kind)
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
    if (kind === 'audio' && options.onThumbnailSource) void readThumbnailMetadata(src, controller.signal, options.onThumbnailSource)
    wrap.append(media)
  } else if (kind === 'text') {
    void fetch(src, { signal: controller.signal }).then(async res => {
      if (!res.ok) throw new Error('Thumbnail unavailable')
      const source = await res.text()
      if (disposed) return
      options.onThumbnailSource?.(source, res.headers.get('ETag') ?? undefined)
      const pre = document.createElement('pre')
      pre.inert = true
      pre.textContent = source.slice(0, 12000)
      wrap.append(pre)
      finish(true)
    }).catch(() => finish(false))
  } else queueMicrotask(() => finish(true))
  viewerDisposers.set(wrap, () => {
    disposed = true
    controller.abort()
    if (native) { native.pause(); native.removeAttribute('src'); native.load() }
  })
  return wrap
}

/** Native viewers own their byte streams; metadata peeks stop after the first 64 KiB even if Range is ignored. */
async function readThumbnailMetadata(src: string, signal: AbortSignal, onSource: NonNullable<FileViewerOptions['onThumbnailSource']>): Promise<void> {
  try {
    const response = await fetch(src, { signal, headers: { Range: 'bytes=0-65535' } })
    if (!response.ok || !response.body) return
    const reader = response.body.getReader()
    const bytes = new Uint8Array(65536)
    let length = 0
    try {
      while (length < bytes.length) {
        const chunk = await reader.read()
        if (chunk.done) break
        const part = chunk.value.subarray(0, bytes.length - length)
        bytes.set(part, length); length += part.length
      }
    } finally { await reader.cancel() }
    onSource(bytes.subarray(0, length), response.headers.get('ETag') ?? undefined)
  } catch { /* Native playback and preview do not depend on metadata. */ }
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

/** Pause a hidden reader tab without tearing down its viewer DOM. */
export function suspendFileViewer(viewer: HTMLElement | null): void {
  if (viewer) {
    liveViewSubscriptions.get(viewer)?.suspend()
    const state = mediaViewers.get(viewer)
    if (state) { state.active = false; state.media.pause() }
    const embedded = embeddedMediaViewers.get(viewer)
    if (embedded) { embedded.active = false; for (const media of embedded.players) media.pause() }
  }
}

/** Resume a reader tab and revalidate its file while retaining its DOM. */
export function resumeFileViewer(viewer: HTMLElement | null): void {
  if (viewer) {
    void liveViewSubscriptions.get(viewer)?.resume()
    const state = mediaViewers.get(viewer)
    if (state) state.active = true
    const embedded = embeddedMediaViewers.get(viewer)
    if (embedded) embedded.active = true
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
  const embedded: EmbeddedMediaState = { active: options.active !== false, players: new Set(), unbind: () => {} }
  embeddedMediaViewers.set(wrap, embedded)

  const veil = loadingVeil(fullPath, options)
  let disposed = false
  let failed = false

  let iframe = document.createElement('iframe')
  iframe.className = 'kbn-fileview-frame'
  iframe.title = basename(fullPath)
  wrap.append(iframe, veil)

  let hasContent = false
  let initialLoadHandled = false
  let generation = 0
  let stagingFrame: HTMLIFrameElement | null = null
  const initialFrame = iframe
  initialFrame.addEventListener('load', () => {
    if (disposed || !hasContent || initialLoadHandled || iframe !== initialFrame) return
    initialLoadHandled = true
    failed = false
    veil.remove()
    prepareIframeExternalLinks(initialFrame)
    bindEmbeddedMedia(wrap, initialFrame)
    onFrameLoad?.(initialFrame, false)
    options.onState?.({ status: 'ready' })
  })

  const stop = watchLiveFile(
    src,
    (html) => {
      if (disposed) return
      options.onThumbnailSource?.(html)
      veil.classList.remove('kbn-fileview-loading-error')
      const withBase = htmlWithBase(html, src)
      const srcdoc = options.transformHtml?.(withBase) ?? withBase
      if (!hasContent) {
        hasContent = true
        iframe.srcdoc = srcdoc
        return
      }

      stagingFrame?.remove()
      const next = document.createElement('iframe')
      next.className = 'kbn-fileview-frame'
      next.title = basename(fullPath)
      next.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;visibility:hidden'
      stagingFrame = next
      const currentGeneration = ++generation
      let loaded = false
      next.addEventListener('load', () => {
        if (disposed || loaded || currentGeneration !== generation) return
        loaded = true
        prepareIframeExternalLinks(next)
        bindEmbeddedMedia(wrap, next)
        const panelScroll = wrap.parentElement?.scrollTop ?? 0
        try {
          next.contentWindow?.scrollTo(0, iframe.contentWindow?.scrollY ?? 0)
        } catch {
          if (wrap.parentElement) wrap.parentElement.scrollTop = panelScroll
        }
        iframe.replaceWith(next)
        iframe = next
        stagingFrame = null
        next.style.cssText = ''
        const firstVisibleContent = !initialLoadHandled
        if (firstVisibleContent) {
          initialLoadHandled = true
          veil.remove()
        }
        failed = false
        onFrameLoad?.(iframe, !firstVisibleContent)
        options.onState?.({ status: 'ready' })
      })
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
    stagingFrame?.remove()
    embedded.unbind()
    for (const media of embedded.players) { media.pause(); players.delete(media) }
    embeddedMediaViewers.delete(wrap)
  })
  return wrap
}

/** Give a srcdoc document the same base URL its direct `/file` navigation had. */
export function htmlWithBase(html: string, src: string): string {
  if (/<base\b/i.test(html)) return html
  const base = `<base href="${escapeHtml(new URL(src, document.baseURI).href)}">`
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
  wrap.append(pane, veil)

  let hasContent = false
  let failed = false
  const stop = watchLiveFile(
    src,
    (text) => {
      options.onThumbnailSource?.(text)
      const scrollTop = hasContent ? wrap.scrollTop : 0
      if (MARKDOWN_EXTS.has(ext)) {
        pane.classList.add('kbn-detail-prose')
        pane.innerHTML = renderMarkdown(text)
      } else {
        pane.innerHTML =
          `<pre class="md-code-block language-${escapeHtml(ext || 'plaintext')}">` +
          `<code class="language-${escapeHtml(ext || 'plaintext')}">${escapeHtml(text)}</code></pre>`
      }
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
