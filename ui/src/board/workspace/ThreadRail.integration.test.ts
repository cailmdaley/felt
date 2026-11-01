// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import { ThreadRail } from './ThreadRail.js'
import { THREAD_PIN, type ThreadPinRequest } from '../ThreadPeek.js'

it('draws ancestry, marks current, and preserves archive folds and focus on repaint', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' }), old = card({ id: 'hub/old', orchestrator: 'hub', status: 'closed', tempered: true }),
    child = card({ id: 'hub/old/child', orchestrator: 'hub/old', status: 'active', ask: { text: 'Choose', at: '2026-07-02T12:00:00Z' } })
  const rail = new ThreadRail(vi.fn(), vi.fn()); document.body.append(rail.el)
  try {
    rail.show(root, new ThreadIndex([root, old, child]))
    const fold = rail.el.querySelector<HTMLDetailsElement>('.ws-tree-archived')!
    expect(fold.open).toBe(false)
    expect(fold.querySelector('summary .ws-tree-attention')?.textContent).toBe('Waiting')
    expect(rail.el.querySelector('[aria-current="page"] .kbn-thread-name')?.textContent).toBe(root.name)
    fold.open = true
    fold.querySelector<HTMLElement>('.kbn-thread-row')!.focus()
    rail.show(root, new ThreadIndex([root, { ...old, outcome: 'changed' }, child]))
    expect(rail.el.querySelector<HTMLDetailsElement>('.ws-tree-archived')!.open).toBe(true)
    expect(document.activeElement?.querySelector('.kbn-thread-name')?.textContent).toBe(old.name)
    rail.el.querySelector<HTMLDetailsElement>('.ws-tree-archived')!.querySelector<HTMLElement>('.constitution-state-dot')!.focus()
    rail.show(root, new ThreadIndex([root, { ...old, name: 'Renamed' }, child]))
    expect(document.activeElement).toBe(rail.el.querySelector('.ws-tree-archived .constitution-state-dot'))
    rail.show(child, new ThreadIndex([root, old, child]))
    expect(rail.el.querySelector<HTMLDetailsElement>('.ws-tree-archived')!.open).toBe(true)
    expect(rail.el.querySelector('[aria-current="page"] .kbn-thread-name')?.textContent).toBe(child.name)
    rail.el.querySelector<HTMLDetailsElement>('.ws-tree-archived')!.open = false
    rail.show(child, new ThreadIndex([root, old, { ...child, outcome: 'changed' }]))
    expect(rail.el.querySelector<HTMLDetailsElement>('.ws-tree-archived')!.open).toBe(false)
  } finally { rail.el.remove(); vi.unstubAllGlobals() }
})

it('reorders siblings on a creation-time change but not a live state change', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const root = card({ id: 'root' }), a = card({ id: 'a', orchestrator: root.id, createdAt: '2026-01-01T00:00:00Z', status: 'active' }), b = card({ id: 'b', orchestrator: root.id, createdAt: '2026-01-02T00:00:00Z', status: 'closed' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    const names = () => [...rail.el.querySelectorAll('.kbn-thread-name')].map(el => el.textContent)
    rail.show(root, new ThreadIndex([root, b, a]))
    expect(names()).toEqual(['root', 'a', 'b'])
    rail.show(root, new ThreadIndex([root, { ...b, status: 'active' }, { ...a, status: 'closed' }]))
    expect(names()).toEqual(['root', 'a', 'b'])
    rail.show(root, new ThreadIndex([root, { ...a, createdAt: '2026-01-03T00:00:00Z' }, b]))
    expect(names()).toEqual(['root', 'b', 'a'])
  } finally { vi.unstubAllGlobals() }
})

it('shows the pin only for current or pinned rows and emits pin requests', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' }), child = card({ id: 'hub/child', orchestrator: 'hub', status: 'active' })
  const rail = new ThreadRail(vi.fn(), vi.fn()), asked = vi.fn((event: Event) => (event as CustomEvent<ThreadPinRequest>).detail)
  document.body.append(rail.el); rail.el.addEventListener(THREAD_PIN, asked)
  const pin = () => [...rail.el.querySelectorAll<HTMLElement>('.kbn-thread-item')].find(item => item.querySelector('.kbn-thread-name')?.textContent === child.name)!.querySelector<HTMLButtonElement>('.kbn-thread-pin')!
  try {
    rail.show(root, new ThreadIndex([root, child]))
    expect(pin().hidden).toBe(true)
    rail.show(child, new ThreadIndex([root, child]))
    expect(pin().hidden).toBe(false)
    pin().click()
    expect(asked.mock.results[0].value).toEqual({ card: child, pinned: true })
    rail.show(root, new ThreadIndex([root, { ...child, tags: ['pinned'] }]))
    expect(pin().hidden).toBe(false)
    expect(pin().getAttribute('aria-pressed')).toBe('true')
  } finally { rail.el.remove(); vi.unstubAllGlobals() }
})

it('keeps family presence on the phone while drawing no rail rows', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  try {
    const root = card({ id: 'hub' }), child = card({ id: 'hub/child', orchestrator: root.id, status: 'active' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(child, new ThreadIndex([root, child]))
    expect(rail.hasFamily).toBe(true)
    expect(rail.el.hidden).toBe(true)
    expect(rail.el.querySelector('.kbn-thread-row')).toBeNull()
  } finally { vi.unstubAllGlobals() }
})

it('resizes from its left edge, remembers the width per viewer and survives unavailable storage', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  vi.stubGlobal('localStorage', storage)
  try {
    const layout = vi.fn(), rail = new ThreadRail(vi.fn(), layout)
    const handle = rail.el.querySelector<HTMLElement>('.ws-thread-handle')!
    expect(rail.el.style.getPropertyValue('--ws-thread-rail-width')).toBe('')
    rail.el.getBoundingClientRect = () => ({ width: 300 }) as DOMRect
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(rail.el.style.getPropertyValue('--ws-thread-rail-width')).toBe('316px')
    expect(storage.getItem('shuttle:workspace:thread-rail-width')).toBe('316')
    expect(layout).toHaveBeenCalled()
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(rail.el.style.getPropertyValue('--ws-thread-rail-width')).toBe('220px')
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(rail.el.style.getPropertyValue('--ws-thread-rail-width')).toBe(`${Math.floor(window.innerWidth * 0.5)}px`)
    storage.setItem('shuttle:workspace:thread-rail-width', '400')
    expect(new ThreadRail(vi.fn(), vi.fn()).el.style.getPropertyValue('--ws-thread-rail-width')).toBe('400px')
    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(rail.el.style.getPropertyValue('--ws-thread-rail-width')).toBe('')
    expect(storage.getItem('shuttle:workspace:thread-rail-width')).toBeNull()
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } })
    const blocked = new ThreadRail(vi.fn(), vi.fn())
    blocked.el.querySelector<HTMLElement>('.ws-thread-handle')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(blocked.el.style.getPropertyValue('--ws-thread-rail-width')).toBe('220px')
  } finally { vi.unstubAllGlobals() }
})
