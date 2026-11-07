// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { GlobeStage, freshPlace, type GlobeHost, type GlobePlace } from './GlobeStage.js'

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
    feeds: { marks: () => undefined, files: found => found.id === 'science/hub' ? [{ key: 'doc:report.html', name: 'report.html', at: Date.now(), unread: false }] : [], refresh: noop, lead: async () => undefined },
    openDocument: (_, doc) => opened.push(doc),
    converse: async found => { conversed.push(found.id); return true },
    constitutionKey: found => `fiber:${found.id}`,
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
    vi.stubGlobal('ResizeObserver', class { observe = noop; disconnect = noop })
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
  it('never reaches Rex from a zoom or a turn', () => {
    stage.follow('science/hub', ORIGIN)
    settle()
    stage.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, metaKey: true, clientX: 400, clientY: 500, bubbles: true, cancelable: true }))
    stage.el.dispatchEvent(new WheelEvent('wheel', { deltaX: 30, clientX: 400, clientY: 500, bubbles: true, cancelable: true }))
    settle()
    expect(board.conversed).toEqual([])
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
