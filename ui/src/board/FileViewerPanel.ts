/**
 * Shared file renderer for sent-file tabs and the Shelf reader.
 *
 * Images and audio use native elements, markdown and text render in a scrolling
 * pane, HTML renders in a scrollable iframe, and browser-native formats such
 * as PDF stay in their own iframe. HTML, markdown, and text subscribe to the
 * shared conditional file poller; their DOM changes only when the body does.
 *
 * Every file URL uses the daemon's owner-routed `GET /api/v1/file` endpoint.
 */

import './FileViewerPanel.css'
import { watchLiveFile, type LiveFileSubscription } from './LiveFileRefresh.js'
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  MARKDOWN_EXTS,
  TEXT_EXTS,
  basename,
  escapeHtml,
  fileBytesUrl,
  fileExt,
  prepareIframeExternalLinks,
  renderMarkdown,
} from './utils.js'

/**
 * Render a deliverable into a fresh element by extension — the shared dispatch
 * the accordion mounts per open file. The iframe variant carries a loading veil
 * (a remote `report.html` can be multi-MB over a slow tunnel; a blank frame
 * reads as broken) that lifts on `load` and flips to an error note on `error`.
 *
 * `onFrameLoad` fires after each HTML document update — the accordion uses it
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
): HTMLElement {
  const ext = fileExt(fullPath)
  const src = fileBytesUrl(shuttleBase, fullPath, originId)

  if (IMAGE_EXTS.has(ext)) {
    // Mount the plate on a vellum mat so it reads as a mounted figure, centered
    // with breathing room, rather than a bitmap bled to the cell edge.
    const wrap = document.createElement('div')
    wrap.className = 'kbn-fileview-image-wrap'
    const img = document.createElement('img')
    img.className = 'kbn-fileview-image'
    img.src = src
    img.alt = basename(fullPath)
    wrap.append(img)
    return wrap
  }

  if (AUDIO_EXTS.has(ext)) {
    const wrap = document.createElement('div')
    wrap.className = 'kbn-fileview-audio'
    const audio = document.createElement('audio')
    audio.controls = true
    audio.src = src
    wrap.append(audio)
    return wrap
  }

  // TEXT. An iframe is the wrong instrument here: the daemon serves most text
  // suffixes as `application/octet-stream`, so the frame either downloads the
  // file or shows unwrapped monospace source with no reading comfort at all —
  // and a `.md` deliverable, the most common thing a worker sends, arrived as
  // raw markdown syntax. Fetching the bytes and rendering them in-page costs
  // one request and turns both into something readable: markdown through the
  // same `renderMarkdown` the fiber body uses, wearing the same
  // `.kbn-detail-prose` skin so a sent report looks like the fiber it came
  // from; anything else as a code block, reusing the `md-code-block` markup
  // the markdown renderer already emits for fenced code.
  if (TEXT_EXTS.has(ext)) {
    return buildTextViewer(src, fullPath, ext, onTextPane)
  }

  if (ext === 'html' || ext === 'htm') {
    return buildHtmlViewer(src, fullPath, onFrameLoad)
  }

  // Non-live iframe deliverables (PDF and opaque browser-native formats).
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-frame-wrap'

  const veil = document.createElement('div')
  veil.className = 'kbn-fileview-loading'
  veil.textContent = `Loading ${basename(fullPath)}…`

  const iframe = document.createElement('iframe')
  iframe.className = 'kbn-fileview-frame'
  iframe.src = src
  iframe.title = basename(fullPath)
  wrap.append(iframe, veil)

  /** Show the failure, whether or not `load` already lifted the veil. */
  const failed = (detail: string): void => {
    veil.classList.add('kbn-fileview-loading-error')
    veil.textContent = `Couldn't load ${basename(fullPath)} — ${detail}`
    if (!veil.isConnected) wrap.append(veil)
  }

  iframe.addEventListener('load', () => {
    // The 404 document loads too, and it loads AFTER the probe has usually
    // answered. Lifting the veil unconditionally here would erase the error the
    // probe just wrote — which is the original blank frame, reintroduced from
    // the other direction. Only a frame nobody has faulted gets revealed.
    if (veil.classList.contains('kbn-fileview-loading-error')) return
    veil.remove()
    prepareIframeExternalLinks(iframe)
    onFrameLoad?.(iframe, false)
  })
  // `error` on an iframe fires for NETWORK failures only. An HTTP 404 is a
  // perfectly successful navigation to an error document, so `load` fires, the
  // veil lifts, and the reader is left looking at an empty frame with nothing
  // saying why. That was the whole defect: the file viewer's one failure mode
  // rendered as a blank rectangle.
  iframe.addEventListener('error', () => failed('the daemon could not be reached'))

  // So ASK. A HEAD settles what the iframe's own events cannot tell us apart.
  // Ordering is not a race: `failed` re-attaches the veil if `load` already
  // removed it, so whichever resolves second still tells the truth.
  void fetch(src, { method: 'HEAD' })
    .then((res) => {
      if (!res.ok) failed(`${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
    })
    .catch(() => failed('the daemon could not be reached'))

  return wrap
}

const liveViewSubscriptions = new WeakMap<HTMLElement, LiveFileSubscription>()

/** Stop the shared poll when its viewer tab closes. */
export function disposeFileViewer(viewer: HTMLElement | null): void {
  if (!viewer) return
  liveViewSubscriptions.get(viewer)?.()
  liveViewSubscriptions.delete(viewer)
}

/** Pause a hidden reader tab without tearing down its viewer DOM. */
export function suspendFileViewer(viewer: HTMLElement | null): void {
  if (viewer) liveViewSubscriptions.get(viewer)?.suspend()
}

/** Resume a reader tab and revalidate its file while retaining its DOM. */
export function resumeFileViewer(viewer: HTMLElement | null): void {
  if (viewer) void liveViewSubscriptions.get(viewer)?.resume()
}

function buildHtmlViewer(
  src: string,
  fullPath: string,
  onFrameLoad?: (iframe: HTMLIFrameElement, refreshed: boolean) => void,
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-frame-wrap'

  const veil = document.createElement('div')
  veil.className = 'kbn-fileview-loading'
  veil.textContent = `Loading ${basename(fullPath)}…`

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
    if (!hasContent || initialLoadHandled || iframe !== initialFrame) return
    initialLoadHandled = true
    veil.remove()
    prepareIframeExternalLinks(initialFrame)
    onFrameLoad?.(initialFrame, false)
  })

  const stop = watchLiveFile(
    src,
    (html) => {
      veil.classList.remove('kbn-fileview-loading-error')
      const srcdoc = htmlWithBase(html, src)
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
        if (loaded || currentGeneration !== generation) return
        loaded = true
        prepareIframeExternalLinks(next)
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
        onFrameLoad?.(iframe, !firstVisibleContent)
      })
      wrap.append(next)
      next.srcdoc = srcdoc
    },
    (error) => {
      if (!hasContent) showLoadError(veil, wrap, fullPath, error)
    },
  )
  liveViewSubscriptions.set(wrap, stop)
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
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-text-wrap'

  const veil = document.createElement('div')
  veil.className = 'kbn-fileview-loading'
  veil.textContent = `Loading ${basename(fullPath)}…`

  const pane = document.createElement('div')
  pane.className = 'kbn-fileview-text'
  wrap.append(pane, veil)

  let hasContent = false
  const stop = watchLiveFile(
    src,
    (text) => {
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
    },
    (error) => {
      if (!hasContent) showLoadError(veil, wrap, fullPath, error)
    },
  )
  liveViewSubscriptions.set(wrap, stop)
  return wrap
}

function showLoadError(veil: HTMLElement, wrap: HTMLElement, fullPath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : ''
  const detail = message.startsWith('file request failed: ')
    ? message.slice('file request failed: '.length)
    : 'the daemon could not be reached'
  veil.classList.add('kbn-fileview-loading-error')
  veil.textContent = `Couldn't load ${basename(fullPath)} — ${detail}`
  if (!veil.isConnected) wrap.append(veil)
}

/** True when a deliverable scrolls — an iframe (HTML/PDF) or the text
 *  pane, both of which can carry a restorable scroll offset. Images and audio
 *  cannot. */
export function isScrollableFile(path: string): boolean {
  const ext = fileExt(path)
  return !IMAGE_EXTS.has(ext) && !AUDIO_EXTS.has(ext)
}
