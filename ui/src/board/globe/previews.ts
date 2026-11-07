/**
 * What a file tile holds, shown on it once it is wide enough to read: the
 * board's own thumbnails, the plot itself or a page's first screen, laid over
 * the canvas in the largest box of the file's shape that fits its tile. They
 * share the board's loading budget, load as their tiles come into reach, and
 * stay cached a while after they leave it, so turning back costs nothing.
 */
import { htmlEl as el } from '../family/drawing.js'
import type { MapFile } from '../family/model.js'
import { Thumbnail } from '../workspace/Thumbnail.js'
import { documentKind, parseDocKey } from '../workspace/documents.js'
import type { Box } from './labels.js'

/** The width a thumbnail is laid out at before it is scaled onto its tile. */
const BASE = 180
/** Previews kept, shown or not; the longest unseen go past this. */
const KEPT = 48
/** A file's shape, width over height, until it says otherwise. */
const ASPECT: Record<string, number> = { image: 4 / 3, html: 1.5, pdf: 1 / Math.SQRT2, video: 16 / 9, text: 1.2 }

interface Item { wrapper: HTMLElement; thumb: Thumbnail; aspect: number; shown: boolean; x: number; y: number }
/** A tile's preview: its file, the box it fills, and the title its face shows until the file draws. */
export interface Shown { key: string; file: MapFile; box: Box; title: string }

export class Previews {
  readonly el = el('div', 'globe-previews')
  private readonly items = new Map<string, Item>()
  private readonly shuttleBase: string
  private readonly reshaped: () => void
  private centre = { x: 0, y: 0 }

  /** `reshaped` is heard when a file's true shape arrives and its box wants laying again. */
  constructor(shuttleBase: string, reshaped: () => void) {
    this.shuttleBase = shuttleBase; this.reshaped = reshaped
    this.el.setAttribute('aria-hidden', 'true')
  }

  /** The file names a place its bytes can be read from. */
  readable(file: MapFile): boolean { return !!parseDocKey(file.key) }
  /** The shape the preview on a tile takes. */
  aspect(key: string, file: MapFile): number {
    const known = this.items.get(key)?.aspect
    if (known) return known
    const path = parseDocKey(file.key)?.path
    return ASPECT[path ? documentKind(path) : 'other'] ?? 1.4
  }

  /** Shows these previews in their boxes, hides the rest; new ones only when `growing`, so a flight passing over loads nothing. */
  show(shown: readonly Shown[], centre: { x: number; y: number }, growing: boolean): void {
    this.centre = centre
    const live = new Set<string>()
    let changed = false
    for (const { key, file, box, title } of shown) {
      let item = this.items.get(key)
      if (!item) {
        if (!growing) continue
        const made = this.make(file, title)
        if (!made) continue
        item = made
        this.items.set(key, item)
      }
      live.add(key)
      if (!item.shown) {
        item.shown = true; item.wrapper.hidden = false; changed = true
        this.items.delete(key); this.items.set(key, item)
      }
      const scale = (box.right - box.left) / BASE
      item.x = (box.left + box.right) / 2; item.y = (box.top + box.bottom) / 2
      item.wrapper.style.transform = `translate(${box.left.toFixed(1)}px, ${box.top.toFixed(1)}px) scale(${scale.toFixed(4)})`
    }
    for (const [key, item] of this.items) {
      if (live.has(key) || !item.shown) continue
      item.shown = false; item.wrapper.hidden = true; changed = true
    }
    let over = this.items.size - KEPT
    for (const [key, item] of this.items) {
      if (over <= 0) break
      if (item.shown) continue
      item.thumb.dispose(); item.wrapper.remove(); this.items.delete(key); over--
    }
    if (changed) this.items.values().next().value?.thumb.schedule()
  }

  dispose(): void {
    for (const item of this.items.values()) item.thumb.dispose()
    this.items.clear()
    this.el.replaceChildren()
  }

  private make(file: MapFile, title: string): Item | null {
    const parsed = parseDocKey(file.key)
    if (!parsed) return null
    const wrapper = el('div', 'globe-preview')
    const item: Item = { wrapper, thumb: null as unknown as Thumbnail, aspect: 0, shown: false, x: 0, y: 0 }
    const size = (aspect: number): void => {
      item.thumb.el.style.width = `${BASE}px`
      item.thumb.el.style.height = `${Math.round(BASE / aspect)}px`
    }
    item.thumb = new Thumbnail({
      key: `globe:${file.key}`, shuttleBase: this.shuttleBase, className: 'globe-preview-thumb', fallback: file.name, captioned: false, title: () => title,
      file: { fullPath: parsed.path, owner: parsed.owner, basename: file.name },
      priority: () => item.shown ? 2 : 0,
      distance: () => Math.hypot(item.x - this.centre.x, item.y - this.centre.y),
      onAspect: aspect => { item.aspect = aspect; size(aspect); this.reshaped() },
    })
    item.aspect = this.aspect('', file)
    size(item.aspect)
    wrapper.hidden = true
    wrapper.append(item.thumb.el)
    this.el.append(wrapper)
    return item
  }
}
