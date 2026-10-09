// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restPopover } from './RestPopover.js'
import { card } from './testFixtures.js'

let close: (() => void) | undefined
afterEach(() => { close?.(); document.body.replaceChildren() })
describe('rest date popover', () => {
  it.each(['', '2099-06-12'])('submits an explicit return day %j', until => {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    anchor.focus()
    const submit = vi.fn(async () => {})
    close = restPopover(card({ id: 'f' }), anchor, submit)
    const input = document.querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(input)
    input.value = until
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(submit).toHaveBeenCalledWith(until)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(anchor)
  })
  it('Escape dismisses without resting', () => {
    const submit = vi.fn(async () => {})
    close = restPopover(card({ id: 'f' }), document.body, submit)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(submit).not.toHaveBeenCalled()
    expect(document.querySelector('form')).toBeNull()
  })
})
