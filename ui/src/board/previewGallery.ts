/**
 * The preview's gallery: what a fiber embeds in its body and what it sent
 * (`withEmbeds` orders them), laid out by what can be seen of it.
 *
 * The first file — what the body embeds, else the newest sent — is the cover,
 * and every image is a plate, each the panel's
 * full width at its own aspect — a plot is read at size or not at all. Pages,
 * PDFs and text sit two to a row as tiles; what a thumbnail cannot draw (an
 * archive, a recording) is a line. Every item opens its document in the reader.
 *
 * Thumbnails come from the shared budget and wait for the preview to settle,
 * so a pointer running down a column does not start a load for every row it
 * passes. `dispose` releases them.
 */

import { Thumbnail } from './workspace/Thumbnail.js'
import { documentKind } from './workspace/documents.js'
import { unseenSince } from './workspace/DocumentSeen.js'
import { humanizeIdleAge } from './utils.js'
import type { FiberSend } from './fiberSends.js'

export type GallerySlot = 'cover' | 'plate' | 'tile' | 'line'

/** How many files the gallery lays out; older ones are counted, not drawn. */
export const GALLERY_LIMIT = 12
/** How long the preview must hold still before its thumbnails start loading. */
export const GALLERY_SETTLE_MS = 160

const GLYPH: Record<ReturnType<typeof documentKind>, string> = {
  fiber: '§', html: '▣', image: '▨', pdf: '▧', text: '≡', audio: '♪', video: '▹', other: '□',
}

/** Where a file sits in the gallery, by its kind and whether it is the newest. */
export function gallerySlot(path: string, newest: boolean): GallerySlot {
  const kind = documentKind(path)
  if (kind === 'audio' || kind === 'other' || kind === 'fiber') return 'line'
  if (kind === 'image') return 'plate'
  if (newest) return 'cover'
  return 'tile'
}

export interface GalleryOptions {
  shuttleBase: string
  open: (send: FiberSend) => void
  clear?: () => void | Promise<void>
  dismiss?: (send: FiberSend) => Promise<void>
  now?: number
}

export function buildSendGallery(sends: readonly FiberSend[], o: GalleryOptions): { el: HTMLElement; dispose: () => void } | null {
  if (!sends.length) return null
  const now = o.now ?? Date.now()
  const el = document.createElement('section')
  el.className = 'kbn-preview-gallery'
  el.setAttribute('aria-label', `Files (${sends.length})`)
  if (o.clear) {
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'kbn-preview-gallery-clear'
    clear.textContent = 'Clear'
    clear.title = 'Hide sent files; files on disk and body embeds are untouched'
    clear.setAttribute('aria-label', 'Clear sent files')
    clear.addEventListener('click', async event => {
      event.stopPropagation()
      if (clear.disabled) return
      clear.disabled = true
      try {
        await o.clear?.()
      } finally {
        clear.disabled = false
      }
    })
    el.append(clear)
  }

  const error = document.createElement('p')
  error.className = 'kbn-preview-gallery-error'
  error.setAttribute('role', 'alert')
  error.hidden = true
  el.append(error)

  const thumbs: Thumbnail[] = []
  let settled = false
  const scroller = (): HTMLElement | null => el.closest<HTMLElement>('.kbn-preview-sheet')
  const visible = (thumb: Thumbnail): boolean => {
    const box = scroller()?.getBoundingClientRect()
    const rect = thumb.el.getBoundingClientRect()
    return !box || (rect.bottom > box.top && rect.top < box.bottom)
  }

  let tiles: HTMLElement | null = null
  const shown = sends.slice(0, GALLERY_LIMIT)
  shown.forEach((send, i) => {
    const slot = gallerySlot(send.fullPath, i === 0)
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'kbn-preview-send'
    item.dataset.slot = slot
    item.dataset.kind = documentKind(send.fullPath)
    const sent = send.timestamp > 0
    const age = sent ? `${humanizeIdleAge(now - send.timestamp)} ago` : 'in the body'
    item.title = sent ? `Open ${send.basename} — sent ${age}` : `Open ${send.basename} — embedded in the constitution`
    if (send.embedded) item.dataset.embedded = ''
    if (sent && unseenSince(send.key, send.timestamp)) item.dataset.unseen = ''
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      o.open(send)
    })

    if (slot !== 'line') {
      const live: Thumbnail = new Thumbnail({
        key: `desk-preview:${send.owner}:${send.fullPath}`,
        file: { fullPath: send.fullPath, owner: send.owner, basename: send.basename },
        fallback: send.basename,
        shuttleBase: o.shuttleBase,
        className: 'kbn-preview-thumb',
        captioned: true,
        priority: () => (!settled || !live.el.isConnected ? 0 : visible(live) ? 3 : 1),
        distance: () => i,
        onAspect: slot === 'plate' ? (aspect) => { live.el.style.aspectRatio = String(Math.max(0.5, Math.min(aspect, 4))) } : undefined,
      })
      thumbs.push(live)
      item.append(live.el)
    } else {
      const glyph = document.createElement('span')
      glyph.className = 'kbn-preview-send-glyph'
      glyph.setAttribute('aria-hidden', 'true')
      glyph.textContent = GLYPH[documentKind(send.fullPath)]
      item.append(glyph)
    }
    const caption = document.createElement('span')
    caption.className = 'kbn-preview-send-caption'
    const name = document.createElement('span')
    name.className = 'kbn-preview-send-name'
    name.textContent = send.basename
    const when = document.createElement('span')
    when.className = 'kbn-preview-send-age'
    when.textContent = age
    caption.append(name, when)
    item.append(caption)

    const tile = document.createElement('div')
    tile.className = 'kbn-preview-send-wrap'
    tile.append(item)
    if (sent && o.dismiss) {
      const dismiss = document.createElement('button')
      dismiss.type = 'button'
      dismiss.className = 'kbn-preview-send-dismiss'
      dismiss.textContent = '×'
      dismiss.title = `Dismiss ${send.basename}; the file on disk is untouched`
      dismiss.setAttribute('aria-label', `Dismiss ${send.basename}`)
      dismiss.addEventListener('click', async event => {
        event.stopPropagation()
        if (dismiss.disabled) return
        dismiss.disabled = true
        error.hidden = true
        tile.hidden = true
        try {
          await o.dismiss!(send)
        } catch (reason) {
          tile.hidden = false
          error.textContent = `Couldn't dismiss ${send.basename}: ${reason instanceof Error ? reason.message : String(reason)}`
          error.hidden = false
          dismiss.disabled = false
          dismiss.focus()
        } finally {
          dismiss.disabled = false
        }
      })
      tile.append(dismiss)
    }

    if (slot === 'tile') {
      if (!tiles) {
        tiles = document.createElement('div')
        tiles.className = 'kbn-preview-tiles'
        el.append(tiles)
      }
      tiles.append(tile)
    } else {
      tiles = null
      el.append(tile)
    }
  })
  if (sends.length > shown.length) {
    const more = document.createElement('p')
    more.className = 'kbn-preview-more'
    const rest = sends.length - shown.length
    more.textContent = `${rest} older ${rest === 1 ? 'file' : 'files'} in the reader`
    el.append(more)
  }

  const pump = (): void => { thumbs[0]?.schedule() }
  const settle = setTimeout(() => {
    settled = true
    pump()
    scroller()?.addEventListener('scroll', pump, { passive: true })
  }, GALLERY_SETTLE_MS)
  return {
    el,
    dispose: () => {
      clearTimeout(settle)
      scroller()?.removeEventListener('scroll', pump)
      for (const thumb of thumbs) thumb.dispose()
    },
  }
}
