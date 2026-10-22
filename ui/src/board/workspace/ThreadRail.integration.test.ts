// @vitest-environment jsdom
import { ThreadIndex } from '../threads.js'
import { expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadRail } from './ThreadRail.js'
import { THREAD_PIN, type ThreadPinRequest } from '../ThreadPeek.js'

it('keeps pure containment beneath a flat waiting strip, folds archives, navigates to an intermediate own subtree and back', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' })
  const child = card({ id: 'hub/child', orchestrator: root.id, status: 'active', name: 'Z working' })
  const deep = card({ id: 'hub/child/folder/deep', orchestrator: child.id, status: 'active', ask: { text: 'Choose a cut', at: '2026-07-02T12:00:00Z' }, name: 'Deep review' })
  const rest = card({ id: 'hub/rest', orchestrator: root.id, effectiveHorizon: 'stashed', name: 'A resting' })
  const done = card({ id: 'hub/done', orchestrator: root.id, status: 'closed', tempered: true })
  const all = [root, rest, child, deep, done], open = vi.fn(), rail = new ThreadRail(open, vi.fn())
  rail.show({ ...root }, new ThreadIndex(all))
  expect(rail.el.textContent).toContain('1 archived')
  expect([...rail.el.querySelectorAll('.ws-thread-tree > ul .kbn-thread-row')].slice(0, 3).map(row => row.querySelector('.kbn-thread-name')?.textContent)).toEqual(['A resting', 'Z working', 'Deep review'])
  // The strip is the only group; its row carries the muted parent path, and no row repeats a state word.
  expect(rail.el.querySelector('.ws-thread-waiting')?.textContent).toContain('Deep review')
  expect(rail.el.querySelector('.ws-thread-waiting .ws-thread-path')?.textContent).toBe('child/folder')
  expect(rail.el.querySelector('.ws-thread-tree > ul .ws-thread-path')).toBeNull()
  expect(rail.el.querySelector('.ws-thread-tree')?.textContent).not.toMatch(/To review|Drafts|Resting/)
  const marks = [...rail.el.querySelectorAll<HTMLElement>('.ws-thread-tree > ul .ws-thread-mark')].map(m => [m.dataset.state, m.title])
  expect(marks.slice(0, 3)).toEqual([['resting', 'Resting'], ['working', 'Working'], ['waiting', 'Waiting']])
  expect(rail.el.querySelector('.ws-thread-tree > ul .kbn-thread-row')?.getAttribute('aria-label')).toBe('A resting, resting')
  expect([...rail.legend.querySelectorAll('.ws-thread-legend-entry')].map(e => e.textContent!.replace(/^[^a-z]*/, ''))).toEqual(['waiting', 'working', 'resting'])
  rail.el.querySelectorAll<HTMLButtonElement>('.ws-thread-tree > ul .kbn-thread-row')[1].click()
  expect(open).toHaveBeenLastCalledWith(child)
  rail.show({ ...child }, new ThreadIndex(all))
  expect(rail.el.querySelector('ul')?.textContent).toContain('Deep review')
  expect(rail.el.querySelector('ul')?.textContent).not.toContain('A resting')
  rail.breadcrumb.querySelector<HTMLButtonElement>('button')!.click()
  expect(open).toHaveBeenLastCalledWith(root)
  rail.show(root, new ThreadIndex(all))
  const fold = rail.el.querySelector<HTMLButtonElement>('[aria-label="Toggle threads of Z working"]')!
  fold.click()
  expect(rail.el.querySelector('ul')?.textContent).not.toContain('Deep review')
  // A new ask wakes its ancestor path; the tree is still containment-ordered.
  rail.show(root, new ThreadIndex(all.map(c => c === deep ? { ...deep, ask: { ...deep.ask!, text: 'New question' } } : c)))
  expect(rail.el.querySelector('ul')?.textContent).toContain('Deep review')
  rail.show(root, new ThreadIndex([root, rest, done]))
  expect(rail.el.querySelector('.ws-thread-waiting')).toBeNull()
  vi.unstubAllGlobals()
})

it('preserves focused folds and rows across toggles and live repaints without stealing outside focus', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' }), branch = card({ id: 'hub/branch', name: 'Branch', orchestrator: root.id, status: 'active' })
  const draft = card({ id: 'hub/branch/draft', name: 'Draft', orchestrator: branch.id, status: 'open' })
  const old = card({ id: 'hub/old', name: 'Old', orchestrator: root.id, status: 'closed', tempered: true })
  const rail = new ThreadRail(vi.fn(), vi.fn()), outside = document.createElement('button')
  document.body.append(rail.el, outside)
  try {
    rail.show(root, new ThreadIndex([root, branch, draft, old]))
    const fold = rail.el.querySelector<HTMLButtonElement>('[aria-label="Toggle threads of Branch"]')!
    fold.focus(); fold.click()
    expect(document.activeElement).toBe(rail.el.querySelector('[aria-label="Toggle threads of Branch"]'))
    ;(document.activeElement as HTMLButtonElement).click()
    const archive = rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details]')!
    archive.open = true
    const row = archive.querySelector<HTMLButtonElement>('.kbn-thread-row')!
    row.focus()
    rail.show(root, new ThreadIndex([root, branch, draft, { ...old, outcome: 'New evidence' }]))
    const refreshed = rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details]')!
    expect(refreshed.open).toBe(true)
    expect(document.activeElement).toBe(refreshed.querySelector('.kbn-thread-row'))
    expect(document.activeElement?.textContent).toContain('New evidence')
    outside.focus()
    rail.show(root, new ThreadIndex([root, branch, draft, { ...old, outcome: 'Another update' }]))
    expect(document.activeElement).toBe(outside)
    const currentRow = rail.el.querySelector<HTMLButtonElement>('.ws-thread-tree > ul .kbn-thread-row')!
    currentRow.focus()
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
