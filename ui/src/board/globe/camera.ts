/**
 * The two ways of looking at the sphere, one camera over both. Pure.
 *
 * An orthographic globe with north up, or Mollweide's whole sky. Each maps a
 * unit vector to the screen and back, so a grabbed point can be kept under the
 * pointer exactly at any zoom, and a flight eases through both.
 */
import type { Vec } from './healpix.js'

export type Projection = 'globe' | 'mollweide'
export interface Viewport { width: number; height: number }
/** Where the view is centred, and the sphere's radius on screen in pixels. */
export interface Camera { lon: number; lat: number; radius: number }

const ROOT2 = Math.SQRT2, EDGE = 2 * ROOT2
const NEAR_POLE = Math.PI / 2 - 1e-9
/** The pixels left around the whole sphere. */
const MARGIN = 14

/** Mollweide's auxiliary angle for `z`, the sine of latitude: the root of 2a + sin 2a = πz. */
export function mollweideAngle(z: number): number {
  if (Math.abs(z) >= 1) return Math.sign(z) * Math.PI / 2
  // Newton slows at the poles, where a closed start is exact to leading order.
  let angle = Math.abs(z) > .98 ? Math.sign(z) * (Math.PI / 2 - Math.cbrt(3 * Math.PI * (1 - Math.abs(z)) / 8)) : Math.asin(z)
  for (let n = 0; n < 12; n++) {
    const step = (2 * angle + Math.sin(2 * angle) - Math.PI * z) / (2 + 2 * Math.cos(2 * angle))
    angle -= step
    if (Math.abs(step) < 1e-13) break
  }
  return angle
}

/** The radius at which the whole sphere just fits. */
export function wholeRadius(projection: Projection, { width, height }: Viewport): number {
  const w = Math.max(40, width - 2 * MARGIN) / 2, h = Math.max(40, height - 2 * MARGIN) / 2
  return projection === 'globe' ? Math.min(w, h) : Math.min(w / EDGE, h / ROOT2)
}

/** A camera ready to project: its basis on the sphere, and its screen centre. */
export interface Frame {
  projection: Projection
  cx: number; cy: number; r: number
  rightX: number; rightY: number
  upX: number; upY: number; upZ: number
  fwdX: number; fwdY: number; fwdZ: number
  lon: number
  /** Mollweide's height of the view's centre, in sphere radii. */
  rise: number
}
export function frameOf({ lon, lat, radius }: Camera, projection: Projection, { width, height }: Viewport): Frame {
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon), sinLat = Math.sin(lat), cosLat = Math.cos(lat)
  return {
    projection, cx: width / 2, cy: height / 2, r: radius, lon,
    rightX: -sinLon, rightY: cosLon,
    upX: -sinLat * cosLon, upY: -sinLat * sinLon, upZ: cosLat,
    fwdX: cosLat * cosLon, fwdY: cosLat * sinLon, fwdZ: sinLat,
    rise: ROOT2 * Math.sin(mollweideAngle(sinLat)),
  }
}

const wrapped = (angle: number): number => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))
/** The longitude from the view's centre to a point, between -π and π. */
export const fromCentre = (frame: Frame, phi: number): number => wrapped(phi - frame.lon)

/** A vector's place on screen, and how far it faces the viewer: below zero it is over the horizon. */
export function project(frame: Frame, [x, y, z]: Vec): { x: number; y: number; depth: number } {
  if (frame.projection === 'globe') {
    return {
      x: frame.cx + frame.r * (x * frame.rightX + y * frame.rightY),
      y: frame.cy - frame.r * (x * frame.upX + y * frame.upY + z * frame.upZ),
      depth: x * frame.fwdX + y * frame.fwdY + z * frame.fwdZ,
    }
  }
  const angle = mollweideAngle(z)
  return {
    x: frame.cx + frame.r * EDGE / Math.PI * fromCentre(frame, Math.atan2(y, x)) * Math.cos(angle),
    y: frame.cy - frame.r * (ROOT2 * Math.sin(angle) - frame.rise),
    depth: 1,
  }
}

/** The vector under a screen point, or null off the sphere. */
export function invert(frame: Frame, sx: number, sy: number): Vec | null {
  const across = (sx - frame.cx) / frame.r, up = (frame.cy - sy) / frame.r
  if (frame.projection === 'globe') {
    const rest = 1 - across * across - up * up
    if (rest < 0) return null
    const depth = Math.sqrt(rest)
    return [
      across * frame.rightX + up * frame.upX + depth * frame.fwdX,
      across * frame.rightY + up * frame.upY + depth * frame.fwdY,
      up * frame.upZ + depth * frame.fwdZ,
    ]
  }
  const sine = (up + frame.rise) / ROOT2
  if (Math.abs(sine) > 1) return null
  const angle = Math.asin(sine), cos = Math.cos(angle)
  const lon = cos === 0 ? 0 : across * Math.PI / (EDGE * cos)
  if (Math.abs(lon) > Math.PI) return null
  const z = (2 * angle + Math.sin(2 * angle)) / Math.PI, phi = frame.lon + lon, flat = Math.sqrt(Math.max(0, (1 - z) * (1 + z)))
  return [flat * Math.cos(phi), flat * Math.sin(phi), z]
}

/** The camera, at its own radius, that holds a vector at a screen point. Out of reach it comes as near as it can. */
export function keeping(camera: Camera, projection: Projection, viewport: Viewport, [x, y, z]: Vec, sx: number, sy: number): Camera {
  const across = (sx - viewport.width / 2) / camera.radius, up = (viewport.height / 2 - sy) / camera.radius
  const phi = Math.atan2(y, x), flat = Math.hypot(x, y)
  if (projection === 'mollweide') {
    const angle = mollweideAngle(z), centred = Math.asin(Math.max(-1, Math.min(1, Math.sin(angle) - up / ROOT2)))
    const lat = Math.asin(Math.max(-1, Math.min(1, (2 * centred + Math.sin(2 * centred)) / Math.PI)))
    return { ...camera, lat, lon: wrapped(phi - across * Math.PI / (EDGE * Math.max(.05, Math.cos(angle)))) }
  }
  const sine = Math.max(-1, Math.min(1, across / Math.max(flat, 1e-12))), turn = Math.asin(sine)
  const a = z, b = flat * Math.cos(turn), size = Math.hypot(a, b), offset = Math.atan2(b, a)
  const swing = Math.acos(Math.max(-1, Math.min(1, up / size)))
  const options = [swing - offset, -swing - offset].map(lat => lat - 2 * Math.PI * Math.round((lat - camera.lat) / (2 * Math.PI)))
  const lat = Math.abs(options[0] - camera.lat) <= Math.abs(options[1] - camera.lat) ? options[0] : options[1]
  return { ...camera, lon: wrapped(phi - turn), lat: Math.max(-NEAR_POLE, Math.min(NEAR_POLE, lat)) }
}

const toVec = (lon: number, lat: number): Vec => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
export const lonLat = ([x, y, z]: Vec): { lon: number; lat: number } => ({ lon: Math.atan2(y, x), lat: Math.atan2(z, Math.hypot(x, y)) })

/** Flight's trade between zooming and panning, as in van Wijk & Nuij (2003). */
const RHO = Math.SQRT2

export interface Flight { at(t: number): Camera; ms: number }
const FLIGHT_MS = 520, FLIGHT_LEAST = 320, FLIGHT_MOST = 1200

/** The smooth path between two cameras, out, across and in, by the optimal zoom-and-pan path, with the sphere's radius never under `least`. */
export function flight(from: Camera, to: Camera, viewport: Viewport, least: number): Flight {
  const a = toVec(from.lon, from.lat), b = toVec(to.lon, to.lat)
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
  const angle = Math.atan2(cross, dot)
  const wide = Math.min(viewport.width, viewport.height), w0 = wide / from.radius, w1 = wide / to.radius
  const blend = (u: number): { lon: number; lat: number } => {
    if (angle < 1e-12) return { lon: from.lon, lat: from.lat }
    const s0 = Math.sin((1 - u) * angle) / Math.sin(angle), s1 = Math.sin(u * angle) / Math.sin(angle)
    return lonLat([s0 * a[0] + s1 * b[0], s0 * a[1] + s1 * b[1], s0 * a[2] + s1 * b[2]])
  }
  const settle = (t: number): number => t * t * (3 - 2 * t)
  if (angle < 1e-9 * Math.min(w0, w1)) {
    const rate = Math.log(w1 / w0)
    return { ms: Math.min(FLIGHT_MOST, Math.max(FLIGHT_LEAST, FLIGHT_MS * Math.abs(rate) / 2)), at: t => ({ ...blend(settle(t)), radius: wide / (w0 * Math.exp(rate * settle(t))) }) }
  }
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * angle * angle) / (2 * w0 * RHO * RHO * angle)
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * angle * angle) / (2 * w1 * RHO * RHO * angle)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const length = (r1 - r0) / RHO, cosh0 = Math.cosh(r0)
  return {
    ms: Math.min(FLIGHT_MOST, Math.max(FLIGHT_LEAST, FLIGHT_MS * Math.abs(length) / 2)),
    at: raw => {
      const t = settle(raw), s = t * length
      const u = w0 / (RHO * RHO * angle) * (cosh0 * Math.tanh(RHO * s + r0) - Math.sinh(r0))
      const w = w0 * cosh0 / Math.cosh(RHO * s + r0)
      return { ...blend(raw === 1 ? 1 : u), radius: raw === 1 ? to.radius : Math.max(least, wide / w) }
    },
  }
}
