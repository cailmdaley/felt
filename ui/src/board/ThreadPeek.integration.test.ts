// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { threadSummary } from './threads.js'
import { response } from './testFixtures.js'
import { installThreadPeek } from './ThreadPeek.js'
import { card } from './testFixtures.js'
import { saveWaitingThreadEntries } from './threadPreferences.js'
afterEach(() => { document.body.replaceChildren(); saveWaitingThreadEntries(false); vi.useRealTimers() })
it('a phone hold expands without its synthetic action being swallowed by click suppression', () => {
  vi.useFakeTimers()
  const root = card({ id: 'root' }), child = card({ id: 'root/child', orchestrator: 'root' })
  root.threadSummary = threadSummary(root, [root, child])
  const data = response({ now: { drafts: [root], inFlight: [], awaitingReview: [] }, threads: [child] })
  const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn(), onRefresh: () => {} })
  const section = renderer.renderNowSection(data.now, {})
  document.body.append(section)
  const host = section.querySelector<HTMLElement>('.kbn-card')!
  const down = new Event('pointerdown', { bubbles: true })
  Object.assign(down, { pointerType: 'touch', pointerId: 1, button: 0, clientX: 10, clientY: 10 })
  host.dispatchEvent(down)
  vi.advanceTimersByTime(500)
  expect(host.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(false)
  vi.runOnlyPendingTimers()
})
it('expands deep asks before work, hides archived rows, and opens the selected thread rather than the root', () => {
  const root = card({ id: 'root' }), child = card({ id: 'root/child', orchestrator: 'root', status: 'active' })
  const ask = card({ id: 'root/child/deep', orchestrator: child.id, status: 'closed' })
  const archived = card({ id: 'root/done', orchestrator: root.id, status: 'closed', tempered: false })
  const host = document.createElement('div'), meta = document.createElement('div'); host.append(meta); document.body.append(host)
  const open = vi.fn()
  installThreadPeek(host, meta, root, [root, child, ask, archived], open)
  expect(meta.textContent).toBe('⑂ 2')
  expect(meta.querySelector('.kbn-thread-badge-waiting')).not.toBeNull()
  const peek = host.querySelector<HTMLElement>('.kbn-thread-peek')!
  expect(peek.hidden).toBe(true)
  meta.querySelector<HTMLButtonElement>('button')!.click()
  expect(peek.hidden).toBe(false)
  expect([...peek.querySelectorAll('button')].map(row => row.textContent)).toEqual([expect.stringContaining(ask.id), expect.stringContaining(child.id)])
  expect(peek.textContent).toContain('1 archived')
  peek.querySelector<HTMLButtonElement>('button')!.click()
  expect(open).toHaveBeenCalledWith(ask)
  expect(host.querySelector('.kbn-thread-subentries')).toBeNull()
  saveWaitingThreadEntries(true)
  const second = document.createElement('div')
  installThreadPeek(second, second, root, [root, child, ask], open)
  expect(second.querySelector('.kbn-thread-subentries')?.textContent).toContain(ask.id)
})
