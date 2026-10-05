// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { anchorPopover, popoverFloor } from './anchoredPopover.js'

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
function fixture(trigger: DOMRect, size: { width: number; height: number }) {
  const anchor = document.createElement('button')
  anchor.getBoundingClientRect = () => trigger
  const panel = document.createElement('div')
  Object.defineProperty(panel, 'offsetWidth', { get: () => size.width })
  Object.defineProperty(panel, 'offsetHeight', { get: () => size.height })
  document.body.append(anchor, panel)
  return { anchor, panel }
}
const viewport = (width: number, height: number): void => {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height })
}
afterEach(() => document.body.replaceChildren())

describe('anchorPopover', () => {
  it('opens below the trigger, aligned to its start, in fixed viewport coordinates', () => {
    viewport(1000, 800)
    const { anchor, panel } = fixture(rect(100, 200, 40, 30), { width: 150, height: 100 })
    anchorPopover(panel, anchor)
    expect([panel.style.position, panel.style.left, panel.style.top, panel.dataset.side]).toEqual(['fixed', '100px', '234px', 'below'])
  })
  it('flips above when the space below is short and shifts inside the right edge', () => {
    viewport(400, 800)
    const { anchor, panel } = fixture(rect(350, 700, 40, 30), { width: 150, height: 100 })
    anchorPopover(panel, anchor)
    expect([panel.style.left, panel.style.top, panel.dataset.side]).toEqual(['242px', '596px', 'above'])
  })
  it('shifts a panel that would leave the left edge back inside it', () => {
    viewport(400, 800)
    const { anchor, panel } = fixture(rect(10, 100, 36, 32), { width: 140, height: 100 })
    anchorPopover(panel, anchor, { placement: 'below-end' })
    expect(panel.style.left).toBe('8px')
  })
  it('stays above a visible phone bottom bar, capping its height to the room it has', () => {
    viewport(390, 844)
    const bar = document.createElement('div'); bar.dataset.part = 'phone-bottom-bar'
    bar.getBoundingClientRect = () => rect(0, 788, 390, 56)
    document.body.append(bar)
    expect(popoverFloor()).toBe(788)
    const { anchor, panel } = fixture(rect(16, 200, 44, 44), { width: 140, height: 700 })
    anchorPopover(panel, anchor)
    expect(panel.dataset.side).toBe('below')
    expect(panel.style.top).toBe('248px')
    expect(panel.style.maxHeight).toBe(`${788 - 8 - 248}px`)
  })
  it('matches the trigger width on request and clears every placement on release', () => {
    viewport(1000, 800)
    const { anchor, panel } = fixture(rect(100, 200, 180, 30), { width: 150, height: 100 })
    const release = anchorPopover(panel, anchor, { matchWidth: true })
    expect(panel.style.minWidth).toBe('180px')
    release()
    expect([panel.style.position, panel.style.left, panel.style.top, panel.style.minWidth]).toEqual(['', '', '', ''])
    expect(panel.hasAttribute('data-anchored')).toBe(false)
  })
})
