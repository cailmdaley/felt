/**
 * The three ways of looking at the sphere, one camera over all. Pure.
 *
 * The globe is orthographic and turns freely: its camera is a rotation, so a
 * grabbed point stays exactly under the pointer at any orientation, over the
 * poles included, and north comes upright only as the hand moves. Mollweide's
 * whole sky is the map healpy draws, north up, turning in longitude. The plane
 * is HEALPix's own (Calabretta & Roukema 2007), where every cell is a straight
 * square diamond, scaled to the sphere's area so a tile is as wide on it as on
 * the sphere.
 */
import { faceAt, facePoint, nside, planeOf, vecOf, type Cell, type Vec } from './healpix.js'

export type Projection = 'globe' | 'mollweide' | 'plane'
export const PROJECTIONS: readonly Projection[] = ['globe', 'mollweide', 'plane']
export interface Viewport { width: number; height: number }
/** A rotation as a unit quaternion, w first: it carries the camera's axes to the sphere's. */
export type Quat = readonly [w: number, x: number, y: number, z: number]
/** A point the hand holds: a direction on the globe, a place on the plane. */
export type Grip = readonly number[]
/**
 * Where the view looks. `turn` orients the globe; `sky` is Mollweide's centre,
 * a longitude and a latitude; `at` is the plane's centre in its own units. Each
 * projection reads its own, and a switch carries one to the next.
 */
export interface Camera { turn: Quat; sky: readonly [lon: number, lat: number]; at: readonly [number, number]; radius: number }

/** The plane's scale to equal area: twelve diamonds of π²/8 against 4π. */
const PLANE_SCALE = Math.sqrt(8 / (3 * Math.PI))
/** The plane's width, after which it repeats, and its half height, in its units. */
export const PERIOD = 2 * Math.PI * PLANE_SCALE
const HALF_HEIGHT = Math.PI / 2 * PLANE_SCALE
const ROOT2 = Math.SQRT2, EDGE = 2 * ROOT2
/** The pixels left around the whole sphere. */
const MARGIN = 14
/** How far north comes upright for each radian the hand turns the globe. */
export const UPRIGHT = 1.2

const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normal = ([w, x, y, z]: Quat): Quat => { const n = Math.hypot(w, x, y, z); return [w / n, x / n, y / n, z / n] }
const times = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
]
const inverse = ([w, x, y, z]: Quat): Quat => [w, -x, -y, -z]
/** A vector carried by a rotation. */
export function rotate([w, x, y, z]: Quat, v: Vec): Vec {
  const u: Vec = [x, y, z], c = cross(u, v), t: Vec = [2 * c[0], 2 * c[1], 2 * c[2]], s = cross(u, t)
  return [v[0] + w * t[0] + s[0], v[1] + w * t[1] + s[1], v[2] + w * t[2] + s[2]]
}
/** The least rotation taking one unit vector to another. */
function between(a: Vec, b: Vec): Quat {
  const w = 1 + dot(a, b)
  if (w < 1e-12) {
    const side = Math.abs(a[0]) < .9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0])
    return normal([0, ...side])
  }
  return normal([w, ...cross(a, b)])
}
const about = (axis: Vec, angle: number): Quat => {
  const s = Math.sin(angle / 2), n = Math.hypot(...axis) || 1
  return [Math.cos(angle / 2), axis[0] * s / n, axis[1] * s / n, axis[2] * s / n]
}
const mix = (a: Quat, b: Quat, s0: number, s1: number): Quat => normal([s0 * a[0] + s1 * b[0], s0 * a[1] + s1 * b[1], s0 * a[2] + s1 * b[2], s0 * a[3] + s1 * b[3]])
/** The rotation part way from one to another, the short way round. */
function slerp(a: Quat, b: Quat, u: number): Quat {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const sign = cos < 0 ? -1 : 1
  cos *= sign
  if (cos > 1 - 1e-9) return mix(a, b, 1 - u, sign * u)
  const angle = Math.acos(cos)
  return mix(a, b, Math.sin((1 - u) * angle) / Math.sin(angle), sign * Math.sin(u * angle) / Math.sin(angle))
}
/** The rotation whose columns are these three axes. */
function ofAxes(r: Vec, u: Vec, f: Vec): Quat {
  const trace = r[0] + u[1] + f[2]
  if (trace > 0) { const s = 2 * Math.sqrt(1 + trace); return normal([s / 4, (u[2] - f[1]) / s, (f[0] - r[2]) / s, (r[1] - u[0]) / s]) }
  if (r[0] > u[1] && r[0] > f[2]) { const s = 2 * Math.sqrt(1 + r[0] - u[1] - f[2]); return normal([(u[2] - f[1]) / s, s / 4, (u[0] + r[1]) / s, (f[0] + r[2]) / s]) }
  if (u[1] > f[2]) { const s = 2 * Math.sqrt(1 + u[1] - r[0] - f[2]); return normal([(f[0] - r[2]) / s, (u[0] + r[1]) / s, s / 4, (f[1] + u[2]) / s]) }
  const s = 2 * Math.sqrt(1 + f[2] - r[0] - u[1])
  return normal([(r[1] - u[0]) / s, (f[0] + r[2]) / s, (f[1] + u[2]) / s, s / 4])
}
/** Looking at a longitude and latitude with north up the screen; straight down on a pole, `lon` is the meridian below the centre. */
export function northUp(lon: number, lat: number): Quat {
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon), sinLat = Math.sin(lat), cosLat = Math.cos(lat)
  return ofAxes([-sinLon, cosLon, 0], [-sinLat * cosLon, -sinLat * sinLon, cosLat], [cosLat * cosLon, cosLat * sinLon, sinLat])
}

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

const wrapped = (value: number, period: number): number => value - period * Math.round(value / period)
const toVec = (lon: number, lat: number): Vec => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
const lonLat = ([x, y, z]: Vec): { lon: number; lat: number } => ({ lon: Math.atan2(y, x), lat: Math.atan2(z, Math.hypot(x, y)) })

/** A direction's place on the plane, in its units. */
export function planeAt([x, y, z]: Vec): [number, number] {
  const [xs, ys] = planeOf(facePoint(z, Math.atan2(y, x)))
  return [xs * PLANE_SCALE, ys * PLANE_SCALE]
}
/** The direction at a place on the plane; null in the notches between the polar faces. */
export function onPlane(px: number, py: number): Vec | null {
  const point = faceAt(px / PLANE_SCALE, py / PLANE_SCALE)
  return point && vecOf(point)
}

/** The radius at which the whole sphere just fits. */
export function wholeRadius(projection: Projection, { width, height }: Viewport): number {
  const w = Math.max(40, width - 2 * MARGIN) / 2, h = Math.max(40, height - 2 * MARGIN) / 2
  return projection === 'globe' ? Math.min(w, h) : projection === 'mollweide' ? Math.min(w / EDGE, h / ROOT2) : Math.min(w / (PERIOD / 2), h / HALF_HEIGHT)
}

/** A camera ready to project: its axes on the sphere, its plane centre, and its screen centre. */
export interface Frame {
  projection: Projection
  cx: number; cy: number; r: number
  rightX: number; rightY: number; rightZ: number
  upX: number; upY: number; upZ: number
  fwdX: number; fwdY: number; fwdZ: number
  atX: number; atY: number
  /** Mollweide's central longitude, and the height of its centre in sphere radii. */
  lon: number; rise: number
}
export function frameOf({ turn, sky, at, radius }: Camera, projection: Projection, { width, height }: Viewport): Frame {
  const [rightX, rightY, rightZ] = rotate(turn, [1, 0, 0]), [upX, upY, upZ] = rotate(turn, [0, 1, 0]), [fwdX, fwdY, fwdZ] = rotate(turn, [0, 0, 1])
  return {
    projection, cx: width / 2, cy: height / 2, r: radius, rightX, rightY, rightZ, upX, upY, upZ, fwdX, fwdY, fwdZ, atX: at[0], atY: at[1],
    lon: sky[0], rise: ROOT2 * Math.sin(mollweideAngle(Math.sin(sky[1]))),
  }
}
/** The longitude from Mollweide's centre to a point, between -π and π. */
export const fromCentre = (frame: Frame, phi: number): number => wrapped(phi - frame.lon, 2 * Math.PI)
/** How far east of the frame's centre a place on the plane lies, by the copy nearest the centre. */
const planeOffset = (frame: Frame, px: number): number => wrapped(px - frame.atX, PERIOD)

/** A cell's diamond on the screen's plane, north, west, south and east, at the copy nearest the centre; `shift` moves it by whole turns. */
export function planeOutline(frame: Frame, { order, face, x, y }: Cell, shift = 0): number[] {
  const side = nside(order), out: number[] = []
  for (const [a, b] of [[x + 1, y + 1], [x, y + 1], [x, y], [x + 1, y]]) {
    const [xs, ys] = planeOf({ face, fx: a / side, fy: b / side })
    out.push(xs * PLANE_SCALE, ys * PLANE_SCALE)
  }
  const middle = (out[2] + out[6]) / 2, offset = planeOffset(frame, middle) + shift
  for (let n = 0; n < 8; n += 2) {
    out[n] = frame.cx + frame.r * (out[n] - middle + offset)
    out[n + 1] = frame.cy - frame.r * (out[n + 1] - frame.atY)
  }
  return out
}

/** A vector's place on screen, and how far it faces the viewer: below zero it is over the horizon. */
export function project(frame: Frame, v: Vec): { x: number; y: number; depth: number } {
  if (frame.projection === 'globe') {
    return {
      x: frame.cx + frame.r * (v[0] * frame.rightX + v[1] * frame.rightY + v[2] * frame.rightZ),
      y: frame.cy - frame.r * (v[0] * frame.upX + v[1] * frame.upY + v[2] * frame.upZ),
      depth: v[0] * frame.fwdX + v[1] * frame.fwdY + v[2] * frame.fwdZ,
    }
  }
  if (frame.projection === 'mollweide') {
    const angle = mollweideAngle(v[2])
    return {
      x: frame.cx + frame.r * EDGE / Math.PI * fromCentre(frame, Math.atan2(v[1], v[0])) * Math.cos(angle),
      y: frame.cy - frame.r * (ROOT2 * Math.sin(angle) - frame.rise),
      depth: 1,
    }
  }
  const [px, py] = planeAt(v)
  return { x: frame.cx + frame.r * planeOffset(frame, px), y: frame.cy - frame.r * (py - frame.atY), depth: 1 }
}
/** The direction at a place on Mollweide's map, in sphere radii from its centre; null off the map. */
function onSky(frame: Pick<Frame, 'lon' | 'rise'>, across: number, up: number): Vec | null {
  const sine = (up + frame.rise) / ROOT2
  if (Math.abs(sine) > 1) return null
  const angle = Math.asin(sine), cos = Math.cos(angle)
  const lon = cos === 0 ? 0 : across * Math.PI / (EDGE * cos)
  if (Math.abs(lon) > Math.PI) return null
  const z = (2 * angle + Math.sin(2 * angle)) / Math.PI, phi = frame.lon + lon, flat = Math.sqrt(Math.max(0, (1 - z) * (1 + z)))
  return [flat * Math.cos(phi), flat * Math.sin(phi), z]
}

/** The vector under a screen point, or null off the sphere. */
export function invert(frame: Frame, sx: number, sy: number): Vec | null {
  const across = (sx - frame.cx) / frame.r, up = (frame.cy - sy) / frame.r
  if (frame.projection === 'plane') return onPlane(frame.atX + across, frame.atY + up)
  if (frame.projection === 'mollweide') return onSky(frame, across, up)
  const rest = 1 - across * across - up * up
  if (rest < 0) return null
  const depth = Math.sqrt(rest)
  return [
    across * frame.rightX + up * frame.upX + depth * frame.fwdX,
    across * frame.rightY + up * frame.upY + depth * frame.fwdY,
    across * frame.rightZ + up * frame.upZ + depth * frame.fwdZ,
  ]
}

/** The plane's camera wrapped to one turn east, its centre held so the plane fills the stage from top to bottom when it can, and is centred when it cannot. */
export function bounded(camera: Camera, { height }: Viewport): Camera {
  const most = Math.max(0, HALF_HEIGHT - height / 2 / camera.radius)
  return { ...camera, at: [wrapped(camera.at[0], PERIOD), Math.max(-most, Math.min(most, camera.at[1]))] }
}
/** A screen point in the camera's own axes on the unit sphere; off the globe, the nearest point of its rim. */
function onBall(camera: Camera, viewport: Viewport, sx: number, sy: number): Vec {
  const across = (sx - viewport.width / 2) / camera.radius, up = (viewport.height / 2 - sy) / camera.radius
  const out = across * across + up * up
  if (out <= 1) return [across, up, Math.sqrt(1 - out)]
  const scale = 1 / Math.sqrt(out)
  return [across * scale, up * scale, 0]
}
/** What the hand takes hold of at a screen point: off the globe, the rim nearest it, so a drag beside the sphere still turns it. */
export function grip(camera: Camera, projection: Projection, viewport: Viewport, sx: number, sy: number): Grip {
  if (projection === 'mollweide') {
    // Off the map, the nearest point of its rim along the line from the centre of the ellipse.
    const frame = frameOf(camera, projection, viewport), across = (sx - frame.cx) / frame.r, up = (frame.cy - sy) / frame.r
    const out = Math.hypot(across / EDGE, (up + frame.rise) / ROOT2), shrink = out > 1 ? (1 - 1e-9) / out : 1
    return onSky(frame, across * shrink, (up + frame.rise) * shrink - frame.rise)!
  }
  if (projection === 'plane') return [camera.at[0] + (sx - viewport.width / 2) / camera.radius, camera.at[1] + (viewport.height / 2 - sy) / camera.radius]
  return rotate(camera.turn, onBall(camera, viewport, sx, sy))
}

/**
 * The camera, at its own radius, that holds a grip at a screen point: on the
 * globe by the least turn, and then, when `upright` is given, turned about the
 * held point toward north up by that share of the turn just made, so north
 * rights itself only while the hand moves and the held point never slips.
 * The plane keeps as much of itself in view as the zoom allows.
 */
export function keeping(camera: Camera, projection: Projection, viewport: Viewport, held: Grip, sx: number, sy: number, upright = 0): Camera {
  if (projection === 'mollweide') {
    const [x, y, z] = held, across = (sx - viewport.width / 2) / camera.radius, up = (viewport.height / 2 - sy) / camera.radius
    const angle = mollweideAngle(z), centred = Math.asin(Math.max(-1, Math.min(1, Math.sin(angle) - up / ROOT2)))
    const lat = Math.asin(Math.max(-1, Math.min(1, (2 * centred + Math.sin(2 * centred)) / Math.PI)))
    return { ...camera, sky: [wrapped(Math.atan2(y, x) - across * Math.PI / (EDGE * Math.max(.05, Math.cos(angle))), 2 * Math.PI), lat] }
  }
  if (projection === 'plane') {
    const x = held[0] - (sx - viewport.width / 2) / camera.radius, y = held[1] - (viewport.height / 2 - sy) / camera.radius
    return bounded({ ...camera, at: [x, y] }, viewport)
  }
  const target = onBall(camera, viewport, sx, sy), seen = rotate(inverse(camera.turn), held as unknown as Vec)
  const step = between(seen, target)
  let turn = normal(times(camera.turn, inverse(step)))
  const moved = 2 * Math.acos(Math.min(1, Math.abs(step[0])))
  if (upright > 0 && moved > 0 && target[2] > 0) {
    const [nx, ny] = rotate(inverse(turn), [0, 0, 1]), lean = Math.atan2(nx, ny)
    const most = upright * moved * (nx * nx + ny * ny) * target[2]
    turn = normal(times(turn, inverse(about(target, Math.max(-most, Math.min(most, lean))))))
  }
  return { ...camera, turn }
}

/** The camera looking straight at a direction, north up, at a radius. */
export function facing(v: Vec, radius: number): Camera {
  const { lon, lat } = lonLat(v)
  return { turn: northUp(lon, lat), sky: [lon, lat], at: planeAt(v), radius }
}
/** The direction at the centre of a projection's view. */
function centreOf(camera: Camera, projection: Projection): Vec {
  if (projection === 'globe') return rotate(camera.turn, [0, 0, 1])
  if (projection === 'mollweide') return toVec(...camera.sky)
  const [px, py] = camera.at
  return onPlane(px, py) ?? toVec(px / PLANE_SCALE, Math.asin(Math.max(-1, Math.min(1, py / HALF_HEIGHT))))
}
/** The camera carried from one projection to another, looking where it looked. */
export function carried(camera: Camera, from: Projection, to: Projection): Camera {
  const { turn, sky, at } = facing(centreOf(camera, from), camera.radius)
  return to === 'globe' ? { ...camera, turn } : to === 'mollweide' ? { ...camera, sky } : { ...camera, at }
}

/** Flight's trade between zooming and panning, as in van Wijk & Nuij (2003). */
const RHO = Math.SQRT2

export interface Flight { at(t: number): Camera; ms: number }
const FLIGHT_MS = 520, FLIGHT_LEAST = 320, FLIGHT_MOST = 1200

/** The smooth path between two cameras, out, across and in, by the optimal zoom-and-pan path, with the sphere's radius never under `least`. */
export function flight(from: Camera, to: Camera, projection: Projection, viewport: Viewport, least: number): Flight {
  let distance: number, blend: (u: number) => Camera
  if (projection === 'globe') {
    const a = rotate(from.turn, [0, 0, 1]), b = rotate(to.turn, [0, 0, 1])
    distance = Math.atan2(Math.hypot(...cross(a, b)), dot(a, b))
    blend = u => ({ ...to, turn: slerp(from.turn, to.turn, u) })
  } else if (projection === 'mollweide') {
    const a = toVec(...from.sky), b = toVec(...to.sky)
    distance = Math.atan2(Math.hypot(...cross(a, b)), dot(a, b))
    blend = u => {
      if (distance < 1e-12) return { ...to, sky: from.sky }
      const s0 = Math.sin((1 - u) * distance) / Math.sin(distance), s1 = Math.sin(u * distance) / Math.sin(distance)
      const { lon, lat } = lonLat([s0 * a[0] + s1 * b[0], s0 * a[1] + s1 * b[1], s0 * a[2] + s1 * b[2]])
      return { ...to, sky: [lon, lat] }
    }
  } else {
    const dx = wrapped(to.at[0] - from.at[0], PERIOD), dy = to.at[1] - from.at[1]
    distance = Math.hypot(dx, dy)
    blend = u => ({ ...to, at: [wrapped(from.at[0] + u * dx, PERIOD), from.at[1] + u * dy] })
  }
  const wide = Math.min(viewport.width, viewport.height), w0 = wide / from.radius, w1 = wide / to.radius
  const settle = (t: number): number => t * t * (3 - 2 * t)
  if (distance < 1e-9 * Math.min(w0, w1)) {
    const rate = Math.log(w1 / w0)
    return { ms: Math.min(FLIGHT_MOST, Math.max(FLIGHT_LEAST, FLIGHT_MS * Math.abs(rate) / 2)), at: t => ({ ...blend(settle(t)), radius: wide / (w0 * Math.exp(rate * settle(t))) }) }
  }
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * distance * distance) / (2 * w0 * RHO * RHO * distance)
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * distance * distance) / (2 * w1 * RHO * RHO * distance)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const length = (r1 - r0) / RHO, cosh0 = Math.cosh(r0)
  return {
    ms: Math.min(FLIGHT_MOST, Math.max(FLIGHT_LEAST, FLIGHT_MS * Math.abs(length) / 2)),
    at: raw => {
      const t = settle(raw), s = t * length
      const u = w0 / (RHO * RHO * distance) * (cosh0 * Math.tanh(RHO * s + r0) - Math.sinh(r0))
      const w = w0 * cosh0 / Math.cosh(RHO * s + r0)
      return { ...blend(raw === 1 ? 1 : u), radius: raw === 1 ? to.radius : Math.max(least, wide / w) }
    },
  }
}
