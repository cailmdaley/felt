// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadRail } from './ThreadRail.js'

it('keeps pure containment beside flat waiting pointers, folds archives, navigates to an intermediate own subtree and back', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' })
  const child = card({ id: 'hub/child', orchestrator: root.id, status: 'active', name: 'Z working' })
  const deep = card({ id: 'hub/child/folder/deep', orchestrator: child.id, status: 'active', ask: { text: 'Choose a cut', at: '2026-07-02T12:00:00Z' }, name: 'Deep review' })
  const rest = card({ id: 'hub/rest', orchestrator: root.id, effectiveHorizon: 'stashed', name: 'A resting' })
  const done = card({ id: 'hub/done', orchestrator: root.id, status: 'closed', tempered: true })
  const all = [root, rest, child, deep, done], open = vi.fn(), rail = new ThreadRail(open, vi.fn())
  rail.show({ ...root }, all)
  expect(rail.el.textContent).toContain('1 archived')
  expect([...rail.el.querySelectorAll('.ws-thread-tree > ul .kbn-thread-row')].slice(0, 3).map(row => row.querySelector('span')?.textContent)).toEqual(['A resting', 'Z working', 'Deep review'])
  expect(rail.el.querySelector('.ws-thread-pointers')?.textContent).toContain('Deep review')
  rail.el.querySelectorAll<HTMLButtonElement>('.ws-thread-tree > ul .kbn-thread-row')[1].click()
  expect(open).toHaveBeenLastCalledWith(child)
  rail.show({ ...child }, all)
  expect(rail.el.querySelector('ul')?.textContent).toContain('Deep review')
  expect(rail.el.querySelector('ul')?.textContent).not.toContain('A resting')
  rail.breadcrumb.querySelector<HTMLButtonElement>('button')!.click()
  expect(open).toHaveBeenLastCalledWith(root)
  rail.show(root, all)
  const fold = rail.el.querySelector<HTMLButtonElement>('[aria-label="Toggle threads of Z working"]')!
  fold.click()
  expect(rail.el.querySelector('ul')?.textContent).not.toContain('Deep review')
  // A new ask wakes its ancestor path; the tree is still containment-ordered.
  rail.show(root, all.map(c => c === deep ? { ...deep, ask: { ...deep.ask!, text: 'New question' } } : c))
  expect(rail.el.querySelector('ul')?.textContent).toContain('Deep review')
  rail.show(root, [root, rest, done])
  expect(rail.el.querySelector('.ws-thread-pointers')).toBeNull()
  vi.unstubAllGlobals()
})

it('preserves focused folds and rows across toggles and live repaints without stealing outside focus', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' }), branch = card({ id: 'hub/branch', name: 'Branch', orchestrator: root.id, status: 'active' })
  const draft = card({ id: 'hub/branch/draft', name: 'Draft', orchestrator: branch.id, status: 'open' })
  const rail = new ThreadRail(vi.fn(), vi.fn()), outside = document.createElement('button')
  document.body.append(rail.el, outside)
  try {
    rail.show(root, [root, branch, draft])
    const fold = rail.el.querySelector<HTMLButtonElement>('[aria-label="Toggle threads of Branch"]')!
    fold.focus(); fold.click()
    expect(document.activeElement).toBe(rail.el.querySelector('[aria-label="Toggle threads of Branch"]'))
    ;(document.activeElement as HTMLButtonElement).click()
    const group = rail.el.querySelector<HTMLDetailsElement>('.ws-thread-pointers')!
    group.open = true
    const row = group.querySelector<HTMLButtonElement>('.kbn-thread-row')!
    row.focus()
    rail.show(root, [root, branch, { ...draft, outcome: 'New evidence' }])
    const refreshed = rail.el.querySelector<HTMLDetailsElement>('.ws-thread-pointers')!
    expect(refreshed.open).toBe(true)
    expect(document.activeElement).toBe(refreshed.querySelector('.kbn-thread-row'))
    expect(document.activeElement?.textContent).toContain('New evidence')
    outside.focus()
    rail.show(root, [root, branch, { ...draft, outcome: 'Another update' }])
    expect(document.activeElement).toBe(outside)
    const currentRow = rail.el.querySelector<HTMLButtonElement>('.ws-thread-tree > ul .kbn-thread-row')!
    currentRow.focus()
    rail.show(root, [root, { ...draft, orchestrator: root.id }])
    expect(document.activeElement).toBe(rail.el.querySelector('.ws-thread-toggle'))
  } finally { rail.el.remove(); outside.remove(); vi.unstubAllGlobals() }
})
