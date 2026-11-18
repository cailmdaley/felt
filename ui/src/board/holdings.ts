import { postDaemonJson } from './daemonApi.js'
import { heldText } from './documentResources.js'
import { thumbnailCount } from './workspace/Thumbnail.js'
import { viewOfHash } from './workspace/route.js'

/**
 * A document the page keeps: its key, its DOM elements, its frames and their
 * `srcdoc` characters, the PDFs drawn in it (their bytes), and the pixels of
 * its canvases and images, in megapixels.
 */
export interface HeldDocument { key: string; state?: string; nodes: number; frames: number; chars: number; pdfBytes: number; canvases: number; megapixels: number }

/** What the board holds at one moment, read from the page as it stands. */
export interface Holdings {
  /** When this page loaded, epoch ms: a new value is a reload. */
  page: number
  route: string
  view: string | null
  visible: boolean
  nodes: number
  /** Every iframe in the page, wherever it sits. */
  frames: number
  previews: { thumbnails: number; frames: number; chars: number; images: number }
  reader: HeldDocument[]
  unfolded: HeldDocument[]
  images: { count: number; megapixels: number }
  cache: { chars: number; entries: number }
}

const megapixels = (images: Iterable<HTMLImageElement | HTMLCanvasElement>): number => {
  let pixels = 0
  for (const image of images) pixels += image instanceof HTMLImageElement ? image.naturalWidth * image.naturalHeight : image.width * image.height
  return Math.round(pixels / 1e4) / 100
}

function held(el: HTMLElement, key: string, state?: string): HeldDocument {
  const frames = [...el.getElementsByTagName('iframe')]
  const canvases = el.getElementsByTagName('canvas')
  return {
    key, ...state ? { state } : {},
    nodes: el.getElementsByTagName('*').length,
    frames: frames.length,
    chars: frames.reduce((sum, frame) => sum + (frame.getAttribute('srcdoc')?.length ?? 0), 0),
    pdfBytes: [...el.querySelectorAll<HTMLElement>('[data-pdf-bytes]')].reduce((sum, pdf) => sum + Number(pdf.dataset.pdfBytes), 0),
    canvases: canvases.length,
    megapixels: megapixels([...canvases, ...el.getElementsByTagName('img')]),
  }
}

const readerState = (page: Element): string =>
  page.classList.contains('ws-selected') ? 'selected' : page.classList.contains('ws-parked') ? 'parked' : 'receded'

/** Counts what the page holds; it keeps nothing between calls. */
export function holdings(): Holdings {
  const previewFrames = [...document.querySelectorAll<HTMLIFrameElement>('.ws-thumbnail iframe')]
  const images = [...document.images]
  return {
    page: Math.round(performance.timeOrigin),
    route: location.hash,
    view: viewOfHash(location.hash),
    visible: document.visibilityState === 'visible',
    nodes: document.getElementsByTagName('*').length,
    frames: document.getElementsByTagName('iframe').length,
    previews: {
      thumbnails: thumbnailCount(),
      frames: previewFrames.length,
      chars: previewFrames.reduce((sum, frame) => sum + (frame.getAttribute('srcdoc')?.length ?? 0), 0),
      images: document.querySelectorAll('.ws-thumbnail img').length,
    },
    reader: [...document.querySelectorAll<HTMLElement>('.ws-page')]
      .filter(page => page.querySelector('.ws-content > :not(.ws-placeholder)'))
      .map(page => held(page, page.dataset.key ?? '', readerState(page))),
    unfolded: [...document.querySelectorAll<HTMLElement>('.uf[data-unfolded] .uf-page')]
      .map(page => held(page, page.dataset.key ?? '')),
    images: { count: images.length, megapixels: megapixels(images) },
    cache: heldText(),
  }
}

/** Whether this page is the installed web app on the host whose daemon serves it. */
export function installedOnHost(): boolean {
  const installed = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  return installed && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
}

/**
 * Once a minute, while this page is the installed web app on its own host,
 * appends what it holds to the daemon's `board-holdings.jsonl`, beside the
 * page's sampled memory footprint.
 */
export function reportHoldings(shuttleBase: string): void {
  if (!installedOnHost()) return
  setInterval(() => { postDaemonJson(shuttleBase, '/api/v1/board/holdings', holdings()).catch(() => {}) }, 60_000)
}
