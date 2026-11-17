import { bezier, noise, ribbon, type Point } from '../ink.js'

/**
 * The constitution view's lines in the margin's fine ink: each orchestrator's
 * fibre leaves its dot, runs down past the strips below it, and curves into
 * the next level's dot; the constitution's own fibre leaves its dot and
 * branches into each of its threads' dots. Each fibre is in its thread's
 * identity colour; the dots keep the state.
 */

const SVG = 'http://www.w3.org/2000/svg'
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/** A dot to draw from or into: where it sits, and the hue of the thread whose fibre leaves it. */
export interface Knot { at: Point; hue: string; seed: string }

/** A fibre from `from` down and into `to`: straight down, then sweeping right into it, with a little wander. */
function fibre(from: Point, to: Point, seed: string, into = true): Point[] {
  const wander = noise(seed, 18), [ax, ay] = from, [bx, by] = to
  const turn = Math.min(14, Math.max(6, (by - ay) / 2))
  const down: Point[] = []
  for (let y = ay; y < by - turn; y += 3) down.push([ax + 0.7 * wander(y) * Math.min(1, (y - ay) / 12, (by - turn - y) / 12), y])
  const corner: Point = [ax, by - turn]
  const sweep = into ? bezier(corner, [ax, by - turn * 0.35], [ax + (bx - ax) * 0.3, by], [bx, by], 12) : bezier(corner, [ax, by - turn * 0.5], [bx, by - turn * 0.5], [bx, by], 12)
  return [...down, ...sweep]
}

/** One fibre as fine tapering ink in its thread's hue: full at its source, thinning toward where it ends. */
function ink(box: SVGSVGElement, points: readonly Point[], hue: string, weight: number): void {
  const d = ribbon(points, u => weight * (1 - 0.45 * u) * (0.8 + 0.2 * Math.sin(u * 9)))
  if (d) box.append(svg('path', { class: 'ov-fibre', 'data-hue': hue, d }))
}

/**
 * Adds the fibres of one region of the view to `box` (sized to it):
 * `chain` runs top to bottom, each knot's fibre into the next (the last into
 * `foot` when given, arriving straight down); `branches` are the knots one
 * fibre from `chain`'s last knot curves into, the trunk running down its left.
 */
export function drawFibres(box: SVGSVGElement, { chain, foot, branches = [], trunk, weight = 1.15 }: {
  chain: readonly Knot[]
  foot?: Point
  branches?: readonly Point[]
  /** The x the branches' trunk runs down. */
  trunk?: number
  weight?: number
}): void {
  chain.forEach((knot, k) => {
    const next = chain[k + 1]
    if (next) ink(box, fibre([knot.at[0], knot.at[1] + 4], [next.at[0] - 4.5, next.at[1]], knot.seed), knot.hue, weight)
    else if (foot) ink(box, fibre([knot.at[0], knot.at[1] + 4], foot, knot.seed, false), knot.hue, weight)
  })
  const root = chain.at(-1)
  if (!root || !branches.length || trunk === undefined) return
  const [hx, hy] = root.at
  // Out of the dot to the trunk, down it, and into each branch's dot; the last branch is the trunk's own end.
  const descent = bezier([hx - 2, hy + 4], [hx - 4, hy + 12], [trunk, hy + 8], [trunk, hy + 22], 10)
  const last = branches.at(-1)!
  ink(box, [...descent, ...fibre([trunk, hy + 22], [last[0] - 4.5, last[1]], `${root.seed}:trunk`).slice(1)], root.hue, weight)
  for (const [bx, by] of branches.slice(0, -1)) ink(box, bezier([trunk, by - 13], [trunk, by - 4], [trunk + (bx - trunk) * 0.35, by], [bx - 4.5, by], 12), root.hue, weight * 0.8)
}
