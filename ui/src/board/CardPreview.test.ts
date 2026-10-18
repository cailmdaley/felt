// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CardPreview, PREVIEW_NEIGHBOUR, PREVIEW_TIMING, columnFrame, headingToward, placePreview, type PreviewContent } from './CardPreview.js'

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height })

describe('columnFrame', () => {
  const viewport = { width: 1440, height: 900 }

  it('takes the neighbour column\'s exact box when it is on screen', () => {
    expect(columnFrame(rect(963, 58, 465, 650), viewport)).toEqual(rect(963, 58, 465, 650))
  })
  it('cuts the box to the viewport where the Desk has scrolled it partly away', () => {
    expect(columnFrame(rect(487, -120, 465, 650), viewport)).toEqual(rect(487, 0, 465, 530))
  })
  it('floats instead when the neighbour is off to the side, narrow, or mostly out of sight', () => {
    // The phone's pager: the next leaf waits beyond the right edge.
    expect(columnFrame(rect(390, 100, 374, 500), { width: 390, height: 844 })).toBeNull()
    expect(columnFrame(rect(400, 100, 180, 500), viewport)).toBeNull()
    expect(columnFrame(rect(400, 780, 465, 650), viewport)).toBeNull()
  })
  it('pairs each Now column with the one it covers', () => {
    expect(PREVIEW_NEIGHBOUR).toEqual({ drafts: 'inFlight', inFlight: 'awaitingReview', awaitingReview: 'inFlight' })
  })
})

describe('headingToward', () => {
  const right = rect(500, 100, 400, 600)
  const left = rect(0, 100, 400, 600)

  it('sees a pointer moving into the triangle toward the panel\'s near edge', () => {
    expect(headingToward({ x: 450, y: 300 }, { x: 460, y: 305 }, right)).toBe(true)
    expect(headingToward({ x: 450, y: 300 }, { x: 440, y: 305 }, left)).toBe(true)
    // Steep but still inside: the near edge spans the whole column.
    expect(headingToward({ x: 450, y: 300 }, { x: 455, y: 330 }, right)).toBe(true)
  })
  it('does not see one moving away, or along the column past the panel\'s reach', () => {
    expect(headingToward({ x: 450, y: 300 }, { x: 440, y: 300 }, right)).toBe(false)
    expect(headingToward({ x: 450, y: 650 }, { x: 452, y: 700 }, right)).toBe(false)
    expect(headingToward({ x: 450, y: 300 }, { x: 450, y: 320 }, right)).toBe(false)
    expect(headingToward({ x: 600, y: 300 }, { x: 610, y: 300 }, right)).toBe(false)
  })
})

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
    expect(a.getAttribute('aria-details')).toBe(preview.panel.id)
    expect(preview.panel.getAttribute('role')).toBe('region')
    expect(preview.panel.getAttribute('aria-label')).toBe('Preview: a')
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
    expect(a.hasAttribute('aria-details')).toBe(false)
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
    expect(rebuilt.getAttribute('aria-details')).toBe(preview.panel.id)
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

  it('stays open while the pointer crosses from the row into the panel, and closes when it leaves both', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    pointer('pointerout', a, { relatedTarget: root })
    vi.advanceTimersByTime(PREVIEW_TIMING.close - 1)
    preview.panel.dispatchEvent(new MouseEvent('pointerenter'))
    vi.advanceTimersByTime(PREVIEW_TIMING.close * 5)
    expect(preview.openRow).toBe(a)
    preview.panel.dispatchEvent(new MouseEvent('pointerleave'))
    vi.advanceTimersByTime(PREVIEW_TIMING.close)
    expect(preview.isOpen).toBe(false)
  })

  it('a press inside the panel leaves it open; a press outside closes it', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    pointer('pointerdown', preview.panel.querySelector('.built')!)
    expect(preview.isOpen).toBe(true)
    pointer('pointerdown', document.body)
    expect(preview.isOpen).toBe(false)
  })

  it('a scroll inside the panel is reading, not leaving', () => {
    const a = row('a')
    root.append(column(a))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    preview.panel.querySelector('.built')!.dispatchEvent(new Event('scroll'))
    expect(preview.isOpen).toBe(true)
  })

  it('a row crossed on the way to the panel waits longer before it takes over', () => {
    const a = row('a'), b = row('b')
    root.append(column(a, b))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    preview.panel.getBoundingClientRect = () => ({ ...rect(500, 0, 400, 800), x: 500, y: 0, toJSON: () => ({}) })
    const move = (x: number, y: number, timeStamp: number) => {
      const e = new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true })
      Object.defineProperty(e, 'pointerType', { value: 'mouse' })
      Object.defineProperty(e, 'timeStamp', { value: timeStamp })
      document.dispatchEvent(e)
    }
    move(300, 100, 1000)
    move(330, 110, 1016)
    const over = new MouseEvent('pointerover', { clientX: 360, clientY: 120, bubbles: true, relatedTarget: a })
    Object.defineProperty(over, 'pointerType', { value: 'mouse' })
    pointer('pointerout', a, { relatedTarget: b })
    b.dispatchEvent(over)
    vi.advanceTimersByTime(PREVIEW_TIMING.warm)
    expect(preview.openRow).toBe(a)
    // The pointer reaches the panel: the crossed row never opens.
    pointer('pointerout', b, { relatedTarget: null })
    preview.panel.dispatchEvent(new MouseEvent('pointerenter'))
    vi.advanceTimersByTime(PREVIEW_TIMING.aim * 2)
    expect(preview.openRow).toBe(a)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('a row the pointer rests on while not aiming opens warm', () => {
    const a = row('a'), b = row('b')
    root.append(column(a, b))
    pointer('pointerover', a)
    vi.advanceTimersByTime(PREVIEW_TIMING.open)
    pointer('pointerout', a, { relatedTarget: b })
    pointer('pointerover', b, { relatedTarget: a })
    vi.advanceTimersByTime(PREVIEW_TIMING.warm)
    expect(preview.openRow).toBe(b)
  })

  it('covers the neighbouring Now column, in its exact frame', () => {
    const board = document.createElement('div')
    const col = (kind: string, left: number, ...rows: HTMLElement[]): HTMLElement => {
      const c = column(...rows)
      c.dataset.column = kind
      c.getBoundingClientRect = () => ({ ...rect(left, 58, 465, 650), x: left, y: 58, toJSON: () => ({}) })
      return c
    }
    const draft = row('draft'), flying = row('flying'), owed = row('owed')
    board.append(col('drafts', 12, draft), col('inFlight', 487, flying), col('awaitingReview', 963, owed))
    root.append(board)
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1440 })
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 })
    const frameOf = (r: HTMLElement) => {
      preview.select(r)
      vi.advanceTimersByTime(PREVIEW_TIMING.open)
      const s = preview.panel.style
      return [preview.panel.dataset.frame, s.left, s.top, s.width, s.height]
    }
    expect(frameOf(draft)).toEqual(['column', '487px', '58px', '465px', '650px'])
    expect(frameOf(flying)).toEqual(['column', '963px', '58px', '465px', '650px'])
    expect(frameOf(owed)).toEqual(['column', '487px', '58px', '465px', '650px'])
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
