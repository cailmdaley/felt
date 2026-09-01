/** Coordinate math for gesture records. Kept free of DOM discovery so it can be
 * tested with ordinary rectangles and so the serializer never has to know how
 * a browser happened to lay a deck out. */

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface GestureBox {
  x: number
  y: number
  width: number
  height: number
}

export interface GesturePoint {
  x: number
  y: number
}

export interface CoordinateSpace {
  kind: 'slide' | 'page'
  /** Screen-space origin of the current slide. */
  originX: number
  originY: number
  /** CSS pixels per logical coordinate. */
  scale: number
  slideIndex?: string
  heading: string
  title: string
}

export function pointInSpace(
  clientX: number,
  clientY: number,
  space: CoordinateSpace,
  scrollX = 0,
  scrollY = 0,
): GesturePoint {
  if (space.kind === 'slide') {
    return {
      x: (clientX - space.originX) / space.scale,
      y: (clientY - space.originY) / space.scale,
    }
  }
  return { x: clientX + scrollX, y: clientY + scrollY }
}

export function boxInSpace(
  rect: RectLike,
  space: CoordinateSpace,
  scrollX = 0,
  scrollY = 0,
): GestureBox {
  const topLeft = pointInSpace(rect.left, rect.top, space, scrollX, scrollY)
  const divisor = space.kind === 'slide' ? space.scale : 1
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width / divisor,
    height: rect.height / divisor,
  }
}

export function roundBox(box: GestureBox, precision = 1): GestureBox {
  const round = (value: number): number => Math.round(value / precision) * precision
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) }
}

/** Extract the uniform scale from a computed CSS transform. */
export function scaleFromTransform(transform: string | null | undefined): number | null {
  if (!transform || transform === 'none') return null
  const matrix = transform.match(/^matrix(?:3d)?\(([^)]+)\)$/)
  if (!matrix) return null
  const values = matrix[1].split(',').map(Number)
  if (values.some((value) => !Number.isFinite(value))) return null
  const scale = transform.startsWith('matrix3d')
    ? Math.hypot(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0)
    : Math.hypot(values[0] ?? 0, values[1] ?? 0)
  return scale > 0 ? scale : null
}
