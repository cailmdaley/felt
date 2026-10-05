// The layout-shift guard: nothing moves when you touch it.
//
// `layoutShift` records the box of every visible element in `regions`,
// applies `act`, waits two frames (and `settle` ms), and returns each element
// that moved or resized by more than half a pixel. Elements inside an `allow`
// selector — the touched control and its intended dependants, such as an
// opened popover — are exempt. An element carried by a moved ancestor with the
// same offset and size is reported once, as its ancestor. `positionsOnly`
// compares where boxes start, not their size, for a container that may
// rightly grow downward (a stage whose bottom bar steps aside).

/** Two animation frames: long enough for layout and a ResizeObserver pass. */
export async function frames(p) {
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

export async function layoutShift(p, { regions, act, allow = [], settle = 0, positionsOnly = false }) {
  await p.evaluate(regions => {
    const path = el => {
      const steps = []
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        steps.unshift(`${node.tagName}:${node.parentElement ? [...node.parentElement.children].indexOf(node) : 0}`)
      }
      return steps.join('/')
    }
    const boxes = new Map()
    for (const selector of regions) for (const root of document.querySelectorAll(selector)) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (boxes.has(el)) continue
        const r = el.getBoundingClientRect()
        if (!r.width && !r.height) continue
        boxes.set(el, { path: path(el), box: [r.x, r.y, r.width, r.height] })
      }
    }
    window.__layoutShiftGuard = { boxes, path }
  }, regions)
  await act()
  await frames(p)
  if (settle) await p.waitForTimeout(settle)
  return p.evaluate(({ allow, positionsOnly }) => {
    const { boxes, path } = window.__layoutShiftGuard
    delete window.__layoutShiftGuard
    // A repaint may replace an element with its twin; follow it by position.
    const byPath = new Map()
    for (const el of document.querySelectorAll('body *')) byPath.set(path(el), el)
    const describe = el => {
      const name = node => `${node.tagName.toLowerCase()}${[...node.classList].filter(c => /^(ws|kbn)-/.test(c)).slice(0, 2).map(c => `.${c}`).join('')}`
      const parent = el.parentElement?.closest('[class*="ws-"], [class*="kbn-"]')
      return parent ? `${name(parent)} ${name(el)}` : name(el)
    }
    const moved = new Map()
    for (const [el, { path: at, box }] of boxes) {
      const now = el.isConnected ? el : byPath.get(at)
      const r = now?.getBoundingClientRect()
      const after = r ? [r.x, r.y, r.width, r.height] : [0, 0, 0, 0]
      const delta = after.map((v, i) => positionsOnly && i > 1 && r ? 0 : v - box[i])
      if (delta.every(d => Math.abs(d) <= 0.5)) continue
      if (allow.some(selector => (now ?? el).closest?.(selector) || el.closest(selector))) continue
      moved.set(el, delta)
    }
    const carried = (el, delta) => {
      if (Math.abs(delta[2]) > 0.5 || Math.abs(delta[3]) > 0.5) return false
      for (let up = el.parentElement; up; up = up.parentElement) {
        const d = moved.get(up)
        if (d && Math.abs(d[0] - delta[0]) <= 0.5 && Math.abs(d[1] - delta[1]) <= 0.5) return true
      }
      return false
    }
    const resizedBy = (el, delta) => {
      for (let up = el.parentElement; up; up = up.parentElement) if (moved.has(up)) return describe(up)
      return null
    }
    return [...moved].filter(([el, delta]) => !carried(el, delta)).map(([el, delta]) => ({
      element: describe(el),
      dx: +delta[0].toFixed(1), dy: +delta[1].toFixed(1), dw: +delta[2].toFixed(1), dh: +delta[3].toFixed(1),
      inside: resizedBy(el, delta),
    }))
  }, { allow, positionsOnly })
}

/** Shifts whose outermost moved element is none of `known`'s selectors. */
export function unexpected(shifts, known = []) {
  return shifts.filter(shift => !known.some(k => shift.element.includes(k) || shift.inside?.includes(k)))
}
