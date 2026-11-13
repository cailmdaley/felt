// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { checkPattern } from '@ui-sdk/core/testing'
import type { KanbanCard } from './KanbanTypes'
import { Dock } from './workspace/Dock'
import { conversationOpening, openDestination, saveConversationOpening, type WorkerOpener } from './conversationOpening'
import { attachConversationPicker, openActionMenu } from './conversationMenu'
import { card } from './testFixtures'

const web = 'https://claude.ai/code/session_test'
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) })
})
afterEach(async () => {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const bandConsole = (current: KanbanCard, openWorker?: WorkerOpener): HTMLAnchorElement => {
  const dock = new Dock('', vi.fn(), undefined, openWorker)
  dock.open(current)
  document.body.append(dock.el)
  return dock.el.querySelector<HTMLAnchorElement>('.ws-acts-console')!
}
const buildConsole = (openWorker = vi.fn(), sessionLink: string | undefined = web): HTMLAnchorElement =>
  bandConsole(card({ id: 'test', status: 'active', workerState: 'running', tmuxSession: 'worker', shuttleHost: 'remote', sessionLink }), openWorker)
const rightClick = async (anchor: HTMLElement): Promise<void> => {
  anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await settle()
}
const key = async (value: string, shiftKey = false): Promise<void> => {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }))
  await settle()
}
const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]

it('right-click offers all destinations without activating the default and marks the remembered choice', async () => {
  saveConversationOpening('app')
  const attach = vi.fn()
  await rightClick(buildConsole(attach))
  expect(attach).not.toHaveBeenCalled()
  expect(items()).toHaveLength(3)
  expect(items().map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
  expect(document.activeElement).toBe(items()[2])
  const browser = items()[1] as HTMLAnchorElement
  expect(browser.href).toBe(web)
  expect(browser.rel).toBe('noopener noreferrer')
  items()[0].click()
  await settle()
  expect(conversationOpening()).toBe('terminal')
  expect(attach).toHaveBeenCalledWith('worker', 'remote', undefined)
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('supports arrows, Home, End, typeahead and Escape without closing the surrounding card', async () => {
  const cardEscape = vi.fn()
  document.addEventListener('keydown', cardEscape)
  const opener = buildConsole()
  await rightClick(opener)
  const entries = items()
  expect(document.activeElement).toBe(entries[0])
  await key('ArrowUp')
  expect(document.activeElement).toBe(entries[2])
  await key('Home')
  expect(document.activeElement).toBe(entries[0])
  await key('End')
  expect(document.activeElement).toBe(entries[2])
  await key('Escape')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(opener.getAttribute('aria-expanded')).toBe('false')
  expect(cardEscape).not.toHaveBeenCalled()
  document.removeEventListener('keydown', cardEscape)
  openActionMenu(opener, [{ label: 'Alpha' }, { label: 'Beta' }], 'Actions')
  await settle()
  await key('b')
  expect(document.activeElement?.textContent).toBe('Beta')
})

it.each(['ContextMenu', 'F10'])('opens from the %s key', async value => {
  const opener = buildConsole()
  opener.focus()
  await key(value, value === 'F10')
  expect(items()).toHaveLength(3)
  await key('Escape')
  expect(document.activeElement).toBe(opener)
})

it('keeps selection out of card click-away handling and dismisses on an outside pointer press', async () => {
  const cardClickAway = vi.fn()
  document.addEventListener('pointerdown', cardClickAway)
  await rightClick(buildConsole())
  items()[0].dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(cardClickAway).not.toHaveBeenCalled()
  document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(cardClickAway).toHaveBeenCalledOnce()
  document.removeEventListener('pointerdown', cardClickAway)
})

it('opens a single destination without changing the preference', async () => {
  saveConversationOpening('app')
  const attach = vi.fn(() => expect(conversationOpening()).toBe('app'))
  const opener = bandConsole(card({ id: 'test', status: 'active', workerState: 'running', tmuxSession: 'worker' }), attach)
  await rightClick(opener)
  expect(items()).toHaveLength(1)
  expect(items()[0].getAttribute('aria-checked')).toBe('true')
  items()[0].click()
  await settle()
  expect(attach).toHaveBeenCalledOnce()
})

it.each(['terminal', 'browser', 'app'] as const)('choosing sole destination %s leaves the stored preference unchanged', async id => {
  saveConversationOpening(id === 'browser' ? 'app' : 'browser')
  const remembered = conversationOpening()
  const save = vi.spyOn(localStorage, 'setItem')
  const open = vi.fn()
  const anchor = document.createElement('button'); document.body.append(anchor)
  const detach = attachConversationPicker(anchor, () => [{ id, label: id, run: open }])
  await rightClick(anchor)
  items()[0].click()
  await settle()
  expect(open).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
  expect(conversationOpening()).toBe(remembered)
  detach()
})

it('long-press owns the touch gesture and swallows its follow-up click, not the next tap', async () => {
  vi.useFakeTimers()
  const attach = vi.fn()
  const opener = buildConsole(attach)
  const parent = document.createElement('div')
  document.body.append(parent); parent.append(opener)
  const parentPress = vi.fn()
  parent.addEventListener('pointerdown', parentPress)
  const down = new Event('pointerdown', { bubbles: true })
  Object.assign(down, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 20, clientY: 20 })
  opener.dispatchEvent(down)
  await vi.advanceTimersByTimeAsync(600)
  expect(items()).toHaveLength(3)
  expect(parentPress).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('pointerup'))
  opener.click()
  expect(attach).not.toHaveBeenCalled()
  items()[0].click()
  await settle()
  expect(attach).toHaveBeenCalledOnce()
})

it('Android’s contextmenu after a fired long-press keeps one picker open', async () => {
  vi.useFakeTimers()
  const opener = buildConsole()
  const down = new Event('pointerdown', { bubbles: true })
  Object.assign(down, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 20, clientY: 20 })
  opener.dispatchEvent(down)
  await vi.advanceTimersByTimeAsync(600)
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  const late = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 })
  opener.dispatchEvent(late)
  await settle()
  expect(late.defaultPrevented).toBe(true)
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
  expect(document.querySelector('[role="menu"]')).toBe(menu)
})

it('a picker anchor refuses the platform link callout and announces no popup, since activating it opens', () => {
  saveConversationOpening('browser')
  const opener = buildConsole()
  expect(opener.tagName).toBe('A')
  expect(opener.classList.contains('kbn-picker-anchor')).toBe(true)
  expect(opener.hasAttribute('aria-haspopup')).toBe(false)
})

it.each([[false, '_blank'], [true, '']])('web destinations open in a new tab only on desktop (phone: %s)', async (phone, target) => {
  saveConversationOpening('browser')
  vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }))
  const opener = buildConsole(undefined)
  expect(opener.href).toBe(web)
  expect(opener.target).toBe(target)
  await rightClick(opener)
  const link = items().find(item => item instanceof HTMLAnchorElement && item.href === web) as HTMLAnchorElement
  expect(link.target).toBe(target)
  const clicked: HTMLAnchorElement[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
  openDestination({ id: 'browser', label: 'Claude browser', href: web })
  expect(clicked.at(-1)?.target).toBe(target)
})

it('satisfies the SDK menu pattern and keeps disabled actions discoverable but inert', async () => {
  const anchor = document.createElement('button'); document.body.append(anchor)
  const run = vi.fn()
  openActionMenu(anchor, [{ label: 'Alpha', run }, { label: 'Beta', disabled: true, run }], 'Actions')
  await settle()
  await checkPattern(document.querySelector('[role="menu"]')!, 'menu')
  openActionMenu(anchor, [{ label: 'Alpha', run }, { label: 'Beta', disabled: true, run }], 'Actions')
  await settle()
  await key('End')
  expect(document.activeElement?.getAttribute('aria-disabled')).toBe('true')
  await key('Enter')
  expect(run).not.toHaveBeenCalled()
})
