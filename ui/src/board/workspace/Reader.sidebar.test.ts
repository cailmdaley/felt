// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { Reader, SIDEBAR_MEDIA } from './Reader.js'
import { ChannelThemes } from './ChannelThemes.js'
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
let reduced: boolean
const scrollCurrent = vi.fn()
let readers: Reader[]
let listedCards: KanbanCard[]
const onChannel = vi.fn<(card: KanbanCard) => void>()
const channels = [alpha, beta, gamma]

function makeReader(current: KanbanCard = alpha, themes?: ChannelThemes, workerPill?: (card: KanbanCard) => HTMLElement | null): Reader {
  const reader = new Reader({
    shuttleBase: '', themes, workerPill,
    buildProse: () => document.createElement('div'),
    onRefreshProse: vi.fn(),
    onSelect: vi.fn(),
    onReturn: vi.fn(),
    onChannel,
    cards: () => channels,
    switcherCards: () => listedCards,
    files: card => card === beta ? ['unique-result.pdf'] : [],
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
  const list = reader.el.querySelector('.ws-switcher') ?? reader.el.querySelector('.ws-sidebar')!
  return [...list.querySelectorAll<HTMLElement>('.ws-channel-row .ws-channel-name')].map((row) => row.textContent ?? '')
}

beforeEach(() => {
  viewport = { wide: false, phone: false }
  reduced = false
  scrollCurrent.mockClear()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollCurrent })
  storage = new Map([['shuttle:workspace:sidebar', 'false']])
  readers = []
  listedCards = [beta, alpha, gamma]
  onChannel.mockReset()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === SIDEBAR_MEDIA ? viewport.wide : query === MOBILE_MEDIA ? viewport.phone : query === '(prefers-reduced-motion: reduce)' ? reduced : false,
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
  it('gives a sidebar worker separate state and elapsed text without replacing its conversation target', () => {
    storage.set('shuttle:workspace:sidebar', 'true')
    const working = { ...beta, workerState: 'running' as const, runtimePhase: 'working', tmuxSession: 'beta-worker', workerStartedAt: Date.now() - 60000 }
    listedCards = [working]
    const target = document.createElement('button'), open = vi.fn()
    target.addEventListener('click', open)
    const reader = makeReader(working, undefined, () => target)
    expect(reader.el.querySelector('.ws-sidebar .ws-worker-control')).toBe(target)
    expect(target.querySelector('.ws-worker-state')?.textContent).toBe('aloft')
    expect(target.querySelector('.ws-worker-elapsed')?.textContent).toBe('1 m')
    expect(target.dataset.part).toBe('act')
    target.click()
    expect(open).toHaveBeenCalledOnce()
  })
  it('binds retained sidebar roots only while active and visible, through revisions, filtering and hide/show', () => {
    storage.set('shuttle:workspace:sidebar', 'true')
    const bound = new Map<HTMLElement, KanbanCard>()
    const bind = vi.fn((el: HTMLElement, card: KanbanCard) => bound.set(el, card))
    const unbind = vi.fn((el: HTMLElement) => bound.delete(el))
    const themes = { bind, unbind, isPlain: () => false, togglePlain: vi.fn() } as unknown as ChannelThemes
    const reader = makeReader(alpha, themes)
    const row = reader.el.querySelector<HTMLElement>('.ws-sidebar [data-channel-uid="alpha"]')!
    expect(bound.get(row)).toBe(alpha)
    expect(row.dataset.part).toBe('sidebar-card')
    expect(row.hasAttribute('data-ws-theme-boundary')).toBe(true)
    expect(reader.el.hasAttribute('data-ws-theme-boundary')).toBe(true)
    expect(reader.el.querySelectorAll('[data-part="chrome-plate"]')).toHaveLength(2)
    for (const part of ['tab-strip', 'tab', 'thumbnail', 'thumbnail-face', 'page-sheet', 'page-sheet-panel']) {
      expect(reader.el.querySelector(`[data-part="${part}"]`)).not.toBeNull()
    }
    expect(reader.el.querySelector('.ws-navbar')?.getAttribute('data-part')).toBe('phone-topbar')
    expect(reader.el.querySelector('.ws-thumbbar')?.getAttribute('data-part')).toBe('phone-bottom-bar')
    expect(reader.el.querySelector('.ws-nav-verdicts')?.getAttribute('data-act')).toBe('verdict')
    expect(reader.el.querySelector('.ws-navbar .ws-worker-pill, .ws-navbar .kbn-card-worker')).toBeNull()
    const revised = { ...alpha, outcome: 'A new result' }
    listedCards = [revised, beta]
    reader.refreshChannels()
    expect(reader.el.querySelector('.ws-sidebar [data-channel-uid="alpha"]')).toBe(row)
    expect(bound.get(row)).toBe(revised)
    expect([...bound.keys()]).toEqual(expect.arrayContaining([reader.el, row]))
    const toggle = reader.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!
    toggle.click()
    expect(bound.size).toBe(1)
    toggle.click()
    expect(bound.get(row)).toBe(revised)
    const find = reader.el.querySelector<HTMLInputElement>('.ws-sidebar input')!
    find.value = 'Beta'; find.dispatchEvent(new Event('input'))
    expect(bound.has(row)).toBe(false)
    reader.hide()
    expect(bound.size).toBe(0)
    reader.show(channel(beta), fiberKey(beta), 'Board', beta)
    expect(bound.size).toBe(2)
    disposeReader(reader)
    expect(bound.size).toBe(0)
  })

  it('keeps a foreign sidebar flight themed after its retained row unbinds, then releases the stylesheet', async () => {
    const animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
    const animationsDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getAnimations')
    const animations = new Map<HTMLElement, { animation: Animation; finish(): void }>()
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: function (this: HTMLElement) {
      let finish!: () => void
      const finished = new Promise<void>(resolve => { finish = resolve })
      const animation = { finished, cancel: finish } as unknown as Animation
      animations.set(this, { animation, finish }); return animation
    } })
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: function (this: HTMLElement) {
      return animations.has(this) ? [animations.get(this)!.animation] : []
    } })
    const themes = new ChannelThemes('')
    try {
      const reader = makeReader(alpha, themes)
      const source = document.createElement('div'); document.body.append(source)
      const rect = (): DOMRect => new DOMRect(10, 20, 280, 120)
      source.getBoundingClientRect = rect
      reader.el.querySelector<HTMLElement>('.ws-sidebar [data-channel-uid="beta"]')!.getBoundingClientRect = rect
      reader.captureSidebar([{ card: beta, source }])
      // The arrival flight (a toggle slides the column instead of flying cards).
      const flight = reader as unknown as { setSidebarVisible(visible: boolean, animate?: boolean): void }
      flight.setSidebarVisible(false, false)
      flight.setSidebarVisible(true)
      const ghost = reader.el.querySelector<HTMLElement>('.ws-sidebar-flight [data-channel-uid="beta"]')!
      const scope = ghost.dataset.wsTheme
      expect(scope).toBeTruthy()
      const row = reader.el.querySelector<HTMLElement>('.ws-sidebar:not(.ws-sidebar-flight) [data-channel-uid="beta"]')!
      expect(row.dataset.wsTheme).toBeUndefined()
      expect(document.querySelector(`style[data-ws-theme-sheet="${scope}"]`)).not.toBeNull()
      animations.get(ghost)!.finish()
      for (let i = 0; i < 5; i++) await Promise.resolve()
      expect(ghost.isConnected).toBe(false)
      expect(document.querySelector(`style[data-ws-theme-sheet="${scope}"]`)).toBeNull()
      disposeReader(reader)
    } finally {
      themes.dispose()
      if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
      if (animationsDescriptor) Object.defineProperty(HTMLElement.prototype, 'getAnimations', animationsDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'getAnimations')
    }
  })

  it('defaults open at wide widths and closed at narrow widths, with a labelled Constitutions lead control', () => {
    storage.clear()
    viewport.wide = true
    const wide = makeReader()
    const wideToggle = wide.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!
    expect(wide.el.classList.contains('ws-with-sidebar')).toBe(true)
    expect(wideToggle.textContent).toBe('▥ Constitutions')
    expect(wideToggle.title).toBe('Constitutions (⌘\\)')
    expect(wideToggle.getAttribute('aria-expanded')).toBe('true')
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

  it('toggles with c as well as the command alias', () => {
    const reader = makeReader()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }))
    expect(reader.el.classList.contains('ws-with-sidebar')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true, cancelable: true }))
    expect(reader.el.classList.contains('ws-with-sidebar')).toBe(false)
  })

  it.each([false, true])('Find focuses the %s sidebar mode, opens the first file match and restores focus on Escape', sidebar => {
    storage.set('shuttle:workspace:sidebar', String(sidebar))
    const reader = makeReader()
    const previous = reader.el.querySelector<HTMLButtonElement>('.ws-return')!
    previous.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    const find = reader.el.querySelector<HTMLInputElement>(sidebar ? '.ws-sidebar input' : '.ws-switcher input')!
    expect(document.activeElement).toBe(find)
    find.value = 'unique-result.pdf'
    find.dispatchEvent(new Event('input'))
    expect(rowNames(reader)).toEqual(['Beta'])
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(previous)
    expect(reader.el.querySelector('.ws-switcher')).toBeNull()
    expect(reader.el.classList.contains('ws-with-sidebar')).toBe(sidebar)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
    const again = reader.el.querySelector<HTMLInputElement>(sidebar ? '.ws-sidebar input' : '.ws-switcher input')!
    again.value = 'unique-result.pdf'; again.dispatchEvent(new Event('input'))
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onChannel).toHaveBeenLastCalledWith(beta)
  })

  it('never shows the sidebar on a phone, even when it is stored open', () => {
    viewport.wide = true
    viewport.phone = true
    storage.set('shuttle:workspace:sidebar', 'true')
    const reader = makeReader()
    expect(reader.el.classList.contains('ws-with-sidebar')).toBe(false)
    expect(reader.el.querySelector('.ws-sidebar-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('puts the theme toggle in the page menu, reachable with the sidebar open and hidden without a theme', () => {
    let hasTheme = false
    let plain = false
    const themes = {
      bind: vi.fn(), unbind: vi.fn(), hasTheme: () => hasTheme, isPlain: () => plain,
      togglePlain: vi.fn(() => { plain = !plain }),
    } as unknown as ChannelThemes
    const reader = makeReader(alpha, themes)
    reader.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!.click()
    expect(reader.el.querySelector('.ws-sidebar [data-part="plain-toggle"]')).toBeNull()
    expect(reader.el.querySelector('.ws-switcher [data-part="plain-toggle"]')).toBeNull()

    reader.el.querySelector<HTMLButtonElement>('.ws-menu-button')!.click()
    const toggle = reader.el.querySelector<HTMLButtonElement>('.ws-menu [data-part="plain-toggle"]')!
    expect(toggle.textContent).toBe("Plain (drop this constitution's theme)")
    expect(toggle.hidden).toBe(true)
    hasTheme = true
    reader.el.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
    expect(toggle.hidden).toBe(false)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    toggle.click()
    expect(themes.togglePlain).toHaveBeenCalledWith(alpha)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    hasTheme = false
    reader.el.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
    expect(toggle.hidden).toBe(false)
    toggle.click()
    reader.el.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
    expect(toggle.hidden).toBe(true)
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

  it.each([false, true])('marks exactly one owner+UID row through repeated constitution steps (reduced motion %s)', reduce => {
    reduced = reduce
    storage.set('shuttle:workspace:sidebar', 'true')
    const reader = makeReader(alpha)
    onChannel.mockImplementation(next => reader.show(channel(next), fiberKey(next), 'Board', next))
    const find = reader.el.querySelector<HTMLInputElement>('.ws-sidebar input')!
    find.value = 'Alpha'; find.dispatchEvent(new Event('input'))
    scrollCurrent.mockClear()
    const steps: Array<[string, boolean, KanbanCard]> = [['j', false, gamma], ['k', false, alpha], ['k', false, beta], ['ArrowDown', true, alpha], ['ArrowDown', true, gamma], ['ArrowUp', true, alpha]]
    for (const [key, altKey, expected] of steps) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }))
      const rows = [...reader.el.querySelectorAll<HTMLElement>('.ws-sidebar [aria-current="true"]')]
      expect(rows).toHaveLength(1)
      expect(rows[0].dataset.channelUid).toBe(expected.uid)
      expect(rows[0].dataset.channelOwner).toBe(expected.originId)
      expect(reader.el.querySelector('.ws-channel-title')?.textContent).toBe(expected.name)
      expect(scrollCurrent).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'instant' : 'smooth' })
    }
    expect(find.value).toBe('')
    expect(scrollCurrent).toHaveBeenCalledTimes(steps.length)
    find.focus(); find.value = 'a'; find.dispatchEvent(new Event('input'))
    const row = reader.el.querySelector('.ws-sidebar [aria-current="true"]')
    scrollCurrent.mockClear()
    reader.show(channel(alpha), fiberKey(alpha), 'Board', { ...alpha, outcome: 'Polling metadata' })
    reader.refreshChannels()
    expect(document.activeElement).toBe(find)
    expect(find.value).toBe('a')
    expect(reader.el.querySelector('.ws-sidebar [aria-current="true"]')).toBe(row)
    expect(scrollCurrent).not.toHaveBeenCalled()
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onChannel).toHaveBeenLastCalledWith(beta)
    onChannel.mockReset()
  })

  it('marks owner identity even for equal UIDs and a channel absent from the overview list', () => {
    storage.set('shuttle:workspace:sidebar', 'true')
    const other = { ...alpha, originId: 'host-other', name: 'Other Alpha' }
    listedCards = [alpha, alpha]
    const reader = makeReader(alpha)
    reader.show(channel(other), fiberKey(other), 'Board', other)
    const selected = [...reader.el.querySelectorAll<HTMLElement>('.ws-sidebar [aria-current="true"]')]
    expect(selected).toHaveLength(1)
    expect(selected[0].dataset.channelOwner).toBe('host-other')
    expect(reader.el.querySelectorAll('.ws-sidebar .ws-channel-row')).toHaveLength(2)
  })

  it('steps constitutions in sidebar order with j/k, even when the card feed differs', () => {
    makeReader(alpha)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))
    expect(onChannel).toHaveBeenLastCalledWith(gamma)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }))
    expect(onChannel).toHaveBeenLastCalledWith(beta)
    onChannel.mockClear()
    for (const key of ['J', 'K']) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    expect(onChannel).not.toHaveBeenCalled()
  })

  it('keeps the selected tab visible when opening the sidebar changes layout', () => {
    const reader = makeReader()
    const base = channel(alpha)
    const documents = Array.from({ length: 4 }, (_, index) => ({
      ...base.documents[0], key: `fiber:host-a:alpha-${index}`, name: `Page ${index + 1}`,
    }))
    const pages: Channel = { ...base, documents, labels: documents.map(doc => doc.name) }
    reader.show(pages, documents[3].key, 'Desk', alpha)
    const strip = reader.el.querySelector<HTMLElement>('.ws-tabs')!
    const selected = reader.el.querySelector<HTMLButtonElement>('.ws-tab[aria-selected="true"]')!
    Object.defineProperty(strip, 'clientWidth', {
      configurable: true, get: () => reader.el.classList.contains('ws-with-sidebar') ? 100 : 120,
    })
    Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 500 })
    Object.defineProperty(selected, 'offsetLeft', { configurable: true, value: 310 })
    Object.defineProperty(selected, 'offsetWidth', { configurable: true, value: 80 })
    window.dispatchEvent(new Event('resize'))
    expect(strip.scrollLeft).toBe(290)
    reader.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!.click()
    expect(strip.scrollLeft).toBe(300)
    expect(strip.scrollLeft).toBeLessThanOrEqual(310)
    expect(strip.scrollLeft + strip.clientWidth).toBeGreaterThanOrEqual(390)
  })

  it('leaves activation keys to focused controls while keeping native Reader modality', () => {
    const reader = makeReader()
    const toggle = reader.el.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!
    for (const key of ['Enter', ' ']) {
      toggle.focus()
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      toggle.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(reader.el.classList.contains('ws-with-sidebar')).toBe(false)
      expect(reader.el.classList.contains('ws-keyboard')).toBe(true)
    }
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(reader.el.classList.contains('ws-keyboard')).toBe(false)
  })

  it('shares arrow navigation with TabStrip without double-stepping focus or selection', () => {
    const reader = makeReader()
    const base = channel(alpha)
    const first = base.documents[0]
    const second = { ...first, key: 'fiber:host-a:second', name: 'Second' }
    const pages: Channel = { ...base, documents: [first, second], labels: ['Note', 'Second'] }
    reader.show(pages, first.key, 'Desk', alpha)
    const tabs = [...reader.el.querySelectorAll<HTMLButtonElement>('.ws-tab')]
    expect(tabs).toHaveLength(2)
    tabs[0].focus()

    const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    tabs[0].dispatchEvent(right)
    expect(right.defaultPrevented).toBe(true)
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])
    expect(reader.el.classList.contains('ws-keyboard')).toBe(true)

    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    tabs[1].dispatchEvent(left)
    expect(left.defaultPrevented).toBe(true)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[0])
  })
})
