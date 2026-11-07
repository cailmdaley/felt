/** The placed tiles with what they stand for, in the shape painting, picking and labels read. */
import type { Attention, MapFile, MapThread, Standing } from '../family/model.js'
import { ATTENTION } from '../family/model.js'
import { assign, tilesOf, type Band, type Tile, type TileKind } from './assign.js'
import { persistentId, type Forest } from './forest.js'
import { centre, cellRadius, cellSpan, outline, type Cell, type Vec } from './healpix.js'
import { mollweideAngle } from './camera.js'

/** What a tile's colour says: a thread's state, or what kind of thing it is. */
export type Tone = Exclude<Standing, 'new'> | 'new' | 'land' | 'page'

/** A cell's outline at some detail, and the longitude and Mollweide angle of each point once a map has asked for them. */
export interface Trace { points: Float64Array; phi?: Float64Array; sin?: Float64Array; cos?: Float64Array }

export interface Body {
  tile: Tile
  key: string
  kind: TileKind
  cell: Cell
  band: Band
  centre: Vec
  /** The cell's width in radians, and the largest angle from its centre to its outline. */
  span: number
  radius: number
  parent: Body | null
  kids: Body[]
  thread?: MapThread
  /** The file behind a lead or file tile; a lead's arrives when read. */
  file?: MapFile
  name: string
  /** The thread's own colour. */
  tone: Tone
  /** The most urgent thing under it, which it shows while too small to open. */
  hottest: Tone
  /** How urgent `hottest` is: lower is more urgent. */
  urgency: number
  /** How recently it moved, from one for this hour to a half for a month ago or more. */
  heat: number
  traces: Map<number, Trace>
}

export const traceOf = (body: Body, step: number): Trace => {
  let trace = body.traces.get(step)
  if (!trace) { trace = { points: outline(body.cell, step) }; body.traces.set(step, trace) }
  return trace
}
/** Fills in the Mollweide numbers for an outline. */
export function chart(trace: Trace): Required<Trace> {
  if (!trace.phi) {
    const count = trace.points.length / 3
    trace.phi = new Float64Array(count); trace.sin = new Float64Array(count); trace.cos = new Float64Array(count)
    for (let n = 0; n < count; n++) {
      const x = trace.points[3 * n], y = trace.points[3 * n + 1], angle = mollweideAngle(trace.points[3 * n + 2])
      trace.phi[n] = Math.atan2(y, x); trace.sin[n] = Math.sin(angle); trace.cos[n] = Math.cos(angle)
    }
  }
  return trace as Required<Trace>
}

const CALM = ATTENTION.length + 2
const MONTH_HOURS_LOG = Math.log10(720)
const urgencyOf = (standing: Standing): number => {
  const at = (ATTENTION as readonly string[]).indexOf(standing)
  return at >= 0 ? at : standing === 'still' ? ATTENTION.length : standing === 'quiet' ? ATTENTION.length + 1 : CALM
}
const heatOf = (age: number): number => 1 - .5 * Math.min(1, Math.log10(1 + Math.max(0, age) / 3_600_000) / MONTH_HOURS_LOG)
const fileOf = (tile: Tile, owner: MapThread): MapFile | undefined => owner.files.find(file => tile.key.endsWith(`\u0000${file.key}`))

export interface Scene {
  roots: Body[]
  byKey: Map<string, Body>
  /** A thread's tile, by its persistent id. */
  threads: Map<string, Body>
  /** What asks, most urgent first, each with its tile. */
  asks: Body[]
  /** The greatest order in use. */
  deepest: number
}

/** The last part of a province's or an area's key is its name. */
const groundName = (key: string): string => key.split('\u0000').at(-1)!
const isGround = (tile: Tile): boolean => tile.kind === 'province' || tile.kind === 'area'

export function sceneOf(forest: Forest, now: number): Scene {
  const byKey = new Map<string, Body>(), threads = new Map<string, Body>(), roots: Body[] = []
  let deepest = 0
  for (const tile of tilesOf(assign(forest.projects))) {
    const up = tile.parent ? byKey.get(tile.parent.key)! : null
    const thread = tile.kind === 'thread' ? forest.threads.get(tile.key) : undefined
    const owner = up?.thread
    const file = tile.kind === 'file' ? fileOf(tile, owner!) : undefined
    const name = isGround(tile) ? groundName(tile.key) : thread?.name ?? file?.name ?? (tile.kind === 'constitution' ? 'Constitution' : tile.kind === 'lead' ? 'Tapestry' : '')
    const tone: Tone = thread ? thread.tone : isGround(tile) ? 'land' : tile.kind === 'file' && file?.unread ? 'new' : 'page'
    const body: Body = {
      tile, key: tile.key, kind: tile.kind, cell: tile.cell, band: tile.band, centre: centre(tile.cell), span: cellSpan(tile.cell.order), radius: cellRadius(tile.cell.order),
      parent: up, kids: [], thread, file, name,
      tone, hottest: thread ? (thread.standing === 'new' ? 'new' : thread.tone) : tone, urgency: thread ? urgencyOf(thread.standing) : CALM, heat: thread ? heatOf(now - thread.lastMove) : 1, traces: new Map(),
    }
    byKey.set(tile.key, body)
    if (thread) threads.set(tile.key, body)
    if (up) up.kids.push(body); else roots.push(body)
    deepest = Math.max(deepest, tile.cell.order)
  }
  const gather = (body: Body): void => {
    for (const kid of body.kids) {
      gather(kid)
      if (kid.urgency < body.urgency) { body.urgency = kid.urgency; body.hottest = kid.hottest }
    }
  }
  roots.forEach(gather)
  return { roots, byKey, threads, deepest, asks: forest.asks.flatMap(ask => { const body = threads.get(persistentId(ask.card)); return body ? [body] : [] }) }
}

export const askKind = (body: Body): Attention => body.thread!.standing as Attention
