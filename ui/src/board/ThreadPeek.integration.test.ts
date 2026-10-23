// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { THREAD_LABEL, ThreadIndex } from './threads.js'
import { LastReplies } from './threadReply.js'
import { response } from './testFixtures.js'
import { badgeWords, installThreadPeek, THREAD_PIN, TREE_LINES_IN_VIEW, ThreadFamilies, type ThreadPinRequest } from './ThreadPeek.js'
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
  expect(meta.textContent).toBe('2 threads')
  expect(meta.querySelector('.kbn-thread-badge-waiting')).not.toBeNull()
  const peek = host.querySelector<HTMLElement>('.kbn-thread-peek')!
  expect(peek.hidden).toBe(true)
  meta.querySelector<HTMLButtonElement>('button')!.click()
  expect(peek.hidden).toBe(false)
  // The tree: the working child, its asking thread a level below it, drawn as the last joint.
  const lines = [...peek.querySelectorAll('.kbn-tree-line')]
  expect(lines.map(line => [line.querySelector('.kbn-thread-name')!.textContent, [...line.querySelectorAll('.kbn-tree-guides > i')].map(i => (i as HTMLElement).dataset.g)]))
    .toEqual([[child.id, ['elbow']], [ask.id, ['gap', 'elbow']]])
  expect(peek.textContent).toContain('1 archived')
  peek.querySelector<HTMLButtonElement>(`.kbn-thread-row[data-card-uid="${ask.id}"]`)!.click()
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
  const waits = [1, 2, 3, 4].map(n => card({ id: `root/w${n}`, orchestrator: root.id, status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }))
  const reviews = Array.from({ length: 16 }, (_, n) => card({ id: `root/review${n}`, orchestrator: root.id, status: 'closed' }))
  const host = document.createElement('div'), meta = document.createElement('div'); host.append(meta)
  installThreadPeek(host, meta, root, new ThreadIndex([root, ...waits, ...reviews]), open)
  expect(meta.textContent).toBe('20 threads · 16 reviews')
  expect(meta.querySelector('.kbn-thread-badge-review')?.textContent).toBe('16 reviews')
  expect(host.querySelector('.kbn-thread-subentries')?.nextElementSibling).toBe(host.querySelector('.kbn-thread-peek'))
  expect(host.querySelectorAll('.kbn-thread-subentries .kbn-thread-row')).toHaveLength(2)
  expect(host.querySelector('.kbn-thread-subentries')?.textContent).not.toContain('review')
  host.querySelector<HTMLButtonElement>('.kbn-thread-more')!.click()
  expect(open).toHaveBeenCalledWith(root)
  const peek = host.querySelector<HTMLElement>('.kbn-thread-peek')!
  expect(peek.querySelectorAll('.kbn-thread-row[data-thread-state="to-review"]')).toHaveLength(16)
  expect([...peek.querySelectorAll('.kbn-thread-more')].map(b => b.textContent)).toEqual(['Open family →'])
})
it('draws a lone extra waiting thread rather than folding it into "+ 1 more"', () => {
  saveWaitingThreadEntries(true)
  const root = card({ id: 'root' })
  const waits = [1, 2, 3].map(n => card({ id: `root/w${n}`, orchestrator: root.id, status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }))
  const host = document.createElement('div')
  installThreadPeek(host, host, root, new ThreadIndex([root, ...waits]), vi.fn())
  expect(host.querySelectorAll('.kbn-thread-subentries .kbn-thread-row')).toHaveLength(3)
  expect(host.querySelector('.kbn-thread-subentries .kbn-thread-more')).toBeNull()
})
it('says the badge in words: threads, then reviews, or reviews alone when every thread is one', () => {
  const words = (threads: number, reviews: number) => badgeWords(threads, reviews).map(el => el.textContent).join('')
  expect(words(1, 0)).toBe('1 thread')
  expect(words(24, 0)).toBe('24 threads')
  expect(words(24, 2)).toBe('24 threads · 2 reviews')
  expect(words(24, 1)).toBe('24 threads · 1 review')
  expect(words(3, 3)).toBe('3 reviews')
  expect(badgeWords(24, 2).at(-1)!.className).toBe('kbn-thread-badge-review')
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
  it('draws its live work in a scrolling box, and offers every thread through the constitution', () => {
    saveWaitingThreadEntries(false)
    const root = card({ id: 'hub', status: 'active' }), open = vi.fn()
    const threads = Array.from({ length: 48 }, (_, n) => card({ id: `hub/t${n}`, orchestrator: 'hub', status: n % 2 ? 'closed' : 'active',
      ask: n % 4 === 0 ? { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } : undefined }))
    const host = document.createElement('div'); document.body.append(host)
    installThreadPeek(host, host, root, new ThreadIndex([root, ...threads]), open)
    const peek = host.querySelector<HTMLElement>('.kbn-thread-peek')!
    expect(peek.querySelectorAll('h4')).toHaveLength(0)
    expect(peek.querySelectorAll('.kbn-thread-tree-body .kbn-thread-row')).toHaveLength(48)
    const all = peek.querySelector<HTMLButtonElement>('.kbn-thread-tree-foot .kbn-thread-all')!
    expect(all.textContent).toBe('Open family →')
    all.click()
    expect(open).toHaveBeenCalledWith(root)
  })
  it('says nothing of all threads while the tree shows every one at a glance', () => {
    const root = card({ id: 'hub' })
    const threads = Array.from({ length: TREE_LINES_IN_VIEW }, (_, n) => card({ id: `hub/t${n}`, orchestrator: 'hub', status: 'active' }))
    const host = document.createElement('div')
    installThreadPeek(host, host, root, new ThreadIndex([root, ...threads]), vi.fn())
    expect(host.querySelector('.kbn-thread-all')).toBeNull()
    expect(host.querySelector<HTMLElement>('.kbn-thread-tree-foot')!.hidden).toBe(true)
  })
})
describe('an opened family focuses on live work', () => {
  const ask = { text: 'Which cut?', at: '2026-07-02T12:00:00Z' }
  const root = card({ id: 'root' })
  const work = card({ id: 'root/work', name: 'busy', orchestrator: 'root', status: 'active' })
  const plan = card({ id: 'root/plan', name: 'a plan', orchestrator: 'root' })
  // A draft that holds a waiting thread stays drawn, as its ancestor.
  const holder = card({ id: 'root/holder', name: 'holder', orchestrator: 'root' })
  const asking = card({ id: 'root/holder/ask', name: 'asking', orchestrator: 'root/holder', status: 'active', ask })
  const asleep = [1, 2].map(n => card({ id: `root/rest${n}`, name: `asleep ${n}`, orchestrator: 'root', status: 'open', effectiveHorizon: 'stashed' }))
  const index = new ThreadIndex([root, work, plan, holder, asking, ...asleep])
  const names = (host: Element) => [...host.querySelectorAll('.kbn-thread-peek .kbn-thread-name')].map(n => n.textContent)
  it('draws waiting, working and review threads with their ancestors; drafts and resting fold behind a line each that unfolds in place', () => {
    saveWaitingThreadEntries(false)
    const families = new ThreadFamilies()
    const host = document.createElement('div'); document.body.append(host)
    installThreadPeek(host, host, root, index, vi.fn(), families)
    host.querySelector<HTMLButtonElement>('.kbn-thread-badge')!.click()
    expect(names(host)).toEqual(['busy', 'holder', 'asking'])
    const folds = () => [...host.querySelectorAll<HTMLButtonElement>('.kbn-thread-fold')]
    expect(folds().map(f => [f.textContent, f.getAttribute('aria-expanded')])).toEqual([['2 drafts', 'false'], ['2 resting', 'false']])
    expect(host.querySelector('.kbn-thread-tree-more')!.textContent).toBe('More: 2 drafts · 2 resting')
    folds()[0].click()
    expect(names(host)).toEqual(['busy', 'a plan', 'holder', 'asking'])
    expect(document.activeElement).toBe(folds()[0])
    expect(folds()[0].getAttribute('aria-expanded')).toBe('true')
    // The unfolding holds through a repaint, which rebuilds the card.
    const again = document.createElement('div'); document.body.append(again)
    installThreadPeek(again, again, root, index, vi.fn(), families)
    expect(names(again)).toEqual(['busy', 'a plan', 'holder', 'asking'])
    folds()[0].click()
    expect(names(host)).toEqual(['busy', 'holder', 'asking'])
  })
})
describe('a mouse on a family', () => {
  const pointer = (el: HTMLElement, type: string): void => {
    const event = new Event(type); Object.assign(event, { pointerType: 'mouse' }); el.dispatchEvent(event)
  }
  it('passing over opens nothing; a badge click opens the family until the next click folds it', () => {
    saveWaitingThreadEntries(false)
    const root = card({ id: 'root' }), child = card({ id: 'root/child', orchestrator: 'root', status: 'active' })
    const families = new ThreadFamilies()
    const host = document.createElement('div'); document.body.append(host)
    installThreadPeek(host, host, root, new ThreadIndex([root, child]), vi.fn(), families)
    const peek = host.querySelector<HTMLElement>('.kbn-thread-peek')!, badge = host.querySelector<HTMLButtonElement>('.kbn-thread-badge')!
    pointer(host, 'pointerenter')
    pointer(host, 'pointermove')
    expect(peek.hidden).toBe(true)
    expect(families.isOpen(root)).toBe(false)
    badge.click()
    expect(peek.hidden).toBe(false)
    expect(families.isOpen(root)).toBe(true)
    pointer(host, 'pointerleave')
    expect(peek.hidden).toBe(false)
    badge.click()
    expect(peek.hidden).toBe(true)
    expect(families.isOpen(root)).toBe(false)
  })
})
describe('sub-entries in an open family', () => {
  it('fold away when the badge opens the family, whose tree draws each thread once, and come back when it folds', () => {
    saveWaitingThreadEntries(true)
    const root = card({ id: 'root' })
    const waits = [1, 2, 3, 4].map(n => card({ id: `root/w${n}`, orchestrator: 'root', status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }))
    const work = card({ id: 'root/work', orchestrator: 'root', status: 'active' })
    const open = vi.fn(), openRoot = vi.fn()
    const host = document.createElement('div'); document.body.append(host)
    host.addEventListener('click', openRoot)
    installThreadPeek(host, host, root, new ThreadIndex([root, ...waits, work]), open)
    const entries = host.querySelector<HTMLElement>('.kbn-thread-subentries')!
    // At rest: stubs off the card, the last folding the rest.
    expect([...entries.querySelectorAll('.kbn-tree-guides')].map(g => [...g.children].map(i => (i as HTMLElement).dataset.g).join())).toEqual(['tee', 'tee', 'elbow'])
    host.querySelector<HTMLButtonElement>('.kbn-thread-badge')!.click()
    expect(host.querySelector<HTMLElement>('.kbn-thread-peek')!.hidden).toBe(false)
    expect(entries.hidden).toBe(true)
    const visible = [...host.querySelectorAll<HTMLElement>('.kbn-thread-row')].filter(row => !row.closest('[hidden]'))
    expect(visible.map(row => row.querySelector('.kbn-thread-name')!.textContent)).toEqual(['root/w1', 'root/w2', 'root/w3', 'root/w4', 'root/work'])
    visible[0].click()
    expect(open).toHaveBeenLastCalledWith(waits[0])
    host.querySelector<HTMLElement>('.kbn-thread-peek')!.click()
    expect(openRoot).not.toHaveBeenCalled()
    host.querySelector<HTMLButtonElement>('.kbn-thread-badge')!.click()
    expect(entries.hidden).toBe(false)
  })
})
describe('a family drawn as a tree', () => {
  const ask = { text: 'Which cut?', at: '2026-07-02T12:00:00Z' }
  it('names each thread once; only waiting and review lines carry a state word, at their end', () => {
    saveWaitingThreadEntries(true)
    const root = card({ id: 'root' })
    const threads = [
      ...[1, 2, 3].map(n => card({ id: `root/w${n}`, name: `asking ${n}`, orchestrator: 'root', status: 'active', ask })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => card({ id: `root/r${n}`, name: `done ${n}`, orchestrator: 'root', status: 'closed' })),
      card({ id: 'root/work', name: 'busy', orchestrator: 'root', status: 'active' }),
      card({ id: 'root/work/deep', name: 'deeper', orchestrator: 'root/work', status: 'open' }),
      card({ id: 'root/rest', name: 'asleep', orchestrator: 'root', status: 'open', effectiveHorizon: 'stashed' }),
    ]
    const host = document.createElement('div'); document.body.append(host)
    installThreadPeek(host, host, root, new ThreadIndex([root, ...threads]), vi.fn())
    for (const open of [false, true]) {
      if (open) host.querySelector<HTMLButtonElement>('.kbn-thread-badge')!.click()
      const shown = [...host.querySelectorAll<HTMLElement>('.kbn-thread-subentries, .kbn-thread-peek')].filter(el => !el.hidden)
      const tags = shown.flatMap(el => [...el.querySelectorAll<HTMLElement>('.kbn-thread-row')].map(row =>
        [row.dataset.threadState, row.querySelector('.kbn-tree-tag')?.textContent ?? null]))
      for (const [state, tag] of tags) expect(tag, `${state} (${open ? 'open' : 'at rest'})`).toBe(open ? ({ waiting: 'waiting', 'to-review': 'review' } as Record<string, string>)[state!] ?? null : null)
      // Outside the tags, no line says its state.
      const rest = shown.map(el => { const copy = el.cloneNode(true) as HTMLElement; copy.querySelectorAll('.kbn-tree-tag').forEach(t => t.remove()); return copy.textContent }).join(' ')
      for (const word of Object.values(THREAD_LABEL)) expect(rest.split(new RegExp(`\\b${word}\\b`, 'i')).length - 1, word).toBeLessThanOrEqual(1)
      const names = [...host.querySelectorAll<HTMLElement>('.kbn-thread-name')].filter(n => !n.closest('[hidden]')).map(n => n.textContent)
      expect(new Set(names).size).toBe(names.length)
    }
  })
  it('a line under the pointer or the keyboard whispers its state, age and what its agent last said', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-07-02T15:00:00Z'))
    saveWaitingThreadEntries(false)
    const transcript = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'An **earlier** reply.' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The cut is ready; see [the report](report.html).' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
    ].map(r => JSON.stringify(r)).join('\n') + '\n'
    const fetcher = vi.fn(async (url: string) => url.includes('/raw?')
      ? new Response(transcript)
      : new Response(JSON.stringify({ byte_count: transcript.length })))
    const root = card({ id: 'root' })
    const child = card({ id: 'root/child', name: 'Choose the cut', orchestrator: 'root', status: 'closed', outcome: 'Cut chosen.',
      sessionUuid: 'sess-1', shuttleHost: 'far', closedAt: '2026-07-02T12:00:00Z' })
    const host = document.createElement('div'); document.body.append(host)
    const families = new ThreadFamilies(new LastReplies('http://daemon', fetcher as unknown as typeof fetch))
    installThreadPeek(host, host, root, new ThreadIndex([root, child]), vi.fn(), families)
    host.querySelector<HTMLButtonElement>('.kbn-thread-badge')!.click()
    const row = host.querySelector<HTMLElement>('.kbn-thread-peek .kbn-thread-row')!
    // Nothing inline but the name.
    expect(row.querySelector('.kbn-thread-name')!.textContent).toBe('Choose the cut')
    expect(row.querySelector('.kbn-tree-tag')!.textContent).toBe('review')
    const pointer = new Event('pointerenter'); Object.assign(pointer, { pointerType: 'mouse' }); row.dispatchEvent(pointer)
    const whisper = () => document.querySelector<HTMLElement>('.kbn-thread-whisper')
    expect(whisper()?.hidden ?? true).toBe(true)
    await vi.advanceTimersByTimeAsync(400)
    expect(whisper()!.hidden).toBe(false)
    expect(whisper()!.querySelector('.kbn-thread-whisper-head')!.textContent).toBe('To review · 3h')
    expect(whisper()!.querySelector('.kbn-thread-whisper-body')!.textContent).toBe('The cut is ready; see the report.')
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://daemon/api/v1/transcript?session=sess-1&host=far',
      'http://daemon/api/v1/transcript/raw?session=sess-1&host=far&offset=0',
    ])
    row.dispatchEvent(new Event('pointerleave'))
    expect(whisper()!.hidden).toBe(true)
    // The keyboard's focus shows it at once, from the reply already read.
    row.focus()
    expect(whisper()!.hidden).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(whisper()!.querySelector('.kbn-thread-whisper-body')!.textContent).toBe('The cut is ready; see the report.')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
describe('quiet families', () => {
  it('a family whose threads are all archived draws no badge', () => {
    const root = card({ id: 'root' }), done = card({ id: 'root/done', orchestrator: 'root', status: 'closed', tempered: true })
    const host = document.createElement('div')
    installThreadPeek(host, host, root, new ThreadIndex([root, done]), vi.fn())
    expect(host.querySelector('.kbn-thread-badge')).toBeNull()
    expect(host.classList.contains('kbn-thread-family')).toBe(false)
  })
})
describe('pinned threads', () => {
  const ask = { text: 'Which cut?', at: '2026-07-02T12:00:00Z' }
  const names = (el: Element | null): string[] => [...el?.querySelectorAll('.kbn-thread-row .kbn-thread-name') ?? []].map(n => n.textContent!)
  it('a pinned thread is a sub-entry with a pressed pin, whatever its state, and is not drawn again in the list', () => {
    saveWaitingThreadEntries(false)
    const root = card({ id: 'root' })
    const work = card({ id: 'root/work', orchestrator: 'root', status: 'active', tags: ['pinned'] })
    const other = card({ id: 'root/other', orchestrator: 'root', status: 'active' })
    const host = document.createElement('div'); document.body.append(host)
    installThreadPeek(host, host, root, new ThreadIndex([root, work, other]), vi.fn())
    const entries = host.querySelector('.kbn-thread-subentries')
    expect(names(entries)).toEqual(['root/work'])
    expect(entries!.querySelector('.kbn-thread-row')!.classList.contains('kbn-thread-pinned')).toBe(true)
    expect(entries!.querySelector('.kbn-thread-pin')!.getAttribute('aria-pressed')).toBe('true')
    host.querySelector<HTMLButtonElement>('.kbn-thread-badge')!.click()
    expect(names(host.querySelector('.kbn-thread-peek'))).toEqual(['root/other', 'root/work'])
    expect(entries!.closest('[hidden]')).toBe(entries)
    expect([...host.querySelectorAll('.kbn-thread-peek .kbn-thread-pin')].map(p => p.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
  })
  it('pinned rows come ahead of the waiting ones and never fold into "+ N more"', () => {
    saveWaitingThreadEntries(true)
    const root = card({ id: 'root' })
    const pins = [1, 2, 3].map(n => card({ id: `root/p${n}`, orchestrator: 'root', status: 'active', tags: ['pinned'] }))
    const waits = [1, 2, 3, 4].map(n => card({ id: `root/w${n}`, orchestrator: 'root', status: 'active', ask }))
    const pinnedWait = card({ id: 'root/pw', orchestrator: 'root', status: 'active', ask, tags: ['pinned'] })
    const host = document.createElement('div'); document.body.append(host)
    installThreadPeek(host, host, root, new ThreadIndex([root, ...waits, ...pins, pinnedWait]), vi.fn())
    const entries = host.querySelector('.kbn-thread-subentries')!
    expect(names(entries)).toEqual(['root/pw', 'root/p1', 'root/p2', 'root/p3', 'root/w1', 'root/w2'])
    expect(entries.querySelector('.kbn-thread-more')!.textContent).toBe('+ 2 more')
  })
  it('the pin control asks the board to pin an unpinned thread and to unpin a pinned one', () => {
    saveWaitingThreadEntries(false)
    const root = card({ id: 'root' })
    const work = card({ id: 'root/work', orchestrator: 'root', status: 'active' })
    const kept = card({ id: 'root/kept', orchestrator: 'root', status: 'active', tags: ['pinned'] })
    const host = document.createElement('div'); document.body.append(host)
    const asked = vi.fn()
    document.addEventListener(THREAD_PIN, asked)
    const openRoot = vi.fn(); host.addEventListener('click', openRoot)
    installThreadPeek(host, host, root, new ThreadIndex([root, work, kept]), vi.fn())
    const pinOf = (id: string) => host.querySelector<HTMLElement>(`.kbn-thread-row[data-card-uid="${id}"]`)!.parentElement!.querySelector<HTMLButtonElement>('.kbn-thread-pin')!
    pinOf('root/work').click()
    pinOf('root/kept').click()
    document.removeEventListener(THREAD_PIN, asked)
    expect(asked.mock.calls.map(([e]) => [(e as CustomEvent<ThreadPinRequest>).detail.card.id, (e as CustomEvent<ThreadPinRequest>).detail.pinned]))
      .toEqual([['root/work', true], ['root/kept', false]])
    expect(openRoot).not.toHaveBeenCalled()
  })
})
