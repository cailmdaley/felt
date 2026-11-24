// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { WORKSPACE_HOST, WORKSPACE_UID, workspaceExample } from '../../harness/workspace-fixtures.js'
import { HostMoveControl, suggestProjectDir } from '../board/workspace/HostMoveControl.js'
import type { KanbanCard } from '../board/KanbanTypes.js'
import { buildKanbanResponseFromComposite } from '../board/KanbanReadModel.js'
import { parseCompositeFeed } from '../board/KanbanComposite.js'
import { servedFeed } from '../board/testFixtures.js'
import { boardCards, ThreadIndex } from '../board/threads.js'
import { PageFeed } from './feed.js'
import { ThreadPage } from './ThreadPage.js'

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'life/desk',
    uid: '01DESK',
    name: 'Desk',
    path: 'life/desk/desk.md',
    status: 'active',
    column: 'inFlight',
    tags: [],
    turn: { turn: 'working', since: '2026-11-24T09:00:00Z' },
    originId: 'remote-hub',
    shuttleKind: 'oneshot',
    shuttleHost: 'remote-hub',
    shuttleAgent: 'claude-opus',
    shuttleProjectDir: '/home/me/code/desk',
    hasLiveWorker: true,
    ...overrides,
  } as KanbanCard
}

describe('suggestProjectDir', () => {
  it('matches by basename across hosts', () => {
    expect(
      suggestProjectDir('/Users/me/dev/felt', ['/home/me/code/other', '/home/me/code/felt']),
    ).toBe('/home/me/code/felt')
  })

  it('returns empty string when no match exists', () => {
    expect(suggestProjectDir('/Users/me/dev/felt', ['/home/me/code/other'])).toBe('')
  })
})

describe('HostMoveControl', () => {
  const origFetch = globalThis.fetch

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('disables offline hosts, suggests project_dir, and posts /api/v1/rehome', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/api/v1/felt-stores')) {
        return new Response(JSON.stringify({
          host: 'laptop',
          origins: {
            laptop: { stale: false, projects: ['/Users/me/dev/desk'] },
            'remote-hub': { stale: false, projects: ['/home/me/code/desk'] },
            'offline-cluster': { stale: true, projects: ['/cluster/desk'] },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (u.endsWith('/api/v1/rehome')) {
        const body = JSON.parse(String(init?.body ?? '{}'))
        expect(body).toEqual({
          fiber: '01DESK',
          origin: 'remote-hub',
          target_host: 'laptop',
          fiber_path: 'life/desk',
          project_dir: '/Users/me/dev/desk',
        })
        return new Response(JSON.stringify({
          ok: true,
          host: 'laptop',
          from_host: 'remote-hub',
          project_dir: '/Users/me/dev/desk',
          previous_host_released: false,
          previous_host_warning: 'remote-hub was unreachable',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const onMoved = vi.fn()
    const onWarning = vi.fn()
    const card = makeCard()
    const ctrl = new HostMoveControl({
      base: 'http://127.0.0.1:4000',
      card: () => card,
      withSaveStatus: async write => { await write(); return true },
      onMoved,
      onWarning,
    })
    document.body.append(ctrl.row, ctrl.confirmRow)

    await ctrl.ensureLoaded()
    const select = ctrl.row.querySelector('select')!
    const offlineOpt = [...select.options].find(o => o.value === 'offline-cluster')!
    expect(offlineOpt.disabled).toBe(true)
    expect(offlineOpt.textContent).toContain('offline')

    select.value = 'laptop'
    select.dispatchEvent(new Event('change'))
    expect(ctrl.confirmRow.hidden).toBe(false)
    const dirInput = ctrl.confirmRow.querySelector<HTMLInputElement>('input')!
    expect(dirInput.value).toBe('/Users/me/dev/desk')

    const moveBtn = ctrl.confirmRow.querySelector<HTMLButtonElement>('.kbn-ctl-send')!
    moveBtn.click()
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1))
    expect(onMoved).toHaveBeenCalledWith({
      host: 'laptop',
      fromHost: 'remote-hub',
      projectDir: '/Users/me/dev/desk',
      warning: 'remote-hub was unreachable',
    })
    expect(onWarning).toHaveBeenCalledWith('remote-hub was unreachable')
    ctrl.dispose()
  })
})

describe('ThreadPage host mismatch guard', () => {
  it('hides the dock composer and shows a mismatch banner when route host differs from card origin', () => {
    const now = Date.now()
    const cards = boardCards(buildKanbanResponseFromComposite(parseCompositeFeed(servedFeed(workspaceExample(now).feed, now))))
    const feed = new PageFeed('http://127.0.0.1:4000', { uid: WORKSPACE_UID, host: 'other-host' })
    feed.cards = cards
    feed.index = new ThreadIndex(cards)
    feed.loaded = true

    const page = new ThreadPage(feed, {
      base: 'http://127.0.0.1:4000',
      route: { page: 'thread', fiber: { uid: WORKSPACE_UID, host: 'other-host' }, inRex: true },
      navigate: () => {},
    })
    document.body.append(page.el)

    const banner = page.el.querySelector<HTMLElement>('.pg-host-mismatch')!
    const dockBand = page.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toContain(`Runs on ${WORKSPACE_HOST} (this pane is on other-host).`)
    expect(dockBand.hidden).toBe(true)

    page.dispose()
  })
})
