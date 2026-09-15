/**
 * FileViewerPanel — sent-deliverable rendering, by extension.
 *
 * Historically this was a *separate* floating overlay opened beside the fiber
 * panel (the split-view seed). The two-column file viewer (board-chrome-
 * redesign) absorbed that role into FiberDetailModal's integrated right-column
 * accordion, so the floating panel is retired. What survives — and is the
 * point of this module — is the by-extension rendering dispatch, factored into
 * the exported `buildFileViewer`: images get an <img>, audio an <audio
 * controls>, everything else (HTML / PDF / text / `astra.yaml`-as-paper) an
 * <iframe>. The accordion mounts these directly. The extension VOCABULARY the
 * dispatch keys off lives in utils.js, shared with the `:::{embed}` renderer;
 * what is owned here is the DOM construction for each kind.
 *
 * Bytes resolve through the daemon's owner-routed `GET /api/v1/file` route
 * (utils.fileBytesUrl) — HTML served as `text/html` is natively iframe-
 * scrollable, so there's no `standalone` height-handshake. (The retired
 * Portolan `:4004` `/project-file/…?standalone=1` route, with its ⤓ save /
 * ↗ open-in-workspace affordances, is gone — there's no file workspace in the
 * standalone UI.)
 */

import './FileViewerPanel.css'
import {
  AUDIO_EXTS,
  IMAGE_EXTS,
  MARKDOWN_EXTS,
  TEXT_EXTS,
  basename,
  escapeHtml,
  fileBytesUrl,
  fileExt,
  isAstraYaml,
  paperUrl,
  prepareIframeExternalLinks,
  renderMarkdown,
} from './utils.js'

/**
 * The byte-source URL for a deliverable. An `astra.yaml` renders as the full
 * Lightcone paper (the paper entry bakes the project dir, owner-routed by
 * origin) rather than raw YAML — the same treatment a `:::{embed} astra.yaml`
 * gets in a fiber body; it falls back to the raw bytes if the dir can't
 * resolve. Everything else streams from `/api/v1/file`.
 */
function fileViewerSrc(shuttleBase: string, fullPath: string, originId: string): string {
  if (isAstraYaml(fullPath)) {
    return paperUrl(fullPath, { originId }) ?? fileBytesUrl(shuttleBase, fullPath, originId)
  }
  return fileBytesUrl(shuttleBase, fullPath, originId)
}

/**
 * Render a deliverable into a fresh element by extension — the shared dispatch
 * the accordion mounts per open file. The iframe variant carries a loading veil
 * (a remote `report.html` can be multi-MB over a slow tunnel; a blank frame
 * reads as broken) that lifts on `load` and flips to an error note on `error`.
 *
 * `onFrameLoad` fires once the iframe's document has loaded — the accordion
 * uses it to restore scroll position on a persistence rehydrate. `onTextPane`
 * is its twin for the self-rendered text pane, which has no document and so no
 * `load`: it fires with the element that scrolls, once the text is in it. A
 * text deliverable is as scrollable as an HTML one, so it keeps its reading
 * position the same way. Image and audio viewers call neither.
 */
export function buildFileViewer(
  shuttleBase: string,
  fullPath: string,
  originId: string,
  onFrameLoad?: (iframe: HTMLIFrameElement) => void,
  onTextPane?: (scroller: HTMLElement) => void,
): HTMLElement {
  const ext = fileExt(fullPath)
  const src = fileViewerSrc(shuttleBase, fullPath, originId)

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
  if (TEXT_EXTS.has(ext) && !isAstraYaml(fullPath)) {
    return buildTextViewer(src, fullPath, ext, onTextPane)
  }

  // HTML (and any iframe-rendered) deliverable.
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
    onFrameLoad?.(iframe)
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

/**
 * Render a text deliverable into a scrolling pane, with the same loading veil
 * and error note the iframe path carries — a slow tunnel and a missing file
 * look identical whichever instrument draws the file, so they read identically
 * too. The fetch is the only thing that differs: `res.ok` settles here what a
 * HEAD probe has to settle for an iframe.
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

  const failed = (detail: string): void => {
    veil.classList.add('kbn-fileview-loading-error')
    veil.textContent = `Couldn't load ${basename(fullPath)} — ${detail}`
    if (!veil.isConnected) wrap.append(veil)
  }

  void fetch(src)
    .then(async (res) => {
      if (!res.ok) {
        failed(`${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
        return
      }
      const text = await res.text()
      if (MARKDOWN_EXTS.has(ext)) {
        pane.classList.add('kbn-detail-prose')
        pane.innerHTML = renderMarkdown(text)
      } else {
        pane.innerHTML =
          `<pre class="md-code-block language-${escapeHtml(ext || 'plaintext')}">` +
          `<code class="language-${escapeHtml(ext || 'plaintext')}">${escapeHtml(text)}</code></pre>`
      }
      veil.remove()
      onReady?.(wrap)
    })
    .catch(() => failed('the daemon could not be reached'))

  return wrap
}

/** True when a deliverable scrolls — an iframe (HTML/PDF/paper) or the text
 *  pane, both of which can carry a restorable scroll offset. Images and audio
 *  cannot. */
export function isScrollableFile(path: string): boolean {
  const ext = fileExt(path)
  return !IMAGE_EXTS.has(ext) && !AUDIO_EXTS.has(ext)
}
