import { ATTENTION_WORD, MAP_WINDOW_MS, isDrawn, needsHuman, type Attention, type FamilyModel, type MapFile, type MapThread } from './model.js'
import { HOUR, TIME_MARKS, elapsed, htmlEl, markPath, mount, part, reconcile, optionFor, shortAgo, svgEl, tagThread, type Drawing, type Sight } from './drawing.js'

/** Column pitch of the weave. */
const CELL = 8
const LABEL = 430
/** A name's width per character, and the rest of a row's label column. */
const NAME_CHAR = 7.4
const LABEL_ASIDE = 130
const ROW = 42
const ROW_NARROW = 46
const THIN = 6
/** A phone's band under the thread's name. */
const STRIP = 14
const TOP = 26
/** The fold under a focused thread's rows, where what it holds lies. */
const FOLD = 56
const FOLD_FILES = 6

interface Row { thread: MapThread; y: number; height: number; loud: boolean; level: number; open: boolean; shown: MapThread }
interface Head { label: string; y: number }
interface Plan { rows: Row[]; heads: Head[]; height: number; fold: number | null }

const kidsOf = (model: FamilyModel, thread: MapThread): MapThread[] => thread.children.map(key => model.threads.get(key)!)
/** A thread and everything under it. */
const underOf = (model: FamilyModel, thread: MapThread): MapThread[] => [thread, ...kidsOf(model, thread).flatMap(kid => underOf(model, kid))]
const rankOf = (thread: MapThread): number => isDrawn(thread) ? thread.rank : Infinity
/** The most urgent thread at or under this one, which a closed row speaks for. */
const speaker = (model: FamilyModel, thread: MapThread): MapThread => underOf(model, thread).reduce((best, item) => rankOf(item) < rankOf(best) ? item : best)
/** A thread's own threads with a row to show, most urgent first. */
const rowKids = (model: FamilyModel, thread: MapThread): MapThread[] =>
  kidsOf(model, thread).filter(kid => rankOf(speaker(model, kid)) < Infinity).sort((a, b) => rankOf(speaker(model, a)) - rankOf(speaker(model, b)))

/** The rows on show: the constitution and its threads in order, the focused thread and those above it open on their own threads. */
function shownRows(model: FamilyModel, focus: string | null): Array<{ thread: MapThread; level: number; open: boolean }> {
  const opened = new Set<MapThread>()
  for (let at = focus ? model.threads.get(focus) : undefined; at; at = at.parent ? model.threads.get(at.parent) : undefined) opened.add(at)
  const rows: Array<{ thread: MapThread; level: number; open: boolean }> = []
  const walk = (thread: MapThread, level: number): void => {
    const open = opened.has(thread) && rowKids(model, thread).length > 0
    rows.push({ thread, level, open })
    if (open) for (const kid of rowKids(model, thread)) walk(kid, level + 1)
  }
  const top = [model.root, ...rowKids(model, model.root)].sort((a, b) => (a === model.root ? rankOf(a) : rankOf(speaker(model, a))) - (b === model.root ? rankOf(b) : rankOf(speaker(model, b))))
  for (const thread of top) {
    if (thread === model.root) rows.push({ thread, level: 0, open: false })
    else walk(thread, 0)
  }
  return rows
}
/** The head of a thread's kind in the attention order, or null for quiet history. */
const heading = (model: FamilyModel, thread: MapThread): string | null =>
  thread.standing === 'still' ? 'No worker' : model.attention.includes(thread) ? ATTENTION_WORD[thread.standing as Attention] : null

/** Top rows under their kind's head, then quiet history as thin lines; nested rows under the row that opened, and the fold after the focused thread's. */
function plan(model: FamilyModel, focus: string | null, row: number): Plan {
  const rows: Row[] = [], heads: Head[] = [], shown = shownRows(model, focus)
  let y = TOP, last: string | null = null, fold: number | null = null
  shown.forEach(({ thread, level, open }, n) => {
    const speaks = open ? thread : speaker(model, thread), head = level ? null : heading(model, speaks)
    if (!level) {
      if (head && head !== last) { if (last) y += 10; heads.push({ label: head, y }); y += 22 }
      if (!head && last) y += 14
      last = head
    }
    const loud = !!head || !!level || thread.key === focus, height = loud ? row : THIN
    rows.push({ thread, y, height, loud, level, open, shown: speaks })
    y += height
    if (focus && fold === null) {
      const next = shown[n + 1], under = focus ? underOf(model, model.threads.get(focus)!) : []
      if (under.includes(thread) && !(next && under.includes(next.thread))) { fold = y; y += FOLD }
    }
  })
  return { rows, heads, height: y + 10, fold }
}

/** One stripe of the weave per kind of work, counted across the row's threads. */
function weave(strip: SVGSVGElement, row: Row, threads: readonly MapThread[], chart: number, height: number, now: number): void {
  const columns = Math.floor(chart / CELL), { thread, loud } = row
  const column = (at: number): number => Math.min(columns - 1, Math.floor(columns * (1 - elapsed(at, now))))
  const tally = (times: readonly number[]): Map<number, number> => {
    const counts = new Map<number, number>()
    for (const at of times) if (now - at > 0 && column(at) >= 0) counts.set(column(at), (counts.get(column(at)) ?? 0) + 1)
    return counts
  }
  const band = height / 3, cells = (counts: Map<number, number>, top: number, keep: (n: number) => boolean): string =>
    [...counts].filter(([, n]) => keep(n)).map(([n]) => `M${n * CELL} ${top.toFixed(1)}h${CELL - 1}v${(band - .5).toFixed(1)}h${-(CELL - 1)}z`).join('')
  const launches = tally(threads.flatMap(item => item.launches)), commits = tally(threads.flatMap(item => item.commits))
  const files = threads.flatMap(item => item.files), sent = tally(files.filter(file => !file.unread).map(file => file.at)), fresh = tally(files.filter(file => file.unread).map(file => file.at))
  const [life, launch, light, dense, sends, news, end] = strip.children
  const from = column(Math.max(Math.min(...threads.map(item => item.born)), now - MAP_WINDOW_MS)) * CELL
  const ended = threads.every(item => item.ended), to = ended && thread.standing === 'quiet' ? column(Math.max(...threads.map(item => item.ended!))) * CELL + CELL : columns * CELL
  strip.setAttribute('viewBox', `0 0 ${chart} ${height}`)
  life.setAttribute('x1', String(from)); life.setAttribute('x2', String(Math.max(from, to)))
  life.setAttribute('y1', String(height / 2)); life.setAttribute('y2', String(height / 2))
  launch.setAttribute('d', cells(launches, .5, () => true))
  light.setAttribute('d', cells(commits, band + .25, n => n < 3))
  dense.setAttribute('d', cells(commits, band + .25, n => n >= 3))
  sends.setAttribute('d', cells(sent, 2 * band, () => true))
  news.setAttribute('d', cells(fresh, 2 * band, () => true))
  end.setAttribute('d', loud ? `M${columns * CELL} ${height / 2}q7 -4 14 0` : '')
}

/** A focused thread's fold, in the order it unfolds anywhere: its tapestry's place, its newest files, its constitution at the end. */
function drawFold(layer: HTMLElement, thread: MapThread | undefined, sight: Sight | null, model: FamilyModel): void {
  const { lead, constitution } = thread && sight ? sight.holds(thread) : {}
  const files = thread ? thread.files.filter(file => file.key !== lead?.key) : []
  const shown = files.slice(0, FOLD_FILES), rest = files.length - shown.length
  const held: Array<{ file: MapFile; kind: string }> = [
    ...(lead ? [{ file: lead, kind: 'lead' }] : []),
    ...shown.map(file => ({ file, kind: 'file' })),
    ...(constitution ? [{ file: constitution, kind: 'constitution' }] : []),
  ]
  layer.toggleAttribute('data-no-lead', !!thread && !lead)
  layer.dataset.count = rest ? `+${rest}` : ''
  reconcile(layer, held, item => item.file.key, () => {
    const way = htmlEl('button', 'fm-fold-file'); way.type = 'button'
    way.append(htmlEl('span', 'fm-fold-name'), htmlEl('span', 'fm-fold-age'))
    return way
  }, (way, { file, kind }) => {
    way.dataset.held = file.key
    way.dataset.owner = thread!.key
    way.dataset.kind = kind
    way.toggleAttribute('data-unread', file.unread)
    way.firstElementChild!.textContent = file.name
    way.lastElementChild!.textContent = file.at ? shortAgo(file.at, model.now) : ''
  })
}

function makeRow(): HTMLElement {
  const row = htmlEl('div', 'fm-row'), label = htmlEl('div', 'fm-row-label'), mark = svgEl('svg', 'fm-row-mark')
  mark.setAttribute('viewBox', '-6 -6 12 12'); mark.append(svgEl('path'))
  const strip = svgEl('svg', 'fm-strip')
  strip.setAttribute('preserveAspectRatio', 'none')
  strip.append(svgEl('line', 'fm-strip-life'), svgEl('path', 'fm-strip-launches'), svgEl('path', 'fm-strip-light'), svgEl('path', 'fm-strip-dense'), svgEl('path', 'fm-strip-files'), svgEl('path', 'fm-strip-fresh'), svgEl('path', 'fm-strip-end'))
  label.append(htmlEl('span', 'fm-row-name'), htmlEl('span', 'fm-row-note'))
  row.append(strip, mark, label, htmlEl('span', 'fm-row-asks'), htmlEl('span', 'fm-row-age'))
  return row
}

export const cloth: Drawing = {
  name: 'cloth', label: 'Cloth', folds: true,
  reading: ['Rows: most urgent first', 'Click a row: its own cloth, then its files', 'Right edge: now', 'Dashes: a thread’s life', 'Top stripe: launches', 'Middle: commits, dark when busy', 'Bottom: sent files, bright when new', 'A closed row: all it holds', 'Colour: its state', 'Thin rows: finished lately'],
  sequence: (model, focus) => shownRows(model, focus).map(row => row.thread),
  draw(host, model, open, _view, sight) {
    const { width, narrow } = mount(host, 'cloth', model, open)
    const chart = narrow ? width : Math.max(260, width - LABEL), focus = sight?.key ?? null
    const layout = plan(model, focus, narrow ? ROW_NARROW : ROW)
    const sheet = part(host, 'fm-rows', cls => htmlEl('div', cls))
    sheet.style.height = `${layout.height}px`
    sheet.style.setProperty('--fm-chart', `${chart}px`)
    sheet.style.setProperty('--fm-cell', `${CELL}px`)
    const ticks: ReadonlyArray<readonly [number, string]> = [[0, 'now'], ...TIME_MARKS.filter(([back]) => back > HOUR)]
    reconcile(part(sheet, 'fm-axis', cls => htmlEl('div', cls)), ticks, ([, label]) => label, ([, label]) => htmlEl('span', '', label), (el, [back]) => {
      el.style.left = `${Math.max(14, chart * (1 - elapsed(model.now - back, model.now))).toFixed(1)}px`
    })
    reconcile(part(sheet, 'fm-heads', cls => htmlEl('div', cls)), layout.heads, head => head.label, head => htmlEl('div', 'fm-head', head.label), (el, head) => { el.style.transform = `translateY(${head.y}px)` })
    reconcile(part(sheet, 'fm-row-list', cls => htmlEl('div', cls)), layout.rows, row => row.thread.key, makeRow, (el, row) => {
      const { thread, y, height, loud, level, shown } = row, under = row.open ? [thread] : underOf(model, thread)
      tagThread(el, shown); el.setAttribute('data-thread', thread.key); optionFor(el, thread, model)
      el.toggleAttribute('data-loud', loud)
      el.toggleAttribute('data-open', row.open)
      el.toggleAttribute('data-fresh', under.some(item => item.fresh))
      el.toggleAttribute('data-long', thread.name.length * NAME_CHAR + level * 14 > width - chart - LABEL_ASIDE)
      el.style.height = `${height}px`
      el.style.setProperty('--fm-level', String(level))
      el.style.transform = `translateY(${y}px)`
      el.querySelector('.fm-row-mark path')!.setAttribute('d', loud ? markPath(shown.tone, 4) : '')
      el.querySelector('.fm-row-name')!.textContent = thread.name
      el.querySelector('.fm-row-note')!.textContent = thread.note
      const asks = under.filter(item => item !== thread && needsHuman(item)).length, held = under.length - 1
      el.querySelector('.fm-row-asks')!.textContent = loud && held ? `${asks ? `${asks} of ` : ''}${held}` : ''
      el.querySelector('.fm-row-age')!.textContent = loud ? shortAgo(Math.max(...under.map(item => item.lastMove)), model.now) : ''
      const strip = el.querySelector<SVGSVGElement>('.fm-strip')!, band = narrow && loud ? STRIP : height
      strip.style.height = `${band}px`
      weave(strip, row, under, chart, band, model.now)
    })
    const fold = part(sheet, 'fm-row-fold', cls => htmlEl('div', cls))
    fold.hidden = layout.fold === null
    fold.style.transform = `translateY(${layout.fold ?? 0}px)`
    drawFold(fold, layout.fold === null || !focus ? undefined : model.threads.get(focus), sight, model)
  },
}
