// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import { FALLBACK_DEFAULT_AGENT, KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import type { KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'

const fleetDefaults: Record<string, string> = {
  alpha: 'claude-opus',
  beta: 'claude-fable',
}

function surfaces(getFleetDefaultAgent?: (origin: string) => string): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => null,
    stopDragAutoScroll: () => {},
    transition: () => {},
    setSurface: () => {},
    openDetail: () => {},
    getFleetDefaultAgent,
    onRefresh: () => {},
  })
}

interface BoardInternals {
  render(data: KanbanResponse): void
  startPolling(): void
  fetchAndRender(): Promise<void>
}

let board: KanbanModal | null = null
let inside: BoardInternals
let localStorageData: Map<string, string>

beforeEach(() => {
  localStorageData = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => localStorageData.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageData.set(key, value),
    clear: () => localStorageData.clear(),
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}))))
  window.history.replaceState(null, '', '/')
  board = new KanbanModal({ shuttleBase: '' })
  inside = board as unknown as BoardInternals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  vi.spyOn(inside, 'fetchAndRender').mockResolvedValue()
  board.mount(document.body)
})

afterEach(() => {
  board?.unmount()
  board = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A Desk row names a non-default agent in its label; the default goes unsaid. */
function rowAgent(root: ParentNode, id: string): string | null {
  const label = root.querySelector<HTMLElement>(`[data-fiber-id="${id}"]`)?.getAttribute('aria-label') ?? ''
  const parts = label.split(' — ')
  return parts.length > 2 ? parts[1] : null
}

describe('agent names follow each owning fleet default', () => {
  it('hides the registry default and omitted agent on Desk rows and resting chips', () => {
    const renderer = surfaces((origin) => fleetDefaults[origin] ?? FALLBACK_DEFAULT_AGENT)
    const now = renderer.renderNowSection({
      drafts: [
        card({ id: 'default', originId: 'alpha', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }),
        card({ id: 'custom', originId: 'beta', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }),
        card({ id: 'implicit', originId: 'alpha', shuttleKind: 'oneshot' }),
      ],
      inFlight: [],
      awaitingReview: [],
    }, {})
    expect(rowAgent(now, 'default')).toBeNull()
    expect(rowAgent(now, 'custom')).toBe('claude-opus')
    expect(rowAgent(now, 'implicit')).toBeNull()

    const resting = renderer.renderStashSection([
      card({ id: 'rest-default', originId: 'alpha', effectiveHorizon: 'stashed', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }),
      card({ id: 'rest-custom', originId: 'beta', effectiveHorizon: 'stashed', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }),
    ], {})
    // A resting line gives its width to the title: the agent rides in its label and title, never inline.
    expect(resting.querySelector('.kbn-cluster-item-agent-name')).toBeNull()
    expect(rowAgent(resting, 'rest-default')).toBeNull()
    expect(resting.querySelector<HTMLElement>('[data-fiber-id="rest-default"]')!.title).toBe('rest-default')
    expect(resting.querySelector<HTMLElement>('[data-fiber-id="rest-custom"]')!.getAttribute('aria-label')).toBe('rest-custom — claude-opus')
    expect(resting.querySelector<HTMLElement>('[data-fiber-id="rest-custom"]')!.title).toBe('rest-custom — claude-opus')
  })

  it('uses the literal default while a fleet registry has not answered', () => {
    const root = surfaces().renderNowSection({
      drafts: [
        card({ id: 'fallback-default', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }),
        card({ id: 'fallback-custom', shuttleKind: 'oneshot', shuttleAgent: 'claude-fable' }),
      ],
      inFlight: [],
      awaitingReview: [],
    }, {})
    expect(rowAgent(root, 'fallback-default')).toBeNull()
    expect(rowAgent(root, 'fallback-custom')).toBe('claude-fable')
  })

  it('loads the owner-routed registry default once for each card origin', async () => {
    const defaults: Record<string, string> = { alpha: 'claude-fable', beta: 'claude-opus' }
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.href)
      const origin = url.searchParams.get('origin') ?? ''
      return new Response(JSON.stringify([{ id: defaults[origin], default: true }]), {
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetcher)

    inside.render(response({ now: {
      drafts: [
        card({ id: 'alpha-card', originId: 'alpha', shuttleKind: 'oneshot', shuttleAgent: 'claude-fable' }),
        card({ id: 'beta-card', originId: 'beta', shuttleKind: 'oneshot', shuttleAgent: 'claude-fable' }),
      ],
      inFlight: [],
      awaitingReview: [],
    } }))

    await vi.waitFor(() => {
      expect(rowAgent(document.body, 'alpha-card')).toBeNull()
      expect(rowAgent(document.body, 'beta-card')).toBe('claude-fable')
    })
    const urls = fetcher.mock.calls.map(([input]) => new URL(String(input), window.location.href))
    expect(urls.filter((url) => url.pathname === '/api/v1/agents').map((url) => url.pathname + url.search).sort()).toEqual([
      '/api/v1/agents?origin=alpha',
      '/api/v1/agents?origin=beta',
    ])
  })
})
