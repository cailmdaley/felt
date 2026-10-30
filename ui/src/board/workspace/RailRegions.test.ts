// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RailFold, RailSplit } from './RailRegions.js'

let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) })
})
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('RailFold', () => {
  it('opens by default, folds on click, remembers, and tells the rail', () => {
    const changed = vi.fn()
    const fold = new RailFold('Threads', 'k', changed)
    expect(fold.open).toBe(true)
    expect(fold.heading.textContent).toBe('Threads')
    expect(fold.button.getAttribute('aria-expanded')).toBe('true')
    fold.button.click()
    expect(fold.open).toBe(false); expect(fold.button.getAttribute('aria-expanded')).toBe('false')
    expect(values.get('k')).toBe('false'); expect(changed).toHaveBeenCalledOnce()
    expect(new RailFold('Threads', 'k', vi.fn()).open).toBe(false)
  })
})

describe('RailSplit', () => {
  const make = (below: boolean, bounds = { min: 72, max: 400 }) => {
    const rail = document.createElement('div'), region = document.createElement('section')
    rail.append(region); document.body.append(rail)
    const changed = vi.fn()
    const split = new RailSplit(rail, { label: 'Resize', storage: 's', region, below, bounds: () => bounds, changed })
    rail.append(split.el)
    return { split, region, changed }
  }
  it('stands only when asked, and sizes its region only with a chosen height', () => {
    const { split, region } = make(false)
    expect(split.el.hidden).toBe(true)
    split.apply(true)
    expect(split.el.hidden).toBe(false); expect(region.hasAttribute('data-sized')).toBe(false)
  })
  it('clamps a stored height to its bounds and stands it down with the boundary', () => {
    values.set('s', '900')
    const { split, region } = make(false)
    split.apply(true)
    expect(region.style.getPropertyValue('--ws-rail-region-height')).toBe('400px')
    expect(split.el.getAttribute('aria-valuenow')).toBe('400')
    split.apply(false)
    expect(region.hasAttribute('data-sized')).toBe(false); expect(split.el.hidden).toBe(true)
  })
  it('moves the boundary down with ArrowDown: a region above grows, a region below shrinks', () => {
    for (const below of [false, true]) {
      values.clear()
      const { split, region, changed } = make(below)
      region.getBoundingClientRect = () => ({ height: 200 } as DOMRect)
      split.apply(true)
      split.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      expect(region.style.getPropertyValue('--ws-rail-region-height')).toBe(below ? '184px' : '216px')
      expect(values.get('s')).toBe(below ? '184' : '216'); expect(changed).toHaveBeenCalled()
      split.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      expect(region.hasAttribute('data-sized')).toBe(false); expect(values.has('s')).toBe(false)
    }
  })
})
