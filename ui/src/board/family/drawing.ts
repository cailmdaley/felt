import type { Standing } from './model.js'
import './family-map.css'

const SVG = 'http://www.w3.org/2000/svg'

export const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag)
  if (cls) el.setAttribute('class', cls)
  return el
}
export const htmlEl = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

/** A mark's outline around its centre: the tone says whose move, the shape tells kinds of the same tone apart. */
export function markPath(standing: Standing, r: number): string {
  if (standing === 'new') { const d = r * 1.3; return `M0 ${-d}L${d} 0L0 ${d}L${-d} 0Z` }
  if (standing === 'blocked') { const d = r * .9; return `M${-d} ${-d}H${d}V${d}H${-d}Z` }
  return `M${-r} 0A${r} ${r} 0 1 0 ${r} 0A${r} ${r} 0 1 0 ${-r} 0Z`
}
/** A small svg holding one state mark. */
export function markSvg(cls: string, standing: Standing, r = 4.5): SVGSVGElement {
  const mark = svgEl('svg', cls), path = svgEl('path')
  mark.setAttribute('viewBox', '-7 -7 14 14'); mark.setAttribute('aria-hidden', 'true')
  path.setAttribute('d', markPath(standing, r)); mark.append(path)
  return mark
}
