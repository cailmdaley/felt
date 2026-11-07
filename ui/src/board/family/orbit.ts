import { needsHuman, type FamilyModel, type MapThread } from './model.js'
import { held, WHOLE, type View } from './zoom.js'
import { heldTitle, miniature, unfold, type Mini, type Satellite } from './locality.js'
import { elapsed, htmlEl, markPath, optionFor, part, reconcile, shortAgo, svgEl, tagThread, type Point, type Sight } from './drawing.js'

/** The radial drawing's plate and its painting: bodies, arms, names, and what the focused thread holds. */
export const TURN = 2 * Math.PI
export const LABEL_HEIGHT = 24
/** A serif name's width per character, kept generous so its line always holds it. */
const LABEL_CHAR = 6.5
/** What a name's numeral takes beside it, and what its age and file count take at its end. */
const LABEL_RANK = 22
const LABEL_AGE = 34
const LABEL_FILES = 28
const LABEL_GAP = 7
/** How far a name may lift off its body's line to clear the arm, and how much of its row's height is air a line may pass through. */
const NUDGES: readonly number[] = [0, 5, 10, 15]
const LINE_INSET = 4
const MARGIN = 8
const NUMERAL = 19
/** A body's step along the rim past its arm's end, and along a phone's arm. */
export const RIM_STEP = 24
/** A miniature's button, as family-map.css sets it. */
const MINI_MARK = 14
const BODY_MAX = 15
const BODY_LEAST = 2
const DOT_LEAST = 1.2
/** The room a body has on the plate, in pixels, before its threads show as dots, as bodies with arms, and with what it holds in miniature. */
const DOTS_FROM = 60
const BODIES_FROM = 110
const MINIS_FROM = 60
/** A body's arms take their true size from this room, and fade out once their scene outgrows this many plates. */
const ARMS_FROM = 16
const ARMS_FADE = 1.3
const ARMS_GONE = 2.4
/** How far from the plate's middle a body can be and still be the one a hand has zoomed to, as a share of the plate. */
const SIGHT = .45
/** How much of the plate a thread's scene must fill to be the one in sight, and for its things to take their names. */
const SIGHT_FILL = .55
const NAMED_FILL = .7
/** How many bodies in view show what they hold. */
const MINIS = 8
const ARM_NAME_RISE = 9
const TITLE_MOST = 340
/** How far out from a focused body its life begins. */
const LIFE_GAP = 9
const ARM_NAME_WIDTH = 110

export type Side = 'left' | 'right'
/** The size of the plate and the shape of the arms on it, the same for every scene. */
export interface Frame {
  width: number
  height: number
  cx: number
  cy: number
  /** How far an arm reaches from its centre. */
  reach: number
  /** How much wider than tall the arms run. */
  stretch: number
  narrow: boolean
}
/** A length of arm: from the body before it, or the centre, to a body. */
export interface Segment { id: string; tone: MapThread['tone']; quiet: boolean; d: string; way: Point[]; links: string[] }
export interface Star extends Point {
  thread: MapThread
  owner: Star | null
  arm: 'todo' | 'done' | null
  side: Side
  numeral: number
  /** Its radius on the field, on its orchestrator's scale. */
  r: number
  /** Its radius on its orchestrator's arm, and in its own scene. */
  full: number
  own: number
  /** Its room for its own scene, on the field. */
  room: number
  /** The field's scale of its own scene, so zooming by the inverse brings that scene to the plate. */
  scale: number
  /** Its own arms, in its scene's coordinates. */
  segments: Segment[]
}
export interface Plate extends Frame {
  stars: Star[]
  armNames: Readonly<Record<'todo' | 'done', string>>
}
/** A star as the view has it. */
export interface Seen extends Star {
  /** A dot in a room too small for its body, and too small even for that. */
  inert: boolean
  hidden: boolean
  focus: boolean
}
export interface SkyLabel extends Point, Fit { thread: MapThread; numeral: number; side: Side }
export interface SkyNumeral extends Point { thread: MapThread; numeral: number }
export interface SkyArm { key: string; at: Point; scale: number; opacity: number; segments: Segment[] }
export interface ArmName extends Point { label: string; side: Side }
/** The plate through a view. */
export interface Sky {
  k: number
  frame: Frame
  stars: Seen[]
  arms: SkyArm[]
  labels: SkyLabel[]
  numerals: SkyNumeral[]
  names: ArmName[]
  /** The thread in sight, with its things and its title, once its scene fills the plate. */
  focus: { thread: MapThread; at: Point; held: Satellite[]; title: Point & { width: number } } | null
  minis: Mini[]
  /** On a phone, what stands under the disc: the thread in sight, and its own threads. */
  ledger: { thread: MapThread; held: Satellite[]; threads: MapThread[] }
}

/** A body's radius from its work: a thread or, one scale up, a whole family. */
export const bodySize = (work: number): number => 2.2 + Math.sqrt(work) * 1.05
export const bodyRadius = (thread: MapThread, unit: number): number => {
  if (thread.merged) return unit * Math.max(3, Math.min(BODY_MAX, bodySize(thread.weight)))
  return unit * Math.max(thread.tone === 'question' || thread.tone === 'blocked' ? 7 : needsHuman(thread) ? 5.5 : thread.standing === 'working' ? 4 : 2.2, Math.min(BODY_MAX, bodySize(thread.weight)))
}
export const ownRadius = (thread: MapThread): number => Math.min(28, 10 + bodySize(thread.weight) * .8)
export const rootRadius = (model: FamilyModel, unit: number): number => unit * Math.min(28, 8 + bodySize(model.mass) * .8)

/** Where a long name may stop and still read whole: at its punctuation, else ahead of a joining word. */
const CLAUSE = /\s[—–-]\s|\s·\s|[:;,.]\s|\s\(|\s↔\s/g
const JOIN = /\s(?:and|with|on|for|in|to|through|from|by|at|into|via|under|after|before|that|so|while|against|across|of|or|as)\s/g
/** Words a stopped name must not end on. */
const DANGLING = /\s(?:the|a|an|its|their|our|and|or|of|to|in|on|for|with)$/
const SHORTEST = 12
const stops = (name: string, pattern: RegExp, most: number): number[] => [...name.matchAll(pattern)].map(match => match.index).filter(at => at >= SHORTEST && at <= most)

/**
 * A name told in at most `most` characters: whole when it fits, else up to the
 * last clause that does, else up to a joining word, else up to a word. Thread
 * names are often sentences; the first clause says what the thread is, and the
 * peek and the page carry the rest.
 */
export function spokenName(name: string, most: number): string {
  if (name.length <= most) return name
  const at = stops(name, CLAUSE, most).at(-1) ?? stops(name, JOIN, most).at(-1) ?? name.lastIndexOf(' ', most)
  return at < SHORTEST ? '' : name.slice(0, at).replace(DANGLING, '')
}

/** A name's line in a label of this width: what it says, and the marks beside it there is room for. */
export interface Fit { text: string; width: number; files: boolean }
export function labelFit(thread: MapThread, room: number): Fit | undefined {
  const text = spokenName(thread.name, Math.floor((room - LABEL_RANK - LABEL_AGE) / LABEL_CHAR))
  if (!text) return undefined
  const used = LABEL_RANK + LABEL_AGE + text.length * LABEL_CHAR, files = !!thread.files.length && used + LABEL_FILES <= room
  return { text, files, width: used + (files ? LABEL_FILES : 0) }
}

interface Box { left: number; right: number; top: number; bottom: number }
const touches = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const labelBox = (label: Pick<SkyLabel, 'x' | 'y' | 'width' | 'side'>): Box => ({
  left: label.side === 'right' ? label.x : label.x - label.width, right: label.side === 'right' ? label.x + label.width : label.x, top: label.y - LABEL_HEIGHT / 2 + .5, bottom: label.y + LABEL_HEIGHT / 2 - .5,
})

/** Each name on the side of its body its arm runs out to, else the other, clear of every other name, body and line, or not at all. */
export function nearLabels(stars: readonly Seen[], named: readonly Seen[], frame: Frame, reserved: readonly Box[], lines: readonly Point[]): SkyLabel[] {
  const placed: Box[] = [...reserved], labels: SkyLabel[] = []
  const clear = (box: Box, own: Seen): boolean => !placed.some(other => touches(box, other))
    && !lines.some(({ x, y }) => x > box.left && x < box.right && y > box.top + LINE_INSET && y < box.bottom - LINE_INSET)
    && stars.every(star => star === own || star.inert || !touches(box, { left: star.x - star.r, right: star.x + star.r, top: star.y - star.r, bottom: star.y + star.r }))
  for (const star of named) {
    const out = star.arm === 'done' ? 1 : -1
    search: for (const side of [star.side, star.side === 'left' ? 'right' as const : 'left' as const]) {
      for (const nudge of NUDGES) {
        const x = side === 'right' ? star.x + star.r + LABEL_GAP : star.x - star.r - LABEL_GAP
        const fit = labelFit(star.thread, side === 'right' ? frame.width - MARGIN - x : x - MARGIN)
        if (!fit) continue
        const label = { thread: star.thread, numeral: star.numeral, x, y: star.y + out * nudge, side, ...fit }
        const box = labelBox(label)
        if (box.top < 0 || box.bottom > frame.height || !clear(box, star)) continue
        placed.push(box)
        labels.push(label)
        break search
      }
    }
  }
  return labels
}

/** The view that brings a thread's own scene to the plate, at the size every scene has. */
export function aim(plate: Plate, thread: MapThread): View {
  const star = plate.stars.find(item => item.thread === thread)
  if (!star) return WHOLE
  const k = 1 / star.scale
  return held({ k, x: (plate.cx - star.x * k) / plate.width, y: (plate.cy - star.y * k) / plate.height })
}
/** The thread a hand has zoomed to, the deepest whose scene fills the plate around its middle, `kept` while it does; null for the whole family. */
export function sighted(plate: Plate, view: View, kept: string | null): string | null {
  const off = (star: Star): number => Math.max(Math.abs(star.x / plate.width * view.k + view.x - .5), Math.abs(star.y / plate.height * view.k + view.y - .5))
  const near = plate.stars.filter(star => star.owner && off(star) <= SIGHT && star.scale * view.k >= SIGHT_FILL)
  const deepest = near.reduce<Star | null>((best, star) => !best || star.scale < best.scale ? star : best, null)
  return near.find(star => star.thread.key === kept && star.scale * view.k <= 2)?.thread.key ?? deepest?.thread.key ?? null
}

/**
 * The plate through a view: its geometry scaled, its marks their reading size,
 * and what shows growing with the room each body has. A scene's threads are
 * dots until the room around them can hold them, then bodies on their arms; the
 * thread in sight takes its title and the names of what it holds as its scene
 * reaches the plate; every body in view takes a name where it has room.
 */
export function zoomPlate(plate: Plate, view: View, model: FamilyModel, sight: Sight | null): Sky {
  const { k } = view, { width, height, reach, narrow } = plate, dx = view.x * width, dy = view.y * height
  const onPlate = (star: Star): Point => ({ x: star.x * k + dx, y: star.y * k + dy })
  const focusKey = sight?.key ?? model.root.key
  const stars = plate.stars.map((star): Seen => {
    const room = star.room * k, fill = room / reach, inert = !!star.owner && star.owner.room * k < BODIES_FROM
    return {
      ...star, ...onPlate(star), room, inert, focus: star.thread.key === focusKey, hidden: !!star.owner && star.owner.room * k < DOTS_FROM,
      r: Math.max(inert ? DOT_LEAST : BODY_LEAST, Math.min(star.r * k, Math.max(inert ? star.full * star.owner!.room * k / BODIES_FROM : star.full, star.own * Math.min(1, fill)))),
    }
  })
  const seen = stars.find(star => star.focus) ?? stars[0]
  const under = (star: Star): boolean => star.thread === seen.thread || (!!star.owner && under(star.owner))
  const inView = (star: Point): boolean => star.x >= 0 && star.x <= width && star.y >= 0 && star.y <= height
  const fill = seen.room / reach, named = fill >= NAMED_FILL && !narrow && (inView(seen))
  if (named) for (const star of stars) star.hidden ||= !under(star)
  const holds = sight?.holds(seen.thread) ?? {}
  const held = narrow ? unfold(seen.thread, holds, plate, { x: 0, y: 0 }, reach) : named ? unfold(seen.thread, holds, plate, seen, reach).filter(item => inView(item)) : []
  const title = named ? { ...heldTitle(seen, reach), width: Math.min(TITLE_MOST, width - seen.x - MARGIN) } : null
  const titled = named && title && title.y >= 0 ? title : null
  const taken: Box[] = narrow ? [] : [
    ...held.map(item => ({ left: item.side === 'right' ? item.x - 8 : item.x - item.room, right: item.side === 'right' ? item.x + item.room : item.x + 8, top: item.y - 12, bottom: item.y + 12 })),
    ...(titled ? [{ left: titled.x, right: titled.x + titled.width, top: titled.y - 4, bottom: titled.y + 40 }] : []),
  ]
  const arms = stars.filter(star => star.segments.length && !star.hidden && star.room >= ARMS_FROM && star.room < ARMS_GONE * reach).map((star): SkyArm => {
    const small = star.room < BODIES_FROM ? (star.r + LABEL_GAP) / reach : k * star.scale
    return { key: star.thread.key, at: star, scale: Math.min(small, k * star.scale), segments: star.segments, opacity: Math.min(1, (ARMS_GONE * reach - star.room) / ((ARMS_GONE - ARMS_FADE) * reach)) }
  })
  const nameable = stars.filter(star => star.owner && !star.inert && !star.hidden && !star.focus && inView(star)).sort((a, b) => b.owner!.room - a.owner!.room || (a.thread.rank < 0 ? Infinity : a.thread.rank) - (b.thread.rank < 0 ? Infinity : b.thread.rank))
  const asking = nameable.filter(star => needsHuman(star.thread))
  const minis = narrow ? [] : nameable.filter(star => star.room >= MINIS_FROM).slice(0, MINIS).map(star => miniature(star.thread, sight?.holds(star.thread) ?? {}, star, star.room))
  const lines = arms.flatMap(arm => arm.segments.flatMap(segment => segment.way.map(point => ({ x: arm.at.x + point.x * arm.scale, y: arm.at.y + point.y * arm.scale }))))
  const labels = narrow ? [] : nearLabels(stars, nameable, plate, taken, lines)
  const names: ArmName[] = []
  if (named && !narrow) {
    for (const arm of ['todo', 'done'] as const) {
      const on = stars.filter(star => star.owner?.thread === seen.thread && star.arm === arm)
      const last = on.filter(star => star.side === (arm === 'todo' ? 'left' : 'right')).at(-1)
      if (!last) continue
      const label = labels.find(item => item.thread === last.thread), edge = label ? labelBox(label) : { top: last.y - last.r, bottom: last.y + last.r }
      const name = { label: `${plate.armNames[arm]} · ${on.length}`, side: last.side, x: last.x + (last.side === 'left' ? -last.r - LABEL_GAP : last.r + LABEL_GAP), y: arm === 'todo' ? edge.top - ARM_NAME_RISE : edge.bottom + ARM_NAME_RISE }
      const box = { left: name.side === 'left' ? name.x - ARM_NAME_WIDTH : name.x, right: name.side === 'left' ? name.x : name.x + ARM_NAME_WIDTH, top: name.y - ARM_NAME_RISE, bottom: name.y + ARM_NAME_RISE }
      if (box.top >= 0 && box.bottom <= height && ![...taken, ...labels.map(labelBox)].some(other => touches(box, other)) && !lines.some(({ x, y }) => x > box.left && x < box.right && y > box.top && y < box.bottom)) names.push(name)
    }
  }
  return {
    k, frame: plate, stars, arms, names, minis, labels,
    numerals: narrow ? asking.map(star => {
      const out = Math.hypot(star.x - seen.x, star.y - seen.y) || 1
      return { thread: star.thread, numeral: star.thread.rank + 1, x: star.x + (star.x - seen.x) / out * (star.r + 9), y: star.y + (star.y - seen.y) / out * (star.r + 9) }
    }) : [],
    focus: titled ? { thread: seen.thread, at: seen, held, title: titled } : null,
    ledger: { thread: seen.thread, held: narrow ? held : [], threads: narrow ? plate.stars.filter(star => star.owner?.thread === seen.thread).map(star => star.thread) : [] },
  }
}


/** The arms in view, each scene's in its own coordinates, moved whole as the field moves. */
function drawArms(layer: SVGGElement, sky: Sky): void {
  reconcile(layer, sky.arms, arm => arm.key, () => svgEl('g', 'fm-arm'), (group, arm) => {
    group.setAttribute('data-owner', arm.key)
    group.style.transform = `translate(${arm.at.x.toFixed(1)}px, ${arm.at.y.toFixed(1)}px) scale(${arm.scale.toFixed(5)})`
    group.style.opacity = arm.opacity.toFixed(2)
    reconcile(group, arm.segments, segment => segment.id, () => {
      const path = svgEl('path', 'fm-reach'); path.setAttribute('vector-effect', 'non-scaling-stroke')
      return path
    }, (path, segment) => {
      if (path.getAttribute('d') !== segment.d) path.setAttribute('d', segment.d)
      path.setAttribute('data-standing', segment.tone)
      path.toggleAttribute('data-quiet', segment.quiet)
      path.setAttribute('data-link', segment.links.join('\n'))
    })
  })
}

function drawStars(layer: SVGGElement, sky: Sky, model: FamilyModel): void {
  reconcile(layer, sky.stars, item => item.thread.key, () => {
    const group = svgEl('g', 'fm-star')
    const hit = svgEl('circle', 'fm-star-hit'), halo = svgEl('circle', 'fm-star-halo'), ring = svgEl('circle', 'fm-star-ring'), body = svgEl('path', 'fm-star-mark'), fresh = svgEl('path', 'fm-star-fresh')
    group.append(hit, halo, ring, body, fresh)
    return group
  }, (group, item) => {
    const { thread, r } = item
    tagThread(group, thread)
    optionFor(group, thread, model)
    group.toggleAttribute('data-root', thread === model.root)
    group.toggleAttribute('data-merged', thread.merged)
    group.toggleAttribute('data-focus', item.focus)
    group.toggleAttribute('data-inert', item.inert)
    group.toggleAttribute('data-hidden', item.hidden)
    group.toggleAttribute('data-current', thread.key === model.current && thread !== model.root)
    group.style.transform = `translate(${item.x.toFixed(1)}px, ${item.y.toFixed(1)}px)`
    group.style.setProperty('--fm-heat', (1 - Math.sqrt(Math.max(0, model.now - thread.lastMove) / (6 * 86_400_000))).toFixed(2))
    group.style.setProperty('--fm-r', r.toFixed(2))
    const moved = String(thread.lastMove), before = group.getAttribute('data-moved')
    if (before !== moved) {
      group.setAttribute('data-moved', moved)
      if (before) { group.removeAttribute('data-stirred'); void (group as unknown as HTMLElement).getBoundingClientRect(); group.setAttribute('data-stirred', '') }
    }
    const [hit, halo, ring, body, fresh] = group.children
    hit.setAttribute('r', String(item.inert ? 0 : sky.frame.narrow ? r + 10 : Math.max(r + 4, 9)))
    halo.setAttribute('r', String(r + 5))
    ring.setAttribute('r', String(Math.max(r + 7, 7)))
    body.setAttribute('d', markPath(thread.standing === 'blocked' ? 'blocked' : 'turn', r))
    fresh.setAttribute('d', thread.fresh && !item.inert ? markPath('new', 3.6) : '')
    fresh.setAttribute('transform', `translate(${(r * .75 + 3).toFixed(1)} ${(-r * .75 - 3).toFixed(1)})`)
  })
}

/** Radial ticks for moments around a body, clockwise from now at the top, on the map's square-root time. */
function lifePath(times: readonly number[], now: number, inner: number, outer: number): string {
  return times.map(at => {
    const angle = TURN * (elapsed(at, now) - .25), x = Math.cos(angle), y = Math.sin(angle)
    return `M${(x * inner).toFixed(1)} ${(y * inner).toFixed(1)}L${(x * outer).toFixed(1)} ${(y * outer).toFixed(1)}`
  }).join('')
}
/** The focused thread's life as a ring about its body: launches outermost, commits within them, sent files bright between. */
function drawLife(layer: SVGGElement, sky: Sky, model: FamilyModel): void {
  const local = sky.focus, body = local ? sky.stars.find(star => star.thread === local.thread)! : null
  reconcile(layer, local ? [local] : [], () => 'life', () => {
    const group = svgEl('g', 'fm-life')
    group.append(svgEl('path', 'fm-life-commits'), svgEl('path', 'fm-life-launches'), svgEl('path', 'fm-life-files'))
    return group
  }, (group, item) => {
    const base = body!.r + LIFE_GAP, [commits, launches, files] = group.children, { thread, at } = item
    tagThread(group, thread)
    group.removeAttribute('data-thread')
    group.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`
    commits.setAttribute('d', lifePath(thread.commits, model.now, base, base + 4))
    files.setAttribute('d', lifePath(thread.files.map(file => file.at), model.now, base + 4.5, base + 7.5))
    launches.setAttribute('d', lifePath(thread.launches, model.now, base + 8, base + 13))
  })
}

/** Sets text only when it differs, so a repaint a frame costs no layout. */
function setText(el: Element, text: string): void { if (el.textContent !== text) el.textContent = text }

/** A sheet with its corner turned: a thing a thread holds. */
const SHEET = 'M-4.5 -6.5H2L4.5 -4V6.5H-4.5ZM2 -6.5V-4H4.5'
function heldMark(): SVGSVGElement {
  const sheet = svgEl('svg', 'fm-held-mark'), page = svgEl('path', 'fm-held-sheet'), fresh = svgEl('path', 'fm-held-new')
  sheet.setAttribute('viewBox', '-8 -8 16 16'); sheet.setAttribute('aria-hidden', 'true')
  page.setAttribute('d', SHEET); fresh.setAttribute('d', markPath('new', 2.9)); fresh.setAttribute('transform', 'translate(5 -5.5)')
  sheet.append(page, fresh)
  return sheet
}

function drawLabels(layer: HTMLElement, numerals: HTMLElement, sky: Sky, model: FamilyModel): void {
  reconcile(layer, sky.labels, label => label.thread.key, () => {
    const el = htmlEl('div', 'fm-label'), text = htmlEl('div', 'fm-label-text'), files = htmlEl('span', 'fm-label-files')
    files.append(heldMark(), htmlEl('span'))
    text.append(htmlEl('span', 'fm-label-name'), ' ', htmlEl('span', 'fm-label-age'), ' ', files)
    el.append(htmlEl('span', 'fm-label-rank'), text)
    return el
  }, (el, label) => {
    tagThread(el, label.thread)
    el.dataset.side = label.side
    el.style.transform = `translate(${(label.side === 'right' ? label.x : label.x - label.width).toFixed(1)}px, ${(label.y - LABEL_HEIGHT / 2).toFixed(1)}px)`
    el.style.width = `${Math.round(label.width)}px`
    const [rank, text] = el.children, [name, age, files] = text.children
    setText(rank, label.numeral ? String(label.numeral) : '')
    setText(name, label.text)
    setText(age, shortAgo(label.thread.lastMove, model.now))
    ;(files as HTMLElement).hidden = !label.files
    setText(files.lastElementChild!, String(label.thread.files.length))
  })
  reconcile(numerals, sky.numerals, numeral => numeral.thread.key, () => htmlEl('div', 'fm-numeral'), (el, numeral) => {
    tagThread(el, numeral.thread)
    setText(el, String(numeral.numeral))
    el.style.transform = `translate(${(numeral.x - NUMERAL / 2).toFixed(1)}px, ${(numeral.y - NUMERAL / 2).toFixed(1)}px)`
  })
}

const heldId = (item: Satellite): string => item.file?.key ?? 'more'
function heldWay(item: Satellite): HTMLElement {
  const way = item.file ? htmlEl('button', 'fm-held') : htmlEl('div', 'fm-held')
  if (item.file) (way as HTMLButtonElement).type = 'button'
  way.append(heldMark(), htmlEl('span', 'fm-held-name'), htmlEl('span', 'fm-held-age'))
  return way
}
function fillHeld(way: HTMLElement, item: Satellite, owner: MapThread, model: FamilyModel): void {
  way.dataset.side = item.side
  way.dataset.kind = item.kind
  way.toggleAttribute('data-unread', !!item.file?.unread)
  if (item.file) { way.dataset.held = item.file.key; way.dataset.owner = owner.key }
  const [, name, age] = way.children
  setText(name, item.file?.name ?? `+${item.more} more`)
  setText(age, item.file?.at ? shortAgo(item.file.at, model.now) : '')
}
/** What the thread in sight holds, a named way to each thing at its place, and every other body's in miniature. */
function drawHeld(layer: HTMLElement, sky: Sky, model: FamilyModel): void {
  const local = sky.focus
  reconcile(layer, local?.held ?? [], heldId, heldWay, (way, item) => {
    const right = item.side === 'right', width = Math.round(item.room) + 8
    fillHeld(way, item, local!.thread, model)
    way.style.width = `${width}px`
    way.style.transform = `translate(${(right ? item.x - 8 : item.x + 8 - width).toFixed(1)}px, ${(item.y - 12).toFixed(1)}px)`
  })
  reconcile(part(layer.parentElement!, 'fm-minis', cls => htmlEl('div', cls)), sky.minis, mini => mini.thread.key, () => htmlEl('div', 'fm-mini-set'), (set, mini) => {
    set.dataset.owner = mini.thread.key
    reconcile(set, mini.marks, item => item.file.key, () => {
      const way = htmlEl('button', 'fm-mini'); way.type = 'button'
      way.append(heldMark())
      return way
    }, (way, item) => {
      way.dataset.held = item.file.key
      way.dataset.owner = mini.thread.key
      way.dataset.kind = item.kind
      way.title = item.file.name
      way.setAttribute('aria-label', `${item.file.name}, ${mini.thread.name}`)
      way.toggleAttribute('data-unread', item.file.unread)
      way.style.transform = `translate(${(item.x - MINI_MARK / 2).toFixed(1)}px, ${(item.y - MINI_MARK / 2).toFixed(1)}px)`
    })
  })
  reconcile(part(layer.parentElement!, 'fm-focus-names', cls => htmlEl('div', cls)), local ? [local] : [], () => 'focus', () => {
    const el = htmlEl('div', 'fm-focus')
    el.append(htmlEl('span', 'fm-focus-name'), htmlEl('span', 'fm-focus-state'))
    return el
  }, (el, item) => {
    tagThread(el, item.thread)
    el.style.width = `${Math.round(item.title.width)}px`
    el.style.transform = `translate(${item.title.x.toFixed(1)}px, ${item.title.y.toFixed(1)}px)`
    const [name, state] = el.children
    setText(name, spokenName(item.thread.name, Math.floor(item.title.width / LABEL_CHAR)) || item.thread.name)
    setText(state, `${item.thread.word} · ${shortAgo(item.thread.lastMove, model.now)}`)
  })
}

/** The arms' names, over the far end of each. */
function drawArmNames(layer: HTMLElement, sky: Sky): void {
  reconcile(layer, sky.names, arm => arm.side, arm => htmlEl('div', 'fm-arm-name', arm.label), (el, arm) => {
    setText(el, arm.label)
    el.dataset.side = arm.side
    el.style.transform = `translate(${arm.x.toFixed(1)}px, ${arm.y.toFixed(1)}px)`
  })
}

/** Under a phone's disc: the thread in sight's own threads in the order to look at them, then what it holds. */
function drawLedger(layer: HTMLElement, sky: Sky, model: FamilyModel): void {
  const { thread, held: items, threads } = sky.ledger
  const rows = part(layer, 'fm-ledger-threads', cls => htmlEl('div', cls))
  reconcile(part(layer, 'fm-ledger-held', cls => htmlEl('div', cls)), items, heldId, heldWay, (way, item) => fillHeld(way, item, thread, model))
  reconcile(rows, threads, item => item.key, () => {
    const row = htmlEl('div', 'fm-ledger-row')
    const body = svgEl('svg', 'fm-ledger-mark'); body.setAttribute('viewBox', '-8 -8 16 16'); body.append(svgEl('path'))
    row.append(htmlEl('span', 'fm-ledger-rank'), body, htmlEl('span', 'fm-ledger-name'), htmlEl('span', 'fm-ledger-age'))
    return row
  }, (row, item) => {
    tagThread(row, item)
    const [rank, body, name, age] = row.children
    setText(rank, needsHuman(item) ? String(item.rank + 1) : '')
    body.firstElementChild!.setAttribute('d', markPath(item.tone, 5))
    setText(name, item.name)
    setText(age, shortAgo(item.lastMove, model.now))
  })
}

/** Paints the plate through a view into the host, keeping every element it can. */
export function paintPlate(host: HTMLElement, sky: Sky, model: FamilyModel): void {
  const frame = part(host, 'fm-sky-plate', cls => htmlEl('div', cls)), { width, height } = sky.frame
  host.classList.toggle('family-map-zoomed', sky.k > 1)
  frame.style.height = `${height}px`
  const svg = part(frame, 'fm-sky-svg', cls => svgEl('svg', cls))
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  drawArms(part(svg, 'fm-arms', cls => svgEl('g', cls)), sky)
  drawLife(part(svg, 'fm-lives', cls => svgEl('g', cls)), sky, model)
  drawStars(part(svg, 'fm-stars', cls => svgEl('g', cls)), sky, model)
  drawHeld(part(frame, 'fm-helds', cls => htmlEl('div', cls)), sky, model)
  drawLabels(part(frame, 'fm-labels', cls => htmlEl('div', cls)), part(frame, 'fm-numerals', cls => htmlEl('div', cls)), sky, model)
  drawArmNames(part(frame, 'fm-arm-names', cls => htmlEl('div', cls)), sky)
  drawLedger(part(host, 'fm-ledger', cls => htmlEl('div', cls)), sky, model)
}
