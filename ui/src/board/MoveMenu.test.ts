// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openMoveMenu } from './MoveMenu.js'
import type { MoveBroker, MoveDestination } from './MoveDestinations.js'
import { card, settle } from './testFixtures.js'

const destinations: MoveDestination[] = [
  { id: 'drafts', label: 'Drafts', group: 'column', action: { kind: 'transition', target: 'drafts' } },
  { id: 'review', label: 'Awaiting review', group: 'column', action: { kind: 'transition', target: 'awaitingReview' } },
  { id: 'rest', label: 'Resting', group: 'other', action: { kind: 'surface', horizon: 'stashed' } },
]
let anchor: HTMLButtonElement
let broker: MoveBroker
const alpha = card({ id: 'alpha', name: 'Alpha' })
const menus = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
const menu = (name = 'Alpha') => document.querySelector<HTMLElement>(`[role="menu"][aria-label="Move ${name}"]`)
const items = () => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
const key = async (key: string) => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  await settle()
}
async function open(phone = false, which = alpha): Promise<void> {
  vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }))
  openMoveMenu(which, anchor, broker)
  await settle()
}
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
  })
  anchor = document.createElement('button'); anchor.textContent = 'Alpha'; document.body.append(anchor)
  broker = { destinations: () => destinations, perform: vi.fn() }
})
afterEach(async () => {
  if (menus().length) await key('Escape')
  document.body.replaceChildren(); vi.unstubAllGlobals()
})

it('offers named destinations with a separator, arrows, Home/End, typeahead and focus return', async () => {
  await open()
  expect(items().map(item => item.textContent)).toEqual(['Drafts', 'Awaiting review', 'Resting'])
  expect(menu()!.querySelectorAll('[role="separator"]')).toHaveLength(1)
  expect(anchor.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(items()[0])
  await key('ArrowUp'); expect(document.activeElement).toBe(items()[2])
  await key('ArrowDown'); expect(document.activeElement).toBe(items()[0])
  await key('End'); expect(document.activeElement).toBe(items()[2])
  await key('Home'); expect(document.activeElement).toBe(items()[0])
  await key('r'); expect(document.activeElement).toBe(items()[2])
  await key('Escape')
  expect(menu()).toBeNull()
  expect(anchor.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(anchor)
  expect(broker.perform).not.toHaveBeenCalled()
})

it('moves the card to the place chosen by Enter, after the menu has closed', async () => {
  await open()
  await key('ArrowDown')
  await key('Enter')
  expect(menu()).toBeNull()
  expect(broker.perform).toHaveBeenCalledExactlyOnceWith(alpha, destinations[1].action)
})

it.each([false, true])('ignores the opening hold until it is released, then takes a deliberate choice (phone=%s)', async phone => {
  await open(phone)
  // jsdom has no hit testing; the browser suite checks the release itself.
  expect(getComputedStyle(items()[0]).pointerEvents).toBe('none')
  menu()!.dispatchEvent(new Event('pointerup', { bubbles: true }))
  await settle()
  expect(menu()).not.toBeNull()
  expect(getComputedStyle(items()[0]).pointerEvents).toBe('auto')
  expect(broker.perform).not.toHaveBeenCalled()
  items()[2].click(); await settle()
  expect(menu()).toBeNull()
  expect(broker.perform).toHaveBeenCalledExactlyOnceWith(alpha, destinations[2].action)
})

it('releases the hold gate on pointercancel too', async () => {
  await open()
  window.dispatchEvent(new Event('pointercancel'))
  expect(getComputedStyle(items()[0]).pointerEvents).toBe('auto')
})

it('opens the phone sheet on its surface rather than on a destination', async () => {
  await open(true)
  expect(menu()!.classList.contains('kbn-move-sheet')).toBe(true)
  expect(document.activeElement).toBe(menu())
  await key('ArrowDown'); expect(document.activeElement).toBe(items()[0])
  await key('Escape'); expect(document.activeElement).toBe(anchor)
})

it('closes on an outside press without the press reaching what lies beneath', async () => {
  const beneath = document.createElement('div'); document.body.append(beneath)
  const cardPress = vi.fn()
  beneath.addEventListener('click', cardPress)
  await open()
  beneath.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  beneath.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  beneath.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  beneath.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  await settle()
  expect(menu()).toBeNull()
  expect(cardPress).not.toHaveBeenCalled()
  expect(broker.perform).not.toHaveBeenCalled()
})

it('closes on resize without moving anything', async () => {
  await open()
  window.dispatchEvent(new Event('resize')); await settle()
  expect(menu()).toBeNull()
  expect(broker.perform).not.toHaveBeenCalled()
})

it('replaces an open move menu instead of stacking a second one', async () => {
  await open()
  await open(false, card({ id: 'beta', name: 'Beta' }))
  expect(menus()).toHaveLength(1)
  expect(menu('Beta')).not.toBeNull()
})
