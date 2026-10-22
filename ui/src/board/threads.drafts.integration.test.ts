// @vitest-environment jsdom
import { ThreadIndex } from './threads.js'
import { expect, it, vi } from 'vitest'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { installThreadPeek } from './ThreadPeek.js'
import { ThreadRail } from './workspace/ThreadRail.js'
import { threadState } from './threads.js'

it('counts unarmed shuttle drafts as threads, separates them from Resting, and excludes plain notes', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  try {
    const fibers = [
      { id: 'hub', name: 'Hub', status: 'active', shuttle: {} },
      { id: 'hub/draft', name: 'Plan the validation', status: 'open', shuttle: {} },
      { id: 'hub/rest', name: 'Resting validation', status: 'open', horizon: 'stashed', shuttle: {} },
      { id: 'hub/note', name: 'An ordinary note', status: 'open' },
    ].map(fiber => ({ origin: 'owner', felt_store: '/store', path: `${fiber.id}.md`, orchestrator: fiber.id === 'hub' ? null : 'hub', fiber }))
    const board = buildKanbanResponseFromComposite(parseCompositeFeed({ host: 'owner', fibers }))
    expect(board.threads?.map(c => c.id).sort()).toEqual(['hub/draft', 'hub/rest'])
    const root = board.now.inFlight[0], draft = board.threads!.find(c => c.id === 'hub/draft')!, rest = board.threads!.find(c => c.id === 'hub/rest')!
    expect(root.threadSummary?.unfinished).toBe(2)
    expect(threadState(draft)).toBe('drafts')
    expect(threadState(rest)).toBe('resting')
    const all = [root, ...board.threads!], host = document.createElement('div'), badge = document.createElement('div')
    host.append(badge)
    const open = vi.fn()
    installThreadPeek(host, badge, root, new ThreadIndex(all), open)
    expect([...host.querySelectorAll<HTMLElement>('.kbn-thread-peek .kbn-thread-row')].map(r => [r.textContent, r.dataset.threadState]))
      .toEqual([['Plan the validation', 'drafts'], ['Resting validation', 'resting']])
    expect(host.querySelector('.kbn-thread-subentries')).toBeNull()
    const rail = new ThreadRail(open, vi.fn()); rail.show(root, new ThreadIndex(all))
    expect(rail.el.querySelector('.ws-thread-waiting')).toBeNull()
    expect([...rail.el.querySelectorAll('.ws-thread-group summary')].map(s => s.textContent)).toEqual(['Drafts · 1', 'Resting · 1'])
    expect(rail.el.querySelector('[data-thread-state="drafts"]')?.textContent).toContain('Plan the validation')
    expect(rail.el.querySelector('[data-thread-state="resting"]')?.textContent).toContain('Resting validation')
    rail.el.querySelector<HTMLButtonElement>('[data-thread-state="drafts"]')!.click()
    expect(open).toHaveBeenCalledWith(draft)
  } finally { vi.unstubAllGlobals() }
})
