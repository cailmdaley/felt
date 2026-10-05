// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { Reader, SIDEBAR_MEDIA } from './Reader.js'
import type { Channel, DocKey } from './documents.js'

const alpha = card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a' })
const beta = card({ id: 'work/beta', uid: 'beta', name: 'Beta', originId: 'host-b' })
const gamma = card({ id: 'work/gamma', uid: 'gamma', name: 'Gamma', originId: 'host-c' })
const fiberKey = (card: KanbanCard): DocKey => `fiber:${card.originId}:${card.uid ?? card.id}`
const channel = (card: KanbanCard): Channel => ({
  uid: card.uid ?? card.id,
  owner: card.originId,
  name: card.name,
  documents: [{ key: fiberKey(card), owner: card.originId, path: card.path, name: card.name, kind: 'fiber', provenance: [{ kind: 'fiber' }] }],
  labels: ['Note'],
  body: '',
})

let viewport: { wide: boolean; phone: boolean }
let storage: Map<string, string>
let readers: Reader[]
let listedCards: KanbanCard[]
const onChannel = vi.fn<(card: KanbanCard) => void>()
const channels = [alpha, beta, gamma]

function makeReader(current: KanbanCard = alpha): Reader {
  const reader = new Reader({
    shuttleBase: '',
    buildProse: () => document.createElement('div'),
    onRefreshProse: vi.fn(),
    onSelect: vi.fn(),
    onReturn: vi.fn(),
    onConversation: vi.fn(),
    onChannel,
    cards: () => channels,
    switcherCards: () => listedCards,
  })
  document.body.append(reader.el)
  reader.show(channel(current), fiberKey(current), 'Board', current)
  readers.push(reader)
  return reader
}

function disposeReader(reader: Reader): void {
  reader.dispose()
  readers = readers.filter((candidate) => candidate !== reader)
}

function rowNames(reader: Reader): string[] {
  return [...reader.el.querySelectorAll<HTMLElement>('.ws-channel-row .ws-channel-name')].map((row) => row.textContent ?? '')
}

beforeEach(() => {
  viewport = { wide: false, phone: false }
  storage = new Map()
  readers = []
  listedCards = [beta, alpha, gamma]
  onChannel.mockClear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === SIDEBAR_MEDIA ? viewport.wide : query === MOBILE_MEDIA ? viewport.phone : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  document.body.replaceChildren()
  sessionStorage.clear()
})

afterEach(() => {
  for (const reader of readers) reader.dispose()
  readers = []
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Reader channel sidebar', () => {
  it('defaults closed at wide and narrow widths, with a labelled Channels lead control', () => {
    viewport.wide = true
    const wide = makeReader()
    const wideToggle = wide.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!
    expect(wide.el.classList.contains('ws-with-sidebar')).toBe(false)
    expect(wideToggle.textContent).toBe('▥ Channels')
    expect(wideToggle.title).toBe('Channels (⌘\\)')
    expect(wideToggle.getAttribute('aria-expanded')).toBe('false')
    disposeReader(wide)

    viewport.wide = false
    const narrow = makeReader()
    expect(narrow.el.classList.contains('ws-with-sidebar')).toBe(false)
    expect(narrow.el.querySelector('.ws-sidebar-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('toggles by click and Cmd+\\, persists the choice, and applies stored choices at any desktop width', () => {
    viewport.wide = true
    const reader = makeReader()
    const toggle = reader.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!
    toggle.click()
    expect(reader.el.classList.contains('ws-with-sidebar')).toBe(true)
    expect(storage.get('shuttle:workspace:sidebar')).toBe('true')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true, cancelable: true }))
    expect(reader.el.classList.contains('ws-with-sidebar')).toBe(false)
    expect(storage.get('shuttle:workspace:sidebar')).toBe('false')
    disposeReader(reader)

    storage.set('shuttle:workspace:sidebar', 'false')
    const storedFalse = makeReader()
    expect(storedFalse.el.classList.contains('ws-with-sidebar')).toBe(false)
    disposeReader(storedFalse)

    storage.set('shuttle:workspace:sidebar', 'true')
    viewport.wide = false
    const storedTrue = makeReader()
    expect(storedTrue.el.classList.contains('ws-with-sidebar')).toBe(true)
  })

  it('never shows the sidebar on a phone, even when it is stored open', () => {
    viewport.wide = true
    viewport.phone = true
    storage.set('shuttle:workspace:sidebar', 'true')
    const reader = makeReader()
    expect(reader.el.classList.contains('ws-with-sidebar')).toBe(false)
    expect(reader.el.querySelector('.ws-sidebar-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('focuses the sidebar find from the title when open and opens a switcher when closed', () => {
    viewport.wide = true
    const open = makeReader()
    open.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!.click()
    open.el.querySelector<HTMLButtonElement>('.ws-channel-title')!.click()
    expect(document.activeElement).toBe(open.el.querySelector('.ws-sidebar .ws-channel-find'))
    expect(open.el.querySelector('.ws-switcher')).toBeNull()
    disposeReader(open)

    storage.set('shuttle:workspace:sidebar', 'false')
    viewport.wide = false
    const closed = makeReader()
    closed.el.querySelector<HTMLButtonElement>('.ws-channel-title')!.click()
    const switcher = closed.el.querySelector<HTMLElement>('.ws-switcher')!
    expect(switcher).not.toBeNull()
    expect(switcher.querySelector('.ws-channel-find')).not.toBeNull()
    expect(switcher.querySelectorAll('.ws-channel-row')).toHaveLength(3)
  })

  it('lists channels in overview order, marks the current channel, filters, and opens the chosen card', () => {
    viewport.wide = true
    const reader = makeReader(beta)
    reader.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!.click()
    const rows = [...reader.el.querySelectorAll<HTMLButtonElement>('.ws-channel-row')]
    expect(rowNames(reader)).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual(['true', 'false', 'false'])

    const find = reader.el.querySelector<HTMLInputElement>('.ws-sidebar .ws-channel-find')!
    find.value = 'alpha'
    find.dispatchEvent(new Event('input'))
    expect(rowNames(reader)).toEqual(['Alpha'])
    reader.el.querySelector<HTMLButtonElement>('.ws-channel-row')!.click()
    expect(onChannel).toHaveBeenCalledOnce()
    expect(onChannel).toHaveBeenCalledWith(alpha)
  })

  it('refreshes sidebar rows without clearing the find text', () => {
    viewport.wide = true
    const reader = makeReader()
    reader.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!.click()
    const find = reader.el.querySelector<HTMLInputElement>('.ws-sidebar .ws-channel-find')!
    find.value = 'a'
    find.dispatchEvent(new Event('input'))
    expect(rowNames(reader)).toEqual(['Beta', 'Alpha', 'Gamma'])

    listedCards = [gamma, alpha]
    reader.refreshChannels()
    expect(find.value).toBe('a')
    expect(rowNames(reader)).toEqual(['Gamma', 'Alpha'])
  })

  it('switches focus-ring modality from keyboard to pointer input', () => {
    const reader = makeReader()
    expect(reader.el.classList.contains('ws-keyboard')).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    expect(reader.el.classList.contains('ws-keyboard')).toBe(true)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(reader.el.classList.contains('ws-keyboard')).toBe(false)
  })
})
