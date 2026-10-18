// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardPreview, PREVIEW_TIMING, placePreview, type PreviewContent } from './CardPreview.js'

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height })

describe('placePreview', () => {
  const size = { width: 380, height: 300 }
  const viewport = { width: 1600, height: 1000 }

  it('opens beside the row, right first, top-aligned with it', () => {
    expect(placePreview(rect(20, 200, 500, 30), size, viewport)).toEqual({ left: 530, top: 200, side: 'right' })
  })
  it('turns to the left at the right edge of the window', () => {
    expect(placePreview(rect(1080, 200, 500, 30), size, viewport)).toEqual({ left: 690, top: 200, side: 'left' })
  })
  it('stays inside the viewport when the row is near its foot', () => {
    expect(placePreview(rect(20, 900, 500, 30), size, viewport).top).toBe(1000 - 8 - 300)
  })
  it('drops below a row too wide to sit beside, or above when below is shorter', () => {
    const narrow = { width: 420, height: 900 }
    expect(placePreview(rect(10, 100, 400, 40), size, narrow)).toMatchObject({ side: 'below', top: 150, left: 10 })
    expect(placePreview(rect(10, 700, 400, 40), size, narrow)).toMatchObject({ side: 'above', top: 390 })
  })
})

function pointer(type: string, target: Element, init: { relatedTarget?: Element | null; pointerType?: string } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: init.relatedTarget ?? null })
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' })
  target.dispatchEvent(event)
}

describe('CardPreview', () => {
  let root: HTMLElement
  let host: HTMLElement
  let preview: CardPreview
  let build: ReturnType<typeof vi.fn<(row: HTMLElement) => PreviewContent | null>>
  let disposed: string[]

  const row = (uid: string, origin = 'here'): HTMLElement => {
    const el = document.createElement('div')
    el.className = 'kbn-card'
    el.dataset.cardUid = uid
    el.dataset.cardOrigin = origin
    el.append(Object.assign(document.createElement('span'), { className: 'kbn-card-name', textContent: uid }))
    return el
  }
  const column = (...rows: HTMLElement[]): HTMLElement => {
    const col = document.createElement('section')
    col.className = 'kbn-col'
    col.append(...rows)
    return col
  }

  beforeEach(() => {
    vi.useFakeTimers()
    root = document.createElement('div')
    host = document.createElement('div')
    document.body.append(host, root)
    disposed = []
    build = vi.fn((el: HTMLElement): PreviewContent | null => {
      const content = document.createElement('div')
      content.className = 'built'
      content.textContent = `full ${el.dataset.cardUid}`
      return { el: content, dispose: () => disposed.push(el.dataset.cardUid!) }
    })
    preview = new CardPreview({ root, host, build })
  })
  afterEach(() => {
    preview.dispose()
    document.body.replaceChildren()
    vi.useRealTimers()
  })

  it('builds nothing until the pointer settles on a row, then shows that row\'s card', () => {
    const a = row('a')
    root.append(column(a, row('b')))
    expect(build).not.toHaveBeenCalled()
    pointer('pointerover', a.firstElementChild!)
    vi.advanceTimersByTime(PREVIEW_TIMING.open - 1)
    expect(build).not.toHaveBeenCalled()
    expect(preview.panel.hidden).toBe(true)
    vi.advanceTimersByTime(1)
    expect(build).toHaveBeenCalledTimes(1)
    expect(preview.panel.hidden).toBe(false)
    expect(preview.panel.textContent).toBe('full a')
    expect(a.getAttribute('aria-describedby')).toBe(preview.panel.id)
    expect(preview.panel.getAttribute('role')).toBe('tooltip')
  })

  it('passes over a row the pointer only crosses', () => {
    const a = row('a'), b = row('b')
    root.append(column(a, b))
    pointer('pointerover', a)
    vi.advanceTimersByTime(100)
    pointer('pointerout', a, { relatedTarget: b })
    pointer('pointerover', b, { relatedTarget: a })
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(build).toHaveBeenCalledTimes(1)
    expect(preview.openRow).toBe(b)
  })

  it('hops warm from row to row while one is showing, without closing between', () => {
    const a = row('a'), b = row('b')
    root.append(column(a, b))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    pointer('pointerout', a, { relatedTarget: b })
    pointer('pointerover', b, { relatedTarget: a })
    vi.advanceTimersByTime(PREVIEW_TIMING.warm)
    expect(preview.openRow).toBe(b)
    expect(preview.panel.hasAttribute('data-warm')).toBe(true)
    expect(disposed).toEqual(['a'])
  })

  it('closes after a grace when the pointer leaves, and stays when it comes back in time', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    pointer('pointerout', a, { relatedTarget: root })
    vi.advanceTimersByTime(PREVIEW_TIMING.close - 1)
    pointer('pointerover', a, { relatedTarget: root })
    vi.advanceTimersByTime(PREVIEW_TIMING.close)
    expect(preview.isOpen).toBe(true)
    pointer('pointerout', a, { relatedTarget: root })
    vi.advanceTimersByTime(PREVIEW_TIMING.close)
    expect(preview.isOpen).toBe(false)
    expect(preview.panel.hidden).toBe(true)
    expect(a.hasAttribute('aria-describedby')).toBe(false)
    expect(disposed).toEqual(['a'])
  })

  it('moving within a row keeps the preview steady', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    pointer('pointerout', a, { relatedTarget: a.firstElementChild })
    pointer('pointerover', a.firstElementChild!, { relatedTarget: a })
    vi.advanceTimersByTime(1000)
    expect(preview.openRow).toBe(a)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('a press closes it and keeps the row quiet until the pointer leaves', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    pointer('pointerdown', a)
    expect(preview.isOpen).toBe(false)
    pointer('pointerover', a.firstElementChild!, { relatedTarget: a })
    vi.advanceTimersByTime(1000)
    expect(preview.isOpen).toBe(false)
    pointer('pointerout', a, { relatedTarget: root })
    pointer('pointerover', a, { relatedTarget: root })
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(preview.isOpen).toBe(true)
  })

  it('a drag closes it before the drag image is taken', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    a.dispatchEvent(new Event('dragstart', { bubbles: true }))
    expect(preview.isOpen).toBe(false)
  })

  it('Escape closes it', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(preview.isOpen).toBe(false)
  })

  it('ignores touch and pen: a finger opens the card, it does not hover', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a, { pointerType: 'touch' })
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(build).not.toHaveBeenCalled()
  })

  it('previews only Desk rows and Resting lines', () => {
    const stray = row('stray')
    root.append(stray)
    pointer('pointerover', stray)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(build).not.toHaveBeenCalled()
    const line = row('line')
    line.className = 'kbn-cluster-item'
    root.append(line)
    pointer('pointerover', line)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(preview.openRow).toBe(line)
  })

  it('follows its card onto the rebuilt row after a Desk redraw, and closes when the card is gone', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    const rebuilt = row('a')
    root.replaceChildren(column(rebuilt, row('b')))
    preview.rerendered()
    expect(preview.openRow).toBe(rebuilt)
    expect(build).toHaveBeenCalledTimes(2)
    expect(rebuilt.getAttribute('aria-describedby')).toBe(preview.panel.id)
    root.replaceChildren(column(row('b')))
    preview.rerendered()
    expect(preview.isOpen).toBe(false)
  })

  it('keeps one card apart from its namesake on another host', () => {
    const here = row('a', 'here')
    root.append(column(here))
    pointer('pointerover', here)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    root.replaceChildren(column(row('a', 'there')))
    preview.rerendered()
    expect(preview.isOpen).toBe(false)
  })

  it('follows the keyboard selection, which the pointer leaving does not close', () => {
    const a = row('a'), b = row('b')
    root.append(column(a, b))
    preview.select(a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(preview.openRow).toBe(a)
    pointer('pointerout', a, { relatedTarget: root })
    vi.advanceTimersByTime(PREVIEW_TIMING.close * 2)
    expect(preview.openRow).toBe(a)
    preview.select(b)
    vi.advanceTimersByTime(PREVIEW_TIMING.warm)
    expect(preview.openRow).toBe(b)
    preview.select(null)
    expect(preview.isOpen).toBe(false)
  })

  it('a scroll the keyboard caused does not cancel the preview it asked for', () => {
    const a = row('a')
    root.append(column(a))
    preview.select(a)
    root.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(preview.openRow).toBe(a)
  })

  it('a scroll under a pointer preview closes it', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    root.dispatchEvent(new Event('scroll'))
    expect(preview.isOpen).toBe(false)
  })

  it('a row with nothing to show opens nothing', () => {
    build.mockReturnValueOnce(null)
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    expect(preview.isOpen).toBe(false)
    expect(preview.panel.hidden).toBe(true)
  })

  it('dispose releases the open content and the panel', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    preview.dispose()
    expect(disposed).toEqual(['a'])
    expect(preview.panel.isConnected).toBe(false)
  })
})
