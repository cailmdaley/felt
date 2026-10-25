// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { headerSheet, headerTile, type HeaderSheet } from './headerSheet.js'

let sheet: HeaderSheet | undefined
afterEach(() => { sheet?.dispose(); sheet = undefined; document.body.replaceChildren(); vi.restoreAllMocks() })

function setup(): { trigger: HTMLButtonElement; first: HTMLButtonElement; last: HTMLButtonElement } {
  sheet = headerSheet('Act', vi.fn())
  const hidden = headerTile(document.createElement('button'), '×', 'Hidden')
  hidden.hidden = true
  const disabled = headerTile(document.createElement('button'), '×', 'Unavailable')
  disabled.disabled = true
  const first = headerTile(document.createElement('button'), '✓', 'Close')
  const last = headerTile(document.createElement('button'), '↻', 'Resume')
  sheet.panel.append(hidden, disabled, first, last)
  document.body.append(sheet.trigger, sheet.panel)
  return { trigger: sheet.trigger, first, last }
}
function key(key: string, shiftKey = false): void {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
}

describe('header sheets', () => {
  it('focuses available tiles, steps with arrows and restores the trigger on Escape', () => {
    const { trigger, first, last } = setup()
    trigger.click()
    expect(document.activeElement).toBe(first)
    key('ArrowDown'); expect(document.activeElement).toBe(last)
    key('ArrowRight'); expect(document.activeElement).toBe(first)
    key('ArrowUp'); expect(document.activeElement).toBe(last)
    key('Escape')
    expect(sheet!.panel.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on Tab at either boundary so focus never stays in a hidden sheet', () => {
    const { trigger, last } = setup()
    trigger.click(); key('Tab', true)
    expect(sheet!.panel.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
    trigger.click(); last.focus(); key('Tab')
    expect(sheet!.panel.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it('toggles shut and releases its document listeners when disposed', () => {
    const { trigger } = setup()
    trigger.click(); trigger.click()
    expect(sheet!.panel.hidden).toBe(true)
    trigger.click(); sheet!.dispose()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    trigger.click()
    expect(sheet!.panel.hidden).toBe(true)
  })
})
