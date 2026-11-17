// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ListenControl } from './ListenControl.js'
import { Voice } from '../voice.js'
import { card, voiceStatus } from '../testFixtures.js'
import { keystrokeIsSpokenFor } from '../views/ViewRegistry.js'

let control: ListenControl
let voice: Voice
let opener: HTMLButtonElement
const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Listening options"]')
const items = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const key = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  voice = new Voice('')
  voice.status = voiceStatus({ enabled: true, follow: true })
  vi.spyOn(voice, 'set').mockResolvedValue(undefined)
  control = new ListenControl({ card: () => card({ id: 'alpha', name: 'Alpha' }), voice, shuttleBase: '', fiberSlug: id => id })
  document.body.append(control.el)
  opener = control.el.querySelector<HTMLButtonElement>('[aria-label="Listening options"]')!
})
afterEach(() => { control.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('names the menu, starts on the first action, wraps arrows and returns focus on Escape', () => {
  opener.click()
  expect(menu()).not.toBeNull()
  expect(opener.getAttribute('aria-expanded')).toBe('true')
  const actions = items()
  expect(document.activeElement).toBe(actions[0])
  key('ArrowUp'); expect(document.activeElement).toBe(actions.at(-1))
  key('ArrowDown'); expect(document.activeElement).toBe(actions[0])
  key('ArrowDown'); expect(document.activeElement).toBe(actions[1])
  key('Escape')
  expect(menu()).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(opener.getAttribute('aria-expanded')).toBe('false')
})

it('keeps the numeric cadence editable without menu arrows stealing focus or submitting a route', () => {
  opener.click()
  const quiet = menu()!.querySelector<HTMLInputElement>('input[type="number"]')!
  quiet.focus()
  key('ArrowUp'); expect(document.activeElement).toBe(quiet)
  key('ArrowDown'); expect(document.activeElement).toBe(quiet)
  expect(menu()).not.toBeNull()
  expect(voice.set).not.toHaveBeenCalled()
  quiet.value = '2.5'; quiet.dispatchEvent(new Event('change', { bubbles: true }))
  expect(voice.set).toHaveBeenCalledWith({ quiet_seconds: 2.5 })
  key('Escape'); expect(menu()).toBeNull(); expect(document.activeElement).toBe(opener)
})

it('keeps inside presses open, dismisses on an outside press, and toggles from the opener', () => {
  opener.click()
  menu()!.querySelector('input')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(menu()).not.toBeNull()
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(menu()).toBeNull()
  opener.click(); expect(menu()).not.toBeNull()
  opener.click(); expect(menu()).toBeNull()
})

it('closes before running the selected route action', () => {
  opener.click()
  items().find(item => item.textContent === 'Pin to this card')!.click()
  expect(menu()).toBeNull()
  expect(voice.set).toHaveBeenCalledWith(expect.objectContaining({ follow: false }))
})

it('holds the board\'s bare keys while open, so a digit cannot switch views beneath it', () => {
  expect(keystrokeIsSpokenFor()).toBe(false)
  opener.click()
  expect(document.activeElement).toBe(items()[0])
  expect(keystrokeIsSpokenFor()).toBe(true)
  key('Escape')
  expect(keystrokeIsSpokenFor()).toBe(false)
})

it('a pressed item acts where a press moves focus to the nearest focusable ancestor, as Safari does', () => {
  // The Channels console: the control sits inside a focusable box, outside any surface that holds focus on a press.
  const box = document.createElement('div'); box.tabIndex = -1
  document.body.append(box); box.append(control.el)
  const press = (target: HTMLElement) => {
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    if (target.dispatchEvent(down)) (target.closest<HTMLElement>('input, [tabindex]') ?? document.body).focus()
    if (target.isConnected) target.click()
  }
  opener.click()
  press(items().find(item => item.textContent === 'Stop listening')!)
  expect(voice.set).toHaveBeenCalledWith({ enabled: false })
  // The cadence field still takes the focus a press gives it.
  opener.click()
  const quiet = menu()!.querySelector<HTMLInputElement>('input[type="number"]')!
  expect(quiet.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))).toBe(true)
})
