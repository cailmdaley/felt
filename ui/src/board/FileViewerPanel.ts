/**
 * Shared renderer for document workspace pages and their thumbnails.
 *
 * Images and audio use native elements, markdown and text render in a scrolling
 * pane, HTML renders in a scrollable iframe (a page that declares itself a
 * public page elsewhere, at that page's address: `remotePage`), and PDF uses
 * the lazy PDF.js viewer. HTML, markdown, and text subscribe to the
 * shared conditional file poller; their DOM changes only when the body does.
 *
 * Native elements stream owner-routed `GET /api/v1/file` by URL; every other
 * read of a document's content, existence or metadata goes through the
 * document cache (`documentResources`). HTML pages and thumbnails resolve
 * relative resources against `/api/v1/file-assets/:origin/*path`.
 */

import './FileViewerPanel.css'
import './prose.css'
import { mediaTime } from '../sdk/civilDay.js'
import { remotePage, remotePageFrame } from '../sdk/remotePage.js'
import { thumbnailPreviews } from './workspace/thumbnailPreview.js'
import { watchLiveFile, type LiveFileSubscription } from './LiveFileRefresh.js'
import type { ReferenceTarget } from './workspace/ChannelReferences.js'
import { fileKind } from './attachments.js'
import { getDaemonJson, postDaemonJson } from './daemonApi.js'
import { drawChangeList, type ChangePRListing } from './workspace/changeList.js'
import { forgetText, head, peek, recallText, RESOURCE_PRIORITY, text as documentText, type Head, type ResourcePriority } from './documentResources.js'
import { loadDuration } from './workspace/audioWaveform.js'
import { carryReading, connectDocumentFrame, frameBridge, DOCUMENT_SANDBOX, withWorkspaceKeyBridge, type DocumentKey, type FrameBridge } from './workspace/DocumentBridge.js'
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
  kind?: 'html' | 'text' | 'image' | 'pdf' | 'audio' | 'video' | 'other' | 'change'
  /** The document host binds this to its fiber, not to the currently selected page. */
  onReview?: (message: string) => Promise<void>
  canReview?: () => boolean
  reviewTarget?: () => string
  /** The directory a change story's relative links resolve against; default the bundle's own. */
  basePath?: string
  /**
   * A constitution whose change its owner bakes on open, and the PRs it
   * follows; the path is then the fiber's own (see `buildBakedChange`).
   */
  bake?: { uid: string; prs: number[] }
  /** Inert previews use the same kind dispatch within their host's load budget. */
  thumbnail?: boolean
  /** Captioned previews keep the filename outside the miniature page. */
  thumbnailLabel?: boolean
  /** A preview larger than a thumbnail keeps a page's large embedded images rather than placeholders. */
  keepMedia?: boolean
  /** Inactive viewers read once for a preview, without periodic subscriptions. */
  active?: boolean
  /**
   * Draw an HTML page at its full height, its viewport units pinned to the
   * board's, so it scrolls with its host instead of in a frame of its own.
   */
  fit?: boolean
  /** Transform HTML after its base URL is installed, before srcdoc assignment. */
  transformHtml?: (html: string) => string
  onDocumentKey?: (key: DocumentKey) => void
  onNavigate?: (href: string) => void
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
 * (a remote `tapestry.html` can be multi-MB over a slow tunnel; a blank frame
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
  const kind = options.kind ?? (/\.change\.json$/i.test(fullPath) ? 'change' : classified === 'markdown' ? 'text' : classified)
  if (options.bake) return buildBakedChange(shuttleBase, options.bake, fullPath, originId, onTextPane, options)
  if (options.thumbnail) return buildThumbnail(src, fullPath, kind, options)

  if (kind === 'change') {
    const basePath = options.basePath ?? fullPath.slice(0, fullPath.lastIndexOf('/'))
    const wrap = document.createElement('div')
    wrap.className = 'kbn-fileview-change'
    let dispose: (() => void) | undefined
    let releaseHighlighter: (() => Promise<void>) | undefined
    let disposed = false, generation = 0
    let scroller: HTMLElement | undefined
    const failed = (error: unknown): void => {
      if (disposed) return
      if (scroller) {
        options.onState?.({ status: 'error', error, hasContent: true })
        return
      }
      const message = document.createElement('div'); message.className = 'change-load-error'; message.setAttribute('role', 'alert')
      message.textContent = `Could not load ${basename(fullPath)}: ${error instanceof Error ? error.message : 'Invalid change bundle'}`
      wrap.replaceChildren(message)
      options.onState?.({ status: 'error', error, hasContent: false })
    }
    const stop = watchLiveFile(src, source => {
      const revision = ++generation
      void Promise.all([import('./workspace/ChangeReader.js'), import('./workspace/changeValidation.js'), import('./workspace/changeModel.js')]).then(([{ mountChangeReader, releaseChangeHighlighter }, { parseChangeBundle }, { changeIdentity }]) => {
        if (disposed || revision !== generation) return
        releaseHighlighter = releaseChangeHighlighter
        const bundle = parseChangeBundle(source)
        const digest = changeIdentity(source)
        dispose?.(); wrap.replaceChildren()
        const mounted = mountChangeReader(wrap, bundle, `${originId}:${fullPath}`, digest, options.onReview, options.canReview, options.reviewTarget, { basePath, originId })
        dispose = mounted.dispose; scroller = mounted.scroller
        options.onThumbnailSource?.(source, recallText(src)?.etag)
        onTextPane?.(scroller)
        options.onState?.({ status: 'ready' })
      }).catch(error => { if (revision === generation) failed(error) })
    }, failed, {
      active: options.active,
      loadOnce: options.active === false,
      onRecover: () => {
        if (!disposed && scroller) options.onState?.({ status: 'ready' })
      },
    })
    liveViewSubscriptions.set(wrap, stop)
    viewerDisposers.set(wrap, () => {
      disposed = true
      stop()
      dispose?.()
      dispose = undefined
      scroller = undefined
      forgetText(src)
      void releaseHighlighter?.()
    })
    return wrap
  }

  if (kind === 'image') {
    // Mount the plate on a vellum mat so it reads as a mounted figure, centered
    // with breathing room, rather than a bitmap bled to the cell edge.
    const wrap = document.createElement('div')
    wrap.className = 'kbn-fileview-image-wrap'
    const img = document.createElement('img')
    img.className = 'kbn-fileview-image'
    img.decoding = 'sync'
    // WebKit can reuse a thumbnail-sized decoded representation when the
    // strip and reader load one image URL at different sizes. Keep the reader
    // request's cache key distinct so its intrinsic dimensions come from the
    // full image. The file endpoint ignores this presentation-only parameter.
    img.src = `${src}&presentation=stage`
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
    return buildTextViewer(src, fullPath, originId, ext, onTextPane, options)
  }

  if (kind === 'html') {
    return buildHtmlViewer(shuttleBase, src, fullPath, originId, onFrameLoad, options)
  }

  // PDF.js renders within the board's stage so the first page can fit the pane
  // even in embedded WebKit, whose native PDF plugin ignores fit-view fragments.
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-frame-wrap'

  const veil = loadingVeil(fullPath, options)
  let disposed = false
  let faulted = false
  const controller = new AbortController()
  let pdfDispose: (() => void) | null = null
  const stage = document.createElement('div')
  stage.className = 'kbn-fileview-pdf-stage'
  stage.setAttribute('role', 'region')
  stage.setAttribute('aria-label', `PDF: ${basename(fullPath)}`)
  wrap.append(stage, veil)

  const failed = (detail: string): void => {
    if (disposed) return
    faulted = true
    showLoadFailure(veil, wrap, fullPath, detail)
    options.onState?.({ status: 'error', error: new Error(`file request failed: ${detail}`), hasContent: false })
  }
  void fetch(src, { cache: 'no-cache', signal: controller.signal }).then(async response => {
    if (!response.ok) throw new Error(response.status === 404 ? '404 Not Found' : `${response.status} ${response.statusText}`)
    const payload = await response.arrayBuffer()
    const prefix = new Uint8Array(payload, 0, Math.min(payload.byteLength, 5))
    const signature = String.fromCharCode(...prefix)
    if (controller.signal.aborted || disposed) return
    if (payload.byteLength < 5 || signature !== '%PDF-') {
      throw new Error('response is not a PDF')
    }
    options.onWeight?.(payload.byteLength > 2 * 1024 * 1024 ? 2 : 1)
    const { mountPdfViewer } = await import('./pdfViewer')
    if (disposed) return
    const mounted = mountPdfViewer(stage, payload, () => {
      if (disposed || faulted) return
      veil.remove()
      options.onState?.({ status: 'ready' })
    }, error => failed(error))
    pdfDispose = mounted.dispose
    if (disposed) pdfDispose()
    await mounted.ready
  }).catch(error => {
    if (controller.signal.aborted || disposed) return
    failed(error instanceof Error ? error.message : 'the daemon could not be reached')
  })
  viewerDisposers.set(wrap, () => {
    disposed = true
    controller.abort()
    pdfDispose?.()
  })

  return wrap
}

type MediaState = { media: HTMLMediaElement; active: boolean; inline: boolean }
const mediaViewers = new WeakMap<HTMLElement, MediaState>()
const players = new Set<HTMLMediaElement>()
type EmbeddedMediaState = { active: boolean; bridge: FrameBridge | null; shown(active: boolean): void }
const embeddedMediaViewers = new WeakMap<HTMLElement, EmbeddedMediaState>()
const embeddedPlayers = new Set<EmbeddedMediaState>()
/**
 * Each HTML document runs in one frame at a time. Its viewers, by its URL:
 * the one shown holds the frame, and a hidden one holds it only while no
 * other viewer does. A remote page runs only while shown, since the board
 * cannot reach into it to pause it.
 */
type DocumentHolder = { readonly active: boolean; readonly live: boolean; release(): void; restore(): void }
const documentHolders = new Map<string, Set<DocumentHolder>>()
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
  kindMark.textContent = { audio: '♪', video: '▹', pdf: '▧', other: '□', image: '▨', html: '▣', text: '≡', change: '±' }[kind]
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
  } else if (kind === 'pdf') {
    // A PDF's title and glyph need no browser plugin or document navigation.
    if (options.onThumbnailSource) void readThumbnailMetadata(src, controller.signal, options.onThumbnailSource)
    queueMicrotask(() => finish(true))
  } else if (kind === 'html') {
    const frame = document.createElement('iframe')
    frame.title = basename(path)
    frame.inert = true
    frame.tabIndex = -1
    frame.setAttribute('scrolling', 'no')
    frame.addEventListener('error', () => finish(false), { once: true })
    // The page's own text, from the cache the reader shares, drawn without scripts.
    frame.setAttribute('sandbox', '')
    frame.allow = "autoplay 'none'"
    void documentText(src, RESOURCE_PRIORITY.thumbnail, { signal: controller.signal }).then(body => {
      if (disposed) return
      if (!body) { finish(false); return }
      options.onThumbnailSource?.(body.text, body.etag)
      // A page declared remote is not loaded for a preview: its card names it and its site.
      const remote = remotePage(body.text, [location.href, src])
      if (remote) {
        wrap.className = 'kbn-fileview-thumbnail kbn-thumbnail-remote'
        duration.textContent = new URL(remote).host
        finish(true)
        return
      }
      // An empty frame has already loaded about:blank; only the page's own load counts.
      frame.addEventListener('load', () => finish(true), { once: true })
      frame.srcdoc = htmlWithBase(thumbnailPreviews.get(src, body.text, body.etag, options.keepMedia), src)
      wrap.append(frame)
    })
  } else if (kind === 'audio') {
    // A recording is its face: the title and the duration its peek declares, with no media element.
    void peek(src, RESOURCE_PRIORITY.thumbnail, { signal: controller.signal }).then(first => {
      if (disposed) return
      if (!first) { finish(false); return }
      options.onThumbnailSource?.(first.bytes, first.etag)
      finish(true)
      void loadDuration(src, controller.signal).then(seconds => {
        if (seconds !== null && !disposed) duration.textContent = mediaTime(seconds)
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
      if (Number.isFinite(media.duration)) duration.textContent = mediaTime(media.duration)
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
    for (const image of wrap.querySelectorAll('img')) image.removeAttribute('src')
    for (const frame of wrap.querySelectorAll('iframe')) { frame.removeAttribute('srcdoc'); frame.removeAttribute('src'); frame.remove() }
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

/** The PR each list-opening Change page has open, by owner and fiber, so a rebuild re-bakes it. */
const openPRs = new Map<string, number>()

/**
 * A constitution's change, baked on open: ask the fiber's owner to bake it
 * (`POST /fibers/<uid>/change`), then read the bundle the bake names through
 * `/file` in the ordinary change viewer. A story's relative links resolve
 * beside the fiber, where the story lives. A failed bake is a line in the
 * page, not a viewer error. A constitution that follows two or more PRs opens
 * on their list instead (`GET /changes/<uid>`), each row baking its PR.
 */
function buildBakedChange(
  shuttleBase: string,
  bake: { uid: string; prs: number[] },
  fiberPath: string,
  originId: string,
  onTextPane?: (scroller: HTMLElement) => void,
  options: FileViewerOptions = {},
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-change'
  const uid = encodeURIComponent(bake.uid)
  const route = `/api/v1/fibers/${uid}/change`
  let viewer: HTMLElement | null = null
  let disposed = false
  let generation = 0
  // The page shows its own progress and failures, so its host only ever sees it ready.
  const ready = (): void => options.onState?.({ status: 'ready' })
  ready()
  const note = (text: string): HTMLElement => {
    const node = document.createElement('div')
    node.className = 'change-bake-note'
    node.textContent = text
    return node
  }
  const bakeInto = (slot: HTMLElement, pr?: number): void => {
    const at = ++generation
    disposeFileViewer(viewer)
    viewer = null
    slot.replaceChildren(note('Baking…'))
    postDaemonJson<{ path: string }>(shuttleBase, route, pr === undefined ? { origin: originId } : { origin: originId, pr }, 'Bake failed')
      .then(({ path }) => {
        if (disposed || at !== generation) return
        viewer = buildFileViewer(shuttleBase, path, originId, undefined, onTextPane, {
          ...options, kind: 'change', bake: undefined, basePath: fiberPath.slice(0, fiberPath.lastIndexOf('/')), onState: ready,
        })
        slot.replaceChildren(viewer)
      })
      .catch((error: unknown) => {
        if (disposed || at !== generation) return
        const failed = note(`Could not bake this change: ${error instanceof Error ? error.message : String(error)}`)
        failed.setAttribute('role', 'alert')
        slot.replaceChildren(failed)
      })
  }
  if (bake.prs.length < 2) bakeInto(wrap)
  else {
    const place = `${originId}:${bake.uid}`
    const query = new URLSearchParams({ origin: originId })
    drawChangeList(wrap, {
      prs: bake.prs,
      listings: getDaemonJson<{ prs: ChangePRListing[] }>(`${shuttleBase}/api/v1/changes/${uid}?${query}`, 'Could not list the PRs').then(answer => answer.prs),
      opened: openPRs.get(place),
      open: bakeInto,
      moved: pr => {
        // A disposed page's late list answer leaves the page that replaced it alone.
        if (disposed) return
        if (pr === undefined) {
          generation++
          disposeFileViewer(viewer)
          viewer = null
          openPRs.delete(place)
        } else openPRs.set(place, pr)
      },
    })
  }
  bindDrawnPage(wrap, {
    suspend: () => suspendFileViewer(viewer),
    resume: () => resumeFileViewer(viewer),
    dispose: () => { disposed = true; disposeFileViewer(viewer) },
  })
  return wrap
}

const liveViewSubscriptions = new WeakMap<HTMLElement, LiveFileSubscription>()
const viewerDisposers = new WeakMap<HTMLElement, () => void>()
/** A board-drawn page's share of the lifecycle its frame gives every viewer. */
export interface DrawnPageLife { suspend(): void; resume(): void; dispose(): void }
const drawnPages = new WeakMap<HTMLElement, DrawnPageLife>()
export function bindDrawnPage(viewer: HTMLElement, life: DrawnPageLife): void { drawnPages.set(viewer, life) }

/** Stop the shared poll when its viewer tab closes. */
export function disposeFileViewer(viewer: HTMLElement | null): void {
  if (!viewer) return
  drawnPages.get(viewer)?.dispose()
  drawnPages.delete(viewer)
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
    drawnPages.get(viewer)?.suspend()
    liveViewSubscriptions.get(viewer)?.suspend()
    const state = mediaViewers.get(viewer)
    if (state) { state.active = false; state.inline = false; state.media.pause() }
    const embedded = embeddedMediaViewers.get(viewer)
    if (embedded) { embedded.active = false; embedded.bridge?.command('active', { active: false }); embedded.shown(false) }
  }
}

/** Resume a reader tab and revalidate its file while retaining its DOM. */
export function resumeFileViewer(viewer: HTMLElement | null): void {
  if (viewer) {
    drawnPages.get(viewer)?.resume()
    void liveViewSubscriptions.get(viewer)?.resume()
    const state = mediaViewers.get(viewer)
    if (state) state.active = true
    const embedded = embeddedMediaViewers.get(viewer)
    if (embedded) { embedded.active = true; embedded.bridge?.command('active', { active: true }); embedded.shown(true) }
  }
}

/** Finish an inactive preview's initial read without activating its subscription. */
export function loadFileViewerOnce(viewer: HTMLElement | null): void {
  if (viewer) void liveViewSubscriptions.get(viewer)?.loadOnce()
}

function buildHtmlViewer(
  shuttleBase: string,
  src: string,
  fullPath: string,
  originId: string,
  onFrameLoad?: (iframe: HTMLIFrameElement, refreshed: boolean) => void,
  options: FileViewerOptions = {},
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-frame-wrap'
  const embedded: EmbeddedMediaState = { active: options.active !== false, bridge: null, shown: () => {} }
  embeddedMediaViewers.set(wrap, embedded)
  embeddedPlayers.add(embedded)
  const veil = loadingVeil(fullPath, options)
  const pdfLayer = document.createElement('div')
  pdfLayer.className = 'kbn-fileview-embedded-pdfs'
  pdfLayer.setAttribute('aria-label', 'Embedded PDFs')
  type EmbeddedPdf = { element: HTMLElement; controller: AbortController; dispose?: () => void; src: string }
  const pdfs = new Map<string, EmbeddedPdf>()
  const pdfWeights = new Map<string, number>()
  let htmlWeight = 1
  let publishedWeight = 0
  const publishWeight = (): void => {
    const weight = htmlWeight + [...pdfWeights.values()].reduce((sum, item) => sum + item, 0)
    if (weight === publishedWeight) return
    publishedWeight = weight
    options.onWeight?.(weight)
  }
  let disposed = false
  let failed = false
  let hasContent = false
  let initialLoadHandled = false
  let generation = 0
  let stagingFrame: HTMLIFrameElement | null = null
  let stagingBridge: FrameBridge | null = null
  const byteWeights = new WeakMap<HTMLIFrameElement, number>()
  const frameWeights = new WeakMap<HTMLIFrameElement, number>()
  const createFrame = (ready: (frame: HTMLIFrameElement, bridge: FrameBridge) => void): HTMLIFrameElement => {
    const frame = document.createElement('iframe')
    frame.className = 'kbn-fileview-frame'
    frame.title = basename(fullPath)
    frame.setAttribute('sandbox', DOCUMENT_SANDBOX)
    frame.allowFullscreen = true
    let announced = false
    let charged = 0
    let resolved = new Set<string>()
    const charge = (media = false): void => {
      const weight = Math.max(charged, byteWeights.get(frame) ?? 1, media ? 2 : 1)
      if (weight <= charged) return
      charged = weight
      frameWeights.set(frame, charged)
      if (frame === iframe) { htmlWeight = weight; publishWeight() }
    }
    const bridge = connectDocumentFrame(frame, message => {
      if (disposed) return
      if (message.type === 'pdf:layout' && frame === iframe) {
        const entries = message.payload.items as { id: string; src: string; x: number; y: number; width: number; height: number }[]
        const live = new Set(entries.map(item => item.id))
        for (const [id, pdf] of pdfs) if (!live.has(id)) {
          pdf.controller.abort(); pdf.dispose?.(); pdf.element.remove(); pdfs.delete(id)
          pdfWeights.delete(id)
        }
        publishWeight()
        const frameBox = frame.getBoundingClientRect(), layerBox = pdfLayer.getBoundingClientRect()
        const scaleX = frameBox.width / Math.max(1, frame.clientWidth), scaleY = frameBox.height / Math.max(1, frame.clientHeight)
        for (const entry of entries) {
          let pdf = pdfs.get(entry.id)
          const bytesUrl = embeddedPdfBytesUrl(shuttleBase, src, originId, entry.src)
          if (!bytesUrl) continue
          if (pdf && pdf.src !== bytesUrl) {
            pdf.controller.abort(); pdf.dispose?.(); pdf.element.remove(); pdfs.delete(entry.id); pdf = undefined
            pdfWeights.delete(entry.id)
            publishWeight()
          }
          if (!pdf) {
            const pdfId = entry.id
            const element = document.createElement('div')
            element.className = 'kbn-fileview-embedded-pdf'
            const controller = new AbortController()
            pdf = { element, controller, src: bytesUrl }
            pdfs.set(entry.id, pdf)
            pdfLayer.append(element)
            void fetch(bytesUrl, { cache: 'no-cache', signal: controller.signal }).then(async response => {
              if (!response.ok) throw new Error(response.status === 404 ? '404 Not Found' : `${response.status} ${response.statusText}`)
              const bytes = await response.arrayBuffer()
              if (controller.signal.aborted || disposed) return
              if (bytes.byteLength < 5 || String.fromCharCode(...new Uint8Array(bytes, 0, 5)) !== '%PDF-') throw new Error('response is not a PDF')
              pdfWeights.set(pdfId, bytes.byteLength > 2 * 1024 * 1024 ? 2 : 1)
              publishWeight()
              const { mountPdfViewer } = await import('./pdfViewer')
              if (controller.signal.aborted || disposed) return
              const mounted = mountPdfViewer(element, bytes, () => {}, error => {
                if (!controller.signal.aborted) element.textContent = `Could not render embedded PDF: ${error}`
              })
              pdf!.dispose = mounted.dispose
              await mounted.ready
            }).catch(error => {
              if (!controller.signal.aborted && !disposed) element.textContent = `Could not load embedded PDF: ${error instanceof Error ? error.message : 'request failed'}`
            })
          }
          const left = frameBox.left - layerBox.left + entry.x * scaleX + pdfLayer.scrollLeft
          const top = frameBox.top - layerBox.top + entry.y * scaleY + pdfLayer.scrollTop
          Object.assign(pdf.element.style, { left: `${left}px`, top: `${top}px`, width: `${entry.width * scaleX}px`, height: `${entry.height * scaleY}px` })
        }
      } else if (message.type === 'height' && options.fit && frame === iframe) {
        fit(message.payload.height as number)
        // The page grown or shrunk to its rewrite's height: its reader returns beside their passage, unless they have scrolled since.
        if (carried && carried.scroller.scrollTop === carried.at) carried.scroller.scrollTop = carried.top
        carried = null
      } else if (message.type === 'reveal' && options.fit && frame === iframe) {
        // The board's own scroller carries a fitted page: bring the fragment's
        // offset to its top, as the page would have scrolled itself.
        const mark = document.createElement('div')
        // The margin keeps the passage clear of a bar pinned over the top of the scroll.
        mark.style.cssText = `position:absolute;left:0;top:${message.payload.top as number}px;width:1px;height:1px;pointer-events:none;scroll-margin-top:48px`
        wrap.append(mark)
        mark.scrollIntoView({ block: 'start' })
        mark.remove()
      } else if (message.type === 'ready') {
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
      } else if (message.type === 'navigate' && embedded.bridge === bridge && embedded.active) {
        options.onNavigate?.(message.payload.href as string)
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
  // A page whose height follows its frame's (a script sizing itself by the window)
  // grows by the same step on every report; it keeps the height it had.
  let fitted = 0, step = 0, coupled = false
  /** Where a fitted page's scroller stands after a rewrite, once the rewrite has its height. */
  let carried: { scroller: HTMLElement; top: number; at: number } | null = null
  const fit = (height: number): void => {
    if (coupled) return
    // A viewport-sized page (e.g. a 16:9 deck with height: 100%) fills the wrap's CSS min-height;
    // leaving style.height unset lets CSS keep tracking width changes cleanly in both directions.
    if (!wrap.style.height && height <= Math.ceil(wrap.getBoundingClientRect().height)) return
    if (height > fitted && fitted && height - fitted === step) { coupled = true; return }
    step = height - fitted
    fitted = height
    wrap.style.height = `${height}px`
  }
  /** The first page a served frame shows, ready: the veil lifts and the host binds to it. */
  const firstReady = (frame: HTMLIFrameElement, bridge: FrameBridge): void => {
    if (!hasContent || initialLoadHandled || iframe !== frame) return
    initialLoadHandled = true
    embedded.bridge = bridge
    if (options.fit) bridge.command('fit')
    bridge.command('active', { active: embedded.active })
    bridge.command('pdf:scan')
    failed = false
    veil.remove()
    onFrameLoad?.(frame, false)
    options.onState?.({ status: 'ready' })
  }
  // The served frame joins the wrap with the first page it shows.
  let iframe = createFrame(firstReady)
  let currentBridge = frameBridge(iframe)!
  wrap.append(pdfLayer, veil)
  /** A page declared remote, framed as itself in the served frame's place. */
  let remote: { url: string; frame: HTMLIFrameElement } | null = null
  /** The page as last read, shown again when this viewer takes the document back. */
  let latest: string | null = null
  const holders = documentHolders.get(src) ?? documentHolders.set(src, new Set()).get(src)!
  const holder: DocumentHolder = {
    get active() { return embedded.active },
    get live() { return !!remote || iframe.parentNode === wrap },
    release: () => { dropServed(); remote?.frame.remove(); remote = null },
    restore: () => { if (latest !== null) show(latest) },
  }
  holders.add(holder)
  /** A viewer of the document still shown that another took it from. */
  const heir = (): DocumentHolder | undefined => [...holders].find(other => other !== holder && other.active && !other.live)
  embedded.shown = active => {
    if (active) { if (!holder.live) holder.restore(); return }
    if (!holder.live) return
    // Hidden, it gives the document back to a viewer still shown, and keeps no remote page.
    const next = heir()
    if (next || remote) holder.release()
    next?.restore()
  }
  /** The served frame and whatever was staged for it leave; a fresh one waits, unattached, for the next page. */
  const dropServed = (): void => {
    generation++
    stagingBridge?.dispose()
    stagingFrame?.remove()
    stagingFrame = null
    stagingBridge = null
    for (const pdf of pdfs.values()) { pdf.controller.abort(); pdf.dispose?.(); pdf.element.remove() }
    pdfs.clear()
    pdfWeights.clear()
    if (iframe.parentNode === wrap) {
      currentBridge.command('pause')
      currentBridge.dispose()
      iframe.remove()
      iframe = createFrame(firstReady)
      currentBridge = frameBridge(iframe)!
    }
    embedded.bridge = null
    hasContent = false
    initialLoadHandled = false
  }
  const showRemote = (url: string): void => {
    if (remote?.url === url) return
    dropServed()
    remote?.frame.remove()
    const frame = remotePageFrame(url, basename(fullPath))
    frame.className = 'kbn-fileview-frame'
    remote = { url, frame }
    frame.addEventListener('load', () => {
      if (disposed || remote?.frame !== frame) return
      initialLoadHandled = true
      failed = false
      veil.remove()
      onFrameLoad?.(frame, false)
      options.onState?.({ status: 'ready' })
    }, { once: true })
    wrap.prepend(frame)
  }

  const show = (html: string): void => {
    options.onThumbnailSource?.(html, recallText(src)?.etag)
    veil.classList.remove('kbn-fileview-loading-error')
    latest = html
    const url = remotePage(html, [location.href, src])
    // Hidden, it waits while another viewer runs the document, and runs no remote page.
    if (!embedded.active && (url || [...holders].some(other => other !== holder && other.live))) { holder.release(); return }
    for (const other of holders) if (other !== holder) other.release()
    if (url) { showRemote(url); return }
    if (remote) { remote.frame.remove(); remote = null; initialLoadHandled = false }
    const withBase = htmlWithBase(html, src)
    const srcdoc = options.transformHtml?.(withBase) ?? withWorkspaceKeyBridge(options.fit ? pinViewportUnits(withBase, window.innerHeight) : withBase)
    const weight = pageWeight(html)
    if (!hasContent) {
      hasContent = true
      byteWeights.set(iframe, weight)
      wrap.prepend(iframe)
      iframe.srcdoc = srcdoc
      return
    }

    stagingBridge?.dispose()
    stagingFrame?.remove()
    // The page on show measures where its passages stand, for the rewrite to keep the reader beside theirs.
    currentBridge.command('anchors')
    const currentGeneration = ++generation
    let loaded = false
    const next = createFrame((frame, bridge) => {
      if (loaded || currentGeneration !== generation) return
      loaded = true
      const position = initialLoadHandled ? currentBridge.position : undefined
      // The reader stays beside the passage they were reading, whatever the rewrite changed around it.
      const before = currentBridge.anchors
      const scroller = options.fit && initialLoadHandled ? scrollingAncestor(wrap) : null
      if (scroller) {
        const y = scroller.getBoundingClientRect().top - wrap.getBoundingClientRect().top
        const top = scroller.scrollTop + carryReading(before, bridge.anchors, y) - y
        carried = y > 0 && top !== scroller.scrollTop ? { scroller, top, at: 0 } : null
      }
      currentBridge.command('pause')
      currentBridge.dispose()
      for (const pdf of pdfs.values()) { pdf.controller.abort(); pdf.dispose?.(); pdf.element.remove() }
      pdfs.clear()
      pdfWeights.clear()
      currentBridge = bridge
      embedded.bridge = bridge
      bridge.command('active', { active: embedded.active })
      if (options.fit) bridge.command('fit')
      // The staged page has loaded at the size it will show at: a shorter one clamps.
      if (position) bridge.command('restore', { x: position.x, y: carryReading(before, bridge.anchors, position.y), clamp: true })
      // Moving a frame reloads its document, so the staged frame already sits
      // where it will stay and the swap only removes its predecessor.
      iframe.remove()
      iframe = frame
      if (carried) { carried.scroller.scrollTop = carried.top; carried.at = carried.scroller.scrollTop }
      htmlWeight = frameWeights.get(frame) ?? byteWeights.get(frame) ?? 1
      publishWeight()
      bridge.command('pdf:scan')
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
    iframe.before(next)
    next.srcdoc = srcdoc
  }

  const stop = watchLiveFile(
    src,
    html => { if (!disposed) show(html) },
    (error) => {
      if (disposed) return
      failed = true
      if (!hasContent && !remote) showLoadError(veil, wrap, fullPath, error)
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
    remote?.frame.remove()
    for (const pdf of pdfs.values()) { pdf.controller.abort(); pdf.dispose?.() }
    pdfs.clear()
    embeddedPlayers.delete(embedded)
    embeddedMediaViewers.delete(wrap)
    holders.delete(holder)
    if (!holders.size) documentHolders.delete(src)
    else if (holder.live) heir()?.restore()
  })
  return wrap
}

/** The element that scrolls a fitted page with the rest of its host. */
function scrollingAncestor(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (at.scrollHeight > at.clientHeight && /auto|scroll/.test(getComputedStyle(at).overflowY)) return at
  }
  return document.scrollingElement as HTMLElement | null
}

/** Only fetch PDFs inside the current host's file-assets namespace. */
function embeddedPdfBytesUrl(base: string, htmlSrc: string, owner: string, raw: string): string | undefined {
  try {
    const assetBase = new URL(htmlAssetUrl(htmlSrc), document.baseURI)
    const target = new URL(raw, assetBase)
    const prefix = `/api/v1/file-assets/${encodeURIComponent(owner)}/`
    if (target.origin !== assetBase.origin || !target.pathname.startsWith(prefix) || !/\.pdf$/i.test(target.pathname)) return undefined
    const relative = target.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    if (!relative || relative.split('/').some(part => part === '.' || part === '..')) return undefined
    return fileBytesUrl(base, `/${relative}`, owner)
  } catch { return undefined }
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
  // The first cascade layer and zero specificity keep report-authored styles in charge.
  const mediaStyle = '<style data-shuttle-media-fit>@layer shuttle-media-fit { :where(img, svg, video, canvas) { max-width: 100%; height: auto; } }</style>'
  if (!html.includes('data-shuttle-media-fit')) {
    const head = /<head\b[^>]*>/i
    const htmlTag = /<html\b[^>]*>/i
    const doctype = /<!doctype\b[^>]*>/i
    if (head.test(html)) html = html.replace(head, match => `${match}${mediaStyle}`)
    else if (htmlTag.test(html)) html = html.replace(htmlTag, match => `${match}<head>${mediaStyle}</head>`)
    else if (doctype.test(html)) html = html.replace(doctype, match => `${match}${mediaStyle}`)
    else html = `${mediaStyle}${html}`
  }
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
  originId: string,
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
        // A leading YAML frontmatter block (a fiber's), opening on a `key:` line, is the file's metadata, not its prose.
        pane.innerHTML = renderMarkdown(text.replace(/^---\r?\n[\w-]+:[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, ''), { basePath: fullPath.slice(0, fullPath.lastIndexOf('/')) || '/', originId })
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

/**
 * Rewrites a page's viewport-height units, in its style sheets and style
 * attributes, as pixels of a viewport `height` tall, so a page drawn at its
 * full height keeps the proportions it has on a screen.
 */
export function pinViewportUnits(html: string, height: number): string {
  const pin = (css: string): string => css.replace(/(-?(?:\d+\.?\d*|\.\d+))[sdl]?vh\b/g, (_, n: string) => `${+(Number(n) * height / 100).toFixed(2)}px`)
  return html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open: string, css: string, close: string) => open + pin(css) + close)
    .replace(/(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi, (_, attr: string, quote: string, css: string) => attr + quote + pin(css) + quote)
}

/**
 * How many of the reader's live-document slots a page costs. A slot is about
 * one ordinary page; every ten images or embedded documents cost another,
 * since WebKit keeps each decoded (an SVG figure is a document of its own),
 * so a report with a hundred figures fills the budget by itself. A page past
 * 2 MB or one with audio or video costs at least two.
 */
export function pageWeight(html: string): number {
  const media = html.match(/<(?:img|iframe|object|embed)\b/gi)?.length ?? 0
  const heavy = new Blob([html]).size > 2 * 1024 * 1024 || /<(?:audio|video)\b/i.test(html) ? 1 : 0
  return Math.min(10, 1 + heavy + Math.floor(media / 10))
}
