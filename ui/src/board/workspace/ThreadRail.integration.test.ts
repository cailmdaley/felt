// @vitest-environment jsdom
import { ThreadIndex } from '../threads.js'
import { expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ThreadRail } from './ThreadRail.js'
import { THREAD_PIN, type ThreadPinRequest } from '../ThreadPeek.js'

it('draws one-line state groups with parent-chain tooltips and navigates through dots and the family head', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' })
  const child = card({ id: 'hub/child', orchestrator: root.id, status: 'active', name: 'Z working' })
  const deep = card({ id: 'hub/child/folder/deep', orchestrator: child.id, status: 'active', ask: { text: 'Choose a cut', at: '2026-07-02T12:00:00Z' }, name: 'Deep review' })
  const rest = card({ id: 'hub/rest', orchestrator: root.id, effectiveHorizon: 'stashed', name: 'A resting' })
  const done = card({ id: 'hub/done', orchestrator: root.id, status: 'closed', tempered: true, name: 'Done' })
  const all = [root, rest, child, deep, done], open = vi.fn(), rail = new ThreadRail(open, vi.fn())
  rail.show({ ...root }, new ThreadIndex(all))
  expect(rail.el.querySelector('.ws-thread-root')).toBeNull()
  const groups = [...rail.el.querySelectorAll<HTMLDetailsElement>('.ws-thread-group')]
  expect(groups.map(g => g.querySelector('summary')!.getAttribute('aria-label'))).toEqual(['Waiting, 1', 'Armed, 1', 'Resting, 1', 'Archived, 1'])
  expect(groups.map(g => g.querySelector('.ws-thread-group-label')!.textContent)).toEqual(['Waiting', 'Armed', 'Resting', 'Archived'])
  expect(groups.map(g => g.open)).toEqual([true, true, true, false])
  expect(rail.el.querySelector('.ws-thread-tree ul')).toBeNull()
  const deepRow = groups[0].querySelector('.kbn-thread-row')!
  expect(deepRow.querySelector('.ws-thread-parent, .kbn-thread-outcome, .kbn-until, .kbn-row-elapsed')).toBeNull()
  expect(deepRow.getAttribute('title')).toBe('hub › Z working')
  deepRow.querySelector<HTMLButtonElement>('.constitution-state-dot')!.click()
  expect(open).toHaveBeenLastCalledWith(deep)
  expect(deepRow.querySelector('.ws-thread-mark')?.getAttribute('title')).toBe('question')
  expect(groups[1].querySelector('.ws-thread-parent')).toBeNull()
  expect(groups[1].querySelector('.ws-thread-mark')).toBeNull()
  expect(rail.el.textContent).not.toMatch(/Tempered/)
  // A group's state is its heading; no row says it again.
  expect(rail.el.querySelectorAll('.kbn-thread-row small')).toHaveLength(0)
  expect(rail.el.querySelector('button.ws-thread-toggle')).toBeNull()
  groups[1].querySelector<HTMLButtonElement>('.kbn-thread-row')!.click()
  expect(open).toHaveBeenLastCalledWith(child)
  // Inside a thread the rail stays on its orchestrator's family, the open thread marked.
  rail.show({ ...child }, new ThreadIndex(all))
  expect(rail.el.textContent).toContain('Deep review')
  expect(rail.el.textContent).toContain('A resting')
  expect(rail.el.querySelector('[aria-current="page"] .kbn-thread-name')?.textContent).toBe('Z working')
  expect(rail.el.querySelectorAll('.ws-thread-current')).toHaveLength(1)
  rail.el.querySelector<HTMLButtonElement>('.ws-thread-root .kbn-thread-row')!.click()
  expect(open).toHaveBeenLastCalledWith(root)
  for (const current of [child, deep]) {
    rail.show(current, new ThreadIndex(all))
    const first = rail.el.querySelector('.ws-thread-tree')!.firstElementChild!
    expect(first.classList.contains('ws-thread-root')).toBe(true)
    expect(first.querySelector('.kbn-thread-name')?.textContent).toBe(root.name)
    expect(first.querySelector('.constitution-state-dot')).not.toBeNull()
    expect(first.querySelector('[aria-current="page"]') !== null).toBe(current === root)
    first.querySelector<HTMLButtonElement>('.kbn-thread-row')!.click()
    expect(open).toHaveBeenLastCalledWith(root)
  }
  rail.show(root, new ThreadIndex([root, rest]))
  expect([...rail.el.querySelectorAll('.ws-thread-group summary')].map(s => s.getAttribute('aria-label'))).toEqual(['Resting, 1'])
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
    const tempered = rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details="archived"]')!
    tempered.open = true
    tempered.querySelector<HTMLButtonElement>('.kbn-thread-row')!.focus()
    rail.show(root, new ThreadIndex([root, branch, draft, { ...old, outcome: 'New evidence' }]))
    const refreshed = rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details="archived"]')!
    expect(refreshed.open).toBe(true)
    expect(document.activeElement).toBe(refreshed.querySelector('.kbn-thread-row'))
    expect(document.activeElement?.textContent).toBe('Old')
    expect(refreshed.querySelector('.kbn-thread-outcome')).toBeNull()
    refreshed.querySelector<HTMLButtonElement>('.constitution-state-dot')!.focus()
    rail.show(root, new ThreadIndex([root, branch, draft, { ...old, name: 'Renamed' }]))
    expect(document.activeElement).toBe(rail.el.querySelector('details[data-thread-details="archived"] .constitution-state-dot'))
    outside.focus()
    rail.show(root, new ThreadIndex([root, branch, draft, { ...old, outcome: 'Another update' }]))
    expect(document.activeElement).toBe(outside)
    rail.el.querySelector<HTMLButtonElement>('details[data-thread-details="armed"] .kbn-thread-row')!.focus()
    rail.show(root, new ThreadIndex([root, { ...draft, orchestrator: root.id }]))
    expect(document.activeElement).toBe(rail.el.querySelector('.ws-thread-heading > .ws-rail-fold'))
  } finally { rail.el.remove(); outside.remove(); vi.unstubAllGlobals() }
})

it('draws no thread tree on the phone, where the threads page carries the family', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  try {
    const root = card({ id: 'hub', status: 'active' })
    const child = card({ id: 'hub/child', orchestrator: 'hub', status: 'active' })
    const deep = card({ id: 'hub/child/deep', orchestrator: 'hub/child', status: 'active' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(child, new ThreadIndex([root, child, deep]))
    expect(rail.el.hidden).toBe(true)
    expect(rail.el.querySelector('.kbn-thread-row')).toBeNull()
    expect(rail.hasFamily).toBe(true)
  } finally { vi.unstubAllGlobals() }
})

it('shows pins only on pinned or current rows and a repaint follows the tag', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = card({ id: 'hub' }), branch = card({ id: 'hub/branch', name: 'Branch', orchestrator: root.id, status: 'active' })
  const rail = new ThreadRail(vi.fn(), vi.fn()); document.body.append(rail.el)
  const asked = vi.fn((event: Event) => (event as CustomEvent<ThreadPinRequest>).detail)
  document.addEventListener(THREAD_PIN, asked)
  rail.show(root, new ThreadIndex([root, branch]))
  const pin = () => rail.el.querySelector<HTMLButtonElement>('.ws-thread-group .kbn-thread-pin')!
  expect(pin().getAttribute('aria-pressed')).toBe('false')
  expect(pin().hidden).toBe(true)
  rail.show(branch, new ThreadIndex([root, branch]))
  expect(pin().hidden).toBe(false)
  pin().click()
  expect(asked.mock.results[0].value).toEqual({ card: branch, pinned: true })
  rail.show(root, new ThreadIndex([root, { ...branch, tags: ['pinned'] }]))
  expect(pin().getAttribute('aria-pressed')).toBe('true')
  expect(pin().hidden).toBe(false)
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

it('marks a working thread with a live worker, and only that one', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const root = card({ id: 'hub' })
    const live = card({ id: 'hub/live', orchestrator: root.id, status: 'active', name: 'Live', workerState: 'running', runtimePhase: 'working' })
    const quiet = card({ id: 'hub/quiet', orchestrator: root.id, status: 'active', name: 'Quiet' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(root, new ThreadIndex([root, live, quiet]))
    const rows = [...rail.el.querySelectorAll<HTMLElement>('details[data-thread-details="working"] .kbn-thread-row')]
    expect(rows.map(r => [r.querySelector('.kbn-thread-name')!.textContent, r.querySelector('.constitution-state-dot')?.getAttribute('data-turn')]))
      .toEqual([['Live', 'working']])
    expect(rail.el.querySelector('details[data-thread-details="armed"] .kbn-thread-name')?.textContent).toBe('Quiet')
    expect(rail.el.querySelector('.ws-thread-mark')).toBeNull()
    expect(rows[0].getAttribute('aria-label')).toBe('Live, working')
  } finally { vi.unstubAllGlobals() }
})

it('indents same-group descendants and keeps cross-group parents only in the tooltip', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const root = card({ id: 'hub' })
    const branch = card({ id: 'hub/branch', orchestrator: root.id, status: 'active', name: 'Branch' })
    const leaf = card({ id: 'hub/branch/leaf', orchestrator: branch.id, status: 'active', name: 'Leaf' })
    const twig = card({ id: 'hub/branch/leaf/twig', orchestrator: leaf.id, status: 'active', name: 'Twig' })
    const draft = card({ id: 'hub/branch/draft', orchestrator: branch.id, status: 'open', name: 'Draft' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(root, new ThreadIndex([root, branch, leaf, twig, draft]))
    const working = [...rail.el.querySelectorAll<HTMLElement>('details[data-thread-details="armed"] .kbn-thread-item')]
    expect(working.map(item => [item.querySelector('.kbn-thread-name')!.textContent, item.dataset.depth ?? '0', item.querySelector('.ws-thread-parent')?.textContent ?? ''])).toEqual([
      ['Branch', '0', ''], ['Leaf', '1', ''], ['Twig', '2', ''],
    ])
    const drafted = rail.el.querySelector('details[data-thread-details="drafts"] .kbn-thread-item') as HTMLElement
    expect(drafted.dataset.depth).toBeUndefined()
    expect(drafted.querySelector('.ws-thread-parent')).toBeNull()
    expect(drafted.querySelector('.kbn-thread-row')?.getAttribute('title')).toBe('hub › Branch')
  } finally { vi.unstubAllGlobals() }
})

it("inside a deep thread keeps the whole family from its top-level constitution, the thread marked in place and its group opened", () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const chair = card({ id: 'chair', name: 'Chair' })
    const validation = card({ id: 'chair/validation', orchestrator: chair.id, status: 'closed', tempered: true, name: 'Validation' })
    const seed = card({ id: 'chair/validation/seed', orchestrator: validation.id, status: 'closed', tempered: true, name: 'Seed' })
    const cousin = card({ id: 'chair/cousin', orchestrator: chair.id, status: 'active', name: 'Cousin' })
    const all = [chair, validation, seed, cousin], open = vi.fn()
    const rail = new ThreadRail(open, vi.fn())
    rail.show(seed, new ThreadIndex(all))
    expect(rail.el.hidden).toBe(false)
    const names = [...rail.el.querySelectorAll('.kbn-thread-name')].map(n => n.textContent)
    expect(names).toEqual(['Chair', 'Cousin', 'Validation', 'Seed'])
    expect(rail.el.querySelectorAll('.ws-thread-current')).toHaveLength(1)
    expect(rail.el.querySelector('.ws-thread-current .kbn-thread-name')?.textContent).toBe('Seed')
    // Archived folds by default, but not when it holds the open thread.
    const tempered = rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details="archived"]')!
    expect(tempered.open).toBe(true)
    // A repaint of the same visit leaves a fold the reader made.
    tempered.open = false
    rail.show(seed, new ThreadIndex([chair, validation, { ...seed, outcome: 'news' }, cousin]))
    expect(rail.el.querySelector<HTMLDetailsElement>('details[data-thread-details="archived"]')!.open).toBe(false)
    // The family's head heads the tree, one click back to the orchestrator.
    rail.el.querySelector<HTMLButtonElement>('.ws-thread-root .kbn-thread-row')!.click()
    expect(open).toHaveBeenLastCalledWith(chair)
  } finally { vi.unstubAllGlobals() }
})

it('keeps the root reachable from its only thread and hides a root with no family', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const chair = card({ id: 'chair', name: 'Chair' })
    const only = card({ id: 'chair/only', orchestrator: chair.id, status: 'active', name: 'Only' })
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(only, new ThreadIndex([chair, only]))
    expect(rail.el.hidden).toBe(false)
    expect(rail.el.querySelector('.ws-thread-root .kbn-thread-name')?.textContent).toBe('Chair')
    rail.show(chair, new ThreadIndex([chair]))
    expect(rail.el.hidden).toBe(true)
  } finally { vi.unstubAllGlobals() }
})

it('draws what asks for the reader first: waiting, then reviews, then the working', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const root = card({ id: 'hub' })
    const work = card({ id: 'hub/work', orchestrator: root.id, status: 'active', name: 'Work' })
    const review = card({ id: 'hub/review', orchestrator: root.id, status: 'closed', name: 'Review' })
    const ask = card({ id: 'hub/ask', orchestrator: root.id, status: 'active', ask: { text: 'Which?', at: '2026-07-02T12:00:00Z' }, name: 'Ask' })
    const index = new ThreadIndex([root, work, review, ask])
    const rail = new ThreadRail(vi.fn(), vi.fn())
    rail.show(root, index)
    const order = [...rail.el.querySelectorAll<HTMLDetailsElement>('.ws-thread-group')].map(g => g.dataset.threadDetails)
    expect(order).toEqual(['waiting', 'to-review', 'armed'])
  } finally { vi.unstubAllGlobals() }
})
