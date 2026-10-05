/**
 * Images pasted or dropped into the fiber page's composer.
 *
 * The composer holds them as chips until a send. Then {@link uploadPastedImages}
 * writes them to the daemon that owns the fiber (`POST /api/v1/attachments`,
 * owner-routed by `origin`), and {@link composeDirective} appends one
 * `[Image: <path>]` line per image to the typed text, so the worker on that
 * host opens each one by path.
 *
 * {@link buildImageStrip} draws the chips; everything else is plain state and
 * requests. The limits mirror `Shuttle.Attachments` on the daemon, which checks
 * them again.
 */

import type { KanbanCard } from './KanbanTypes.js'
import { errorMessageFromResponse } from './KanbanModalShared.js'

/** The image types a composer accepts, and the daemon stores. */
export const PASTED_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** The largest single image, in bytes. */
export const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024
/** The most images one send carries. */
export const MAX_PASTED_IMAGES = 8
/** The largest total one send carries, in bytes. */
export const MAX_PASTED_TOTAL_BYTES = 25 * 1024 * 1024

const MB = 1024 * 1024
const TYPE_WORDS = 'PNG, JPEG, GIF or WebP'

/** The parts of a `File` the composer reads; a plain `Blob` has no name. */
export type ImageSource = Blob & { name?: string }

/** One image waiting in the composer. */
export interface PastedImage {
  /** Stable within one composer, for removal. */
  readonly id: number
  readonly blob: ImageSource
  readonly name: string
  readonly mime: string
  readonly size: number
}

/** One stored image, as the owning daemon answers it. */
export interface StoredImage {
  name: string
  path: string
  sha256: string
  size: number
}

/** Whole megabytes exactly; anything else rounded up to a tenth, so a size
 *  just over a limit never reads as equal to it. */
function megabytes(bytes: number): string {
  const mb = bytes / MB
  return Number.isInteger(mb) ? `${mb} MB` : `${(Math.ceil(mb * 10) / 10).toFixed(1)} MB`
}

/**
 * The composer's images, in the order they arrived. {@link add} admits what
 * fits the limits and says what it turned away.
 */
export class PastedImages {
  private items: PastedImage[] = []
  private nextId = 1

  get list(): readonly PastedImage[] {
    return this.items
  }

  get size(): number {
    return this.items.length
  }

  get totalBytes(): number {
    return this.items.reduce((sum, item) => sum + item.size, 0)
  }

  /**
   * Admit each image that fits, in order. Returns the sentence naming what
   * was turned away and why, or null when everything was admitted.
   */
  add(blobs: Iterable<ImageSource>): string | null {
    const refused: string[] = []
    for (const blob of blobs) {
      const name = blob.name?.trim() || `image ${this.nextId}`
      const reason = this.refusal(blob)
      if (reason) {
        refused.push(`${name} ${reason}`)
        continue
      }
      this.items.push({ id: this.nextId++, blob, name, mime: blob.type, size: blob.size })
    }
    return refused.length ? `Not added: ${refused.join('; ')}.` : null
  }

  remove(id: number): void {
    this.items = this.items.filter((item) => item.id !== id)
  }

  clear(): void {
    this.items = []
  }

  private refusal(blob: ImageSource): string | null {
    if (!PASTED_IMAGE_TYPES.includes(blob.type)) return `is not a ${TYPE_WORDS} image`
    if (blob.size === 0) return 'is empty'
    if (blob.size > MAX_PASTED_IMAGE_BYTES)
      return `is ${megabytes(blob.size)}; the limit is ${megabytes(MAX_PASTED_IMAGE_BYTES)} per image`
    if (this.items.length >= MAX_PASTED_IMAGES) return `would exceed ${MAX_PASTED_IMAGES} images per send`
    if (this.totalBytes + blob.size > MAX_PASTED_TOTAL_BYTES)
      return `would bring the send past ${megabytes(MAX_PASTED_TOTAL_BYTES)}`
    return null
  }
}

/**
 * The images a paste should attach, or none. A clipboard that carries
 * non-empty `text/plain` is a text paste, even when an image rides along (an
 * office app puts a rendered PNG beside the copied text): the caller lets the
 * default paste happen and attaches nothing.
 */
export function pastedImageFiles(
  clipboard: Pick<DataTransfer, 'files' | 'items' | 'getData'> | null,
): File[] {
  if (!clipboard) return []
  if (clipboard.getData('text/plain').trim()) return []
  return filesFromTransfer(clipboard)
}

/** The files a paste or drop carries, or none. */
export function filesFromTransfer(transfer: Pick<DataTransfer, 'files' | 'items'> | null): File[] {
  if (!transfer) return []
  const fromFiles = Array.from(transfer.files ?? [])
  if (fromFiles.length) return fromFiles
  // Some browsers expose a pasted bitmap only as an item.
  return Array.from(transfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

/** Whether a drag carries files at all (its contents are hidden until drop). */
export function transferHasFiles(transfer: Pick<DataTransfer, 'types'> | null): boolean {
  return Array.from(transfer?.types ?? []).includes('Files')
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Base64 of `bytes`, chunked so a 10 MB image does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

async function encode(image: PastedImage): Promise<Record<string, string>> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Image upload needs the board on https or localhost.')
  const buffer = await image.blob.arrayBuffer()
  const digest = await subtle.digest('SHA-256', buffer)
  return {
    name: image.name,
    mime: image.mime,
    data: bytesToBase64(new Uint8Array(buffer)),
    sha256: hex(digest),
  }
}

/**
 * Store `images` on the daemon that owns `card`'s fiber and return their
 * absolute paths there, in order. Throws an `Error` whose message is the
 * daemon's own (or the network's) when anything fails; nothing is half-sent,
 * because the daemon writes a batch all or nothing.
 */
export async function uploadPastedImages(
  shuttleBase: string,
  card: Pick<KanbanCard, 'id' | 'originId'>,
  images: readonly PastedImage[],
): Promise<string[]> {
  if (!images.length) return []
  const attachments = await Promise.all(images.map(encode))
  let res: Response
  try {
    res = await fetch(`${shuttleBase}/api/v1/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fiber: card.id, origin: card.originId, attachments }),
    })
  } catch (err: unknown) {
    const detail = (err as { message?: string })?.message ?? String(err)
    throw new Error(`Couldn't upload images: ${detail}`)
  }
  if (!res.ok) {
    throw new Error(`Couldn't upload images: ${await errorMessageFromResponse(res, 'Upload failed')}`)
  }
  const body = (await res.json().catch(() => ({}))) as { files?: StoredImage[] }
  const paths = (body.files ?? []).map((file) => file?.path).filter((p): p is string => typeof p === 'string')
  if (paths.length !== images.length) throw new Error("Couldn't upload images: the daemon's answer named no paths.")
  return paths
}

/** The directive a worker receives: the typed text, then one line per image. */
export function composeDirective(text: string, paths: readonly string[]): string {
  const lines = paths.map((path) => `[Image: ${path}]`)
  return [text.trim(), ...lines].filter(Boolean).join('\n')
}

/**
 * The composer's chip strip: a thumbnail per image with a remove control,
 * hidden while there are none. `paint` redraws it from `images`; each
 * thumbnail's object URL lives as long as its chip, and `dispose` releases
 * them all when the panel closes. `setFrozen` disables removal while a send
 * is in flight.
 */
export function buildImageStrip(images: PastedImages): {
  el: HTMLElement
  paint: () => void
  setFrozen: (frozen: boolean) => void
  dispose: () => void
} {
  const el = document.createElement('div')
  el.className = 'kbn-ctl-images'
  const urls = new Map<number, string>()
  let frozen = false
  let disposed = false

  const paint = (): void => {
    // A closed panel's strip draws nothing more, so it mints no new URLs.
    if (disposed) return
    const live = new Set(images.list.map((image) => image.id))
    for (const [id, url] of urls) {
      if (!live.has(id)) {
        URL.revokeObjectURL(url)
        urls.delete(id)
      }
    }
    el.replaceChildren(
      ...images.list.map((image) => {
        let url = urls.get(image.id)
        if (!url) {
          url = URL.createObjectURL(image.blob)
          urls.set(image.id, url)
        }
        const chip = document.createElement('span')
        chip.className = 'kbn-ctl-image'
        chip.title = `${image.name} · ${megabytes(image.size)}`
        const thumb = document.createElement('img')
        thumb.src = url
        thumb.alt = image.name
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'kbn-ctl-image-remove'
        remove.textContent = '×'
        remove.setAttribute('aria-label', `Remove ${image.name}`)
        remove.disabled = frozen
        remove.addEventListener('click', (e) => {
          e.stopPropagation()
          images.remove(image.id)
          paint()
        })
        chip.append(thumb, remove)
        return chip
      }),
    )
    el.hidden = images.size === 0
  }

  const setFrozen = (on: boolean): void => {
    frozen = on
    el.classList.toggle('kbn-ctl-images-frozen', on)
    paint()
  }
  const dispose = (): void => {
    disposed = true
    for (const url of urls.values()) URL.revokeObjectURL(url)
    urls.clear()
  }

  paint()
  return { el, paint, setFrozen, dispose }
}
