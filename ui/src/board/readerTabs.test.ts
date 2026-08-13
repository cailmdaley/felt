/**
 * ReaderTabs — the tab-set rules both readers on the board obey.
 *
 * These are the invariants a tabbed viewer is judged on: a file opened twice
 * is one tab, the strip never reorders itself under a click, and closing what
 * you were reading leaves you next to it rather than back at the start.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  activateTab,
  closeTab,
  coerceTabRefs,
  emptyTabState,
  findTab,
  openTab,
  type TabState,
} from './ReaderTabs.js'

interface Tab {
  path: string
}

function opened(...paths: string[]): TabState<Tab> {
  let state = emptyTabState<Tab>()
  for (const path of paths) state = openTab(state, path, () => ({ path })).state
  return state
}

describe('openTab', () => {
  it('appends a new tab and makes it active', () => {
    const { state, created } = openTab(emptyTabState<Tab>(), '/a', () => ({ path: '/a' }))
    expect(created).toBe(true)
    expect(state.tabs.map((t) => t.path)).toEqual(['/a'])
    expect(state.active).toBe('/a')
  })

  it('never opens the same file twice — it activates the tab that exists', () => {
    const first = opened('/a', '/b')
    const make = vi.fn(() => ({ path: '/a' }))
    const { state, entry, created } = openTab(first, '/a', make)
    expect(make).not.toHaveBeenCalled()
    expect(created).toBe(false)
    expect(entry).toBe(first.tabs[0]) // the SAME entry, DOM and all
    expect(state.tabs.map((t) => t.path)).toEqual(['/a', '/b'])
    expect(state.active).toBe('/a')
  })

  it('keeps open-order when a tab is re-activated — the strip does not resort', () => {
    let state = opened('/a', '/b', '/c')
    state = openTab(state, '/a', () => ({ path: '/a' })).state
    state = activateTab(state, '/c')
    expect(state.tabs.map((t) => t.path)).toEqual(['/a', '/b', '/c'])
    expect(state.active).toBe('/c')
  })
})

describe('activateTab', () => {
  it('leaves the set alone for a path that is not open', () => {
    const state = opened('/a')
    expect(activateTab(state, '/ghost')).toBe(state)
    expect(findTab(state, '/ghost')).toBeNull()
  })
})

describe('closeTab', () => {
  it('falls to the neighbour that slid into place', () => {
    const state = activateTab(opened('/a', '/b', '/c'), '/b')
    const { state: after, closed } = closeTab(state, '/b')
    expect(closed?.path).toBe('/b')
    expect(after.tabs.map((t) => t.path)).toEqual(['/a', '/c'])
    expect(after.active).toBe('/c')
  })

  it('falls backwards when the last tab closes', () => {
    const { state } = closeTab(opened('/a', '/b', '/c'), '/c')
    expect(state.active).toBe('/b')
  })

  it('leaves the active tab alone when a background tab closes', () => {
    const state = activateTab(opened('/a', '/b', '/c'), '/a')
    const { state: after } = closeTab(state, '/c')
    expect(after.active).toBe('/a')
  })

  it('empties to nothing active', () => {
    const { state } = closeTab(opened('/a'), '/a')
    expect(state.tabs).toEqual([])
    expect(state.active).toBeNull()
  })

  it('shrugs at a path that is not open', () => {
    const before = opened('/a')
    const { state, closed } = closeTab(before, '/ghost')
    expect(closed).toBeNull()
    expect(state).toBe(before)
  })
})

describe('coerceTabRefs', () => {
  it('reads a stored strip, field by field', () => {
    expect(
      coerceTabRefs([
        { path: '/a', basename: 'a.html', host: 'farhost', scroll: 120, zoom: 1.5 },
        { path: '/b' },
      ]),
    ).toEqual([
      { path: '/a', basename: 'a.html', host: 'farhost', scroll: 120, zoom: 1.5 },
      { path: '/b' },
    ])
  })

  it('drops pathless, malformed and non-array records', () => {
    expect(coerceTabRefs([{ basename: 'ghost' }, null, 7, { path: '' }])).toEqual([])
    expect(coerceTabRefs('nonsense')).toEqual([])
    expect(coerceTabRefs(undefined)).toEqual([])
  })

  it('drops junk fields rather than rehydrating them', () => {
    expect(coerceTabRefs([{ path: '/a', scroll: 'down', zoom: -3, host: 5 }])).toEqual([
      { path: '/a' },
    ])
  })

  it('never rehydrates a duplicate — a doubled store is not two tabs', () => {
    expect(coerceTabRefs([{ path: '/a' }, { path: '/a', scroll: 9 }])).toEqual([{ path: '/a' }])
  })
})
