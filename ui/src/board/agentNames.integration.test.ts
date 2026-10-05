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
    pin: () => {},
    stack: () => {},
    reorderQueue: () => {},
    unqueueRow: () => {},
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
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
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

describe('agent names follow each owning fleet default', () => {
  it('hides the registry default and omitted agent on cards, pins and resting chips', () => {
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
    expect(now.querySelector<HTMLElement>('[data-fiber-id="default"] .kbn-card-actor')?.hidden).toBe(true)
    expect(now.querySelector<HTMLElement>('[data-fiber-id="custom"] .kbn-card-actor')?.textContent).toBe('claude-opus')
    expect(now.querySelector<HTMLElement>('[data-fiber-id="implicit"] .kbn-card-actor')?.hidden).toBe(true)

    const pinned = renderer.renderPinnedSection([
      card({ id: 'pin-default', originId: 'alpha', status: 'active', shuttleKind: 'pinned', shuttleAgent: 'claude-opus' }),
      card({ id: 'pin-default-beta', originId: 'beta', status: 'active', shuttleKind: 'pinned', shuttleAgent: 'claude-fable' }),
      card({ id: 'pin-custom', originId: 'beta', status: 'active', shuttleKind: 'pinned', shuttleAgent: 'claude-opus' }),
    ], {})
    expect(pinned.querySelector<HTMLElement>('[data-fiber-id="pin-default"] .kbn-pin-chip-hint')?.hidden).toBe(true)
    expect(pinned.querySelector<HTMLElement>('[data-fiber-id="pin-default-beta"] .kbn-pin-chip-hint')?.hidden).toBe(true)
    expect(pinned.querySelector<HTMLElement>('[data-fiber-id="pin-custom"] .kbn-pin-chip-hint')?.textContent).toBe('claude-opus')

    const resting = renderer.renderStashSection([
      card({ id: 'rest-default', originId: 'alpha', effectiveHorizon: 'stashed', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }),
      card({ id: 'rest-custom', originId: 'beta', effectiveHorizon: 'stashed', shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }),
    ], {})
    expect(resting.querySelector('[data-fiber-id="rest-default"] .kbn-cluster-item-agent-name')).toBeNull()
    expect(resting.querySelector('[data-fiber-id="rest-custom"] .kbn-cluster-item-agent-name')?.textContent).toBe('claude-opus')
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
    expect(root.querySelector<HTMLElement>('[data-fiber-id="fallback-default"] .kbn-card-actor')?.hidden).toBe(true)
    expect(root.querySelector<HTMLElement>('[data-fiber-id="fallback-custom"] .kbn-card-actor')?.textContent).toBe('claude-fable')
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
      expect(document.querySelector<HTMLElement>('[data-fiber-id="alpha-card"] .kbn-card-actor')?.hidden).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-fiber-id="beta-card"] .kbn-card-actor')?.textContent).toBe('claude-fable')
    })
    const urls = fetcher.mock.calls.map(([input]) => new URL(String(input), window.location.href))
    expect(urls.map((url) => url.pathname + url.search).sort()).toEqual([
      '/api/v1/agents?origin=alpha',
      '/api/v1/agents?origin=beta',
    ])
  })
})
