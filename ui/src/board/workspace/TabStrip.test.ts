// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { centeredScrollLeft, indexCaptions, TAB_CROSSING_MS, TabStrip, TIP_DELAY_MS } from './TabStrip.js'
import { noteAudioSketch } from './audioSketch.js'
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
    strip.render(['One', 'Two', 'Three'])
    dimensions(strip.el, { clientWidth: 100, scrollWidth: 500 })
    dimensions(strip.buttons[1], { offsetLeft: 200, offsetWidth: 90 })
    dimensions(strip.buttons[2], { offsetLeft: 300, offsetWidth: 90 })
    strip.mark(1, true)
    expect(strip.el.scrollLeft).toBe(195)
    // Edges fade only where a tile runs past them.
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

  it('names pages in words: the fiber page as §, file names without their extension unless that collides', () => {
    const channel = buildChannel({ uid: 'words', owner: 'words-host', name: 'A named fiber', path: '/fiber.md', fiberDir: '/', body: 'Preview prose', embeds: [{ path: '/song.mp3' }, { path: '/a/take.wav' }, { path: '/b/take.flac' }] })
    expect(indexCaptions(channel.labels, channel)).toEqual(['§', 'song', 'take.wav', 'take.flac'])
    const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
    strips.push(strip)
    strip.render(channel.labels, channel.documents.map(d => d.key), channel)
    expect(strip.buttons.map(button => button.querySelector('.ws-tab-label')?.textContent)).toEqual(['§', 'song', 'take.wav', 'take.flac'])
    expect(strip.buttons.map(button => button.getAttribute('aria-label'))).toEqual(channel.labels)
    expect(strip.buttons[0].classList.contains('ws-tab-anchor')).toBe(true)
    expect(strip.buttons.some(button => button.hasAttribute('title'))).toBe(false)
  })

  it('gives every tile a legible face at once: its title, its kind, and a recording its sketch or length', () => {
    const channel = buildChannel({ uid: 'faces', owner: 'faces-host', name: 'Faces', path: '/fiber.md', fiberDir: '/', body: 'Body', embeds: [{ path: '/report.html', title: 'The composer’s desk' }, { path: '/etude.mp3' }, { path: '/score.pdf' }, { path: '/coda.mp3' }] })
    noteAudioSketch(channel.documents[2].key, [0.1, 0.9, 0.4, 0.2], 61)
    noteAudioSketch(channel.documents[4].key, null, 125)
    const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
    strips.push(strip)
    strip.render(channel.labels, channel.documents.map(d => d.key), channel)
    const face = (i: number): Element => strip.buttons[i].querySelector('[data-part="thumbnail-face"]')!
    expect(strip.buttons.map(b => b.dataset.kind)).toEqual(['fiber', 'html', 'audio', 'pdf', 'audio'])
    expect(face(0).querySelector('.ws-thumbnail-kind')?.textContent).toBe('§')
    expect(face(1).querySelector('.ws-thumbnail-title')?.textContent).toBe('The composer’s desk')
    expect(face(2).querySelector('.ws-thumbnail-title')?.textContent).toBe('etude')
    expect(face(2).querySelectorAll('.ws-tile-sketch[data-form="peaks"] i')).toHaveLength(4)
    expect(face(3).querySelector('.ws-thumbnail-title')?.textContent).toBe('score')
    expect(face(3).querySelector('.ws-thumbnail-kind')?.textContent).toBe('▧')
    expect(face(4).querySelector('.ws-tile-sketch')?.textContent).toBe('2:05')
    noteAudioSketch(channel.documents[4].key, [0.5, 0.5], 125)
    expect(face(4).querySelectorAll('.ws-tile-sketch i')).toHaveLength(2)
  })

  describe('hover caption', () => {
    const pointer = (type: string, target: Element, pointerType = 'mouse'): void => {
      const event = new MouseEvent(type, { bubbles: true })
      Object.defineProperty(event, 'pointerType', { value: pointerType })
      target.dispatchEvent(event)
    }
    const setup = (): TabStrip => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const channel = buildChannel({ uid: 'peek', owner: 'peek-host', name: 'Peek', path: '/fiber.md', fiberDir: '/', body: 'Body prose', embeds: [{ path: '/one.html' }, { path: '/two.png' }] })
      const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
      strips.push(strip)
      const band = document.createElement('div')
      band.style.position = 'relative'
      band.append(strip.el, strip.tip)
      document.body.append(band)
      strip.render(channel.labels, channel.documents.map(d => d.key), channel)
      strip.mark(0, false)
      return strip
    }
    afterEach(() => { vi.useRealTimers() })

    it('waits before a first caption, then follows the pointer across tiles at once', () => {
      const strip = setup()
      pointer('pointerover', strip.buttons[1])
      vi.advanceTimersByTime(TIP_DELAY_MS - 1)
      expect(strip.tip.hidden).toBe(true)
      vi.advanceTimersByTime(1)
      expect(strip.tip.hidden).toBe(false)
      expect(strip.tip.getAttribute('aria-hidden')).toBe('true')
      expect(strip.tip.textContent).toBe('one.html')
      pointer('pointerover', strip.buttons[2])
      expect(strip.tip.textContent).toBe('two.png')
    })

    it('names no selected tile, gives way to a press or a key, leaves with the pointer and ignores touch', () => {
      const strip = setup()
      pointer('pointerover', strip.buttons[0])
      vi.advanceTimersByTime(1000)
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', strip.buttons[1], 'touch')
      vi.advanceTimersByTime(1000)
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', strip.buttons[1])
      vi.advanceTimersByTime(TIP_DELAY_MS)
      expect(strip.tip.hidden).toBe(false)
      pointer('pointerdown', strip.buttons[1])
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', strip.buttons[2])
      vi.advanceTimersByTime(TIP_DELAY_MS)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', strip.buttons[1])
      vi.advanceTimersByTime(TIP_DELAY_MS)
      strip.el.dispatchEvent(new MouseEvent('pointerleave'))
      expect(strip.tip.hidden).toBe(true)
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
