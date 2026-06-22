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
 * <iframe>. The accordion mounts these directly.
 *
 * Bytes resolve through the daemon's owner-routed `GET /api/v1/file` route
 * (utils.fileBytesUrl) — HTML served as `text/html` is natively iframe-
 * scrollable, so there's no `standalone` height-handshake. (The retired
 * Portolan `:4004` `/project-file/…?standalone=1` route, with its ⤓ save /
 * ↗ open-in-workspace affordances, is gone — there's no file workspace in the
 * standalone UI.)
 */

import './FileViewerPanel.css'
import { fileBytesUrl, paperUrl } from './utils.js'

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])
export const AUDIO_EXTS = new Set(['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac'])

/**
 * The byte-source URL for a deliverable. An `astra.yaml` renders as the full
 * Lightcone paper (the paper entry bakes the project dir, owner-routed by
 * origin) rather than raw YAML — the same treatment a `:::{embed} astra.yaml`
 * gets in a fiber body; it falls back to the raw bytes if the dir can't
 * resolve. Everything else streams from `/api/v1/file`.
 */
export function fileViewerSrc(shuttleBase: string, fullPath: string, originId: string): string {
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
 * uses it to restore scroll position on a persistence rehydrate. Non-iframe
 * viewers (img/audio) never call it.
 */
export function buildFileViewer(
  shuttleBase: string,
  fullPath: string,
  originId: string,
  onFrameLoad?: (iframe: HTMLIFrameElement) => void,
): HTMLElement {
  const ext = extOf(fullPath)
  const src = fileViewerSrc(shuttleBase, fullPath, originId)

  if (IMAGE_EXTS.has(ext)) {
    // Mount the plate on a vellum mat so it reads as a mounted figure, centered
    // with breathing room, rather than a bitmap bled to the cell edge.
    const wrap = document.createElement('div')
    wrap.className = 'kbn-fileview-image-wrap'
    const img = document.createElement('img')
    img.className = 'kbn-fileview-image'
    img.src = src
    img.alt = basenameOf(fullPath)
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

  // HTML (and any iframe-rendered) deliverable.
  const wrap = document.createElement('div')
  wrap.className = 'kbn-fileview-frame-wrap'

  const veil = document.createElement('div')
  veil.className = 'kbn-fileview-loading'
  veil.textContent = `Loading ${basenameOf(fullPath)}…`

  const iframe = document.createElement('iframe')
  iframe.className = 'kbn-fileview-frame'
  iframe.src = src
  iframe.title = basenameOf(fullPath)
  iframe.addEventListener('load', () => {
    veil.remove()
    onFrameLoad?.(iframe)
  })
  iframe.addEventListener('error', () => {
    veil.classList.add('kbn-fileview-loading-error')
    veil.textContent = `Couldn't load ${basenameOf(fullPath)}`
  })

  wrap.append(iframe, veil)
  return wrap
}

export function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function extOf(path: string): string {
  const base = basenameOf(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function isAstraYaml(path: string): boolean {
  return basenameOf(path) === 'astra.yaml'
}

/** True when a deliverable scrolls inside an iframe (HTML/PDF/text/paper) and
 *  so can carry a restorable scroll offset. Images and audio cannot. */
export function isScrollableFile(path: string): boolean {
  const ext = extOf(path)
  return !IMAGE_EXTS.has(ext) && !AUDIO_EXTS.has(ext)
}
