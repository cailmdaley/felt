// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { SettingsMenu } from './SettingsMenu.js'
import { settle } from '../testFixtures.js'

afterEach(() => { document.body.replaceChildren() })

function mount(): { menu: SettingsMenu; opener: HTMLButtonElement; content: HTMLElement; host: HTMLElement; outside: HTMLButtonElement } {
  const host = document.createElement('div'), opener = document.createElement('button'), outside = document.createElement('button')
  const content = document.createElement('div'); content.textContent = 'settings'
  const field = document.createElement('input'); field.setAttribute('aria-label', 'Field')
  content.append(field)
  document.body.append(host, opener, outside)
  return { menu: new SettingsMenu(), opener, content, host, outside }
}
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]:not([hidden])')
const key = async (value: string): Promise<void> => {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  await settle()
}
const press = async (target: Element): Promise<void> => {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  await settle()
}

it('opens as a non-modal dialog under its button, holding only the settings, with focus on the panel', async () => {
  const { menu, opener, content, host } = mount()
  menu.show(content, opener, host)
  await settle()
  expect(menu.isOpen).toBe(true)
  expect(host.contains(menu.el)).toBe(true)
  expect(dialog()?.getAttribute('aria-modal')).not.toBe('true')
  expect([...dialog()!.children]).toEqual([content])
  expect(document.activeElement).toBe(dialog())
  expect(opener.getAttribute('aria-expanded')).toBe('true')
})

it('closes on Escape and returns focus to the button', async () => {
  const { menu, opener, content, host } = mount()
  menu.show(content, opener, host)
  await settle()
  await key('Escape')
  expect(menu.isOpen).toBe(false)
  expect(dialog()).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(opener.getAttribute('aria-expanded')).toBe('false')
})

it('closes on a press outside, not on a press inside or on the button', async () => {
  const { menu, opener, content, host, outside } = mount()
  menu.show(content, opener, host)
  await settle()
  await press(content)
  await press(opener)
  expect(menu.isOpen).toBe(true)
  await press(outside)
  expect(menu.isOpen).toBe(false)
})

it('closes when focus leaves it, so it never covers the control that took focus', async () => {
  const { menu, opener, content, host, outside } = mount()
  menu.show(content, opener, host)
  await settle()
  content.querySelector('input')!.focus()
  outside.focus()
  await settle()
  expect(menu.isOpen).toBe(false)
  expect(document.activeElement).toBe(outside)
})

it('toggles from its button and runs a close continuation after closing', async () => {
  const { menu, opener, content, host } = mount()
  menu.show(content, opener, host)
  await settle()
  menu.show(content, opener, host)
  await settle()
  expect(menu.isOpen).toBe(false)
  menu.show(content, opener, host)
  await settle()
  let ran = false
  menu.close(() => { ran = !menu.isOpen })
  await settle()
  expect(ran).toBe(true)
})
