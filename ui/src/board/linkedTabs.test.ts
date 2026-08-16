// Where a followed [[wikilink]] lands. The panel that holds the tabs is DOM;
// the rules for which tab it should be showing are not, and they live in
// linkedTabs.ts so they can be checked without a browser.

import { describe, expect, it } from 'vitest'
import { emptyTabState, type TabState } from './ReaderTabs.js'
import { closeLinkedTab, focusTab, insertTab, routeWikilink } from './linkedTabs.js'

interface Tab {
  path: string
}

const state = (ids: string[], active: string | null): TabState<Tab> => ({
  tabs: ids.map((path) => ({ path })),
  active,
})
const ids = (s: TabState<Tab>): string[] => s.tabs.map((t) => t.path)

describe('routing a wikilink click', () => {
  it('sends a link to the origin fiber back to the origin card', () => {
    // The card next door is already showing it — a tab of it would be a
    // duplicate of the page the reader is reading from.
    const s = state(['b'], 'b')
    expect(routeWikilink(s, 'a', 'a')).toBe('origin')
  })

  it('focuses an already-open fiber instead of fetching it again', () => {
    const s = state(['b', 'c'], 'c')
    expect(routeWikilink(s, 'a', 'b')).toBe('focus')
  })

  it('loads anything not already on screen', () => {
    expect(routeWikilink(state(['b'], 'b'), 'a', 'c')).toBe('load')
    // No origin fiber known → a self-reference is just another fiber.
    expect(routeWikilink(emptyTabState<Tab>(), null, 'a')).toBe('load')
  })
})

describe('focusing a tab', () => {
  it('shows it without reordering the strip', () => {
    const s = focusTab(state(['b', 'c', 'd'], 'd'), 'b')
    expect(s.active).toBe('b')
    expect(ids(s)).toEqual(['b', 'c', 'd'])
  })
})

describe('inserting a loaded fiber', () => {
  it('appends in open-order and shows it', () => {
    const { state: s, kept } = insertTab(state(['b'], 'b'), { path: 'c' })
    expect(kept).toBe(true)
    expect(ids(s)).toEqual(['b', 'c'])
    expect(s.active).toBe('c')
  })

  it('never opens a second tab for a fiber whose fetch raced another click', () => {
    // Two clicks on one reference, both routed `load` before either resolved.
    const first = insertTab(emptyTabState<Tab>(), { path: 'c' })
    const second = insertTab(first.state, { path: 'c' })
    expect(second.kept).toBe(false)
    expect(ids(second.state)).toEqual(['c'])
    expect(second.state.active).toBe('c')
  })
})

describe('closing a tab', () => {
  it('falls to the neighbour that slid into its place', () => {
    const { state: s, empty } = closeLinkedTab(state(['b', 'c', 'd'], 'c'), 'c')
    expect(ids(s)).toEqual(['b', 'd'])
    expect(s.active).toBe('d')
    expect(empty).toBe(false)
  })

  it('leaves the shown tab alone when a background tab closes', () => {
    const { state: s } = closeLinkedTab(state(['b', 'c', 'd'], 'd'), 'b')
    expect(s.active).toBe('d')
  })

  it('reports empty when the last tab goes — the panel closes with it', () => {
    const { state: s, empty } = closeLinkedTab(state(['b'], 'b'), 'b')
    expect(ids(s)).toEqual([])
    expect(s.active).toBeNull()
    expect(empty).toBe(true)
  })

  it('is a no-op for a fiber that is not open', () => {
    const before = state(['b'], 'b')
    const { state: s, closed, empty } = closeLinkedTab(before, 'z')
    expect(closed).toBeNull()
    expect(empty).toBe(false)
    expect(ids(s)).toEqual(['b'])
  })
})
