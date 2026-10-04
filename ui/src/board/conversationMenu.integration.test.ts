// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { terminalWorkerPill } from './appConversation'
import { conversationActions } from './conversationMenu'
import { card } from './testFixtures'

const web = 'https://claude.ai/code/session_test'
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  vi.stubGlobal('localStorage', { getItem: () => null })
})
afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it('offers only actual supported alternatives, including query URLs on the web', () => {
  expect(conversationActions(web, true, vi.fn()).map(a => a.label)).toEqual([
    'Open in Terminal (Kitty)', 'Open in Claude browser', 'Open in Claude app',
  ])
  expect(conversationActions(`${web}?source=remote`, true, vi.fn()).map(a => a.label)).toEqual([
    'Open in Terminal (Kitty)', 'Open in Claude browser',
  ])
  expect(conversationActions('https://claude.ai.evil.test/code/session_test', true, vi.fn())).toHaveLength(1)
  expect(conversationActions(web, false, vi.fn())).toEqual([{ label: 'Open in Claude browser', href: web }])
})

it('right-click opens alternatives without activating the default; terminal preserves host routing', () => {
  const attach = vi.fn()
  const pill = terminalWorkerPill(card({ id: 'test', tmuxSession: 'worker', shuttleHost: 'remote', sessionLink: web }), { openWorker: attach })
  document.body.append(pill)
  pill.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  expect(attach).not.toHaveBeenCalled()
  const menu = document.querySelector('[role="menu"]')!
  expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3)
  expect(menu.querySelector<HTMLAnchorElement>('a')!.href).toBe(web)
  expect(menu.querySelector<HTMLAnchorElement>('a')!.rel).toBe('noopener noreferrer')
  menu.querySelector<HTMLButtonElement>('button')!.click()
  expect(attach).toHaveBeenCalledWith('worker', 'remote')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('supports arrow navigation and Escape, restoring focus without closing the surrounding card', () => {
  const cardEscape = vi.fn()
  document.addEventListener('keydown', cardEscape, true)
  const pill = terminalWorkerPill(card({ id: 'test', tmuxSession: 'worker', sessionLink: web }), { openWorker: vi.fn() })
  document.body.append(pill)
  pill.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  expect(document.activeElement).toBe(items[0])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  expect(document.activeElement).toBe(items[2])
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(pill)
  expect(pill.getAttribute('aria-expanded')).toBe('false')
  expect(cardEscape).not.toHaveBeenCalled()
  document.removeEventListener('keydown', cardEscape, true)
})

it('keeps menu selection out of the card click-away handler and dismisses on outside gestures', () => {
  const cardClickAway = vi.fn()
  document.addEventListener('pointerdown', cardClickAway, true)
  const pill = terminalWorkerPill(card({ id: 'test', tmuxSession: 'worker', sessionLink: web }), { openWorker: vi.fn() })
  document.body.append(pill)
  pill.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  document.querySelector('[role="menuitem"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(cardClickAway).not.toHaveBeenCalled()
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(cardClickAway).toHaveBeenCalledOnce()
  document.removeEventListener('pointerdown', cardClickAway, true)
})

it('retains native context menus when no alternative exists', () => {
  const pill = terminalWorkerPill(card({ id: 'test', tmuxSession: 'worker' }), { openWorker: vi.fn() })
  const event = new MouseEvent('contextmenu', { cancelable: true })
  pill.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(pill.hasAttribute('aria-haspopup')).toBe(false)
})
