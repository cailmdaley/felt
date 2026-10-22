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
