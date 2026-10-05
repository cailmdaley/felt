// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { centeredScrollLeft, TAB_CROSSING_MS, TabStrip } from './TabStrip.js'
import type { KeyIntent } from '../keymap.js'

let strips: TabStrip[] = []
afterEach(() => {
  for (const strip of strips) strip.dispose()
  strips = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function create(onSelect = vi.fn(), onExpand = vi.fn()): TabStrip {
  const strip = new TabStrip(onSelect, onExpand)
  strips.push(strip)
  document.body.append(strip.el)
  return strip
}
function dimensions(el: HTMLElement, values: Record<string, number>): void {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(el, name, { configurable: true, value })
  }
}

describe('TabStrip', () => {
  it('exports clamped centring math and uses the design crossing duration', () => {
    expect(centeredScrollLeft(0, 90, 100, 500)).toBe(0)
    expect(centeredScrollLeft(200, 90, 100, 500)).toBe(195)
    expect(centeredScrollLeft(450, 100, 100, 500)).toBe(400)
    expect(centeredScrollLeft(20, 30, 100, 90)).toBe(0)
    expect(TAB_CROSSING_MS).toBe(280)
  })

  it('is a labelled tablist with one roving Tab stop and immediate selection callbacks', () => {
    const onSelect = vi.fn(), onExpand = vi.fn()
    const strip = create(onSelect, onExpand)
    strip.render(['Prose', 'Report', 'Appendix'])
    expect([...strip.el.children].map(button => button.textContent)).toEqual(['Prose', 'Report', 'Appendix'])
    expect(strip.el.getAttribute('role')).toBe('tablist')
    expect(strip.el.getAttribute('aria-label')).toBe('Documents')
    expect(strip.buttons.map((button) => button.getAttribute('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(strip.buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1])
    expect(strip.buttons.map((button) => button.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])

    strip.buttons[1].click()
    expect(onSelect).toHaveBeenCalledWith(1)
    expect(strip.buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1])
    strip.buttons[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(onExpand).toHaveBeenCalledOnce()
  })

  it('handles shared reader intents with roving focus and one keyboard stop', () => {
    const onSelect = vi.fn()
    const strip = create(onSelect)
    strip.render(['One', 'Two', 'Three'])
    strip.buttons[0].focus()
    expect(strip.handleIntent('next' satisfies KeyIntent)).toBe(true)
    expect(onSelect).toHaveBeenLastCalledWith(1)
    expect(strip.buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1])
    expect(document.activeElement).toBe(strip.buttons[1])

    expect(strip.handleIntent('last')).toBe(true)
    expect(onSelect).toHaveBeenLastCalledWith(2)
    expect(document.activeElement).toBe(strip.buttons[2])
    expect(strip.handleIntent('first')).toBe(true)
    expect(onSelect).toHaveBeenLastCalledWith(0)
    expect(strip.buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1])
    expect(strip.handleIntent('scrollDown')).toBe(false)
  })

  it('is a no-op for unchanged labels and preserves focused nodes during reconciliation', () => {
    const strip = create()
    const labels = ['Prose', 'Report', 'Notes']
    strip.render(labels)
    strip.mark(1, false)
    const [prose, report, notes] = strip.buttons
    report.focus()
    strip.render([...labels])
    expect(strip.buttons).toEqual([prose, report, notes])
    expect(document.activeElement).toBe(report)

    strip.render(['Prose', 'Report', 'New page', 'Notes'])
    expect([...strip.el.children].map(button => button.textContent)).toEqual(['Prose', 'Report', 'New page', 'Notes'])
    expect(strip.buttons[0]).toBe(prose)
    expect(strip.buttons[1]).toBe(report)
    expect(strip.buttons[3]).toBe(notes)
    expect(document.activeElement).toBe(report)
    expect(strip.buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1])
  })

  it('reconciles reordering by label identity and keeps the selected tab', () => {
    const strip = create()
    strip.render(['One', 'Two', 'Three'])
    strip.mark(1, false)
    const selected = strip.buttons[1]
    selected.focus()
    strip.render(['Three', 'Two', 'One'])
    expect([...strip.el.children].map(button => button.textContent)).toEqual(['Three', 'Two', 'One'])
    expect(strip.buttons[1]).toBe(selected)
    expect(document.activeElement).toBe(selected)
    expect(strip.buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1])
  })

  it('centres the selected tab and settles immediately when reduced motion is preferred', () => {
    const media = {
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const strip = create()
    strip.render(['One', 'Two'])
    dimensions(strip.el, { clientWidth: 100, scrollWidth: 500 })
    dimensions(strip.buttons[1], { offsetLeft: 200, offsetWidth: 90 })
    strip.mark(1, true)
    expect(strip.el.scrollLeft).toBe(195)
    expect(strip.el.classList.contains('ws-fade-l')).toBe(true)
    expect(strip.el.classList.contains('ws-fade-r')).toBe(true)
  })

  it('supports duplicate labels as distinct stable tabs and clears on dispose', () => {
    const strip = create()
    strip.render(['report.html', 'report.html'])
    expect(strip.buttons).toHaveLength(2)
    expect(strip.buttons[0]).not.toBe(strip.buttons[1])
    const el = strip.el
    strip.dispose()
    expect(el.children).toHaveLength(0)
  })
})
