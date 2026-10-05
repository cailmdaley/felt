// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceDepth } from './Depth.js'
let reduced = false, fine = true
let frames: FrameRequestCallback[]
let root: HTMLElement
let depth: WorkspaceDepth
const flush = () => { const pending = frames.splice(0); pending.forEach(fn => fn(0)) }
beforeEach(() => {
  vi.useFakeTimers()
  frames = []
  reduced = false; fine = true
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() { return query.includes('reduced-motion') ? reduced : query === '(pointer: fine)' ? fine : false },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.push(fn); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  root = document.createElement('div'); document.body.append(root)
  depth = new WorkspaceDepth(root)
})
afterEach(() => { depth.dispose(); root.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('recedes one Desk for either surface and restores it on return', () => {
  depth.setActive(true); expect(root.classList.contains('kbn-workspace-raised')).toBe(true)
  depth.setActive(false); expect(root.classList.contains('kbn-workspace-raised')).toBe(false)
})
it('coalesces pointer events in one frame and does no work while idle', () => {
  depth.setActive(true)
  for (const x of [20, 100, window.innerWidth]) document.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: window.innerHeight }))
  expect(frames).toHaveLength(1); flush(); expect(frames).toHaveLength(0)
  expect(root.style.getPropertyValue('--ws-desk-x')).toBe('-8px')
  expect(root.style.getPropertyValue('--ws-page-x')).toBe('-3px')
  vi.advanceTimersByTime(1000); expect(frames).toHaveLength(0)
})
it('bounds crossing plus pointer to the same drift budget and clears after crossing', () => {
  depth.setActive(true); depth.cross(10000); flush()
  expect(root.style.getPropertyValue('--ws-desk-x')).toBe('6px')
  vi.advanceTimersByTime(280); flush()
  expect(root.style.getPropertyValue('--ws-desk-x')).toBe('0px')
})
it.each(['reduced', 'coarse', 'inactive'])('never schedules parallax when %s', preference => {
  reduced = preference === 'reduced'; fine = preference !== 'coarse'
  depth.setActive(preference !== 'inactive')
  document.dispatchEvent(new MouseEvent('pointermove', { clientX: 20 }))
  depth.cross(1000); expect(frames).toHaveLength(0)
})
