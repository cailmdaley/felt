// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ThreadIndex } from '../threads.js'
import { card } from '../testFixtures.js'
import { buildChannel, docKey } from './documents.js'
import { ThreadRail } from './ThreadRail.js'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

const input = { uid: 'task', owner: 'host-a', name: 'Task', path: '/notes/task.md', fiberDir: '/notes', body: '' }
const regions = (rail: ThreadRail): { threads: HTMLElement; files: HTMLElement } => ({
  threads: rail.el.querySelector<HTMLElement>('.ws-thread-scroll')!, files: rail.el.querySelector<HTMLElement>('.ws-rail-files')!,
})

it('draws Threads above Sent files, newest first, and opens a file on click', () => {
  const root = card({ id: 'hub' }), child = card({ id: 'hub/child', orchestrator: root.id, status: 'active' })
  const rail = new ThreadRail(vi.fn(), vi.fn())
  rail.show(root, new ThreadIndex([root, child]))
  const channel = buildChannel({ ...input, sent: [{ path: '/old.png', time: 1 }, { path: '/new.png', owner: 'host-b', time: 2 }] })
  const newer = docKey('host-b', '/new.png', 'host-a'), choose = vi.fn()
  rail.showFiles(channel, 'host-a:/old.png', new Set([newer]), choose)
  const { threads, files } = regions(rail)
  expect([...rail.el.children].filter(el => el !== rail.handle)).toEqual([threads, rail.split, rail.artifact.el, files])
  expect(rail.artifact.el.hidden).toBe(true)
  expect(rail.el.hidden).toBe(false); expect(threads.hidden).toBe(false)
  expect([...rail.el.querySelectorAll('.ws-thread-heading')].map(h => h.textContent)).toEqual(['Threads', 'Sent files'])
  const rows = [...files.querySelectorAll<HTMLButtonElement>('.ws-rail-file')]
  expect(rows.map(row => row.dataset.key)).toEqual([newer, 'host-a:/old.png'])
  expect(rows[0].querySelector('.ws-sent-new')?.textContent).toBe('new')
  expect(rows[1].getAttribute('aria-current')).toBe('page')
  rows[0].click()
  expect(choose).toHaveBeenCalledExactlyOnceWith(newer)
})

it('stands for files alone, shows one quiet line when there are none, and hides with neither', () => {
  const solo = card({ id: 'solo' }), rail = new ThreadRail(vi.fn(), vi.fn())
  rail.show(solo, new ThreadIndex([solo]))
  rail.showFiles(buildChannel(input), '', new Set(), vi.fn())
  expect(rail.present).toBe(false); expect(rail.el.hidden).toBe(true)
  rail.showFiles(buildChannel({ ...input, sent: [{ path: '/plot.png', time: 1 }] }), '', new Set(), vi.fn())
  expect(rail.present).toBe(true); expect(rail.el.hidden).toBe(false)
  expect(regions(rail).threads.hidden).toBe(true)
  // Files ask for the eye: a rail with them is open by default.
  expect(rail.quiet).toBe(false)
  const root = card({ id: 'hub' }), child = card({ id: 'hub/child', orchestrator: root.id, status: 'active' })
  rail.show(root, new ThreadIndex([root, child]))
  rail.showFiles(buildChannel(input), '', new Set(), vi.fn())
  const empty = regions(rail).files.querySelectorAll('.ws-rail-file-list > *')
  expect(empty).toHaveLength(1)
  expect(empty[0].textContent).toBe('No files sent yet.')
})

it('updates live as files arrive, keeping a focused row focused', () => {
  const root = card({ id: 'hub' }), child = card({ id: 'hub/child', orchestrator: root.id, status: 'active' })
  const rail = new ThreadRail(vi.fn(), vi.fn()); document.body.append(rail.el)
  rail.show(root, new ThreadIndex([root, child]))
  const first = buildChannel({ ...input, sent: [{ path: '/a.png', time: 1 }] })
  rail.showFiles(first, '', new Set(), vi.fn())
  const row = rail.el.querySelector<HTMLButtonElement>('.ws-rail-file')!; row.focus()
  rail.showFiles(first, '', new Set(), vi.fn())
  expect(rail.el.querySelector('.ws-rail-file')).toBe(row)
  const next = buildChannel({ ...input, previous: first, sent: [{ path: '/a.png', time: 1 }, { path: '/b.png', time: 5 }] })
  rail.showFiles(next, '', new Set(['host-a:/b.png']), vi.fn())
  const rows = [...rail.el.querySelectorAll<HTMLElement>('.ws-rail-file')]
  expect(rows.map(r => r.dataset.key)).toEqual(['host-a:/b.png', 'host-a:/a.png'])
  expect(document.activeElement).toBe(rows[1])
})

it('shows the newest four sent files, then folds the rest behind a toggle that expands in place', () => {
  const root = card({ id: 'solo' }), rail = new ThreadRail(vi.fn(), vi.fn())
  rail.show(root, new ThreadIndex([root]))
  const sent = (n: number): { path: string; time: number }[] => Array.from({ length: n }, (_, i) => ({ path: `/f${i}.png`, time: i + 1 }))
  const rows = (): string[] => [...rail.el.querySelectorAll<HTMLElement>('.ws-rail-file')].map(row => row.dataset.key!)
  rail.showFiles(buildChannel({ ...input, sent: sent(4) }), '', new Set(), vi.fn())
  expect(rows()).toHaveLength(4)
  expect(rail.el.querySelector('.ws-rail-files-more')).toBeNull()
  const channel = buildChannel({ ...input, sent: sent(9) })
  rail.showFiles(channel, '', new Set(), vi.fn())
  expect(rows()).toEqual([8, 7, 6, 5].map(i => docKey('host-a', `/f${i}.png`, 'host-a')))
  const more = rail.el.querySelector<HTMLButtonElement>('.ws-rail-files-more')!
  expect(more.textContent).toBe('Show 5 more')
  more.click()
  expect(rows()).toHaveLength(9)
  expect(rail.el.querySelector('.ws-rail-files-more')!.textContent).toBe('Show fewer')
})

it('marks a family waiting on the human', () => {
  const root = card({ id: 'hub' }), rail = new ThreadRail(vi.fn(), vi.fn())
  const quiet = card({ id: 'hub/quiet', orchestrator: root.id, status: 'closed' })
  rail.show(root, new ThreadIndex([root, quiet]))
  expect(rail.needsHuman).toBe(false)
  const asking = card({ id: 'hub/asking', orchestrator: root.id, status: 'active', ask: { text: 'which cut?', at: '2026-01-01T00:00:00Z' } })
  rail.show(root, new ThreadIndex([root, quiet, asking]))
  expect(rail.needsHuman).toBe(true)
})
