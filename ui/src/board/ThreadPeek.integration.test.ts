// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { ThreadIndex } from './threads.js'
import { response } from './testFixtures.js'
import { installThreadPeek, PEEK_ROWS } from './ThreadPeek.js'
import { card } from './testFixtures.js'
import { saveWaitingThreadEntries, waitingThreadEntries } from './threadPreferences.js'
afterEach(() => { document.body.replaceChildren(); saveWaitingThreadEntries(false); vi.useRealTimers() })
it('enables waiting subentries by default and respects an explicit opt-out', () => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  expect(waitingThreadEntries()).toBe(true)
  vi.stubGlobal('localStorage', { getItem: () => 'false' })
  expect(waitingThreadEntries()).toBe(false)
  vi.unstubAllGlobals()
})
describe('phone gestures on a family', () => {
  const root = card({ id: 'root' }), child = card({ id: 'root/child', orchestrator: 'root' })
  const seat = card({ id: 'seat', shuttleRole: 'chair', shuttleSeat: true }), seatChild = card({ id: 'seat/child', orchestrator: 'seat' })
  const rest = card({ id: 'rest', effectiveHorizon: 'stashed' }), restChild = card({ id: 'rest/child', orchestrator: 'rest', effectiveHorizon: 'stashed' })
  const index = new ThreadIndex([root, child, seat, seatChild, rest, restChild])
  for (const c of [root, seat, rest]) c.threadSummary = index.summary(c)
  const data = response({ now: { drafts: [root], inFlight: [], awaitingReview: [] }, roles: [seat], stash: [rest], threads: [child, seatChild, restChild] })
  const touch = (el: HTMLElement, type: string): void => {
    const event = new Event(type, { bubbles: true })
    Object.assign(event, { pointerType: 'touch', pointerId: 1, button: 0, isPrimary: true, clientX: 10, clientY: 10 })
    el.dispatchEvent(event)
  }
  const draw = () => {
    const longPress = vi.fn()
    const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
      stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn(), onRefresh: () => {}, onCardLongPress: longPress })
    document.body.append(renderer.renderNowSection(data.now, {}), renderer.renderRolesSection(data.roles, {})!, renderer.renderStashSection([rest], {}))
    return longPress
  }
  it('a hold on a family card or seat opens the Move menu and leaves the family folded', () => {
    vi.useFakeTimers()
    const longPress = draw()
    for (const id of ['root', 'seat']) {
      const el = document.querySelector<HTMLElement>(`[data-card-uid="${id}"]`)!
      touch(el, 'pointerdown')
      vi.advanceTimersByTime(500)
      touch(el, 'pointerup')
      el.click() // the lift's own click, which the fired hold swallows
      expect(longPress).toHaveBeenLastCalledWith(expect.objectContaining({ id }), el)
      expect(el.closest('.kbn-thread-family')!.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(true)
    }
    expect(longPress).toHaveBeenCalledTimes(2)
    vi.runOnlyPendingTimers()
  })
  it('a resting row keeps no hold gesture of its own', () => {
    vi.useFakeTimers()
    const longPress = draw()
    const row = document.querySelector<HTMLElement>('.kbn-cluster-item[data-card-uid="rest"]')!
    touch(row, 'pointerdown')
    vi.advanceTimersByTime(500)
    touch(row, 'pointerup')
    expect(longPress).not.toHaveBeenCalled()
    vi.runOnlyPendingTimers()
  })
  it('a tap on the badge expands and folds the family', () => {
    draw()
    const family = document.querySelector<HTMLElement>('[data-card-uid="root"]')!
    const badge = family.querySelector<HTMLButtonElement>('.kbn-thread-badge')!
    touch(family, 'pointerenter')
    expect(family.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(true)
    badge.click()
    expect(family.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(false)
    badge.click()
    expect(family.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(true)
  })
})
it('expands deep asks before work, hides archived rows, and opens the selected thread rather than the root', () => {
  const root = card({ id: 'root' }), child = card({ id: 'root/child', orchestrator: 'root', status: 'active' })
  saveWaitingThreadEntries(false)
  const ask = card({ id: 'root/child/deep', orchestrator: child.id, status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } })
  const archived = card({ id: 'root/done', orchestrator: root.id, status: 'closed', tempered: false })
  const host = document.createElement('div'), meta = document.createElement('div'); host.append(meta); document.body.append(host)
  const open = vi.fn()
  installThreadPeek(host, meta, root, new ThreadIndex([root, child, ask, archived]), open)
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
  installThreadPeek(second, second, root, new ThreadIndex([root, child, ask]), open)
  expect(second.querySelector('.kbn-thread-subentries')?.textContent).toContain(ask.id)
})
it('caps enabled Desk subentries at two actual waits, never reviews, and opens the root for more', () => {
  saveWaitingThreadEntries(true)
  const root = card({ id: 'root' }), open = vi.fn()
  const waits = [1, 2, 3].map(n => card({ id: `root/w${n}`, orchestrator: root.id, status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }))
  const reviews = Array.from({ length: 16 }, (_, n) => card({ id: `root/review${n}`, orchestrator: root.id, status: 'closed' }))
  const host = document.createElement('div'), meta = document.createElement('div'); host.append(meta)
  installThreadPeek(host, meta, root, new ThreadIndex([root, ...waits, ...reviews]), open)
  expect(meta.textContent).toContain('16 to review')
  expect(host.querySelector('.kbn-thread-subentries')?.nextElementSibling).toBe(host.querySelector('.kbn-thread-peek'))
  expect(host.querySelectorAll('.kbn-thread-subentries .kbn-thread-row')).toHaveLength(2)
  expect(host.querySelector('.kbn-thread-subentries')?.textContent).not.toContain('review')
  host.querySelector<HTMLButtonElement>('.kbn-thread-more')!.click()
  expect(open).toHaveBeenCalledWith(root)
  expect(host.querySelector('.kbn-thread-peek')?.textContent).toContain('To review')
})
describe('role seats', () => {
  it('a seat with threads carries its badge beside the chip; a seat without stays a bare chip', () => {
    const seat = card({ id: 'seat', shuttleRole: 'chair', shuttleSeat: true }), seatChild = card({ id: 'seat/child', orchestrator: 'seat' })
    const lone = card({ id: 'lone', shuttleRole: 'scribe', shuttleSeat: true })
    const index = new ThreadIndex([seat, seatChild, lone])
    for (const c of [seat, lone]) c.threadSummary = index.summary(c)
    const data = response({ roles: [seat, lone], threads: [seatChild] })
    const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
      stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn(), onRefresh: () => {} })
    document.body.append(renderer.renderRolesSection(data.roles, {})!)
    const seated = document.querySelector<HTMLElement>('.kbn-role-seat')!
    expect(seated.getAttribute('role')).toBe('listitem')
    expect(seated.querySelector('[data-card-uid="seat"]')).not.toBeNull()
    expect(seated.querySelector('.kbn-role-threads .kbn-thread-badge')).not.toBeNull()
    const bare = document.querySelector<HTMLElement>('[data-card-uid="lone"]')!
    expect(bare.closest('.kbn-role-seat')).toBeNull()
    expect(bare.getAttribute('role')).toBe('listitem')
  })
})
describe('a large family stays a peek, not a column', () => {
  it('caps each group at a few rows, folding the rest into "+ N more" that opens the root', () => {
    saveWaitingThreadEntries(false)
    const root = card({ id: 'hub', status: 'active' }), open = vi.fn()
    const threads = Array.from({ length: 48 }, (_, n) => card({ id: `hub/t${n}`, orchestrator: 'hub', status: n % 2 ? 'closed' : 'active',
      ask: n % 4 === 0 ? { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } : undefined }))
    const host = document.createElement('div'); document.body.append(host)
    installThreadPeek(host, host, root, new ThreadIndex([root, ...threads]), open)
    const peek = host.querySelector<HTMLElement>('.kbn-thread-peek')!
    expect([...peek.querySelectorAll('h4')].map(h => h.textContent)).toEqual(['Waiting', 'To review', 'Working'])
    expect(peek.querySelectorAll('.kbn-thread-row')).toHaveLength(3 * PEEK_ROWS)
    const more = [...peek.querySelectorAll<HTMLButtonElement>('.kbn-thread-more')]
    expect(more.map(b => b.textContent)).toEqual([`+ ${12 - PEEK_ROWS} more`, `+ ${24 - PEEK_ROWS} more`, `+ ${12 - PEEK_ROWS} more`])
    more[1].click()
    expect(open).toHaveBeenCalledWith(root)
  })
})
