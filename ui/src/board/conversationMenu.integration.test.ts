// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminalWorkerPill } from './appConversation'
import { conversationOpening, saveConversationOpening } from './conversationOpening'
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
  const pill = terminalWorkerPill(card({ id: 'test', tmuxSession: 'worker', shuttleHost: 'remote', sessionLink }), { openWorker })
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

it('shows a single-destination picker and saves before opening', () => {
  saveConversationOpening('app')
  const attach = vi.fn(() => expect(conversationOpening()).toBe('terminal'))
  const pill = terminalWorkerPill(card({ id: 'test', tmuxSession: 'worker' }), { openWorker: attach })
  document.body.append(pill)
  rightClick(pill)
  expect(items()).toHaveLength(1)
  expect(items()[0].getAttribute('aria-checked')).toBe('true')
  items()[0].click()
  expect(attach).toHaveBeenCalledOnce()
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
