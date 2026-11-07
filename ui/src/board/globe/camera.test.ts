import { describe, expect, it } from 'vitest'
import { centre, cellOf, type Vec } from './healpix.js'
import { flight, frameOf, invert, keeping, lonLat, mollweideAngle, project, wholeRadius, type Camera, type Projection } from './camera.js'

const viewport = { width: 800, height: 1000 }
const unit = (lon: number, lat: number): Vec => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
const closeTo = (a: Vec, b: Vec, digits: number): void => a.forEach((value, n) => expect(value).toBeCloseTo(b[n], digits))
const views: Array<[Projection, Camera]> = [
  ['globe', { lon: .7, lat: .9, radius: 380 }],
  ['globe', { lon: -2, lat: -1.4, radius: 1e6 }],
  ['mollweide', { lon: 2, lat: 0, radius: 130 }],
  ['mollweide', { lon: 2, lat: .6, radius: 90_000 }],
]

describe('the projections', () => {
  it('solves Mollweide\'s angle across the whole range, poles included', () => {
    for (const z of [-1, -.9999, -.5, 0, .3, .99, .99999, 1]) {
      const angle = mollweideAngle(z)
      expect((2 * angle + Math.sin(2 * angle)) / Math.PI).toBeCloseTo(z, 9)
    }
  })
  it('round-trips a point through the screen at every zoom', () => {
    for (const [projection, camera] of views) {
      const frame = frameOf(camera, projection, viewport), span = 200 / camera.radius
      for (const [dlon, dlat] of [[0, 0], [span, span / 2], [-span / 2, -span]]) {
        const point = unit(camera.lon + dlon, camera.lat + dlat), screen = project(frame, point)
        closeTo(invert(frame, screen.x, screen.y)!, point, 8)
      }
    }
  })
  it('shows north at the top with east to the right', () => {
    const frame = frameOf({ lon: 0, lat: 0, radius: 300 }, 'globe', viewport)
    expect(project(frame, [0, 0, 1])).toMatchObject({ x: 400, y: 200 })
    expect(project(frame, [0, 1, 0]).x).toBeCloseTo(700)
    expect(project(frame, [-1, 0, 0]).depth).toBe(-1)
  })
  it('fits the whole sphere, and Mollweide takes half as much height as width', () => {
    expect(wholeRadius('globe', viewport)).toBe(386)
    const r = wholeRadius('mollweide', viewport), frame = frameOf({ lon: 0, lat: 0, radius: r }, 'mollweide', viewport)
    expect(project(frame, unit(Math.PI - 1e-9, 0)).x).toBeCloseTo(786)
    expect(project(frame, [0, 0, 1]).y).toBeCloseTo(500 - Math.SQRT2 * r)
  })
  it('finds nothing off the sphere', () => {
    const frame = frameOf({ lon: 0, lat: 0, radius: 100 }, 'globe', viewport)
    expect(invert(frame, 5, 5)).toBeNull()
    expect(invert(frameOf({ lon: 0, lat: 0, radius: 100 }, 'mollweide', viewport), 5, 5)).toBeNull()
  })
})

describe('keeping a point under the pointer', () => {
  it('holds it exactly as the pointer moves, at any zoom', () => {
    for (const [projection, camera] of views) {
      const frame = frameOf(camera, projection, viewport), grabbed = invert(frame, 430, 520)!
      let moving = camera
      for (const [sx, sy] of [[440, 510], [470, 480], [520, 540], [410, 530]]) {
        moving = keeping(moving, projection, viewport, grabbed, sx, sy)
        const seen = project(frameOf(moving, projection, viewport), grabbed)
        expect(seen.x).toBeCloseTo(sx, projection === 'globe' ? 6 : 1)
        expect(seen.y).toBeCloseTo(sy, projection === 'globe' ? 6 : 1)
      }
    }
  })
  it('holds a point through a zoom', () => {
    const camera: Camera = { lon: .3, lat: .5, radius: 500 }, grabbed = invert(frameOf(camera, 'globe', viewport), 300, 400)!
    const closer = keeping({ ...camera, radius: 50_000 }, 'globe', viewport, grabbed, 300, 400)
    const seen = project(frameOf(closer, 'globe', viewport), grabbed)
    expect(seen.x).toBeCloseTo(300, 6)
    expect(seen.y).toBeCloseTo(400, 6)
  })
  it('stays north up on a deep cell at the pole', () => {
    const point = centre(cellOf(11, 3 * 4 ** 11 - 1))
    const camera = { ...lonLat(point), radius: 2e6 }, frame = frameOf(camera, 'globe', viewport)
    const seen = project(frame, point)
    expect(seen.x).toBeCloseTo(400, 4)
    expect(seen.y).toBeCloseTo(500, 4)
  })
})

describe('a flight', () => {
  const from: Camera = { lon: 0, lat: 1, radius: 386 }, to: Camera = { lon: 2.5, lat: -.6, radius: 90_000 }
  const trip = flight(from, to, viewport, 386)
  it('starts and ends on its cameras', () => {
    expect(trip.at(0).radius).toBeCloseTo(386, 3)
    expect(trip.at(0).lat).toBeCloseTo(1, 6)
    expect(trip.at(1)).toMatchObject({ radius: 90_000 })
    expect(trip.at(1).lon).toBeCloseTo(2.5, 6)
  })
  it('never zooms out past the whole sphere, and moves without a jump', () => {
    let last = trip.at(0)
    for (let n = 1; n <= 200; n++) {
      const here = trip.at(n / 200)
      expect(here.radius).toBeGreaterThanOrEqual(386)
      const step = Math.hypot(here.lat - last.lat, Math.sin(here.lon - last.lon)) * Math.min(here.radius, last.radius)
      expect(step).toBeLessThan(viewport.width * .7)
      last = here
    }
  })
  it('zooms in place when the centre does not move', () => {
    const still = flight(from, { ...from, radius: 7000 }, viewport, 386)
    expect(still.at(.5).lat).toBeCloseTo(1, 9)
    expect(still.at(1).radius).toBeCloseTo(7000, 6)
  })
})
