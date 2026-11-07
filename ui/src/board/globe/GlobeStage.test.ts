// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { GlobeStage, freshPlace, type GlobeHost, type GlobePlace } from './GlobeStage.js'
import { frameOf, invert, northUp, project, type Frame } from './camera.js'

const WIDTH = 800, HEIGHT = 1000, ORIGIN = 'local'
const thread = (id: string, extra: Partial<KanbanCard> = {}): KanbanCard => card({ id, uid: id, name: id, status: 'active', createdAt: '2026-11-01T00:00:00Z', sessionUuid: `session-${id}`, ...extra })

const noop = (): void => {}
const gradient = { addColorStop: noop }
const context = new Proxy({ getTransform: () => ({ a: 1, d: 1 }), createRadialGradient: () => gradient, measureText: (text: string) => ({ width: text.length * 7 }) }, {
  get: (target, key) => key in target ? target[key as keyof typeof target] : noop,
  set: () => true,
}) as unknown as CanvasRenderingContext2D

function host(): GlobeHost & { conversed: string[]; opened: string[] } {
  const conversed: string[] = [], opened: string[] = []
  return {
    conversed, opened,
    feeds: {
      marks: () => undefined, refresh: noop, lead: async () => undefined,
      files: found => found.id === 'science/hub' ? [{ key: 'doc:report.html', name: 'report.html', at: Date.now(), unread: false }]
        : found.id === 'life/errand' ? [{ key: 'local:/runs/plot.png', name: 'plot.png', at: Date.now(), unread: false }] : [],
    },
    openDocument: (_, doc) => opened.push(doc),
    converse: async found => { conversed.push(found.id); return true },
    constitutionKey: found => `fiber:${found.id}`,
    shuttleBase: '',
  }
}

describe('moving on the globe', () => {
  const cards = [thread('science/hub'), thread('science/hub/thread', { orchestrator: 'science/hub' }), thread('life/errand')]
  let frames: FrameRequestCallback[], stage: GlobeStage, board: ReturnType<typeof host>, place: GlobePlace
  const settle = (ms = 3000): void => { for (let n = 0; n < 200 && frames.length; n++) { const next = frames.splice(0); const at = performance.now() + ms; for (const frame of next) frame(at) } }
  const clickAt = (x: number, y: number, pointerType = 'mouse'): void => {
    const canvas = stage.el.querySelector('canvas')!
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0, pointerType, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y, pointerId: 1, pointerType }))
    settle()
  }
  const crumbs = (): string[] => [...stage.el.querySelectorAll('.globe-crumb')].map(crumb => crumb.textContent ?? '')

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
    vi.stubGlobal('cancelAnimationFrame', noop)
    vi.stubGlobal('ResizeObserver', class { observe = noop; unobserve = noop; disconnect = noop })
    vi.stubGlobal('Path2D', class {})
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerId: number; pointerType: string
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; this.pointerType = init.pointerType ?? 'mouse' }
    })
    Element.prototype.setPointerCapture ??= noop
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: WIDTH, height: HEIGHT, right: WIDTH, bottom: HEIGHT, x: 0, y: 0, toJSON: noop })
    board = host()
    place = freshPlace()
    stage = new GlobeStage(board, () => false, noop, place)
    document.body.append(stage.el)
    ;(stage as unknown as { resized(): void }).resized()
    board.onFeeds!()
    stage.update(new ThreadIndex(cards), cards)
    settle()
  })
  afterEach(() => {
    stage.dispose()
    stage.el.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('flies to a thread and opens its conversation at once on a click, and steps back out leaving Rex be', () => {
    stage.follow('science/hub', ORIGIN)
    settle()
    expect(board.conversed).toEqual([])
    clickAt(400, 500)
    expect(crumbs().at(-1)).toBe('science/hub')
    expect(board.conversed).toEqual(['science/hub'])
    stage.keydown(new KeyboardEvent('keydown', { key: 'h' }))
    settle()
    expect(crumbs()).toEqual(['Everything', 'science'])
    stage.keydown(new KeyboardEvent('keydown', { key: 'h' }))
    settle()
    expect(crumbs()).toEqual(['Everything'])
    expect(board.conversed).toEqual(['science/hub'])
  })
  it('comes to a thread on a first tap and opens its conversation on the second', () => {
    stage.follow('science/hub', ORIGIN)
    settle()
    clickAt(400, 500, 'touch')
    expect(board.conversed).toEqual([])
    clickAt(400, 500, 'touch')
    expect(board.conversed).toEqual(['science/hub'])
  })
  const wheel = (deltaY: number, init: WheelEventInit = {}): void => {
    stage.el.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: 400, clientY: 500, bubbles: true, cancelable: true, ...init }))
  }
  const drag = (from: [number, number], to: [number, number]): void => {
    const canvas = stage.el.querySelector('canvas')!
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: from[0], clientY: from[1], pointerId: 2, button: 0, bubbles: true }))
    for (let n = 1; n <= 10; n++) window.dispatchEvent(new PointerEvent('pointermove', { clientX: from[0] + (to[0] - from[0]) * n / 10, clientY: from[1] + (to[1] - from[1]) * n / 10, pointerId: 2 }))
  }
  it('zooms on a plain scroll, out as it scrolls back, and on a pinch, never reaching Rex', () => {
    stage.follow('science/hub', ORIGIN)
    settle()
    const start = place.camera!.radius
    wheel(-40)
    const closer = place.camera!.radius
    expect(closer).toBeGreaterThan(start)
    wheel(40)
    expect(place.camera!.radius).toBeCloseTo(start, 6)
    wheel(-8, { ctrlKey: true })
    expect(place.camera!.radius / start).toBeCloseTo(closer / start, 6)
    settle()
    expect(board.conversed).toEqual([])
  })
  it('turns from straight over the pole and on past it, the grabbed point under the pointer', () => {
    const frame = (): Frame => frameOf(place.camera ?? { turn: northUp(Math.PI / 4, Math.PI / 2), at: [0, 0], radius: 386 }, 'globe', { width: WIDTH, height: HEIGHT })
    const grabbed = invert(frame(), 400, 380)!
    drag([400, 380], [400, 760])
    const seen = project(frame(), grabbed)
    expect(seen.x).toBeCloseTo(400, 4)
    expect(seen.y).toBeCloseTo(760, 4)
    expect(project(frame(), [0, 0, 1]).y).toBeGreaterThan(HEIGHT / 2)
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 400, clientY: 760, pointerId: 2 }))
    expect(board.conversed).toEqual([])
  })
  it('names an archived thread only once the view comes to it', () => {
    const settled = [...cards, thread('science/hub/old', { orchestrator: 'science/hub', status: 'closed', tempered: true })]
    stage.update(new ThreadIndex(settled), settled)
    stage.follow('science/hub', ORIGIN)
    settle()
    const named = (): string[] => [...stage.el.querySelectorAll('.globe-name')].map(name => name.textContent ?? '')
    expect(named()).toContain('science/hub/thread')
    expect(named()).not.toContain('science/hub/old')
    stage.follow('science/hub/old', ORIGIN)
    settle()
    expect(named()).toContain('science/hub/old')
  })
  it('shows a sent plot on its tile once the tile is wide enough to read it, and names it beneath', () => {
    const shown = (): HTMLElement[] => [...stage.el.querySelectorAll<HTMLElement>('.globe-preview:not([hidden])')]
    expect(shown()).toHaveLength(0)
    stage.follow('life/errand', ORIGIN)
    settle()
    const name = stage.el.querySelector<HTMLElement>('.globe-name[data-kind="file"]')!
    const [, x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(name.style.transform)!.map(Number)
    for (let n = 0; n < 12 && !shown().length; n++) stage.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, clientX: x, clientY: y, bubbles: true, cancelable: true }))
    settle()
    expect(shown()).toHaveLength(1)
    expect(shown()[0].querySelector('img')?.getAttribute('src')).toContain('plot.png')
    const caption = stage.el.querySelector<HTMLElement>('.globe-name[data-kind="file"]')!
    expect(caption.textContent).toBe('plot.png')
  })
  it('opens a sent file on the stage from its tile', () => {
    stage.follow('science/hub', ORIGIN)
    settle()
    const file = stage.el.querySelector<HTMLElement>('.globe-name[data-kind="file"]')!
    expect(file.textContent).toBe('report.html')
    file.click()
    expect(board.opened).toEqual(['doc:report.html'])
    expect(board.conversed).toEqual([])
  })
  it('gives its names the board\'s vocabulary', () => {
    stage.follow('science/hub', ORIGIN)
    settle()
    const name = stage.el.querySelector<HTMLElement>('.globe-name[data-kind="thread"]')!
    expect(name.getAttribute('role')).toBe('option')
    expect(name.dataset.thread).toBeDefined()
    expect(name.dataset.standing).toBeDefined()
  })
  it('answers false for a fiber it does not hold', () => {
    expect(stage.follow('nowhere', ORIGIN)).toBe(false)
  })
  it('names what asks in earnest beside its marker, from the whole sphere', () => {
    const asking = [...cards, thread('life/ask', { ask: { text: 'Which?', at: '2026-11-06T00:00:00Z' } })]
    stage.update(new ThreadIndex(asking), asking)
    settle()
    expect([...stage.el.querySelectorAll('.globe-name')].map(name => name.textContent)).toContain('life/ask')
  })
  it('rings the thread once Rex answers that it moved there, and not before or otherwise', async () => {
    stage.follow('science/hub', ORIGIN)
    settle()
    place.worker = null
    board.converse = async () => false
    clickAt(400, 500)
    await Promise.resolve()
    expect(place.worker).toBeNull()
    let answer!: (moved: boolean) => void
    board.converse = () => new Promise(resolve => { answer = resolve })
    clickAt(400, 500)
    expect(place.worker).toBeNull()
    answer(true)
    await Promise.resolve()
    expect(place.worker).toBe('science/hub')
  })
  it('keeps a fiber named alike on two hosts as two tiles, and comes to the host Rex names', () => {
    const twins = [...cards, thread('life/twin', { uid: undefined, originId: 'north', name: 'Twin north' }), thread('life/twin', { uid: undefined, originId: 'south', name: 'Twin south' })]
    stage.update(new ThreadIndex(twins), twins)
    settle()
    for (const [origin, name] of [['north', 'Twin north'], ['south', 'Twin south']]) {
      stage.follow('life/twin', origin)
      settle()
      expect(crumbs().at(-1)).toBe(name)
    }
  })
  it('holds a new thread as cards refresh', () => {
    const fresh = [...cards, thread('science/hub/new', { orchestrator: 'science/hub' })]
    stage.update(new ThreadIndex(fresh), fresh)
    settle()
    expect(stage.follow('science/hub/new', ORIGIN)).toBe(true)
  })
})
