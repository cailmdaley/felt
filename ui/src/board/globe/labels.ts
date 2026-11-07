/**
 * Which names fit where. Pure: a name is laid into its tile's outline whole or
 * not at all, wrapped to as few lines as the tile's shape allows, and no two
 * names touch.
 */
export type Measure = (text: string) => number
export interface Block { lines: string[]; width: number; height: number; role: string }
export interface Box { left: number; top: number; right: number; bottom: number }
export interface Point { x: number; y: number }
/** A screen polygon as flat x, y pairs. */
export type Polygon = readonly number[]

const MOST_LINES = 4

/** The lines of `text` no wider than `width`, greedily; a single word wider than that stands on its own. */
export function wrap(text: string, width: number, measure: Measure): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && measure(next) > width) { lines.push(line); line = word } else line = next
  }
  if (line) lines.push(line)
  return lines
}

/** The name laid out at each number of lines worth trying, longest line first, in a type role whose line is `lineHeight`. */
export function blocks(text: string, measure: Measure, lineHeight: number, role: string): Block[] {
  const whole = measure(text), out: Block[] = []
  for (let count = 1; count <= MOST_LINES; count++) {
    let width = whole / count
    let lines = wrap(text, width, measure)
    while (lines.length > count) { width *= 1.08; lines = wrap(text, width, measure) }
    const widest = Math.max(...lines.map(measure))
    if (out.some(block => block.lines.length === lines.length)) continue
    out.push({ lines, width: Math.ceil(widest), height: lines.length * lineHeight, role })
  }
  return out
}

/** Is a point inside a polygon, by crossings. */
export function within(polygon: Polygon, x: number, y: number): boolean {
  let inside = false
  for (let a = 0, b = polygon.length - 2; a < polygon.length; b = a, a += 2) {
    const ay = polygon[a + 1], by = polygon[b + 1]
    if ((ay > y) !== (by > y) && x < polygon[a] + (y - ay) / (by - ay) * (polygon[b] - polygon[a])) inside = !inside
  }
  return inside
}
const PAD = 3
/** A box at a point sits wholly in the polygon, its edges checked along their length. */
export function boxFits(polygon: Polygon, { x, y }: Point, width: number, height: number): boolean {
  const w = width / 2 + PAD, h = height / 2 + PAD
  for (const tx of [-1, -.5, 0, .5, 1]) if (!within(polygon, x + tx * w, y - h) || !within(polygon, x + tx * w, y + h)) return false
  return within(polygon, x - w, y) && within(polygon, x + w, y)
}

/** A box at a point stands wholly outside the polygon: none of its edge in the polygon, none of the polygon in it. */
export function boxClear(polygon: Polygon, { x, y }: Point, width: number, height: number): boolean {
  const w = width / 2 + PAD, h = height / 2 + PAD
  for (const tx of [-1, -.5, 0, .5, 1]) if (within(polygon, x + tx * w, y - h) || within(polygon, x + tx * w, y + h)) return false
  if (within(polygon, x - w, y) || within(polygon, x + w, y)) return false
  for (let n = 0; n < polygon.length; n += 2) if (Math.abs(polygon[n] - x) < w && Math.abs(polygon[n + 1] - y) < h) return false
  return true
}

export const overlaps = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
export const boxAt = ({ x, y }: Point, width: number, height: number): Box => ({ left: x - width / 2, top: y - height / 2, right: x + width / 2, bottom: y + height / 2 })

export interface Candidate<T> {
  owner: T
  /** The shape the name must stay inside, or null for one set beside its mark and free of any tile. */
  polygon: Polygon | null
  /** A shape the name must stay wholly out of. */
  clear?: Polygon
  /** Where the name would go, best first. */
  anchors: readonly Point[]
  blocks: readonly Block[]
}
export interface Placed<T> { owner: T; block: Block; at: Point; box: Box }

/** Takes candidates in order, first come first placed, each in the first spot it fits clear of the rest and the frame. */
export function placeNames<T>(candidates: Iterable<Candidate<T>>, frame: Box, most: number, kept: readonly Box[] = []): Placed<T>[] {
  const placed: Placed<T>[] = []
  for (const { owner, polygon, clear, anchors, blocks: options } of candidates) {
    if (placed.length >= most) break
    search: for (const block of options) {
      for (const at of anchors) {
        const box = boxAt(at, block.width, block.height)
        if (box.left < frame.left || box.top < frame.top || box.right > frame.right || box.bottom > frame.bottom) continue
        const bigger: Box = { left: box.left - 4, top: box.top - 2, right: box.right + 4, bottom: box.bottom + 2 }
        if (kept.some(other => overlaps(bigger, other)) || placed.some(other => other.owner === owner || overlaps(bigger, other.box))) continue
        if (polygon && !boxFits(polygon, at, block.width, block.height)) continue
        if (clear && !boxClear(clear, at, block.width, block.height)) continue
        placed.push({ owner, block, at, box })
        break search
      }
    }
  }
  return placed
}

/** The largest box of a width-to-height ratio centred at a point that sits inside a polygon, by halving on its size; null when none does. */
export function inscribed(polygon: Polygon, { x, y }: Point, aspect: number): Box | null {
  let left = 0, right = 0
  for (let n = 0; n < polygon.length; n += 2) right = Math.max(right, Math.abs(polygon[n] - x), Math.abs(polygon[n + 1] - y) * aspect)
  const fits = (half: number): boolean => {
    const h = half / aspect
    for (const t of [-1, -.5, 0, .5, 1]) if (!within(polygon, x + t * half, y - h) || !within(polygon, x + t * half, y + h) || !within(polygon, x - half, y + t * h) || !within(polygon, x + half, y + t * h)) return false
    return true
  }
  if (!within(polygon, x, y)) return null
  for (let n = 0; n < 14; n++) { const mid = (left + right) / 2; if (fits(mid)) left = mid; else right = mid }
  return left > 0 ? { left: x - left, top: y - left / aspect, right: x + left, bottom: y + left / aspect } : null
}
