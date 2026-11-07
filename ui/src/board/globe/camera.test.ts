import { describe, expect, it } from 'vitest'
import { cellCount, cellOf, centre, type Vec } from './healpix.js'
import { PERIOD, UPRIGHT, carried, mollweideAngle, facing, flight, frameOf, grip, invert, keeping, northUp, onPlane, planeAt, project, rotate, wholeRadius, type Camera, type Projection } from './camera.js'

const viewport = { width: 800, height: 1000 }
const unit = (lon: number, lat: number): Vec => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]
const closeTo = (a: Vec, b: Vec, digits: number): void => a.forEach((value, n) => expect(value).toBeCloseTo(b[n], digits))
const at = (lon: number, lat: number, radius: number): Camera => facing(unit(lon, lat), radius)
/** The camera turned about its line of sight. */
const rolled = (camera: Camera, angle: number): Camera => {
  const [w, x, y, z] = camera.turn, c = Math.cos(angle / 2), s = Math.sin(angle / 2)
  return { ...camera, turn: [w * c - z * s, x * c + y * s, y * c - x * s, z * c + w * s] }
}
/** How far north leans from straight up on screen, at the centre of the view; zero is upright. */
const lean = (camera: Camera): number => {
  const [w, x, y, z] = camera.turn, [nx, ny] = rotate([w, -x, -y, -z], [0, 0, 1])
  return Math.atan2(nx, ny)
}
const views: Array<[Projection, Camera]> = [
  ['globe', at(.7, .9, 380)],
  ['globe', at(-2, -1.4, 1e6)],
  ['globe', rolled({ turn: northUp(.4, Math.PI / 2), sky: [0, 0], at: [0, 0], radius: 500 }, 2)],
  ['mollweide', at(2, 0, 130)],
  ['mollweide', at(2, .6, 90_000)],
  ['plane', at(2, 0, 400)],
  ['plane', at(2, .6, 90_000)],
  ['plane', at(.3, 1.2, 4000)],
]

describe('the projections', () => {
  it('round-trips a point through the screen at every zoom', () => {
    for (const [projection, camera] of views) {
      const frame = frameOf(camera, projection, viewport)
      for (const [dx, dy] of [[0, 0], [40, 30], [-35, -60]]) {
        const point = invert(frame, 400 + dx, 500 + dy)!, screen = project(frame, point)
        expect(screen.x).toBeCloseTo(400 + dx, 6)
        expect(screen.y).toBeCloseTo(500 + dy, 6)
      }
    }
  })
  it('shows north at the top with east to the right', () => {
    const frame = frameOf(at(0, 0, 300), 'globe', viewport)
    expect(project(frame, [0, 0, 1]).x).toBeCloseTo(400)
    expect(project(frame, [0, 0, 1]).y).toBeCloseTo(200)
    expect(project(frame, [0, 1, 0]).x).toBeCloseTo(700)
    expect(project(frame, [-1, 0, 0]).depth).toBeCloseTo(-1)
  })
  it('looks straight down on the pole with the chosen meridian below', () => {
    const frame = frameOf({ turn: northUp(Math.PI / 4, Math.PI / 2), sky: [0, 0], at: [0, 0], radius: 300 }, 'globe', viewport)
    expect(project(frame, [0, 0, 1]).x).toBeCloseTo(400)
    expect(project(frame, [0, 0, 1]).y).toBeCloseTo(500)
    const below = project(frame, unit(Math.PI / 4, 0))
    expect(below.x).toBeCloseTo(400)
    expect(below.y).toBeCloseTo(800)
  })
  it('lays the plane out to the sphere\'s area, every cell a square diamond', () => {
    expect(wholeRadius('plane', viewport) * PERIOD).toBeCloseTo(772)
    for (const ipix of [0, 77, 191]) {
      const cell = cellOf(2, ipix), deep = 2 ** 18
      const corners = [[cell.x, cell.y], [cell.x + 1, cell.y], [cell.x + 1, cell.y + 1], [cell.x, cell.y + 1]]
        .map(([x, y]) => planeAt(centre({ order: 20, face: cell.face, x: Math.min(4 * deep - 1, x * deep), y: Math.min(4 * deep - 1, y * deep) })))
      const across = Math.hypot(corners[0][0] - corners[2][0], corners[0][1] - corners[2][1])
      const down = Math.hypot(corners[1][0] - corners[3][0], corners[1][1] - corners[3][1])
      expect(across * down / 2).toBeCloseTo(4 * Math.PI / cellCount(2), 3)
      expect(across).toBeCloseTo(down, 3)
    }
  })
  it('solves Mollweide\'s angle across the whole range, poles included', () => {
    for (const z of [-1, -.9999, -.5, 0, .3, .99, .99999, 1]) {
      const angle = mollweideAngle(z)
      expect((2 * angle + Math.sin(2 * angle)) / Math.PI).toBeCloseTo(z, 9)
    }
  })
  it('fits Mollweide\'s whole sky at half as much height as width', () => {
    const r = wholeRadius('mollweide', viewport), frame = frameOf(at(0, 0, r), 'mollweide', viewport)
    expect(project(frame, unit(Math.PI - 1e-9, 0)).x).toBeCloseTo(786)
    expect(project(frame, [0, 0, 1]).y).toBeCloseTo(500 - Math.SQRT2 * r)
  })
  it('finds nothing off the sphere, off the map, or in the plane\'s notches', () => {
    expect(invert(frameOf(at(0, 0, 100), 'globe', viewport), 5, 5)).toBeNull()
    expect(invert(frameOf(at(0, 0, 100), 'mollweide', viewport), 5, 5)).toBeNull()
    expect(onPlane(0, PERIOD / 4 * .99)).toBeNull()
    expect(onPlane(PERIOD / 8, PERIOD / 4 * .99)).not.toBeNull()
  })
})

describe('keeping a point under the pointer', () => {
  it('holds it exactly as the pointer moves, at any zoom and orientation, with north righting itself or not', () => {
    for (const upright of [0, UPRIGHT]) for (const [projection, camera] of views) {
      const held = grip(camera, projection, viewport, 430, 520), point = invert(frameOf(camera, projection, viewport), 430, 520)!
      let moving = camera
      for (const [sx, sy] of [[440, 510], [470, 480], [520, 540], [410, 530]]) {
        moving = keeping(moving, projection, viewport, held, sx, sy, upright)
        const seen = project(frameOf(moving, projection, viewport), point)
        expect(seen.x).toBeCloseTo(sx, 6)
        expect(seen.y).toBeCloseTo(sy, 6)
      }
    }
  })
  it('turns the globe right over the pole and on, the held point never slipping', () => {
    let camera = at(0, 1.2, 300)
    const held = grip(camera, 'globe', viewport, 400, 440)
    for (let y = 440; y <= 780; y += 5) {
      camera = keeping(camera, 'globe', viewport, held, 400, y, UPRIGHT)
      const seen = project(frameOf(camera, 'globe', viewport), held as unknown as Vec)
      expect(seen.x).toBeCloseTo(400, 6)
      expect(seen.y).toBeCloseTo(y, 6)
    }
    // The pole has passed below the centre: the view now looks from beyond it.
    expect(project(frameOf(camera, 'globe', viewport), [0, 0, 1]).y).toBeGreaterThan(500)
  })
  it('brings north upright only as the hand moves', () => {
    const tilted = rolled(at(.5, .3, 400), .6), held = grip(tilted, 'globe', viewport, 400, 500)
    expect(lean(tilted)).toBeCloseTo(.6, 6)
    expect(lean(keeping(tilted, 'globe', viewport, held, 400, 500, UPRIGHT))).toBeCloseTo(.6, 9)
    let camera = tilted
    for (let x = 400; x <= 760; x += 8) camera = keeping(camera, 'globe', viewport, held, x, 500, UPRIGHT)
    expect(lean(camera)).toBeGreaterThanOrEqual(0)
    expect(lean(camera)).toBeLessThan(.6 / 4)
  })
  it('takes hold of Mollweide\'s rim from beside the map', () => {
    const camera = at(0, 0, 100), held = grip(camera, 'mollweide', viewport, 5, 500) as unknown as Vec
    expect(Math.hypot(...held)).toBeCloseTo(1, 9)
    expect(project(frameOf(camera, 'mollweide', viewport), held).x).toBeCloseTo(400 - 2 * Math.SQRT2 * 100, 3)
  })
  it('turns from beside the sphere by its rim', () => {
    const camera = at(0, 0, 200), held = grip(camera, 'globe', viewport, 700, 500)
    expect(Math.abs(lean(keeping(camera, 'globe', viewport, held, 700, 650)))).toBeGreaterThan(.3)
  })
  it('holds a point through a zoom', () => {
    const camera = at(.3, .5, 500), held = grip(camera, 'globe', viewport, 300, 400)
    const seen = project(frameOf(keeping({ ...camera, radius: 50_000 }, 'globe', viewport, held, 300, 400), 'globe', viewport), held as unknown as Vec)
    expect(seen.x).toBeCloseTo(300, 6)
    expect(seen.y).toBeCloseTo(400, 6)
  })
  it('centres a deep cell at the pole', () => {
    const point = centre(cellOf(11, 3 * 4 ** 11 - 1))
    for (const projection of ['globe', 'plane'] as const) {
      const seen = project(frameOf(facing(point, 2e6), projection, viewport), point)
      expect(seen.x).toBeCloseTo(400, 3)
      expect(seen.y).toBeCloseTo(500, 3)
    }
  })
  it('carries the view between projections', () => {
    const plane = carried({ ...at(0, 0, 900), turn: at(1.1, .4, 900).turn }, 'globe', 'plane')
    closeTo(invert(frameOf(plane, 'plane', viewport), 400, 500)!, unit(1.1, .4), 9)
    const sky = carried(plane, 'plane', 'mollweide')
    closeTo(invert(frameOf(sky, 'mollweide', viewport), 400, 500)!, unit(1.1, .4), 9)
    closeTo(rotate(carried({ ...sky, turn: at(0, 0, 1).turn }, 'mollweide', 'globe').turn, [0, 0, 1]), unit(1.1, .4), 9)
  })
})

describe('a flight', () => {
  const from = rolled(at(0, 1, 386), 1), to = at(2.5, -.6, 90_000)
  const trip = flight(from, to, 'globe', viewport, 386)
  const centreOf = (camera: Camera): Vec => rotate(camera.turn, [0, 0, 1])
  it('starts and ends on its cameras, landing north up', () => {
    expect(trip.at(0).radius).toBeCloseTo(386, 3)
    closeTo(centreOf(trip.at(0)), unit(0, 1), 6)
    expect(trip.at(1)).toMatchObject({ radius: 90_000 })
    closeTo(centreOf(trip.at(1)), unit(2.5, -.6), 6)
    expect(lean(trip.at(1))).toBeCloseTo(0, 6)
  })
  it('never zooms out past the whole sphere, and moves without a jump', () => {
    let last = trip.at(0)
    for (let n = 1; n <= 200; n++) {
      const here = trip.at(n / 200), a = centreOf(here), b = centreOf(last)
      expect(here.radius).toBeGreaterThanOrEqual(386)
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * Math.min(here.radius, last.radius)).toBeLessThan(viewport.width * .7)
      last = here
    }
  })
  it('zooms in place when the centre does not move', () => {
    const still = flight(from, { ...from, radius: 7000 }, 'globe', viewport, 386)
    closeTo(centreOf(still.at(.5)), unit(0, 1), 9)
    expect(still.at(1).radius).toBeCloseTo(7000, 6)
  })
  it('crosses the plane\'s seam the short way', () => {
    const west: Camera = { ...from, at: [.1, 0] }, east: Camera = { ...from, at: [PERIOD - .1, 0] }
    const middle = flight(west, east, 'plane', viewport, 386).at(.5).at[0]
    expect(Math.min(Math.abs(middle), Math.abs(middle - PERIOD))).toBeLessThan(.11)
  })
})
