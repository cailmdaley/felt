import { MAP_WINDOW_MS } from './model.js'
import { elapsed, htmlEl, mount, part, reconcile, svgEl, type Drawing } from './drawing.js'
import { axis, drawFold, drawHeads, fillRow, heading, makeRow, planRows, type Row } from './rows.js'

/** Column pitch of the weave. */
const CELL = 8
const LABEL = 380
/** A phone's band under the thread's name. */
const STRIP = 14

function weave(strip: SVGSVGElement, { thread, loud }: Row, chart: number, height: number, now: number): void {
  const columns = Math.floor(chart / CELL)
  const column = (at: number): number => Math.min(columns - 1, Math.floor(columns * (1 - elapsed(at, now))))
  const counts = new Map<number, number>()
  for (const at of [...thread.launches, ...thread.commits, ...thread.files.map(file => file.at)]) {
    if (now - at > 0 && column(at) >= 0) counts.set(column(at), (counts.get(column(at)) ?? 0) + 1)
  }
  const block = (n: number): string => `M${n * CELL} 1h${CELL - 1}v${height - 2}h${-(CELL - 1)}z`
  const [life, light, dense, end] = strip.children
  const from = column(Math.max(thread.born, now - MAP_WINDOW_MS)) * CELL
  const to = thread.ended && thread.standing === 'quiet' ? column(thread.ended) * CELL + CELL : columns * CELL
  strip.setAttribute('viewBox', `0 0 ${chart} ${height}`)
  life.setAttribute('x1', String(from)); life.setAttribute('x2', String(Math.max(from, to)))
  life.setAttribute('y1', String(height / 2)); life.setAttribute('y2', String(height / 2))
  light.setAttribute('d', [...counts].filter(([, n]) => n < 3).map(([n]) => block(n)).join(''))
  dense.setAttribute('d', [...counts].filter(([, n]) => n >= 3).map(([n]) => block(n)).join(''))
  end.setAttribute('d', loud ? `M${columns * CELL} ${height / 2}q7 -4 14 0` : '')
}

export const cloth: Drawing = {
  name: 'cloth', label: 'Cloth',
  reading: ['Rows: most urgent first', 'Right edge: now', 'Dashes: a thread’s life', 'Blocks: launches, commits, files', 'Colour: its state', 'Diamond: a new file', 'Thin rows: finished lately'],
  draw(host, model, open, _view, focus) {
    const { width, narrow } = mount(host, 'cloth', model, open)
    const chart = narrow ? width : Math.max(260, width - LABEL)
    const plan = planRows(model.order, thread => heading(model, thread), 26, narrow ? 46 : 42, 6, focus?.key ?? null)
    const cloth = part(host, 'fm-rows', cls => htmlEl('div', cls))
    cloth.style.height = `${plan.height}px`
    cloth.style.setProperty('--fm-chart', `${chart}px`)
    cloth.style.setProperty('--fm-cell', `${CELL}px`)
    axis(part(cloth, 'fm-axis', cls => htmlEl('div', cls)), at => chart * (1 - elapsed(at, model.now)), model.now)
    drawHeads(part(cloth, 'fm-heads', cls => htmlEl('div', cls)), plan)
    reconcile(part(cloth, 'fm-row-list', cls => htmlEl('div', cls)), plan.rows, row => row.thread.key, () => {
      const row = makeRow(), strip = svgEl('svg', 'fm-strip')
      strip.setAttribute('preserveAspectRatio', 'none')
      strip.append(svgEl('line', 'fm-strip-life'), svgEl('path', 'fm-strip-light'), svgEl('path', 'fm-strip-dense'), svgEl('path', 'fm-strip-end'))
      row.prepend(strip)
      return row
    }, (el, row) => {
      fillRow(el, row, model)
      const strip = el.querySelector<SVGSVGElement>('.fm-strip')!
      strip.style.height = `${narrow && row.loud ? STRIP : row.height}px`
      weave(strip, row, chart, narrow && row.loud ? STRIP : row.height, model.now)
      drawFold(el, row, focus, model)
    })
  },
}
