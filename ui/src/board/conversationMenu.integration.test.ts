// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { workerPill } from './appConversation'
import { conversationOpening, openDestination, saveConversationOpening } from './conversationOpening'
import { attachConversationPicker } from './conversationMenu'
import { card } from './testFixtures'

const web = 'https://claude.ai/code/session_test'
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) })
})
afterEach(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const buildPill = (openWorker = vi.fn(), sessionLink: string | undefined = web): HTMLElement => {
  const pill = workerPill(card({ id: 'test', tmuxSession: 'worker', shuttleHost: 'remote', sessionLink }), { openWorker })
  document.body.append(pill)
  return pill
}
const rightClick = (pill: HTMLElement): void => { pill.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })) }
const items = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]

it('right-click offers all destinations without activating the default and marks the remembered choice', () => {
  saveConversationOpening('app')
  const attach = vi.fn()
  rightClick(buildPill(attach))
  expect(attach).not.toHaveBeenCalled()
  expect(items()).toHaveLength(3)
  expect(items().map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
  expect(document.activeElement).toBe(items()[2])
  const browser = items()[1] as HTMLAnchorElement
  expect(browser.href).toBe(web)
  expect(browser.rel).toBe('noopener noreferrer')
  items()[0].click()
  expect(conversationOpening()).toBe('terminal')
  expect(attach).toHaveBeenCalledWith('worker', 'remote')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('supports arrow navigation and Escape, restoring focus without closing the surrounding card', () => {
  const cardEscape = vi.fn()
  document.addEventListener('keydown', cardEscape, true)
  const pill = buildPill()
  rightClick(pill)
  const entries = items()
  expect(document.activeElement).toBe(entries[0])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  expect(document.activeElement).toBe(entries[2])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(pill)
  expect(pill.getAttribute('aria-expanded')).toBe('false')
  expect(cardEscape).not.toHaveBeenCalled()
  document.removeEventListener('keydown', cardEscape, true)
})

it('keeps selection out of card click-away handling and dismisses on outside gestures', () => {
  const cardClickAway = vi.fn()
  document.addEventListener('pointerdown', cardClickAway, true)
  rightClick(buildPill())
  items()[0].dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(cardClickAway).not.toHaveBeenCalled()
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(cardClickAway).toHaveBeenCalledOnce()
  document.removeEventListener('pointerdown', cardClickAway, true)
})

it('opens a single destination without changing the preference', () => {
  saveConversationOpening('app')
  const attach = vi.fn(() => expect(conversationOpening()).toBe('app'))
  const pill = workerPill(card({ id: 'test', tmuxSession: 'worker' }), { openWorker: attach })
  document.body.append(pill)
  rightClick(pill)
  expect(items()).toHaveLength(1)
  expect(items()[0].getAttribute('aria-checked')).toBe('true')
  items()[0].click()
  expect(attach).toHaveBeenCalledOnce()
})

it.each(['terminal', 'browser', 'app'] as const)('choosing sole destination %s leaves the stored preference unchanged', id => {
  saveConversationOpening(id === 'browser' ? 'app' : 'browser')
  const remembered = conversationOpening()
  const save = vi.spyOn(localStorage, 'setItem')
  const open = vi.fn()
  const anchor = document.createElement('button'); document.body.append(anchor)
  const detach = attachConversationPicker(anchor, () => [{ id, label: id, run: open }])
  rightClick(anchor)
  items()[0].click()
  expect(open).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
  expect(conversationOpening()).toBe(remembered)
  detach()
})

it('long-press owns the touch gesture and swallows its follow-up click, not the next tap', () => {
  vi.useFakeTimers()
  const attach = vi.fn()
  const pill = buildPill(attach)
  const parent = document.createElement('div')
  document.body.append(parent); parent.append(pill)
  const parentPress = vi.fn()
  parent.addEventListener('pointerdown', parentPress)
  const down = new Event('pointerdown', { bubbles: true })
  Object.assign(down, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 20, clientY: 20 })
  pill.dispatchEvent(down)
  vi.advanceTimersByTime(600)
  expect(items()).toHaveLength(3)
  expect(parentPress).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('pointerup'))
  pill.click()
  expect(attach).not.toHaveBeenCalled()
  items()[0].click()
  expect(attach).toHaveBeenCalledOnce()
})

it('Android’s contextmenu after a fired long-press leaves the picker under its anchor', () => {
  vi.useFakeTimers()
  const pill = buildPill()
  const down = new Event('pointerdown', { bubbles: true })
  Object.assign(down, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 20, clientY: 20 })
  pill.dispatchEvent(down)
  vi.advanceTimersByTime(600)
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  const late = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 400 })
  pill.dispatchEvent(late)
  expect(late.defaultPrevented).toBe(true)
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
  expect(document.querySelector('[role="menu"]')).toBe(menu)
})

it('a picker anchor refuses the platform link callout and announces no popup, since activating it opens', () => {
  saveConversationOpening('browser')
  const pill = buildPill()
  expect(pill.tagName).toBe('A')
  expect(pill.classList.contains('kbn-picker-anchor')).toBe(true)
  expect(pill.hasAttribute('aria-haspopup')).toBe(false)
})

it.each([[false, '_blank'], [true, '']])('web destinations open in a new tab only on desktop (phone: %s)', (phone, target) => {
  saveConversationOpening('browser')
  vi.stubGlobal('matchMedia', () => ({ matches: phone }))
  const pill = buildPill(undefined) as HTMLAnchorElement
  expect(pill.href).toBe(web)
  expect(pill.target).toBe(target)
  rightClick(pill)
  const link = items().find(item => item instanceof HTMLAnchorElement && item.href === web) as HTMLAnchorElement
  expect(link.target).toBe(target)
  const clicked: HTMLAnchorElement[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this) })
  openDestination({ id: 'browser', label: 'Claude browser', href: web })
  expect(clicked.at(-1)?.target).toBe(target)
})
