// @vitest-environment jsdom
import { ThreadIndex } from '../threads.js'
import { expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadRail } from './ThreadRail.js'
import { THREAD_PIN, type ThreadPinRequest } from '../ThreadPeek.js'

it('draws state groups only, each a flat list in tree order with the parent path, and navigates back through the breadcrumb', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' })
  const child = card({ id: 'hub/child', orchestrator: root.id, status: 'active', name: 'Z working' })
  const deep = card({ id: 'hub/child/folder/deep', orchestrator: child.id, status: 'active', ask: { text: 'Choose a cut', at: '2026-07-02T12:00:00Z' }, name: 'Deep review' })
  const rest = card({ id: 'hub/rest', orchestrator: root.id, effectiveHorizon: 'stashed', name: 'A resting' })
  const done = card({ id: 'hub/done', orchestrator: root.id, status: 'closed', tempered: true, name: 'Done' })
  const all = [root, rest, child, deep, done], open = vi.fn(), rail = new ThreadRail(open, vi.fn())
  rail.show({ ...root }, new ThreadIndex(all))
  const groups = [...rail.el.querySelectorAll<HTMLDetailsElement>('.ws-thread-group')]
  expect(groups.map(g => g.querySelector('summary')!.textContent)).toEqual(['Waiting · 1', 'Working · 1', 'Resting · 1', 'Tempered · 1'])
  expect(groups.map(g => g.open)).toEqual([true, true, true, false])
  expect(rail.el.querySelector('.ws-thread-tree ul')).toBeNull()
  const deepRow = groups[0].querySelector('.kbn-thread-row')!
  expect(deepRow.querySelector('.ws-thread-path')?.textContent).toBe('child')
  expect(deepRow.querySelector('.ws-thread-mark')?.getAttribute('title')).toBe('question')
  expect(groups[1].querySelector('.ws-thread-path')).toBeNull()
  expect(groups[1].querySelector('.ws-thread-mark')).toBeNull()
  expect(rail.el.textContent).not.toMatch(/Archived/)
  groups[1].querySelector<HTMLButtonElement>('.kbn-thread-row')!.click()
  expect(open).toHaveBeenLastCalledWith(child)
  rail.show({ ...child }, new ThreadIndex(all))
  expect(rail.el.textContent).toContain('Deep review')
  expect(rail.el.textContent).not.toContain('A resting')
  rail.breadcrumb.querySelector<HTMLButtonElement>('button')!.click()
  expect(open).toHaveBeenLastCalledWith(root)
  rail.show(root, new ThreadIndex([root, rest]))
  expect([...rail.el.querySelectorAll('.ws-thread-group summary')].map(s => s.textContent)).toEqual(['Resting · 1'])
  vi.unstubAllGlobals()
})

it('marks a discarded thread among the tempered and keeps roles with Resting', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const root = card({ id: 'hub' })
    const dropped = card({ id: 'hub/dropped', orchestrator: root.id, status: 'closed', tempered: false, name: 'Dropped' })
    const done = card({ id: 'hub/done', orchestrator: root.id, status: 'closed', tempered: true, name: 'Done' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(root, new ThreadIndex([root, dropped, done]))
    const marks = [...rail.el.querySelectorAll('.ws-thread-group .ws-thread-mark')].map(m => m.getAttribute('title'))
    expect(marks).toEqual(['Discarded'])
  } finally { vi.unstubAllGlobals() }
})

it('preserves focused rows and open groups across live repaints without stealing outside focus', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' }), branch = card({ id: 'hub/branch', name: 'Branch', orchestrator: root.id, status: 'active' })
  const draft = card({ id: 'hub/branch/draft', name: 'Draft', orchestrator: branch.id, status: 'open' })
  const old = card({ id: 'hub/old', name: 'Old', orchestrator: root.id, status: 'closed', tempered: true })
  const rail = new ThreadRail(vi.fn(), vi.fn()), outside = document.createElement('button')
  document.body.append(rail.el, outside)
  try {
    rail.show(root, new ThreadIndex([root, branch, draft, old]))
    const tempered = rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details="tempered"]')!
    tempered.open = true
    tempered.querySelector<HTMLButtonElement>('.kbn-thread-row')!.focus()
    rail.show(root, new ThreadIndex([root, branch, draft, { ...old, outcome: 'New evidence' }]))
    const refreshed = rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details="tempered"]')!
    expect(refreshed.open).toBe(true)
    expect(document.activeElement).toBe(refreshed.querySelector('.kbn-thread-row'))
    expect(document.activeElement?.textContent).toContain('New evidence')
    outside.focus()
    rail.show(root, new ThreadIndex([root, branch, draft, { ...old, outcome: 'Another update' }]))
    expect(document.activeElement).toBe(outside)
    rail.el.querySelector<HTMLButtonElement>('details[data-thread-details="working"] .kbn-thread-row')!.focus()
    rail.show(root, new ThreadIndex([root, { ...draft, orchestrator: root.id }]))
    expect(document.activeElement).toBe(rail.el.querySelector('.ws-thread-toggle'))
  } finally { rail.el.remove(); outside.remove(); vi.unstubAllGlobals() }
})

it('draws no thread tree on the phone, keeping only the breadcrumb back to the orchestrator', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  try {
    const root = card({ id: 'hub', status: 'active' })
    const child = card({ id: 'hub/child', orchestrator: 'hub', status: 'active' })
    const deep = card({ id: 'hub/child/deep', orchestrator: 'hub/child', status: 'active' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(child, new ThreadIndex([root, child, deep]))
    expect(rail.el.hidden).toBe(true)
    expect(rail.el.querySelector('.kbn-thread-row')).toBeNull()
    expect(rail.breadcrumb.hidden).toBe(false)
  } finally { vi.unstubAllGlobals() }
})

it('every rail row carries a pin that asks the board to toggle it, and a repaint follows the tag', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' }), branch = card({ id: 'hub/branch', name: 'Branch', orchestrator: root.id, status: 'active' })
  const rail = new ThreadRail(vi.fn(), vi.fn()); document.body.append(rail.el)
  const asked = vi.fn((event: Event) => (event as CustomEvent<ThreadPinRequest>).detail)
  document.addEventListener(THREAD_PIN, asked)
  rail.show(root, new ThreadIndex([root, branch]))
  const pin = () => rail.el.querySelector<HTMLButtonElement>('.ws-thread-tree .kbn-thread-pin')!
  expect(pin().getAttribute('aria-pressed')).toBe('false')
  pin().click()
  expect(asked.mock.results[0].value).toEqual({ card: branch, pinned: true })
  rail.show(root, new ThreadIndex([root, { ...branch, tags: ['pinned'] }]))
  expect(pin().getAttribute('aria-pressed')).toBe('true')
  document.removeEventListener(THREAD_PIN, asked)
  rail.el.remove()
  vi.unstubAllGlobals()
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
    expect(rail.el.style.getPropertyValue('--ws-thread-rail-width')).toBe(`${Math.min(640, Math.floor(window.innerWidth * 0.5))}px`)
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
