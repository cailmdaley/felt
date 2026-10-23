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
  it('coalesces repeated marks without reading layout on the interaction stack', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const strip = create()
    const reads = vi.fn(() => 100)
    Object.defineProperty(strip.el, 'clientWidth', { configurable: true, get: reads })
    strip.render(['One', 'Two'])
    strip.mark(0, false)
    strip.setFocus(30)
    strip.mark(1, false)
    expect(reads).not.toHaveBeenCalled()
    expect(strip.buttons[1].getAttribute('aria-selected')).toBe('true')
    expect(frames).toHaveLength(1)
    frames.shift()!(0)
    expect(reads).toHaveBeenCalled()
  })
  it('lands a pending placement at once when flushed, and only once', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const strip = create()
    strip.render(['One', 'Two'])
    frames.length = 0
    dimensions(strip.el, { clientWidth: 100, scrollWidth: 500 })
    dimensions(strip.buttons[1], { offsetLeft: 200, offsetWidth: 90 })
    strip.mark(1, false)
    expect(strip.el.scrollLeft).toBe(0)
    strip.flushLayout()
    expect(strip.el.scrollLeft).toBe(195)
    expect(cancel).toHaveBeenCalledWith(1)
    strip.el.scrollLeft = 7
    strip.flushLayout()
    expect(strip.el.scrollLeft).toBe(7)
  })
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

  it('centres the selected tab without animating when reduced motion is preferred', () => {
    let frame!: FrameRequestCallback
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
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
    frame(0)
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
    expect(indexCaptions(channel.labels, channel)).toEqual(['take.flac', 'take.wav', 'song', '§'])
    const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
    strips.push(strip)
    strip.render(channel.labels, channel.documents.map(d => d.key), channel)
    expect(strip.buttons.map(button => button.querySelector('.ws-tab-label')?.textContent)).toEqual(['take.flac', 'take.wav', 'song', '§'])
    expect(strip.buttons.map(button => button.getAttribute('aria-label'))).toEqual(channel.labels)
    expect(strip.buttons[3].classList.contains('ws-tab-anchor')).toBe(true)
    expect(strip.buttons.some(button => button.hasAttribute('title'))).toBe(false)
  })

  it('gives every tile a legible face at once: its title, its kind, and a recording its sketch or length', () => {
    const channel = buildChannel({ uid: 'faces', owner: 'faces-host', name: 'Faces', path: '/fiber.md', fiberDir: '/', body: 'Body', embeds: [{ path: '/report.html', title: 'The composer’s desk' }, { path: '/etude.mp3' }, { path: '/score.pdf' }, { path: '/coda.mp3' }] })
    noteAudioSketch(channel.documents[2].key, [0.1, 0.9, 0.4, 0.2], 61)
    noteAudioSketch(channel.documents[0].key, null, 125)
    const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
    strips.push(strip)
    strip.render(channel.labels, channel.documents.map(d => d.key), channel)
    const face = (i: number): Element => strip.buttons[i].querySelector('[data-part="thumbnail-face"]')!
    expect(strip.buttons.map(b => b.dataset.kind)).toEqual(['audio', 'pdf', 'audio', 'html', 'fiber'])
    expect(strip.buttons.map(b => b.dataset.caption)).toEqual(['coda', 'score', 'etude', 'The composer’s desk', undefined])
    expect(face(4).querySelector('.ws-thumbnail-kind')?.textContent).toBe('§')
    expect(face(3).querySelector('.ws-thumbnail-title')?.textContent).toBe('The composer’s desk')
    expect(face(2).querySelector('.ws-thumbnail-title')?.textContent).toBe('etude')
    expect(face(2).querySelectorAll('.ws-tile-sketch[data-form="peaks"] i')).toHaveLength(4)
    expect(face(1).querySelector('.ws-thumbnail-title')?.textContent).toBe('score')
    expect(face(1).querySelector('.ws-thumbnail-kind')?.textContent).toBe('▧')
    expect(face(0).querySelector('.ws-tile-sketch')?.textContent).toBe('2:05')
    noteAudioSketch(channel.documents[0].key, [0.5, 0.5], 125)
    expect(face(0).querySelectorAll('.ws-tile-sketch i')).toHaveLength(2)
  })

  for (const side of ['sent', 'declared'] as const) describe(`hover caption (${side} tiles)`, () => {
    const pointer = (type: string, target: Element, pointerType = 'mouse'): void => {
      const event = new MouseEvent(type, { bubbles: true })
      Object.defineProperty(event, 'pointerType', { value: pointerType })
      target.dispatchEvent(event)
    }
    const setup = (): { strip: TabStrip; at: (page: number) => HTMLButtonElement } => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
      const channel = buildChannel({ uid: 'peek', owner: 'peek-host', name: 'Peek', path: '/fiber.md', fiberDir: '/', body: 'Body prose',
        ...(side === 'sent' ? { sent: [{ path: '/one.html', time: 20 }, { path: '/two.png', time: 10 }] } : { embeds: [{ path: '/one.html' }, { path: '/two.png' }] }) })
      const strip = new TabStrip(vi.fn(), vi.fn(), { shuttleBase: '' })
      strips.push(strip)
      const band = document.createElement('div')
      band.style.position = 'relative'
      band.append(strip.el, strip.tip)
      document.body.append(band)
      strip.render(channel.labels, channel.documents.map(d => d.key), channel)
      // Pages by distance from the § (0): sent tiles run right of it, declared ones left.
      const anchor = channel.documents.findIndex(d => d.kind === 'fiber')
      const at = (page: number): HTMLButtonElement => strip.buttons[anchor + (side === 'sent' ? page : -page)]
      strip.mark(anchor, false)
      return { strip, at }
    }
    afterEach(() => { vi.useRealTimers() })

    it('waits before a first caption, then follows the pointer across tiles at once', () => {
      const { strip, at } = setup()
      pointer('pointerover', at(1))
      vi.advanceTimersByTime(TIP_DELAY_MS - 1)
      expect(strip.tip.hidden).toBe(true)
      vi.advanceTimersByTime(1)
      expect(strip.tip.hidden).toBe(false)
      expect(strip.tip.getAttribute('aria-hidden')).toBe('true')
      expect(strip.tip.textContent).toBe('one.html')
      pointer('pointerover', at(2))
      expect(strip.tip.textContent).toBe('two.png')
    })

    it('names no selected tile, gives way to a press or a key, leaves with the pointer and ignores touch', () => {
      const { strip, at } = setup()
      pointer('pointerover', at(0))
      vi.advanceTimersByTime(1000)
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', at(1), 'touch')
      vi.advanceTimersByTime(1000)
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', at(1))
      vi.advanceTimersByTime(TIP_DELAY_MS)
      expect(strip.tip.hidden).toBe(false)
      pointer('pointerdown', at(1))
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', at(2))
      vi.advanceTimersByTime(TIP_DELAY_MS)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
      expect(strip.tip.hidden).toBe(true)
      pointer('pointerover', at(1))
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

  describe('a run with a chat', () => {
    const chatRun = (sent = 2) => buildChannel({ uid: 'talk', owner: 'talk-host', name: 'Talk', path: '/fiber.md', fiberDir: '/', body: '', isConstitution: true, conversation: true,
      embeds: [{ path: '/report.html' }], sent: Array.from({ length: sent }, (_, i) => ({ path: `/sent-${i}.png`, time: 1000 + i })) })
    const make = (channel: ReturnType<typeof buildChannel>, onSelect = vi.fn()) => {
      const strip = new TabStrip(onSelect, vi.fn(), { shuttleBase: '' })
      strips.push(strip); document.body.append(strip.el)
      strip.render(channel.labels, channel.documents.map(d => d.key), channel)
      strip.mark(channel.documents.length - 1, false)
      return strip
    }
    const kinds = (strip: TabStrip) => strip.buttons.map(b => b.dataset.kind)

    it('ends in the chat’s tile, selected, its files to the left and the constitution without a tile', () => {
      const channel = chatRun()
      const strip = make(channel)
      expect(kinds(strip)).toEqual(['image', 'image', 'html', 'chat'])
      expect(strip.buttons.at(-1)?.getAttribute('aria-selected')).toBe('true')
      expect(strip.buttons.at(-1)?.querySelector('.ws-thumbnail-kind')?.textContent).toBe('❝')
      expect(strip.el.hasAttribute('data-lone')).toBe(false)
    })

    it('draws the constitution as a plain § tile while it is selected, and drops it when another page is', () => {
      const channel = chatRun()
      const strip = make(channel)
      strip.mark(0, false)
      expect(kinds(strip)).toEqual(['fiber', 'image', 'image', 'html', 'chat'])
      expect(strip.buttons[0].getAttribute('aria-selected')).toBe('true')
      expect(strip.buttons[0].classList.contains('ws-tab-anchor')).toBe(true)
      expect(strip.buttons[0].querySelector('.ws-thumbnail-kind')?.textContent).toBe('§')
      strip.mark(channel.documents.length - 1, false)
      expect(kinds(strip)).toEqual(['image', 'image', 'html', 'chat'])
    })

    it('steps by keyboard over the tiles alone, never onto the tileless constitution', () => {
      const channel = chatRun()
      const onSelect = vi.fn()
      const strip = make(channel, onSelect)
      strip.buttons[0].focus()
      expect(strip.handleIntent('prev')).toBe(true)
      expect(onSelect).not.toHaveBeenCalled()
      expect(strip.handleIntent('last')).toBe(true)
      expect(onSelect).toHaveBeenLastCalledWith(channel.documents.length - 1)
      expect(strip.handleIntent('first')).toBe(true)
      expect(onSelect).toHaveBeenLastCalledWith(1)
      expect(kinds(strip)).not.toContain('fiber')
    })

    it('folds the sent files farthest from the chat behind a +N tile at the run’s start', () => {
      const channel = chatRun(6)
      const strip = make(channel)
      const more = strip.el.querySelector<HTMLButtonElement>('.ws-tab-more')!
      expect(more.textContent).toBe('+3')
      expect(strip.el.firstElementChild).toBe(more)
      expect(strip.buttons.map(b => b.dataset.tabKey!.split('/').at(-1))).toEqual(['sent-3.png', 'sent-4.png', 'sent-5.png', 'report.html', 'chat:talk-host:talk'])
      // An open constitution's § leads the run, the fold just after it.
      strip.mark(0, false)
      expect([...strip.el.children].slice(0, 3).map(el => (el as HTMLElement).dataset.kind ?? el.textContent)).toEqual(['fiber', '+3', 'image'])
      strip.mark(channel.documents.length - 1, false)
      expect(strip.el.firstElementChild).toBe(more)
      more.click()
      expect(strip.el.querySelector('.ws-tab-more')).toBeNull()
      expect(document.activeElement?.getAttribute('data-tab-key')).toContain('sent-2.png')
      expect(kinds(strip)).not.toContain('fiber')
    })

    it('marks a strip of the chat alone as lone, and not once the constitution joins it', () => {
      const channel = buildChannel({ uid: 'alone', owner: 'alone-host', name: 'Alone', path: '/fiber.md', fiberDir: '/', body: '', isConstitution: true, conversation: true })
      const strip = make(channel)
      expect(kinds(strip)).toEqual(['chat'])
      expect(strip.el.hasAttribute('data-lone')).toBe(true)
      strip.mark(0, false)
      expect(kinds(strip)).toEqual(['fiber', 'chat'])
      expect(strip.el.hasAttribute('data-lone')).toBe(false)
    })
  })

  describe('sent-attachment cap', () => {
    const many = (extra: Partial<Parameters<typeof buildChannel>[0]> = {}) => buildChannel({
      uid: 'cap', owner: 'cap-host', name: 'Cap', path: '/fiber.md', fiberDir: '/', body: '',
      sent: Array.from({ length: 7 }, (_, i) => ({ path: `/sent-${i}.html`, time: 1000 + i })), ...extra,
    })
    const make = (channel: ReturnType<typeof buildChannel>, onSelect = vi.fn()) => {
      const strip = new TabStrip(onSelect, vi.fn(), { shuttleBase: '' })
      strips.push(strip); document.body.append(strip.el)
      strip.render(channel.labels, channel.documents.map(d => d.key), channel)
      return strip
    }
    const names = (strip: TabStrip) => strip.buttons.map(b => b.dataset.tabKey!.split('/').at(-1))
    const more = (strip: TabStrip) => strip.el.querySelector<HTMLButtonElement>('.ws-tab-more')

    it('mounts the page and the three newest sent files, folding the rest behind +N', () => {
      const channel = many()
      const strip = make(channel)
      expect(names(strip)).toEqual(['fiber:cap-host:cap', 'sent-6.html', 'sent-5.html', 'sent-4.html'])
      expect(strip.el.querySelectorAll('.ws-tab-thumb')).toHaveLength(4)
      expect(more(strip)?.textContent).toBe('+4')
      expect(more(strip)?.getAttribute('aria-label')).toBe('Show 4 more documents')
      expect(strip.el.lastElementChild).toBe(more(strip))
    })

    it('never folds embedded or linked documents, however many', () => {
      const channel = many({ embeds: Array.from({ length: 5 }, (_, i) => ({ path: `/embed-${i}.html` })), links: [{ path: '/linked.html' }] })
      const strip = make(channel)
      expect(strip.buttons).toHaveLength(channel.documents.length - 4)
      expect(names(strip)).toEqual(expect.arrayContaining(['embed-0.html', 'embed-4.html', 'linked.html', 'fiber:cap-host:cap']))
      expect(more(strip)?.textContent).toBe('+4')
    })

    it('shows no tile when the sent files fit the cap', () => {
      const strip = make(many({ sent: [{ path: '/a.html', time: 1 }, { path: '/b.html', time: 2 }, { path: '/c.html', time: 3 }] }))
      expect(more(strip)).toBeNull()
      expect(strip.buttons).toHaveLength(4)
    })

    it('reveals every document, mounting their tiles, when +N is activated', () => {
      const channel = many()
      const strip = make(channel)
      more(strip)!.click()
      expect(strip.buttons).toHaveLength(channel.documents.length)
      expect(strip.el.querySelectorAll('.ws-tab-thumb')).toHaveLength(channel.documents.length)
      expect(more(strip)).toBeNull()
      strip.render(channel.labels, channel.documents.map(d => d.key), channel)
      expect(strip.buttons).toHaveLength(channel.documents.length)
    })

    it('reveals a hidden document when it is marked, and by keyboard stepping past the cap', () => {
      const channel = many()
      const onSelect = vi.fn()
      const strip = make(channel, onSelect)
      const last = channel.documents.length - 1
      const lastKey = channel.documents[last].key
      strip.mark(last, false)
      expect(strip.buttons.at(-1)?.dataset.tabKey).toBe(lastKey)
      expect(strip.buttons.at(-1)?.getAttribute('aria-selected')).toBe('true')
      expect(more(strip)).toBeNull()

      const other = make(many())
      const edge = other.buttons.at(-1)!
      edge.focus()
      expect(other.handleIntent('next')).toBe(true)
      expect(other.buttons).toHaveLength(channel.documents.length)
      expect(document.activeElement).toBe(other.buttons[other.buttons.indexOf(edge) + 1])
    })

    it('keeps a selected hidden document visible across a re-render, and re-caps on another channel', () => {
      const channel = many()
      const strip = make(channel)
      strip.mark(channel.documents.length - 1, false)
      strip.render(channel.labels, channel.documents.map(d => d.key), channel)
      expect(strip.buttons).toHaveLength(channel.documents.length)
      const next = many({ uid: 'cap-2' })
      strip.render(next.labels, next.documents.map(d => d.key), next)
      expect(strip.buttons).toHaveLength(4)
      expect(more(strip)?.textContent).toBe('+4')
    })
  })
})
