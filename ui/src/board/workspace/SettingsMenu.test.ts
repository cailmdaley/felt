// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { SettingsMenu } from './SettingsMenu.js'

afterEach(() => { document.body.replaceChildren() })

function mount(): { menu: SettingsMenu; opener: HTMLButtonElement; content: HTMLElement; host: HTMLElement; outside: HTMLButtonElement } {
  const host = document.createElement('div'), opener = document.createElement('button'), outside = document.createElement('button')
  const content = document.createElement('div'); content.textContent = 'settings'
  document.body.append(host, opener, outside)
  return { menu: new SettingsMenu(), opener, content, host, outside }
}

it('opens under its button as a non-modal dropdown holding only the settings', () => {
  const { menu, opener, content, host } = mount()
  menu.show(content, opener, host)
  expect(menu.isOpen).toBe(true)
  expect(host.contains(menu.el)).toBe(true)
  expect(menu.el.tagName).not.toBe('DIALOG')
  expect([...menu.el.children]).toEqual([content])
  expect(opener.getAttribute('aria-expanded')).toBe('true')
})

it('closes on Escape and returns focus to the button', () => {
  const { menu, opener, content, host } = mount()
  menu.show(content, opener, host)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(menu.isOpen).toBe(false)
  expect(document.activeElement).toBe(opener)
  expect(opener.getAttribute('aria-expanded')).toBe('false')
})

it('closes on a press outside, not on a press inside or on the button', () => {
  const { menu, opener, content, host, outside } = mount()
  menu.show(content, opener, host)
  content.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  opener.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(menu.isOpen).toBe(true)
  outside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(menu.isOpen).toBe(false)
})

it('toggles from its button and runs a close continuation after closing', () => {
  const { menu, opener, content, host } = mount()
  menu.show(content, opener, host)
  menu.show(content, opener, host)
  expect(menu.isOpen).toBe(false)
  menu.show(content, opener, host)
  let ran = false
  menu.close(() => { ran = !menu.isOpen })
  expect(ran).toBe(true)
})
