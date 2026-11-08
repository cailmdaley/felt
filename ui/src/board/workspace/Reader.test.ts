// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { Reader, type ReaderOptions } from './Reader.js'
import { ChannelThemes } from './ChannelThemes.js'
import { buildChannel, type Channel, type DocKey } from './documents.js'

const alpha = card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a' })
// Beta draws a base of its own, so the sheet it holds is released with its last binding.
const beta = card({ id: 'work/beta', uid: 'beta', name: 'Beta', originId: 'host-b', theme: 'blueprint' })
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

let viewport: { phone: boolean }
let storage: Map<string, string>
let reduced: boolean
const scrollCurrent = vi.fn()
let readers: Reader[]
let frames: FrameRequestCallback[]
let listedCards: KanbanCard[]
const onChannel = vi.fn<(card: KanbanCard) => void>()
const channels = [alpha, beta, gamma]

function makeReader(current: KanbanCard = alpha, themes?: ChannelThemes, workerPill?: (card: KanbanCard) => HTMLElement | null, extra: Partial<ReaderOptions> = {}): Reader {
  const reader = new Reader({
    shuttleBase: '', themes, workerPill,
    buildProse: () => document.createElement('div'),
    onRefreshProse: vi.fn(),
    onSelect: key => reader.select(key),
    onOpenDocument: key => reader.select(key), onRevisitDocument: key => reader.select(key),
    onReturn: vi.fn(),
    onChannel,
    cards: () => channels,
    deskCards: () => listedCards,
    files: card => card === beta ? ['unique-result.pdf'] : [],
    ...extra,
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
  return [...reader.el.querySelectorAll<HTMLElement>('.ws-switcher .ws-channel-name')].map(row => row.textContent ?? '')
}
function press(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  viewport = { phone: false }
  reduced = false
  scrollCurrent.mockClear()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollCurrent })
  storage = new Map()
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
    matches: query === MOBILE_MEDIA ? viewport.phone : query === '(prefers-reduced-motion: reduce)' ? reduced : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  frames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
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

describe('Reader', () => {
  it("draws the card's own worker pill bare at the head's right end; the map rides the centre column", () => {
    const working = { ...beta, workerState: 'running' as const, runtimePhase: 'working', turn: 'working' as const, column: 'inFlight' as const, tmuxSession: 'beta-worker', lastActivityAt: Date.now() - 34 * 60000 }
    listedCards = [working]
    const open = vi.fn()
    const reader = makeReader(working, undefined, () => {
      const pill = document.createElement('button')
      pill.className = 'kbn-card-worker'
      pill.addEventListener('click', open)
      return pill
    })
    const head = reader.el.querySelector<HTMLElement>('.ws-navbar .ws-nav-trail .ws-head-worker')!
    expect(head.hidden).toBe(false)
    expect(head.dataset.part).toBe('act')
    // Document actions stay reachable from the phone's top bar, without a map or count.
    expect(head.parentElement?.lastElementChild?.getAttribute('aria-label')).toBe('Document menu')
    expect(reader.el.querySelector('.ws-head-position')).toBeNull()
    expect(reader.el.querySelector('.ws-navbar [data-part="page-band"]')).toBeNull()
    expect(reader.el.querySelector('.ws-stage-column > [data-part="page-band"]')).toBeNull()
    const control = head.querySelector<HTMLElement>('.ws-worker-control')!
    expect(control.dataset.turn).toBe('working')
    expect(control.querySelector('.ws-worker-dot')).not.toBeNull()
    expect(control.querySelector('.ws-worker-state')?.textContent).toBe('working')
    expect(control.querySelector('.ws-worker-elapsed')?.textContent).toBe('34m')
    control.click()
    expect(open).toHaveBeenCalledOnce()
    // Where the phone shows the dot alone, the dot is the target's own child: a click on it is a click on the target.
    const dot = control.querySelector<HTMLElement>('.ws-worker-dot')!
    expect(dot.parentElement).toBe(control)
    dot.click()
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('binds the reader alone and leaves the phone bar free of chrome plates and verbs', () => {
    const bound = new Map<HTMLElement, KanbanCard>()
    const bind = vi.fn((el: HTMLElement, card: KanbanCard) => bound.set(el, card))
    const unbind = vi.fn((el: HTMLElement) => bound.delete(el))
    const themes = { bind, unbind, isPlain: () => false, togglePlain: vi.fn() } as unknown as ChannelThemes
    const reader = makeReader(beta, themes)
    expect(reader.el.hasAttribute('data-ws-theme-boundary')).toBe(true)
    expect([...bound.keys()]).toEqual([reader.el])
    expect(reader.el.querySelectorAll('[data-part="chrome-plate"]')).toHaveLength(0)
    expect(reader.el.querySelector('[data-part="page-sheet"]')).not.toBeNull()
    expect(reader.el.querySelector('.ws-navbar')?.getAttribute('data-part')).toBe('phone-topbar')
    expect(reader.el.querySelector('.ws-thumbbar')).toBeNull()
    expect(reader.el.querySelector('.ws-navbar .kbn-ctl-temper, .ws-navbar .kbn-ctl-discard')).toBeNull()
    expect(reader.el.querySelector<HTMLElement>('.ws-navbar .ws-head-worker')?.hidden).toBe(true)
    reader.hide()
    expect(bound.size).toBe(0)
    disposeReader(reader)
  })

  it('draws no column beside the stage: no sidebar, toggle, handle or stored preference', () => {
    const reader = makeReader()
    expect(reader.el.querySelector('.ws-sidebar, .ws-sidebar-toggle, .ws-sidebar-handle, aside')).toBeNull()
    expect(reader.el.className).not.toMatch(/ws-with-sidebar|ws-zen/)
    expect([...storage.keys()].filter(key => key.includes('sidebar'))).toEqual([])
    const before = reader.el.innerHTML
    press('[', { metaKey: true })
    expect(reader.el.innerHTML).toBe(before)
  })

  it('puts the theme toggle in the page menu, hidden without a theme', () => {
    let hasTheme = false
    let plain = false
    const themes = {
      bind: vi.fn(), unbind: vi.fn(), hasTheme: () => hasTheme, isPlain: () => plain,
      togglePlain: vi.fn(() => { plain = !plain }),
    } as unknown as ChannelThemes
    const reader = makeReader(alpha, themes)
    expect(reader.el.querySelector('[data-part="plain-toggle"]')).toBeNull()

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

  it('opens the switcher from the title where no board bar Find answers', () => {
    const reader = makeReader()
    reader.el.querySelector<HTMLButtonElement>('.ws-channel-title')!.click()
    const switcher = reader.el.querySelector<HTMLElement>('.ws-switcher')!
    expect(switcher.querySelector('.ws-channel-find')).not.toBeNull()
    expect(switcher.querySelectorAll('.ws-channel-row')).toHaveLength(3)
  })

  it('sends the title and / to the board bar Find on the desktop, and to the switcher on the phone', () => {
    const onFind = vi.fn(() => true)
    const desk = makeReader(alpha, undefined, undefined, { onFind })
    desk.el.querySelector<HTMLButtonElement>('.ws-channel-title')!.click()
    press('/')
    expect(onFind).toHaveBeenCalledTimes(2)
    expect(desk.el.querySelector('.ws-switcher')).toBeNull()
    disposeReader(desk)
    viewport.phone = true
    const phone = makeReader(alpha, undefined, undefined, { onFind })
    phone.el.querySelector<HTMLButtonElement>('.ws-channel-title')!.click()
    expect(onFind).toHaveBeenCalledTimes(2)
    expect(phone.el.querySelector('.ws-switcher')).not.toBeNull()
  })

  it('lists channels in Desk order, marks the current channel, filters, and opens the chosen card', () => {
    const reader = makeReader(beta, undefined, undefined, { pickerCards: () => listedCards })
    reader.el.querySelector<HTMLButtonElement>('.ws-channel-title')!.click()
    const rows = [...reader.el.querySelectorAll<HTMLButtonElement>('.ws-channel-row')]
    expect(rowNames(reader)).toEqual(['Beta', 'Alpha', 'Gamma'])
    expect(rows.map(row => row.getAttribute('aria-current'))).toEqual(['true', 'false', 'false'])

    const find = reader.el.querySelector<HTMLInputElement>('.ws-switcher .ws-channel-find')!
    find.value = 'alpha'
    find.dispatchEvent(new Event('input'))
    expect(rowNames(reader)).toEqual(['Alpha'])
    reader.el.querySelector<HTMLButtonElement>('.ws-channel-row')!.click()
    expect(onChannel).toHaveBeenCalledOnce()
    expect(onChannel).toHaveBeenCalledWith(alpha)
  })

  it('marks owner identity even for equal UIDs and a channel absent from the list', () => {
    const other = { ...alpha, originId: 'host-other', name: 'Other Alpha' }
    const reader = makeReader(alpha, undefined, undefined, { pickerCards: () => [alpha, alpha] })
    reader.show(channel(other), fiberKey(other), 'Board', other)
    reader.el.querySelector<HTMLButtonElement>('.ws-channel-title')!.click()
    const selected = [...reader.el.querySelectorAll<HTMLElement>('.ws-switcher [aria-current="true"]')]
    expect(selected).toHaveLength(1)
    expect(selected[0].dataset.channelOwner).toBe('host-other')
    expect(reader.el.querySelectorAll('.ws-switcher .ws-channel-row')).toHaveLength(2)
  })

  it('steps constitutions in Desk order with j/k, even when the card feed differs', () => {
    makeReader(alpha)
    press('j')
    expect(onChannel).toHaveBeenLastCalledWith(gamma)
    press('k')
    expect(onChannel).toHaveBeenLastCalledWith(beta)
    onChannel.mockClear()
    for (const key of ['J', 'K']) press(key)
    expect(onChannel).not.toHaveBeenCalled()
  })

  it('walks past the open constitution when it stands outside the Desk, from the end of the rows', () => {
    const other = card({ id: 'work/other', uid: 'other', name: 'Other', originId: 'host-a' })
    makeReader(other)
    press('k')
    expect(onChannel).toHaveBeenLastCalledWith(gamma)
  })

  it('says briefly where a step landed: its Desk column and name', () => {
    const stops = new Map([[beta, 'Drafts'], [alpha, 'Drafts'], [gamma, 'In flight']])
    makeReader(alpha, undefined, undefined, { deskStop: row => stops.get(row)! })
    press('j')
    expect(document.querySelector('.shuttle-toast .toast-message')?.textContent).toBe('In flight · Gamma')
    press('k')
    expect(document.querySelector('.shuttle-toast .toast-message')?.textContent).toBe('Drafts · Beta')
    expect(document.querySelectorAll('.shuttle-toast')).toHaveLength(1)
  })

  it('jumps between Desk columns with J/K, landing on the constitution last open in each', () => {
    const delta = card({ id: 'work/delta', uid: 'delta', name: 'Delta', originId: 'host-d' })
    listedCards = [alpha, beta, gamma, delta]
    const stops = new Map([[alpha, 'review'], [beta, 'review'], [gamma, 'flight'], [delta, 'flight']])
    const reader = makeReader(alpha, undefined, undefined, { deskStop: row => stops.get(row)! })
    const jump = (key: string): void => press(key, { shiftKey: true })
    jump('J')
    expect(onChannel).toHaveBeenLastCalledWith(gamma)
    reader.show(channel(delta), fiberKey(delta), 'Board', delta)
    jump('K')
    expect(onChannel).toHaveBeenLastCalledWith(alpha)
    reader.show(channel(beta), fiberKey(beta), 'Board', beta)
    jump('J')
    expect(onChannel).toHaveBeenLastCalledWith(delta)
    onChannel.mockClear()
    jump('K')
    expect(onChannel).not.toHaveBeenCalled()
  })

  it('reads index geometry before writing page widths during layout', () => {
    const reader = makeReader()
    Object.defineProperty(reader.stage, 'clientWidth', { configurable: true, value: 1200 })
    Object.defineProperty(reader.stage, 'clientHeight', { configurable: true, value: 800 })
    const page = reader.track.querySelector<HTMLElement>('.ws-page')!
    const writes = vi.spyOn(page.style, 'width', 'set')
    vi.spyOn(reader.stage.parentElement!, 'getBoundingClientRect').mockImplementation(() => {
      expect(writes).not.toHaveBeenCalled()
      return new DOMRect(0, 0, 1200, 800)
    })
    ;(reader as unknown as { layout(animate: boolean): void }).layout(false)
    expect(writes).toHaveBeenCalledOnce()
  })

  it('leaves activation keys to focused controls while keeping native Reader modality', () => {
    const reader = makeReader()
    const expand = reader.el.querySelector<HTMLButtonElement>('.ws-expand-button')!
    for (const key of ['Enter', ' ']) {
      expand.focus()
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      expand.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(reader.el.classList.contains('ws-expand-mode')).toBe(false)
      expect(reader.el.classList.contains('ws-keyboard')).toBe(true)
    }
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(reader.el.classList.contains('ws-keyboard')).toBe(false)
  })

  it('scrolls the family page with the reader\'s scroll keys', () => {
    const scroller = document.createElement('div')
    scroller.className = 'ws-family-scroll'
    scroller.scrollBy = vi.fn()
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { value: 400 })
    const family: Channel = { ...channel(alpha), documents: [{ key: 'family:host-a:alpha', owner: 'host-a', path: alpha.path, name: 'Family', kind: 'family', provenance: [{ kind: 'family' }] }, ...channel(alpha).documents], labels: ['Family', 'Note'] }
    const page = document.createElement('div'); page.append(scroller)
    const reader = makeReader(alpha, undefined, undefined, { buildProse: doc => doc.kind === 'family' ? page : document.createElement('div') })
    reader.show(family, 'family:host-a:alpha', 'Board', alpha)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }))
    expect(scroller.scrollBy).toHaveBeenCalledOnce()
  })

  describe('sent files', () => {
    const sent = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/notes/alpha.md', fiberDir: '/notes', body: '', sent: [{ path: '/notes/plot.png', time: 1 }] })
    const openSheet = (reader: Reader, open: () => void): void => {
      const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', '') })
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: showModal, configurable: true })
      Object.defineProperty(HTMLDialogElement.prototype, 'close', { value(this: HTMLDialogElement) { this.removeAttribute('open') }, configurable: true })
      try {
        open()
        expect(showModal).toHaveBeenCalledOnce()
        expect(reader.el.querySelector('.ws-page-sheet [data-part="page-sheet-row"]')?.getAttribute('data-key')).toBe('host-a:/notes/plot.png')
        disposeReader(reader)
      } finally { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close') }
    }

    it('gives the phone a top bar toggle only while there are files, and opens the sheet from it', () => {
      viewport.phone = true
      const reader = makeReader()
      const toggle = reader.el.querySelector<HTMLButtonElement>('.ws-navbar .ws-files-toggle')!
      expect(toggle.hidden).toBe(true)
      reader.show(sent, sent.documents[0].key, 'Board', alpha)
      expect(toggle.hidden).toBe(false)
      expect(toggle.closest('.ws-nav-trail')).not.toBeNull()
      openSheet(reader, () => { toggle.click(); expect(toggle.getAttribute('aria-expanded')).toBe('true') })
    })

    it('seats the desktop toggle in the selected page\'s header line, before Expand', () => {
      const reader = makeReader()
      const toggle = reader.el.querySelector<HTMLButtonElement>('.ws-files-toggle')!
      expect(toggle.hidden).toBe(true)
      reader.show(sent, sent.documents[0].key, 'Board', alpha)
      expect(toggle.hidden).toBe(false)
      expect(toggle.parentElement).toBe(reader.host.get(sent.documents[0].key)!.label)
      expect(toggle.nextElementSibling?.classList.contains('ws-expand-button')).toBe(true)
      reader.select(sent.documents[1].key)
      expect(toggle.parentElement).toBe(reader.host.get(sent.documents[1].key)!.label)
      openSheet(reader, () => toggle.click())
    })

    it('marks unread files on the toggle at every width', () => {
      for (const phone of [false, true]) {
        viewport.phone = phone
        const reader = makeReader()
        const toggle = reader.el.querySelector<HTMLButtonElement>('.ws-files-toggle')!
        const fresh = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/notes/alpha.md', fiberDir: '/notes', body: '', sent: [{ path: `/notes/plot-${phone}.png`, time: Date.now() + 60_000 }] })
        reader.show(fresh, fresh.documents[0].key, 'Board', alpha)
        reader.show(buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/notes/alpha.md', fiberDir: '/notes', body: '', previous: fresh, sent: [{ path: `/notes/plot-${phone}.png`, time: Date.now() + 120_000 }] }), fresh.documents[0].key, 'Board', alpha)
        expect(toggle.hasAttribute('data-attention')).toBe(true)
        disposeReader(reader)
      }
    })

    it('opens the sheet from the document menu', () => {
      const reader = makeReader()
      reader.show(sent, sent.documents[0].key, 'Board', alpha)
      reader.el.querySelector<HTMLButtonElement>('.ws-menu-button')!.click()
      openSheet(reader, () => reader.showSentFiles())
    })
  })

  it('keeps all sent attachments available without drawing page chrome', () => {
    const big = buildChannel({
      uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/alpha.md', fiberDir: '/', body: '',
      sent: Array.from({ length: 6 }, (_, i) => ({ path: `/sent-${i}.html`, time: 100 + i })),
    })
    const onReturn = vi.fn()
    const reader = makeReader(alpha, undefined, undefined, { onReturn })
    reader.show(big, big.documents[0].key, 'Board', alpha)
    expect(reader.el.querySelector('.ws-tabs,.ws-thumbbar')).toBeNull()
    const file = big.documents.at(-1)!
    reader.openDocument(file.key)
    expect(reader.document?.key).toBe(file.key)
    reader.el.querySelector<HTMLButtonElement>('.ws-return')!.click()
    expect(onReturn).toHaveBeenCalledOnce()
  })
})
