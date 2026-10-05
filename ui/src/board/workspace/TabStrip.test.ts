// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { centeredScrollLeft, indexCaptions, TAB_CROSSING_MS, TabStrip } from './TabStrip.js'
import type { KeyIntent } from '../keymap.js'
import { buildChannel } from './documents.js'
import { cacheDocumentTitle } from './DocumentTitles.js'

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

  it('follows document identity through a title change and styles declared titles even when the words match the filename', () => {
    const channel = buildChannel({ uid: 'u', owner: 'typography', name: 'Note', path: '/note.md', fiberDir: '/', body: '', embeds: [{ path: '/doc.html' }] })
    const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
    strips.push(strip)
    strip.render(channel.labels, channel.documents.map(d => d.key), channel)
    strip.mark(1, false)
    const selected = strip.buttons[1]
    cacheDocumentTitle(channel.documents[1].key, '/doc.html', '<title>doc.html</title>', 'same-words')
    strip.render(channel.labels, channel.documents.map(d => d.key), channel)
    expect(selected.querySelector('.ws-tab-label')?.classList.contains('ws-tab-title')).toBe(true)
    strip.render(['Note', 'Declared title'], channel.documents.map(d => d.key), channel)
    expect(strip.buttons[1]).toBe(selected)
    expect(selected.getAttribute('aria-selected')).toBe('true')
    expect(selected.getAttribute('aria-label')).toBe('Declared title')
  })

  it('indexes pages in words: the fiber page as §, file names without their extension unless that collides', () => {
    const channel = buildChannel({ uid: 'words', owner: 'words-host', name: 'A named fiber', path: '/fiber.md', fiberDir: '/', body: 'Preview prose', embeds: [{ path: '/song.mp3' }, { path: '/a/take.wav' }, { path: '/b/take.flac' }] })
    expect(indexCaptions(channel.labels, channel)).toEqual(['§', 'song', 'take.wav', 'take.flac'])
    const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
    strips.push(strip)
    strip.render(channel.labels, channel.documents.map(d => d.key), channel)
    expect(strip.buttons.map(button => button.textContent)).toEqual(['§', 'song', 'take.wav', 'take.flac'])
    expect(strip.buttons.map(button => button.getAttribute('aria-label'))).toEqual(channel.labels)
    expect(strip.buttons[0].classList.contains('ws-tab-anchor')).toBe(true)
    expect(strip.buttons.some(button => button.hasAttribute('title'))).toBe(false)
    expect(strip.el.querySelector('[data-part="thumbnail"]')).toBeNull()
  })

  describe('hover preview', () => {
    const pointer = (type: string, target: Element, pointerType = 'mouse', relatedTarget: Element | null = null): void => {
      const event = new MouseEvent(type, { bubbles: true, relatedTarget })
      Object.defineProperty(event, 'pointerType', { value: pointerType })
      target.dispatchEvent(event)
    }
    const setup = (): { strip: TabStrip; preview: NonNullable<TabStrip['preview']> } => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const channel = buildChannel({ uid: 'peek', owner: 'peek-host', name: 'Peek', path: '/fiber.md', fiberDir: '/', body: 'Body prose', embeds: [{ path: '/one.html' }, { path: '/two.png' }] })
      const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
      strips.push(strip)
      document.body.append(strip.el, strip.preview!.el)
      strip.render(channel.labels, channel.documents.map(d => d.key), channel)
      return { strip, preview: strip.preview! }
    }
    afterEach(() => { vi.useRealTimers() })

    it('waits before a first preview, then follows the pointer across labels at once', () => {
      const { strip, preview } = setup()
      pointer('pointerover', strip.buttons[1])
      vi.advanceTimersByTime(399)
      expect(preview.open).toBe(false)
      vi.advanceTimersByTime(1)
      expect(preview.open).toBe(true)
      expect(preview.el.getAttribute('aria-hidden')).toBe('true')
      expect(preview.el.querySelector('.ws-tab-preview-title')?.textContent).toBe('one.html')
      expect(preview.el.querySelector('[data-part="thumbnail"]')).not.toBeNull()
      expect(preview.el.querySelector('[data-part="thumbnail-face"]')).not.toBeNull()
      pointer('pointerout', strip.buttons[1], 'mouse', strip.buttons[2])
      pointer('pointerover', strip.buttons[2])
      expect(preview.open).toBe(true)
      expect(preview.el.querySelector('.ws-tab-preview-title')?.textContent).toBe('two.png')
      expect(document.activeElement).not.toBe(preview.el)
    })

    it('leaves with the pointer, gives way to a press or a key, and ignores touch', () => {
      const { strip, preview } = setup()
      pointer('pointerover', strip.buttons[0], 'touch')
      vi.advanceTimersByTime(1000)
      expect(preview.open).toBe(false)
      pointer('pointerover', strip.buttons[0])
      vi.advanceTimersByTime(400)
      expect(preview.el.querySelector('.ws-tab-preview-title')?.textContent).toBe('Peek')
      pointer('pointerout', strip.buttons[0], 'mouse', document.body)
      vi.advanceTimersByTime(200)
      expect(preview.open).toBe(false)
      pointer('pointerover', strip.buttons[1])
      expect(preview.open).toBe(true)
      pointer('pointerdown', strip.buttons[1])
      expect(preview.open).toBe(false)
      pointer('pointerover', strip.buttons[1])
      vi.advanceTimersByTime(1000)
      expect(preview.open).toBe(false)
      pointer('pointerover', strip.buttons[2])
      vi.advanceTimersByTime(400)
      expect(preview.open).toBe(true)
      expect(preview.dismiss()).toBe(true)
      expect(preview.dismiss()).toBe(false)
      strip.setVisible(false)
      vi.advanceTimersByTime(1000)
      pointer('pointerover', strip.buttons[0])
      vi.advanceTimersByTime(1000)
      expect(preview.open).toBe(false)
    })
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
