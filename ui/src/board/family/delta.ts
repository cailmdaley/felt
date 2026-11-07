import type { FamilyModel, MapThread } from './model.js'
import { MAP_WINDOW_MS } from './model.js'
import { elapsed, htmlEl, markPath, mount, part, reconcile, svgEl, tagThread, type Drawing } from './drawing.js'
import { axis, drawHeads, fillRow, heading, makeRow, planRows, type Row } from './rows.js'

const LABEL = 400

function strand(group: SVGGElement, { thread, loud }: Row, y: number, parentY: number, x: (at: number) => number, end: number): void {
  const from = x(thread.born), bend = Math.min(18, Math.max(5, (end - from) / 2))
  const closes = !loud && thread.ended !== null
  const to = closes ? x(thread.ended!) : end
  group.querySelector('.fm-strand-branch')!.setAttribute('d', `M${from.toFixed(1)} ${parentY}C${(from + bend).toFixed(1)} ${parentY} ${from.toFixed(1)} ${y} ${(from + bend).toFixed(1)} ${y}`)
  let run = `M${(from + bend).toFixed(1)} ${y}H${(to - (closes ? bend : 0)).toFixed(1)}`
  if (closes) run += `C${to.toFixed(1)} ${y} ${(to - bend).toFixed(1)} ${parentY} ${to.toFixed(1)} ${parentY}`
  group.querySelector('.fm-strand')!.setAttribute('d', run)
  const marks = (times: readonly number[], shape: (px: number) => string): string => times.map(at => shape(x(at))).join('')
  group.querySelector('.fm-strand-launches')!.setAttribute('d', marks(thread.launches, px => `M${px.toFixed(1)} ${y - 4}v8`))
  group.querySelector('.fm-strand-commits')!.setAttribute('d', marks(thread.commits, px => `M${(px - 2).toFixed(1)} ${y}a2 2 0 1 0 4 0a2 2 0 1 0-4 0`))
  group.querySelector('.fm-strand-files')!.setAttribute('d', marks(thread.files.map(file => file.at), px => `M${px.toFixed(1)} ${y - 3.5}l3.5 3.5l-3.5 3.5l-3.5-3.5z`))
  const tip = group.querySelector('.fm-strand-tip')!
  tip.setAttribute('d', loud ? markPath(thread.standing, 5) : '')
  tip.setAttribute('transform', `translate(${end} ${y})`)
}

/** The strands of the family, each leaving its orchestrator's line where it was born. */
function drawStrands(layer: SVGGElement, rows: readonly Row[], model: FamilyModel, narrow: boolean, x: (at: number) => number, end: number): void {
  const line = (row: Row): number => row.y + (narrow && row.loud ? row.height - 8 : row.height / 2)
  const ys = new Map<MapThread, number>(rows.map(row => [row.thread, line(row)]))
  reconcile(layer, rows.filter(row => row.thread !== model.root), row => row.thread.key, () => {
    const group = svgEl('g', 'fm-strand-group')
    group.append(svgEl('path', 'fm-strand-branch'), svgEl('path', 'fm-strand'), svgEl('path', 'fm-strand-launches'), svgEl('path', 'fm-strand-commits'), svgEl('path', 'fm-strand-files'), svgEl('path', 'fm-strand-tip'))
    return group
  }, (group, row) => {
    tagThread(group, row.thread)
    group.setAttribute('data-link', row.thread.key)
    group.toggleAttribute('data-loud', row.loud)
    strand(group, row, ys.get(row.thread)!, ys.get(model.threads.get(row.thread.parent!)!) ?? ys.get(model.root)!, x, end)
  })
}

export const delta: Drawing = {
  name: 'delta', label: 'Delta',
  reading: ['Branches: a thread leaves its orchestrator when born', 'Right edge: now', 'Ticks: launches', 'Dots: commits', 'Diamonds: files', 'Thin lines: finished, flowing back'],
  draw(host, model, open) {
    const { width, narrow } = mount(host, 'delta', model, open)
    const chart = narrow ? width : Math.max(280, width - LABEL), end = chart - 12
    const oldest = model.now - MAP_WINDOW_MS
    const x = (at: number): number => 12 + (end - 12) * (1 - elapsed(Math.max(at, oldest), model.now))
    const threads = [model.root, ...model.order.filter(thread => thread !== model.root)]
    const plan = planRows(threads, thread => thread === model.root ? 'Constitution' : heading(model, thread), 18, narrow ? 50 : 42, 8)
    const list = part(host, 'fm-rows', cls => htmlEl('div', cls))
    list.style.height = `${plan.height}px`
    list.style.setProperty('--fm-chart', `${chart}px`)
    axis(part(list, 'fm-axis', cls => htmlEl('div', cls)), x, model.now)
    const svg = part(list, 'fm-delta-svg', cls => svgEl('svg', cls))
    svg.setAttribute('viewBox', `0 0 ${width} ${plan.height}`)
    const trunk = part(svg, 'fm-trunk', cls => svgEl('path', cls))
    const top = plan.rows[0], line = top.y + (narrow ? top.height - 8 : top.height / 2)
    tagThread(trunk, model.root)
    trunk.setAttribute('d', `M${x(Math.min(...model.order.map(thread => thread.born)))} ${line}H${end}`)
    drawStrands(part(svg, 'fm-strands', cls => svgEl('g', cls)), plan.rows, model, narrow, x, end)
    drawHeads(part(list, 'fm-heads', cls => htmlEl('div', cls)), plan)
    reconcile(part(list, 'fm-row-list', cls => htmlEl('div', cls)), plan.rows, row => row.thread.key, makeRow, (el, row) => fillRow(el, row, model))
  },
}

