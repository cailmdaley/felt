// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { Reader } from './Reader.js'
import type { Channel, WorkspaceDocument } from './documents.js'
import type { SwipeSignal } from './PhoneGestures.js'

const alpha = card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a' })
const page = (n: number): WorkspaceDocument => ({ key: `fiber:host-a:page-${n}`, owner: 'host-a', path: `/page-${n}`, name: `Page ${n}`, kind: 'fiber', provenance: [{ kind: 'fiber' }] })
const documents = [page(0), page(1), page(2)]
const channel: Channel = { uid: 'alpha', owner: 'host-a', name: 'Alpha', documents, labels: ['A', 'B', 'C'], body: '' }

let reader: Reader
const onSelect = vi.fn()
const swipe = (signal: SwipeSignal): void => (reader as unknown as { swipe(signal: SwipeSignal): void }).swipe(signal)
const transform = (): string => reader.track.style.transform
const swiping = (): boolean => reader.stage.classList.contains('ws-swiping')

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  onSelect.mockReset()
  reader = new Reader({
    shuttleBase: '', buildProse: () => document.createElement('div'), onRefreshProse: vi.fn(),
    onSelect, onReturn: vi.fn(), onChannel: vi.fn(), cards: () => [alpha], switcherCards: () => [alpha], files: () => [],
  })
  Object.defineProperty(reader.stage, 'clientWidth', { configurable: true, value: 390 })
  Object.defineProperty(reader.stage, 'clientHeight', { configurable: true, value: 700 })
  document.body.append(reader.el)
  reader.show(channel, documents[1].key, 'Desk', alpha)
})
afterEach(() => {
  reader.dispose()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Reader page swipe', () => {
  it('follows a move and settles on release', () => {
    const rest = transform()
    swipe({ phase: 'move', dx: -60 })
    expect(swiping()).toBe(true)
    expect(transform()).not.toBe(rest)
    swipe({ phase: 'end', dx: -60, velocity: 0 })
    expect(swiping()).toBe(false)
    expect(transform()).toBe(rest)
  })

  it('drops a latched swipe when the selection changes under it, so layout owns the track again', () => {
    swipe({ phase: 'move', dx: -60 })
    reader.select(documents[2].key)
    expect(swiping()).toBe(false)
    const settled = transform()
    ;(reader as unknown as { layout(animate: boolean): void }).layout(false)
    expect(transform()).toBe(settled)
  })

  it('drops a latched swipe when the channel is shown again or hidden', () => {
    swipe({ phase: 'move', dx: -60 })
    reader.show(channel, documents[0].key, 'Desk', alpha)
    expect(swiping()).toBe(false)
    swipe({ phase: 'move', dx: -60 })
    reader.hide()
    expect(swiping()).toBe(false)
  })

  it('cancels when a release arrives with no measurable stage', () => {
    swipe({ phase: 'move', dx: -60 })
    Object.defineProperty(reader.stage, 'clientWidth', { configurable: true, value: 0 })
    swipe({ phase: 'end', dx: -60, velocity: 0 })
    expect(swiping()).toBe(false)
  })

  it('cancels a swipe whose release never arrives after half a second without movement', () => {
    const rest = transform()
    swipe({ phase: 'move', dx: -60 })
    vi.advanceTimersByTime(300)
    swipe({ phase: 'move', dx: -80 })
    vi.advanceTimersByTime(300)
    expect(swiping()).toBe(true)
    vi.advanceTimersByTime(250)
    expect(swiping()).toBe(false)
    expect(transform()).toBe(rest)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
