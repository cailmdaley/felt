// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPageSwipe, SWIPE, type SwipeSignal } from '../src/board/workspace/PhoneGestures.js'

type Listener = (event: unknown) => void
type Phase = 'capture' | 'bubble'

/** Drive the recognizer's own listeners with trusted-looking touches; jsdom cannot mint trusted events. */
function harness() {
  const root = document.createElement('div')
  document.body.append(root)
  const listeners: Array<{ at: 'root' | 'window'; type: string; phase: Phase; fn: Listener }> = []
  const record = (at: 'root' | 'window') => (type: string, fn: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    const capture = typeof options === 'boolean' ? options : !!options?.capture
    listeners.push({ at, type, phase: capture ? 'capture' : 'bubble', fn: fn as Listener })
  }
  vi.spyOn(root, 'addEventListener').mockImplementation(record('root'))
  vi.spyOn(window, 'addEventListener').mockImplementation(record('window'))
  const signals: SwipeSignal[] = []
  installPageSwipe(root, signal => signals.push(signal), () => true, SWIPE)
  let time = 0
  /** Capture at the root, then the content's own handler, then bubble at the window. */
  const dispatch = (type: string, target: Element, x: number, y: number, content?: (event: { preventDefault(): void }) => void) => {
    time += 16
    const touch = { identifier: 1, clientX: x, clientY: y, screenX: x, screenY: y }
    const event = {
      type, target, isTrusted: true, cancelable: true, timeStamp: time, defaultPrevented: false,
      touches: type === 'touchend' ? [] : [touch], changedTouches: [touch],
      preventDefault() { this.defaultPrevented = true },
    }
    for (const l of listeners) if (l.at === 'root' && l.phase === 'capture' && l.type === type) l.fn(event)
    content?.(event)
    for (const l of listeners) if (l.at === 'window' && l.phase === 'bubble' && l.type === type) l.fn(event)
  }
  const drag = (target: Element, content?: (event: { preventDefault(): void }) => void) => {
    dispatch('touchstart', target, 300, 400, content)
    for (const x of [280, 250, 200, 150]) dispatch('touchmove', target, x, 402, content)
    dispatch('touchend', target, 150, 402, content)
    return signals.map(signal => signal.phase)
  }
  return { root, drag }
}

beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation(el => ({ touchAction: (el as HTMLElement).style.touchAction || 'auto', overflowX: 'visible' }) as CSSStyleDeclaration)
})
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('page swipe recognition', () => {
  it('latches a sideways drag over ordinary content', () => {
    const { root, drag } = harness()
    const p = document.createElement('p'); root.append(p)
    expect(drag(p)).toEqual(['move', 'move', 'move', 'move', 'end'])
  })

  it('leaves the horizontal gesture to content whose touch-action keeps it from the browser', () => {
    for (const touchAction of ['pan-y', 'pinch-zoom', 'pan-y pinch-zoom', 'none', 'pan-x']) {
      const { root, drag } = harness()
      const deck = document.createElement('div'); deck.style.touchAction = touchAction
      const slide = document.createElement('section'); deck.append(slide); root.append(deck)
      expect(drag(slide), touchAction).toEqual([])
      vi.mocked(root.addEventListener).mockRestore()
      vi.mocked(window.addEventListener).mockRestore()
    }
  })

  it('still latches over content that leaves both pans to the browser', () => {
    for (const touchAction of ['manipulation', 'pan-x pan-y', 'pan-x pan-y pinch-zoom']) {
      const { root, drag } = harness()
      const box = document.createElement('div'); box.style.touchAction = touchAction; root.append(box)
      expect(drag(box), touchAction).toContain('end')
      vi.mocked(root.addEventListener).mockRestore()
      vi.mocked(window.addEventListener).mockRestore()
    }
  })

  it('latches over a reader surface that opts in despite its own touch-action', () => {
    const { root, drag } = harness()
    const bar = document.createElement('div'); bar.style.touchAction = 'pan-y'; bar.dataset.wsSwipe = 'on'
    const label = document.createElement('span'); bar.append(label); root.append(bar)
    expect(drag(label)).toContain('end')
  })

  it('does not latch a touch the content already handled', () => {
    const moves = harness()
    const carousel = document.createElement('div'); moves.root.append(carousel)
    expect(moves.drag(carousel, event => event.preventDefault())).toEqual([])
    vi.mocked(moves.root.addEventListener).mockRestore()
    vi.mocked(window.addEventListener).mockRestore()
    const starts = harness()
    const slider = document.createElement('div'); starts.root.append(slider)
    let first = true
    expect(starts.drag(slider, event => { if (first) event.preventDefault(); first = false })).toEqual([])
  })
})
