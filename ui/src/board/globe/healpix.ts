/**
 * HEALPix on the nested scheme (Górski et al. 2005), in the plane of
 * Calabretta & Roukema (2007): each of the twelve base pixels is a diamond with
 * straight sides there, and the map to the sphere is equal-area, so a cell's
 * edges are straight lines in `(fx, fy)` and every cell of an order has the
 * same area. Its curved outline on the sphere is those lines carried across.
 *
 * Within a face `fx` runs south-corner to east-corner and `fy` south-corner to
 * west-corner, as in the C++ library, and the nested index interleaves their
 * bits. A cell's four children are therefore digits 0 south, 1 east, 2 west
 * and 3 north.
 */

export interface Cell { order: number; face: number; x: number; y: number }
/** A place on a face, in shares of its sides. */
export interface FacePoint { face: number; fx: number; fy: number }
export type Vec = readonly [x: number, y: number, z: number]
export type Digit = 0 | 1 | 2 | 3
export const SOUTH: Digit = 0, EAST: Digit = 1, WEST: Digit = 2, NORTH: Digit = 3

const HALF_PI = Math.PI / 2, QUARTER_PI = Math.PI / 4

export const nside = (order: number): number => 2 ** order
export const cellCount = (order: number): number => 12 * 4 ** order
/** Each cell's solid angle at an order, in steradians. */
export const cellArea = (order: number): number => 4 * Math.PI / cellCount(order)
/** At least the greatest angle from a cell's centre to its outline. */
export const cellRadius = (order: number): number => 1.1 / nside(order)
/** The cell's width in radians, the square root of its area. */
export const cellSpan = (order: number): number => Math.sqrt(cellArea(order))

export const baseCell = (face: number): Cell => ({ order: 0, face, x: 0, y: 0 })
export const child = ({ order, face, x, y }: Cell, digit: Digit): Cell =>
  ({ order: order + 1, face, x: 2 * x + (digit & 1), y: 2 * y + (digit >> 1) })
export const parent = ({ order, face, x, y }: Cell): Cell =>
  ({ order: order - 1, face, x: Math.floor(x / 2), y: Math.floor(y / 2) })

/** The nested index, by arithmetic rather than bit operations so that it holds past order 15. */
export function ipixOf({ order, face, x, y }: Cell): number {
  let index = 0, place = 1
  for (let bit = 0; bit < order; bit++) {
    index += ((x % 2) + 2 * (y % 2)) * place
    x = Math.floor(x / 2); y = Math.floor(y / 2); place *= 4
  }
  return face * place + index
}
export function cellOf(order: number, ipix: number): Cell {
  const count = 4 ** order, face = Math.floor(ipix / count)
  let rest = ipix - face * count, x = 0, y = 0, place = 1
  for (let bit = 0; bit < order; bit++) {
    x += (rest % 2) * place
    y += (Math.floor(rest / 2) % 2) * place
    rest = Math.floor(rest / 4); place *= 2
  }
  return { order, face, x, y }
}
/** One number for a cell of any order, the NUNIQ of multi-order maps. */
export const uniq = (cell: Cell): number => 4 * 4 ** cell.order + ipixOf(cell)
export const contains = (outer: Cell, inner: Cell): boolean => {
  if (inner.order < outer.order || inner.face !== outer.face) return false
  const shift = 2 ** (inner.order - outer.order)
  return Math.floor(inner.x / shift) === outer.x && Math.floor(inner.y / shift) === outer.y
}

/** A face's centre in the plane, in units of pi/2. */
const faceCentre = (face: number): readonly [number, number] => {
  const band = Math.floor(face / 4), k = face % 4
  return band === 1 ? [k, 0] : [k + .5, band === 0 ? .5 : -.5]
}

/**
 * A place on a face in the HEALPix plane, in radians: `xs` runs east from 0 to
 * 2π with the face 4 astride the seam at nought, `ys` north from -π/2 to π/2.
 * Every cell is a square diamond there.
 */
export function planeOf({ face, fx, fy }: FacePoint): [xs: number, ys: number] {
  const [cx, cy] = faceCentre(face)
  return [HALF_PI * cx + (fx - fy) * QUARTER_PI, HALF_PI * cy + (fx + fy - 1) * QUARTER_PI]
}
/** The face and place at a point of the plane, its east wrapped; null in the notches between the polar faces. */
export function faceAt(xs: number, ys: number): FacePoint | null {
  const t = xs / HALF_PI, w = ys / HALF_PI
  for (let face = 0; face < 12; face++) {
    const [cx, cy] = faceCentre(face)
    const dt = t - cx - 4 * Math.round((t - cx) / 4), dw = w - cy
    const fx = dt + dw + .5, fy = dw - dt + .5
    if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) return { face, fx, fy }
  }
  return null
}

/** A point of a face on the sphere. */
export function vecOf(point: FacePoint): Vec {
  const [xs, ys] = planeOf(point)
  if (Math.abs(ys) <= QUARTER_PI) {
    const z = ys * 8 / (3 * Math.PI), sin = Math.sqrt((1 - z) * (1 + z))
    return [sin * Math.cos(xs), sin * Math.sin(xs), z]
  }
  const sigma = 2 - Math.abs(ys) * 4 / Math.PI, third = sigma * sigma / 3
  const tip = (Math.floor(xs / HALF_PI) + .5) * HALF_PI
  const phi = sigma === 0 ? tip : tip + (xs - tip) / sigma
  const sin = Math.sqrt(third * (2 - third)), z = 1 - third
  return [sin * Math.cos(phi), sin * Math.sin(phi), ys > 0 ? z : -z]
}

/** The face holding a direction, and the place on it: `z` the sine of latitude, `phi` the longitude. */
export function facePoint(z: number, phi: number): FacePoint {
  const lon = ((phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), tt = lon / HALF_PI
  const abs = Math.abs(z)
  let t: number, w: number
  if (abs <= 2 / 3) { t = tt; w = z * 3 / 4 } else {
    const sigma = Math.sqrt(3 * (1 - abs)), tip = Math.floor(tt) + .5
    t = tip + (tt - tip) * sigma
    w = (z > 0 ? 1 : -1) * (1 - sigma / 2)
  }
  let best: FacePoint = { face: 0, fx: 0, fy: 0 }, worst = Infinity
  for (let face = 0; face < 12; face++) {
    const [cx, cy] = faceCentre(face)
    const dt = t - cx - 4 * Math.round((t - cx) / 4), dw = w - cy
    const fx = dt + dw + .5, fy = dw - dt + .5
    // The least overshoot wins, so a point on a shared edge always lands somewhere.
    const out = Math.max(-fx, fx - 1, -fy, fy - 1)
    if (out < worst) { worst = out; best = { face, fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) } }
  }
  return best
}

/** The cell of an order at a place on a face. */
export const cellAt = ({ face, fx, fy }: FacePoint, order: number): Cell => {
  const side = nside(order)
  return { order, face, x: Math.min(side - 1, Math.floor(fx * side)), y: Math.min(side - 1, Math.floor(fy * side)) }
}
export const inCell = ({ face, fx, fy }: FacePoint, { order, face: f, x, y }: Cell): boolean => {
  if (face !== f) return false
  const side = nside(order), ax = fx * side, ay = fy * side
  return ax >= x && ax <= x + 1 && ay >= y && ay <= y + 1
}

export const centre = ({ order, face, x, y }: Cell): Vec => vecOf({ face, fx: (x + .5) / nside(order), fy: (y + .5) / nside(order) })

/**
 * The cell's outline, `step` points to a side, flat: north corner to west,
 * west to south, south to east, east to north, as `healpy.boundaries` gives it.
 */
export function outline({ order, face, x, y }: Cell, step: number): Float64Array {
  const side = nside(order), out = new Float64Array(12 * step)
  const put = (n: number, ax: number, ay: number): void => {
    const [vx, vy, vz] = vecOf({ face, fx: ax / side, fy: ay / side })
    out[3 * n] = vx; out[3 * n + 1] = vy; out[3 * n + 2] = vz
  }
  for (let n = 0; n < step; n++) {
    const along = n / step
    put(n, x + 1 - along, y + 1)
    put(n + step, x, y + 1 - along)
    put(n + 2 * step, x + along, y)
    put(n + 3 * step, x + 1, y + along)
  }
  return out
}
