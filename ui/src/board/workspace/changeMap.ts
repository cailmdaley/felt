import type { ChangeArea } from './changeModel.js'
import { el, button } from './changeElements.js'

/** Squarified rectangles in input coordinates, largest first. Zero-line files have no area. */
export function squarify(weights: number[], width: number, height: number) {
  const total = weights.reduce((a, b) => a + b, 0)
  const pending = weights.map((weight, index) => ({ index, size: weight * width * height / total })).filter(x => x.size > 0).sort((a, b) => b.size - a.size)
  const rects: { index: number; x: number; y: number; width: number; height: number }[] = []
  let x = 0, y = 0, w = width, h = height
  const worst = (row: typeof pending, side: number) => {
    const sum = row.reduce((n, r) => n + r.size, 0)
    return Math.max(side * side * row[0].size / (sum * sum), sum * sum / (side * side * row.at(-1)!.size))
  }
  while (pending.length) {
    const row = [pending.shift()!], side = Math.min(w, h)
    while (pending.length && worst([...row, pending[0]], side) <= worst(row, side)) row.push(pending.shift()!)
    const thickness = row.reduce((n, r) => n + r.size, 0) / side
    let offset = 0
    for (const r of row) {
      const length = r.size / thickness
      rects.push({ index: r.index, x: x + (w < h ? offset : 0), y: y + (w < h ? 0 : offset), width: w < h ? length : thickness, height: w < h ? thickness : length })
      offset += length
    }
    if (w < h) { y += thickness; h -= thickness } else { x += thickness; w -= thickness }
  }
  return rects
}

/** A reusable area map: counts and navigation come from the caller, not Git. */
const countFormat = new Intl.NumberFormat('en-US')

export function changeMap(areas: ChangeArea[], navigate: (area: ChangeArea) => void): HTMLElement {
  const root = el('section', 'change-map')
  root.dataset.windowId = 'map'
  const total = areas.reduce((n, a) => n + a.lines, 0)
  const count = areas.reduce((n, a) => n + a.files.length, 0)
  root.append(el('h2', '', `${countFormat.format(total)} changed lines in ${countFormat.format(count)} files`))
  const canvas = el('div', 'change-map-canvas')
  root.append(canvas)
  const tiles = areas.map(area => {
    const percent = total ? area.lines / total * 100 : 0
    const tile = button('', () => navigate(area))
    tile.className = 'change-map-tile'
    if (!area.lines) tile.style.display = 'none'
    tile.dataset.role = area.role ?? 'implementation'
    const count = `${countFormat.format(area.lines)} · ${percent.toFixed(1)}%`
    tile.title = `${area.name}: ${count}${area.what ? ` — ${area.what}` : ''}`
    tile.setAttribute('aria-label', tile.title)
    tile.append(el('strong', '', area.name), el('span', '', count))
    if (area.what) tile.append(el('p', '', area.what))
    canvas.append(tile)
    return tile
  })
  const observer = new ResizeObserver(() => {
    for (const rect of squarify(areas.map(a => a.lines), canvas.clientWidth, canvas.clientHeight)) {
      const tile = tiles[rect.index]
      Object.assign(tile.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
      tile.dataset.small = String(rect.width < 130 || rect.height < 90)
      tile.dataset.tiny = String(rect.width < 65 || rect.height < 42)
    }
  })
  observer.observe(canvas)
  // The reader owns this element's lifetime.
  root.addEventListener('dispose', () => observer.disconnect(), { once: true })
  return root
}
